#pragma once

#include <cstddef>
#include <filesystem>
#include <vector>

namespace keyfinder::domain {

// Produces a normalized full-track peak envelope suitable for compact UI
// rendering. The returned vector always contains `points` values in [0, 1].
[[nodiscard]] std::vector<float> generate_waveform(
    const std::filesystem::path& path, std::size_t points);

}  // namespace keyfinder::domain
