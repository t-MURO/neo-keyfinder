#pragma once

#include <filesystem>
#include <string>
#include <vector>

#include "keyfinder/model.hpp"
#include "keyfinder/settings.hpp"

namespace keyfinder::domain {

struct ScanWarning {
  std::string path;
  std::string code;
  std::string message;
};

struct ScanResult {
  std::vector<Track> tracks;
  std::vector<ScanWarning> warnings;
};

[[nodiscard]] ScanResult scan_paths(
    const std::vector<std::filesystem::path>& inputs,
    const Settings& settings);

}  // namespace keyfinder::domain
