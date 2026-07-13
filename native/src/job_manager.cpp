#include "keyfinder/job_manager.hpp"

#include <algorithm>
#include <chrono>
#include <exception>
#include <thread>
#include <utility>

#include "keyfinder/analyzer.hpp"
#include "keyfinder/writer.hpp"

namespace keyfinder::domain {

struct JobManager::Job {
  std::string id;
  std::atomic<bool> cancelled{false};
  std::atomic<std::size_t> next_track{0};
  std::atomic<std::size_t> completed{0};
  std::atomic<std::uint64_t> sequence{1};
  std::atomic<bool> finished{false};
  std::mutex emit_mutex;
  std::thread coordinator;
};

namespace {

void emit(const EventSink& sink,
          const std::shared_ptr<JobManager::Job>& job,
          const std::string& event,
          nlohmann::json payload) {
  std::lock_guard lock(job->emit_mutex);
  sink({{"version", 1},
        {"event", event},
        {"jobId", job->id},
        {"sequence", job->sequence.fetch_add(1)},
        {"payload", std::move(payload)}});
}

}  // namespace

JobManager::JobManager(EventSink sink) : sink_(std::move(sink)) {}

JobManager::~JobManager() {
  std::vector<std::shared_ptr<Job>> jobs;
  {
    std::lock_guard lock(jobs_mutex_);
    for (const auto& [_, job] : jobs_) {
      job->cancelled = true;
      jobs.push_back(job);
    }
  }
  for (const auto& job : jobs) {
    if (job->coordinator.joinable()) job->coordinator.join();
  }
}

std::string JobManager::start(std::vector<Track> tracks, Settings settings) {
  {
    std::lock_guard lock(jobs_mutex_);
    for (auto iterator = jobs_.begin(); iterator != jobs_.end();) {
      if (!iterator->second->finished) {
        ++iterator;
        continue;
      }
      if (iterator->second->coordinator.joinable()) {
        iterator->second->coordinator.join();
      }
      iterator = jobs_.erase(iterator);
    }
  }
  auto job = std::make_shared<Job>();
  job->id = "job-" + std::to_string(next_job_id_.fetch_add(1));
  {
    std::lock_guard lock(jobs_mutex_);
    jobs_[job->id] = job;
  }

  const auto sink = sink_;
  job->coordinator = std::thread(
      [job, tracks = std::move(tracks), settings = std::move(settings), sink]() mutable {
        const auto total = tracks.size();
        const auto available = std::max(1U, std::thread::hardware_concurrency());
        const auto worker_count = settings.parallel
                                      ? std::min<std::size_t>(available, std::max<std::size_t>(1, total))
                                      : 1;
        std::vector<std::thread> workers;
        workers.reserve(worker_count);

        for (std::size_t worker = 0; worker < worker_count; ++worker) {
          workers.emplace_back([&, job, sink]() {
            while (!job->cancelled) {
              const auto index = job->next_track.fetch_add(1);
              if (index >= tracks.size()) return;
              auto track = tracks[index];

              if (settings.skip_existing && outputs_already_satisfied(track, settings)) {
                track.status = TrackStatus::skipped;
                emit(sink, job, "trackUpdated", {{"track", to_json(track)}});
              } else {
                track.status = TrackStatus::analyzing;
                track.error.reset();
                emit(sink, job, "trackUpdated", {{"track", to_json(track)}});
                try {
                  double last_progress = -1.0;
                  const auto analysis = analyze_file(
                      track.path, settings.max_duration_minutes,
                      [&]() { return job->cancelled.load(); },
                      [&](double fraction) {
                        if (fraction >= 1.0 || fraction - last_progress >= 0.02) {
                          last_progress = fraction;
                          emit(sink, job, "trackProgress",
                               {{"trackId", track.id}, {"fraction", fraction}});
                        }
                      });
                  track.detected_key = analysis.key;
                  track.detected_code = key_code(analysis.key, settings);
                  track.status = TrackStatus::completed;
                  if (settings.automatic_writes && !job->cancelled) {
                    track = write_detected_key(
                        std::move(track), settings,
                        [&]() { return job->cancelled.load(); });
                  }
                } catch (const std::exception& error) {
                  if (job->cancelled || std::string(error.what()) == "ANALYSIS_CANCELLED") {
                    track.status = TrackStatus::cancelled;
                  } else {
                    track.status = TrackStatus::failed;
                    track.error = TrackError{"ANALYSIS_FAILED", "analysis", error.what()};
                  }
                }
                emit(sink, job, "trackUpdated", {{"track", to_json(track)}});
              }

              const auto done = job->completed.fetch_add(1) + 1;
              emit(sink, job, "jobProgress",
                   {{"completed", done}, {"total", total},
                    {"fraction", total == 0 ? 1.0
                                             : static_cast<double>(done) /
                                                   static_cast<double>(total)}});
            }
          });
        }
        for (auto& worker : workers) worker.join();

        if (job->cancelled) {
          const auto first_unstarted =
              std::min(job->next_track.load(), tracks.size());
          for (auto index = first_unstarted; index < tracks.size(); ++index) {
            auto track = tracks[index];
            track.status = TrackStatus::cancelled;
            track.error.reset();
            emit(sink, job, "trackUpdated", {{"track", to_json(track)}});
            const auto done = job->completed.fetch_add(1) + 1;
            emit(sink, job, "jobProgress",
                 {{"completed", done},
                  {"total", total},
                  {"fraction", total == 0
                                   ? 1.0
                                   : static_cast<double>(done) /
                                         static_cast<double>(total)}});
          }
        }

        emit(sink, job, "jobFinished",
             {{"cancelled", job->cancelled.load()},
              {"completed", job->completed.load()},
              {"total", total}});
        job->finished = true;
      });

  return job->id;
}

bool JobManager::cancel(const std::string& job_id) {
  std::lock_guard lock(jobs_mutex_);
  const auto iterator = jobs_.find(job_id);
  if (iterator == jobs_.end()) return false;
  if (iterator->second->finished) return false;
  iterator->second->cancelled = true;
  return true;
}

}  // namespace keyfinder::domain
