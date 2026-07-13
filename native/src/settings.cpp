#include "keyfinder/settings.hpp"

#include <algorithm>
#include <stdexcept>

namespace keyfinder::domain {
namespace {

const std::array<std::string, 25> kStandardCodes = {
    "A",  "Am", "Bb", "Bbm", "B",  "Bm", "C",   "Cm", "Db",
    "Dbm", "D", "Dm", "Eb",  "Ebm", "E", "Em",  "F",  "Fm",
    "Gb", "Gbm", "G", "Gm", "Ab", "Abm", "..."};

const std::array<std::string, 25> kDjCodes = {
    "11B", "8A", "6B", "3A", "1B", "10A", "8B", "5A", "3B",
    "12A", "10B", "7A", "5B", "2A", "12B", "9A", "7B", "4A",
    "2B", "11A", "9B", "6A", "4B", "1A", ""};

OutputSettings outputs_from_json(const nlohmann::json& value) {
  OutputSettings outputs;
  outputs.title = output_mode_from_string(value.value("title", "none"));
  outputs.artist = output_mode_from_string(value.value("artist", "none"));
  outputs.album = output_mode_from_string(value.value("album", "none"));
  outputs.comment = output_mode_from_string(value.value("comment", "prepend"));
  outputs.grouping = output_mode_from_string(value.value("grouping", "none"));
  outputs.initial_key =
      output_mode_from_string(value.value("initialKey", "none"));
  outputs.filename = output_mode_from_string(value.value("filename", "none"));
  return outputs;
}

}  // namespace

std::string to_string(OutputMode mode) {
  switch (mode) {
    case OutputMode::none:
      return "none";
    case OutputMode::prepend:
      return "prepend";
    case OutputMode::append:
      return "append";
    case OutputMode::overwrite:
      return "overwrite";
  }
  throw std::invalid_argument("Unknown output mode");
}

OutputMode output_mode_from_string(const std::string& value) {
  if (value == "none") return OutputMode::none;
  if (value == "prepend") return OutputMode::prepend;
  if (value == "append") return OutputMode::append;
  if (value == "overwrite") return OutputMode::overwrite;
  throw std::invalid_argument("Unknown output mode: " + value);
}

std::string to_string(NotationMode mode) {
  switch (mode) {
    case NotationMode::standard:
      return "standard";
    case NotationMode::custom:
      return "custom";
    case NotationMode::combined:
      return "combined";
    case NotationMode::dj_combined:
      return "djCombined";
  }
  throw std::invalid_argument("Unknown notation mode");
}

NotationMode notation_mode_from_string(const std::string& value) {
  if (value == "standard") return NotationMode::standard;
  if (value == "custom") return NotationMode::custom;
  if (value == "combined") return NotationMode::combined;
  if (value == "djCombined") return NotationMode::dj_combined;
  throw std::invalid_argument("Unknown notation mode: " + value);
}

nlohmann::json to_json(const Settings& settings) {
  return {
      {"schemaVersion", settings.schema_version},
      {"parallel", settings.parallel},
      {"maxDurationMinutes", settings.max_duration_minutes},
      {"skipExisting", settings.skip_existing},
      {"automaticWrites", settings.automatic_writes},
      {"extensionFilterEnabled", settings.extension_filter_enabled},
      {"extensions", settings.extensions},
      {"outputs",
       {{"title", to_string(settings.outputs.title)},
        {"artist", to_string(settings.outputs.artist)},
        {"album", to_string(settings.outputs.album)},
        {"comment", to_string(settings.outputs.comment)},
        {"grouping", to_string(settings.outputs.grouping)},
        {"initialKey", to_string(settings.outputs.initial_key)},
        {"filename", to_string(settings.outputs.filename)}}},
      {"delimiter", settings.delimiter},
      {"notation", to_string(settings.notation)},
      {"customCodes", settings.custom_codes},
      {"libraryPaths",
       {{"itunes", settings.itunes_library_path},
        {"traktor", settings.traktor_library_path},
        {"serato", settings.serato_library_path}}},
  };
}

Settings settings_from_json(const nlohmann::json& value) {
  Settings settings;
  if (!value.is_object()) return settings;
  settings.schema_version = value.value("schemaVersion", 1U);
  settings.parallel = value.value("parallel", true);
  settings.max_duration_minutes = value.value("maxDurationMinutes", 60U);
  settings.skip_existing = value.value("skipExisting", false);
  settings.automatic_writes = value.value("automaticWrites", false);
  settings.extension_filter_enabled =
      value.value("extensionFilterEnabled", false);
  if (value.contains("extensions") && value["extensions"].is_array()) {
    settings.extensions = value["extensions"].get<std::vector<std::string>>();
  }
  if (value.contains("outputs") && value["outputs"].is_object()) {
    settings.outputs = outputs_from_json(value["outputs"]);
  }
  settings.delimiter = value.value("delimiter", " - ");
  settings.notation = notation_mode_from_string(value.value("notation", "standard"));
  if (value.contains("customCodes") && value["customCodes"].is_array()) {
    const auto codes = value["customCodes"].get<std::vector<std::string>>();
    std::copy_n(codes.begin(), std::min(codes.size(), settings.custom_codes.size()),
                settings.custom_codes.begin());
  }
  if (value.contains("libraryPaths") && value["libraryPaths"].is_object()) {
    const auto& paths = value["libraryPaths"];
    settings.itunes_library_path = paths.value("itunes", "");
    settings.traktor_library_path = paths.value("traktor", "");
    settings.serato_library_path = paths.value("serato", "");
  }
  if (settings.max_duration_minutes == 0) settings.max_duration_minutes = 60;
  return settings;
}

const std::array<std::string, 25>& standard_key_codes() {
  return kStandardCodes;
}

std::string key_code(int key, const Settings& settings) {
  if (key < 0 || static_cast<std::size_t>(key) >= kStandardCodes.size()) return "";
  const auto& standard = kStandardCodes[static_cast<std::size_t>(key)];
  const auto& dj = kDjCodes[static_cast<std::size_t>(key)];
  const auto& custom = settings.custom_codes[static_cast<std::size_t>(key)];
  if (settings.notation == NotationMode::standard) return standard;
  if (settings.notation == NotationMode::dj_combined) {
    return dj.empty() ? standard : dj + settings.delimiter + standard;
  }
  if (custom.empty()) return standard;
  if (settings.notation == NotationMode::custom) return custom;
  return custom + " " + standard;
}

std::vector<std::string> all_key_codes(const Settings& settings) {
  std::vector<std::string> codes;
  codes.reserve(kStandardCodes.size());
  for (std::size_t key = 0; key < kStandardCodes.size(); ++key) {
    codes.push_back(key_code(static_cast<int>(key), settings));
  }
  return codes;
}

}  // namespace keyfinder::domain
