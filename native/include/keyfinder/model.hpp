#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace keyfinder::domain {

enum class TrackStatus {
  pending,
  reading,
  ready,
  skipped,
  analyzing,
  completed,
  failed,
  cancelled,
};

struct TrackError {
  std::string code;
  std::string stage;
  std::string message;
};

struct Track {
  std::string id;
  std::filesystem::path path;
  std::string filename;
  std::string title;
  std::string artist;
  std::string album;
  std::string comment;
  std::string grouping;
  std::string initial_key;
  std::optional<double> initial_bpm;
  std::optional<std::int64_t> duration_ms;
  std::optional<int> detected_key;
  std::string detected_code;
  std::optional<double> detected_bpm;
  TrackStatus status{TrackStatus::pending};
  std::optional<TrackError> error;
};

[[nodiscard]] std::string path_to_utf8(const std::filesystem::path& path);
[[nodiscard]] std::filesystem::path path_from_utf8(const std::string& path);
[[nodiscard]] std::string stable_track_id(const std::filesystem::path& path);
[[nodiscard]] std::string to_string(TrackStatus status);
[[nodiscard]] TrackStatus track_status_from_string(const std::string& value);
[[nodiscard]] nlohmann::json to_json(const Track& track);
[[nodiscard]] Track track_from_json(const nlohmann::json& value);

}  // namespace keyfinder::domain
