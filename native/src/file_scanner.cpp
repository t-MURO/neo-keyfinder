#include "keyfinder/file_scanner.hpp"

#include <algorithm>
#include <cctype>
#include <deque>
#include <system_error>
#include <unordered_set>

#include "keyfinder/metadata.hpp"

namespace keyfinder::domain {
namespace {

struct PendingPath {
  std::filesystem::path path;
  bool discovered_in_directory{false};
};

const std::vector<std::string> kSupportedAudioExtensions{
    "mp3", "m4a", "mp4", "wma", "flac", "aif", "aiff", "wav"};

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

bool has_extension(const std::filesystem::path& path,
                   const std::vector<std::string>& extensions) {
  auto extension = path.extension().string();
  if (!extension.empty() && extension.front() == '.') extension.erase(0, 1);
  extension = lowercase(std::move(extension));
  return std::any_of(extensions.begin(), extensions.end(),
                     [&](const std::string& allowed) {
                       return extension == lowercase(allowed);
                     });
}

bool extension_allowed(const PendingPath& candidate,
                       const Settings& settings) {
  if (settings.extension_filter_enabled) {
    return has_extension(candidate.path, settings.extensions);
  }
  // Directly chosen files remain visible so the UI can explain why they
  // cannot be read. Recursive folder intake stays focused on supported audio.
  return !candidate.discovered_in_directory ||
         has_extension(candidate.path, kSupportedAudioExtensions);
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
  std::deque<PendingPath> pending;
  for (const auto& input : inputs) pending.push_back({input, false});
  std::unordered_set<std::string> visited_directories;
  std::unordered_set<std::string> visited_files;

  while (!pending.empty()) {
    const auto candidate = std::move(pending.front());
    pending.pop_front();

    std::error_code error;
    if (!std::filesystem::exists(candidate.path, error) || error) {
      warn(result, candidate.path, "NOT_FOUND", "The path does not exist");
      continue;
    }

    const auto canonical = std::filesystem::weakly_canonical(candidate.path, error);
    if (error) {
      warn(result, candidate.path, "CANONICALIZE_FAILED", error.message());
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
      for (const auto& entry : iterator) pending.push_back({entry.path(), true});
      continue;
    }

    if (!std::filesystem::is_regular_file(canonical, error) || error) continue;
    if (!extension_allowed({canonical, candidate.discovered_in_directory}, settings)) {
      continue;
    }

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
