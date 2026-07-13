#include "keyfinder/file_scanner.hpp"

#include <algorithm>
#include <cctype>
#include <deque>
#include <system_error>
#include <unordered_set>

#include "keyfinder/metadata.hpp"

namespace keyfinder::domain {
namespace {

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char byte) {
    return static_cast<char>(std::tolower(byte));
  });
  return value;
}

std::string canonical_key(const std::filesystem::path& path) {
  auto key = path_to_utf8(path.lexically_normal());
#if defined(_WIN32)
  key = lowercase(std::move(key));
#endif
  return key;
}

bool extension_allowed(const std::filesystem::path& path,
                       const Settings& settings) {
  if (!settings.extension_filter_enabled) return true;
  auto extension = path.extension().string();
  if (!extension.empty() && extension.front() == '.') extension.erase(0, 1);
  extension = lowercase(std::move(extension));
  return std::any_of(settings.extensions.begin(), settings.extensions.end(),
                     [&](const std::string& allowed) {
                       return extension == lowercase(allowed);
                     });
}

void warn(ScanResult& result,
          const std::filesystem::path& path,
          std::string code,
          std::string message) {
  result.warnings.push_back(
      {path_to_utf8(path), std::move(code), std::move(message)});
}

}  // namespace

ScanResult scan_paths(const std::vector<std::filesystem::path>& inputs,
                      const Settings& settings) {
  ScanResult result;
  std::deque<std::filesystem::path> pending(inputs.begin(), inputs.end());
  std::unordered_set<std::string> visited_directories;
  std::unordered_set<std::string> visited_files;

  while (!pending.empty()) {
    const auto candidate = std::move(pending.front());
    pending.pop_front();

    std::error_code error;
    if (!std::filesystem::exists(candidate, error) || error) {
      warn(result, candidate, "NOT_FOUND", "The path does not exist");
      continue;
    }

    const auto canonical = std::filesystem::weakly_canonical(candidate, error);
    if (error) {
      warn(result, candidate, "CANONICALIZE_FAILED", error.message());
      continue;
    }

    if (std::filesystem::is_directory(canonical, error)) {
      const auto key = canonical_key(canonical);
      if (!visited_directories.insert(key).second) continue;
      std::filesystem::directory_iterator iterator(
          canonical, std::filesystem::directory_options::skip_permission_denied,
          error);
      if (error) {
        warn(result, canonical, "DIRECTORY_READ_FAILED", error.message());
        continue;
      }
      for (const auto& entry : iterator) pending.push_back(entry.path());
      continue;
    }

    if (!std::filesystem::is_regular_file(canonical, error) || error) continue;
    if (!extension_allowed(canonical, settings)) continue;

    const auto key = canonical_key(canonical);
    if (!visited_files.insert(key).second) continue;

    Track track;
    track.id = stable_track_id(canonical);
    track.path = canonical;
    track.filename = path_to_utf8(canonical.filename());
    track.status = TrackStatus::reading;
    read_metadata(track);
    result.tracks.push_back(std::move(track));
  }

  return result;
}

}  // namespace keyfinder::domain
