#pragma once

#include <filesystem>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "keyfinder/settings.hpp"

namespace keyfinder::domain {

struct Playlist {
  std::string id;
  std::string name;
  std::string source;
  std::string origin;
  std::vector<std::filesystem::path> tracks;
  bool read_only{true};
};

struct PlaylistWarning {
  std::string source;
  std::string path;
  std::string code;
  std::string message;
};

struct PlaylistResult {
  std::vector<Playlist> playlists;
  std::vector<PlaylistWarning> warnings;
};

[[nodiscard]] PlaylistResult discover_libraries(const Settings& settings);
[[nodiscard]] PlaylistResult load_standalone_playlist(
    const std::filesystem::path& path);
[[nodiscard]] nlohmann::json to_json(const Playlist& playlist);
[[nodiscard]] nlohmann::json to_json(const PlaylistWarning& warning);

}  // namespace keyfinder::domain
