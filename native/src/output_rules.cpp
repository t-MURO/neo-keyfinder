#include "keyfinder/output_rules.hpp"

#include <algorithm>
#include <cctype>

namespace keyfinder::domain {
namespace {

std::string limited(std::string value, std::size_t limit) {
  if (limit == 0) return value;
  std::size_t characters = 0;
  std::size_t byte = 0;
  while (byte < value.size() && characters < limit) {
    const auto lead = static_cast<unsigned char>(value[byte]);
    std::size_t width = 1;
    if ((lead & 0xe0U) == 0xc0U) width = 2;
    if ((lead & 0xf0U) == 0xe0U) width = 3;
    if ((lead & 0xf8U) == 0xf0U) width = 4;
    byte += std::min(width, value.size() - byte);
    ++characters;
  }
  if (byte < value.size()) value.resize(byte);
  return value;
}

bool non_alphanumeric_boundary(const std::string& value,
                               std::optional<std::size_t> position) {
  if (!position || *position >= value.size()) return true;
  const auto byte = static_cast<unsigned char>(value[*position]);
  return std::isalnum(byte) == 0;
}

}  // namespace

std::optional<std::string> apply_output_rule(
    const std::string& new_data,
    const std::string& current_data,
    std::size_t character_limit,
    OutputMode mode,
    const std::string& delimiter,
    const std::vector<std::string>& possible_codes) {
  if (mode == OutputMode::none) return std::nullopt;

  std::vector<std::string> candidates;
  if (new_data.empty()) {
    candidates = possible_codes;
  } else {
    candidates.push_back(new_data);
  }
  if (candidates.empty()) return std::nullopt;

  for (auto& candidate : candidates) {
    candidate = limited(std::move(candidate), character_limit);
    if (mode == OutputMode::overwrite && current_data == candidate) {
      return std::nullopt;
    }
    if (mode == OutputMode::prepend &&
        current_data.compare(0, candidate.size(), candidate) == 0 &&
        non_alphanumeric_boundary(
            current_data,
            candidate.size() < current_data.size()
                ? std::optional<std::size_t>(candidate.size())
                : std::nullopt)) {
      return std::nullopt;
    }
    if (mode == OutputMode::append && current_data.size() >= candidate.size() &&
        current_data.compare(current_data.size() - candidate.size(),
                             candidate.size(), candidate) == 0 &&
        non_alphanumeric_boundary(
            current_data,
            current_data.size() > candidate.size()
                ? std::optional<std::size_t>(current_data.size() - candidate.size() - 1)
                : std::nullopt)) {
      return std::nullopt;
    }
  }

  const auto& candidate = candidates.front();
  if (mode == OutputMode::overwrite) return candidate;
  if (current_data.empty()) return candidate;
  if (mode == OutputMode::prepend) return candidate + delimiter + current_data;
  if (mode == OutputMode::append) return current_data + delimiter + candidate;
  return std::nullopt;
}

}  // namespace keyfinder::domain
