#pragma once

#include <filesystem>
#include <string>

#include "keyfinder/model.hpp"

namespace keyfinder::domain {

struct MutationResult {
  bool changed{false};
  std::string value;
  std::string error;
};

void read_metadata(Track& track);
[[nodiscard]] MutationResult write_metadata_field(
    const std::filesystem::path& path,
    const std::string& field,
    const std::string& value);

}  // namespace keyfinder::domain
