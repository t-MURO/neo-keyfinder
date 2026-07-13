#include "keyfinder/model.hpp"

#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace keyfinder::domain {

std::string path_to_utf8(const std::filesystem::path& path) {
#if defined(_WIN32)
  const auto encoded = path.u8string();
  return {encoded.begin(), encoded.end()};
#else
  return path.string();
#endif
}

std::filesystem::path path_from_utf8(const std::string& path) {
#if defined(_WIN32)
  return std::filesystem::path(std::u8string(path.begin(), path.end()));
#else
  return std::filesystem::path(path);
#endif
}

std::string stable_track_id(const std::filesystem::path& path) {
  constexpr std::uint64_t kOffset = 14695981039346656037ULL;
  constexpr std::uint64_t kPrime = 1099511628211ULL;
  std::uint64_t hash = kOffset;
  for (const auto byte : path_to_utf8(path)) {
    hash ^= static_cast<unsigned char>(byte);
    hash *= kPrime;
  }
  std::ostringstream output;
  output << std::hex << std::setfill('0') << std::setw(16) << hash;
  return output.str();
}

std::string to_string(TrackStatus status) {
  switch (status) {
    case TrackStatus::pending:
      return "pending";
    case TrackStatus::reading:
      return "reading";
    case TrackStatus::ready:
      return "ready";
    case TrackStatus::skipped:
      return "skipped";
    case TrackStatus::analyzing:
      return "analyzing";
    case TrackStatus::completed:
      return "completed";
    case TrackStatus::failed:
      return "failed";
    case TrackStatus::cancelled:
      return "cancelled";
  }
  throw std::invalid_argument("Unknown track status");
}

TrackStatus track_status_from_string(const std::string& value) {
  if (value == "pending") return TrackStatus::pending;
  if (value == "reading") return TrackStatus::reading;
  if (value == "ready") return TrackStatus::ready;
  if (value == "skipped") return TrackStatus::skipped;
  if (value == "analyzing") return TrackStatus::analyzing;
  if (value == "completed") return TrackStatus::completed;
  if (value == "failed") return TrackStatus::failed;
  if (value == "cancelled") return TrackStatus::cancelled;
  throw std::invalid_argument("Unknown track status: " + value);
}

nlohmann::json to_json(const Track& track) {
  nlohmann::json value = {
      {"id", track.id},
      {"path", path_to_utf8(track.path)},
      {"filename", track.filename},
      {"title", track.title},
      {"artist", track.artist},
      {"album", track.album},
      {"comment", track.comment},
      {"grouping", track.grouping},
      {"initialKey", track.initial_key},
      {"detectedCode", track.detected_code},
      {"status", to_string(track.status)},
  };
  value["durationMs"] = track.duration_ms ? nlohmann::json(*track.duration_ms)
                                           : nlohmann::json(nullptr);
  value["detectedKey"] = track.detected_key ? nlohmann::json(*track.detected_key)
                                             : nlohmann::json(nullptr);
  if (track.error) {
    value["error"] = {{"code", track.error->code},
                      {"stage", track.error->stage},
                      {"message", track.error->message}};
  } else {
    value["error"] = nullptr;
  }
  return value;
}

Track track_from_json(const nlohmann::json& value) {
  Track track;
  track.id = value.at("id").get<std::string>();
  track.path = path_from_utf8(value.at("path").get<std::string>());
  track.filename = value.value("filename", track.path.filename().string());
  track.title = value.value("title", "");
  track.artist = value.value("artist", "");
  track.album = value.value("album", "");
  track.comment = value.value("comment", "");
  track.grouping = value.value("grouping", "");
  track.initial_key = value.value("initialKey", "");
  track.detected_code = value.value("detectedCode", "");
  track.status = track_status_from_string(value.value("status", "pending"));
  if (value.contains("durationMs") && !value["durationMs"].is_null()) {
    track.duration_ms = value["durationMs"].get<std::int64_t>();
  }
  if (value.contains("detectedKey") && !value["detectedKey"].is_null()) {
    track.detected_key = value["detectedKey"].get<int>();
  }
  if (value.contains("error") && value["error"].is_object()) {
    track.error = TrackError{value["error"].value("code", "UNKNOWN"),
                             value["error"].value("stage", "unknown"),
                             value["error"].value("message", "Unknown error")};
  }
  return track;
}

}  // namespace keyfinder::domain
