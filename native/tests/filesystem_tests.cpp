#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>

#include "keyfinder/file_scanner.hpp"
#include "keyfinder/metadata.hpp"
#include "keyfinder/model.hpp"
#include "keyfinder/settings.hpp"
#include "keyfinder/writer.hpp"

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

keyfinder::domain::Track make_track(const std::filesystem::path& path,
                                    const std::string& id) {
  keyfinder::domain::Track track;
  track.id = id;
  track.path = std::filesystem::canonical(path);
  track.filename = track.path.filename().string();
  track.detected_key = 0;
  track.detected_code = "A";
  track.status = keyfinder::domain::TrackStatus::completed;
  keyfinder::domain::read_metadata(track);
  track.detected_key = 0;
  track.detected_code = "A";
  track.status = keyfinder::domain::TrackStatus::completed;
  return track;
}

}  // namespace

int main() {
  using keyfinder::domain::OutputMode;
  using keyfinder::domain::Settings;
  const auto fixtures = std::filesystem::path(NKF_LEGACY_FIXTURES_DIR);
  const auto suffix = std::to_string(
      std::chrono::steady_clock::now().time_since_epoch().count());
  const auto temporary =
      std::filesystem::temp_directory_path() / ("neo-keyfinder-files-" + suffix);
  const auto nested = temporary / std::filesystem::path(u8"Müsic") / "nested";
  std::filesystem::create_directories(nested);
  const auto audio = nested / std::filesystem::path(u8"Tést.WAV");
  const auto ignored = nested / "document.pdf";
  std::filesystem::copy_file(fixtures / "readTags/wav.wav", audio);
  std::filesystem::copy_file(fixtures / "notAV.pdf", ignored);
  std::error_code symlink_error;
  std::filesystem::create_directory_symlink(temporary, nested / "cycle",
                                             symlink_error);

  Settings filtered;
  filtered.extension_filter_enabled = true;
  filtered.extensions = {"wav"};
  const auto scan = keyfinder::domain::scan_paths(
      {temporary, audio, temporary / "missing"}, filtered);
  expect(scan.tracks.size() == 1, "recursive scan deduplicates files and cycles");
  expect(scan.tracks.front().filename == "Tést.WAV", "Unicode paths round trip");
  expect(scan.warnings.size() == 1 && scan.warnings.front().code == "NOT_FOUND",
         "missing inputs produce a warning");

  Settings unfiltered;
  const auto unfiltered_folder_scan =
      keyfinder::domain::scan_paths({temporary}, unfiltered);
  expect(unfiltered_folder_scan.tracks.size() == 1 &&
             unfiltered_folder_scan.tracks.front().filename == "Tést.WAV",
         "folder intake hides files that are not supported audio");
  const auto unfiltered_scan = keyfinder::domain::scan_paths({ignored}, unfiltered);
  expect(unfiltered_scan.tracks.size() == 1,
         "unfiltered intake retains unsupported files as rows");
  expect(unfiltered_scan.tracks.front().error &&
             unfiltered_scan.tracks.front().error->code == "METADATA_UNSUPPORTED",
         "unsupported metadata is a per-track error");

  const auto source = temporary / "track.wav";
  const auto collision = temporary / "A - track.wav";
  std::filesystem::copy_file(fixtures / "readTags/wav.wav", source);
  std::filesystem::copy_file(fixtures / "readTags/wav.wav", collision);
  Settings rename;
  rename.outputs.comment = OutputMode::none;
  rename.outputs.filename = OutputMode::prepend;
  const auto collided = keyfinder::domain::write_detected_key(
      make_track(source, "stable-id"), rename);
  expect(collided.error && collided.error->code == "PARTIAL_WRITE",
         "filename collisions are rejected independently");
  expect(std::filesystem::exists(source) && std::filesystem::exists(collision),
         "a collision never overwrites either file");

  const auto rename_source = temporary / "other.wav";
  std::filesystem::copy_file(fixtures / "readTags/wav.wav", rename_source);
  const auto renamed = keyfinder::domain::write_detected_key(
      make_track(rename_source, "stable-id"), rename);
  expect(!renamed.error, "a non-colliding filename write succeeds");
  expect(renamed.id == "stable-id", "renames preserve the stable track identity");
  expect(renamed.filename == "A - other.wav" &&
             std::filesystem::exists(temporary / "A - other.wav"),
         "renames preserve the extension and update the model");

  std::filesystem::remove_all(temporary);
  return 0;
}
