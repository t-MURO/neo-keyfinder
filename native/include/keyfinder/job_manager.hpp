#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include "keyfinder/model.hpp"
#include "keyfinder/settings.hpp"

namespace keyfinder::domain {

using EventSink = std::function<void(const nlohmann::json&)>;

class JobManager {
 public:
  struct Job;

  explicit JobManager(EventSink sink);
  ~JobManager();

  JobManager(const JobManager&) = delete;
  JobManager& operator=(const JobManager&) = delete;

  [[nodiscard]] std::string start(std::vector<Track> tracks, Settings settings);
  [[nodiscard]] bool cancel(const std::string& job_id);

 private:
  EventSink sink_;
  std::mutex jobs_mutex_;
  std::unordered_map<std::string, std::shared_ptr<Job>> jobs_;
  std::atomic<std::uint64_t> next_job_id_{1};
};

}  // namespace keyfinder::domain
