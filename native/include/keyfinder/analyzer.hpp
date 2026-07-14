#pragma once

#include <filesystem>
#include <functional>
#include <optional>

namespace keyfinder::domain {

struct AnalysisResult {
  int key;
  std::optional<double> bpm;
};

using CancellationCheck = std::function<bool()>;
using ProgressCallback = std::function<void(double)>;

[[nodiscard]] AnalysisResult analyze_file(
    const std::filesystem::path& path,
    unsigned int max_duration_minutes,
    bool analyze_bpm,
    const CancellationCheck& is_cancelled,
    const ProgressCallback& progress);

}  // namespace keyfinder::domain
