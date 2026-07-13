#pragma once

#include <functional>

#include "keyfinder/model.hpp"
#include "keyfinder/settings.hpp"

namespace keyfinder::domain {

[[nodiscard]] bool outputs_already_satisfied(const Track& track,
                                             const Settings& settings);
[[nodiscard]] Track write_detected_key(
    Track track, const Settings& settings,
    const std::function<bool()>& is_cancelled = {});

}  // namespace keyfinder::domain
