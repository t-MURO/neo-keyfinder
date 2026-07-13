#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace keyfinder::domain {

enum class OutputMode { none, prepend, append, overwrite };
enum class NotationMode { standard, custom, combined, dj_combined };

struct OutputSettings {
  OutputMode title{OutputMode::none};
  OutputMode artist{OutputMode::none};
  OutputMode album{OutputMode::none};
  OutputMode comment{OutputMode::prepend};
  OutputMode grouping{OutputMode::none};
  OutputMode initial_key{OutputMode::none};
  OutputMode filename{OutputMode::none};
};

struct Settings {
  std::uint32_t schema_version{1};
  bool parallel{true};
  std::uint32_t max_duration_minutes{60};
  bool skip_existing{false};
  bool automatic_writes{false};
  bool extension_filter_enabled{false};
  std::vector<std::string> extensions{
      "mp3", "m4a", "mp4", "wma", "flac", "aif", "aiff", "wav"};
  OutputSettings outputs{};
  std::string delimiter{" - "};
  NotationMode notation{NotationMode::standard};
  std::array<std::string, 25> custom_codes{};
  std::string itunes_library_path;
  std::string traktor_library_path;
  std::string serato_library_path;
};

[[nodiscard]] std::string to_string(OutputMode mode);
[[nodiscard]] OutputMode output_mode_from_string(const std::string& value);
[[nodiscard]] std::string to_string(NotationMode mode);
[[nodiscard]] NotationMode notation_mode_from_string(const std::string& value);
[[nodiscard]] nlohmann::json to_json(const Settings& settings);
[[nodiscard]] Settings settings_from_json(const nlohmann::json& value);
[[nodiscard]] const std::array<std::string, 25>& standard_key_codes();
[[nodiscard]] std::string key_code(int key, const Settings& settings);
[[nodiscard]] std::vector<std::string> all_key_codes(const Settings& settings);

}  // namespace keyfinder::domain
