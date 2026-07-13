#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

#include "keyfinder/settings.hpp"

namespace keyfinder::domain {

inline constexpr std::size_t kKeyCharacterLimit = 3;
inline constexpr std::size_t kMetadataCharacterLimit = 50;
inline constexpr std::size_t kFilenameCharacterLimit = 256;

[[nodiscard]] std::optional<std::string> apply_output_rule(
    const std::string& new_data,
    const std::string& current_data,
    std::size_t character_limit,
    OutputMode mode,
    const std::string& delimiter,
    const std::vector<std::string>& possible_codes = {});

}  // namespace keyfinder::domain
