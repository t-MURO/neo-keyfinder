#pragma once

#include <optional>
#include <vector>

namespace keyfinder::domain {

[[nodiscard]] bool bpm_detection_available();
[[nodiscard]] std::optional<double> detect_bpm(
    const std::vector<float>& mono_samples);

}  // namespace keyfinder::domain
