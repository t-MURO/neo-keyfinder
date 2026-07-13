#include "keyfinder/writer.hpp"

#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include "keyfinder/metadata.hpp"
#include "keyfinder/output_rules.hpp"

namespace keyfinder::domain {
namespace {

struct Destination {
  std::string* value;
  OutputMode mode;
  const char* property;
  std::size_t limit;
};

std::vector<Destination> metadata_destinations(Track& track,
                                               const Settings& settings) {
  return {
      {&track.title, settings.outputs.title, "TITLE", kMetadataCharacterLimit},
      {&track.artist, settings.outputs.artist, "ARTIST", kMetadataCharacterLimit},
      {&track.album, settings.outputs.album, "ALBUM", kMetadataCharacterLimit},
      {&track.comment, settings.outputs.comment, "COMMENT", kMetadataCharacterLimit},
      {&track.grouping, settings.outputs.grouping, "GROUPING", kMetadataCharacterLimit},
      {&track.initial_key, settings.outputs.initial_key, "INITIALKEY", kKeyCharacterLimit},
  };
}

std::string filename_stem(const Track& track) {
  return path_to_utf8(track.path.stem());
}

void append_error(std::vector<std::string>& errors,
                  const std::string& destination,
                  const std::string& message) {
  if (!message.empty()) errors.push_back(destination + ": " + message);
}

std::string join_errors(const std::vector<std::string>& errors) {
  std::string result;
  for (const auto& error : errors) {
    if (!result.empty()) result += "; ";
    result += error;
  }
  return result;
}

}  // namespace

bool outputs_already_satisfied(const Track& input, const Settings& settings) {
  Track track = input;
  const auto codes = all_key_codes(settings);
  bool any_enabled = false;
  for (const auto& destination : metadata_destinations(track, settings)) {
    if (destination.mode == OutputMode::none) continue;
    any_enabled = true;
    if (apply_output_rule("", *destination.value, destination.limit,
                          destination.mode, settings.delimiter, codes)) {
      return false;
    }
  }
  if (settings.outputs.filename != OutputMode::none) {
    any_enabled = true;
    if (apply_output_rule("", filename_stem(track), kFilenameCharacterLimit,
                          settings.outputs.filename, settings.delimiter, codes)) {
      return false;
    }
  }
  return any_enabled;
}

Track write_detected_key(Track track, const Settings& settings,
                         const std::function<bool()>& is_cancelled) {
  if (!track.detected_key) {
    track.error = TrackError{"NO_DETECTED_KEY", "write",
                             "Only successfully analyzed tracks can be written"};
    return track;
  }

  const auto code = key_code(*track.detected_key, settings);
  std::vector<std::string> errors;
  for (const auto& destination : metadata_destinations(track, settings)) {
    const auto next = apply_output_rule(code, *destination.value, destination.limit,
                                        destination.mode, settings.delimiter);
    if (!next) continue;
    if (is_cancelled && is_cancelled()) {
      track.status = TrackStatus::cancelled;
      track.error = TrackError{"WRITE_CANCELLED", "write",
                               "Writing was cancelled"};
      return track;
    }
    const auto mutation =
        write_metadata_field(track.path, destination.property, *next);
    if (mutation.changed) {
      *destination.value = mutation.value;
    } else {
      append_error(errors, destination.property, mutation.error);
    }
  }

  const auto next_name = apply_output_rule(
      code, filename_stem(track), kFilenameCharacterLimit,
      settings.outputs.filename, settings.delimiter);
  if (next_name) {
    if (is_cancelled && is_cancelled()) {
      track.status = TrackStatus::cancelled;
      track.error = TrackError{"WRITE_CANCELLED", "write",
                               "Writing was cancelled"};
      return track;
    }
    const auto target = track.path.parent_path() /
                        path_from_utf8(*next_name + path_to_utf8(track.path.extension()));
    std::error_code error;
    if (std::filesystem::exists(target, error) && target != track.path) {
      append_error(errors, "filename", "A file with the target name already exists");
    } else {
      std::filesystem::rename(track.path, target, error);
      if (error) {
        append_error(errors, "filename", error.message());
      } else {
        track.path = std::filesystem::weakly_canonical(target, error);
        if (error) track.path = target;
        track.filename = path_to_utf8(track.path.filename());
      }
    }
  }

  if (!errors.empty()) {
    track.error = TrackError{"PARTIAL_WRITE", "write", join_errors(errors)};
  } else if (track.error && track.error->stage == "write") {
    track.error.reset();
  }
  return track;
}

}  // namespace keyfinder::domain
