#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "keyfinder/metadata.hpp"
#include "keyfinder/model.hpp"

namespace {

using keyfinder::domain::Track;

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

std::filesystem::path fixture(const std::string& folder,
                              const std::string& filename) {
  return std::filesystem::path(NKF_LEGACY_FIXTURES_DIR) / folder / filename;
}

Track read(const std::filesystem::path& path) {
  Track track;
  track.path = path;
  keyfinder::domain::read_metadata(track);
  return track;
}

void expect_metadata(const std::string& filename, const std::string& title,
                     const std::string& artist, const std::string& album,
                     const std::string& comment, const std::string& grouping,
                     const std::string& initial_key) {
  const auto track = read(fixture("readTags", filename));
  expect(!track.error, filename + " is readable");
  expect(track.title == title, filename + " title");
  expect(track.artist == artist, filename + " artist");
  expect(track.album == album, filename + " album");
  expect(track.comment == comment, filename + " comment");
  expect(track.grouping == grouping, filename + " grouping");
  expect(track.initial_key == initial_key, filename + " initial key");
  expect(track.duration_ms.has_value(), filename + " duration");
}

void expect_write_round_trip(const std::filesystem::path& source,
                             const std::filesystem::path& directory) {
  const auto target = directory / source.filename();
  std::filesystem::copy_file(source, target,
                             std::filesystem::copy_options::overwrite_existing);
  for (const auto& [field, member] :
       std::vector<std::pair<std::string, std::string Track::*>>{
           {"TITLE", &Track::title},
           {"ARTIST", &Track::artist},
           {"ALBUM", &Track::album},
           {"COMMENT", &Track::comment},
           {"GROUPING", &Track::grouping},
           {"INITIALKEY", &Track::initial_key},
       }) {
    const auto mutation =
        keyfinder::domain::write_metadata_field(target, field, "ABC");
    expect(mutation.changed, source.filename().string() + " writes " + field +
                                 ": " + mutation.error);
    const auto track = read(target);
    expect(!track.error, source.filename().string() + " remains readable");
    expect(track.*member == "ABC",
           source.filename().string() + " round trips " + field);
  }
}

}  // namespace

int main() {
  expect_metadata("flac.flac", "Title", "Artist", "Album", "Comment", "",
                  "Key");
  expect_metadata("mp3 with no tags.mp3", "", "", "", "", "", "");
  expect_metadata("mp3 with id3 v1.mp3", "Title v1", "Artist v1", "Album v1",
                  "Comment v1", "", "");
  expect_metadata("mp3 with id3 v2.3.mp3", "Title v2.3", "Artist v2.3",
                  "Album v2.3", "Comment v2.3", "Grouping v2.3", "2.3");
  expect_metadata("mp3 with id3 v2.4.mp3", "Title v2.4", "Artist v2.4",
                  "Album v2.4", "Comment v2.4", "Grouping v2.4", "2.4");
  expect_metadata("mp3 with id3 v2.3 and v1.mp3", "Title v2.3", "Artist v2.3",
                  "Album v2.3", "Comment v2.3", "Grouping v2.3", "2.3");
  expect_metadata("mp3 with id3 v2.4 and v1.mp3", "Title v2.4", "Artist v2.4",
                  "Album v2.4", "Comment v2.4", "Grouping v2.4", "2.4");
  for (const auto& filename : {"aiff.aiff", "wav.wav", "alac.m4a", "aac.m4a",
                               "wma.wma"}) {
    expect_metadata(filename, "Title", "Artist", "Album", "Comment", "Grouping",
                    "Key");
  }

  const auto suffix = std::to_string(
      std::chrono::steady_clock::now().time_since_epoch().count());
  const auto temporary =
      std::filesystem::temp_directory_path() / ("neo-keyfinder-metadata-" + suffix);
  std::filesystem::create_directories(temporary);
  for (const auto& entry :
       std::filesystem::directory_iterator(fixture("writeTags", ""))) {
    if (entry.is_regular_file()) expect_write_round_trip(entry.path(), temporary);
  }
  std::filesystem::remove_all(temporary);
  return 0;
}
