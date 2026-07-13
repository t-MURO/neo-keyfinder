#pragma once

#include <filesystem>
#include <functional>

namespace keyfinder::domain {

struct AnalysisResult {
  int key;
};

using CancellationCheck = std::function<bool()>;
using ProgressCallback = std::function<void(double)>;

[[nodiscard]] AnalysisResult analyze_file(
    const std::filesystem::path& path,
    unsigned int max_duration_minutes,
    const CancellationCheck& is_cancelled,
    const ProgressCallback& progress);

}  // namespace keyfinder::domain
