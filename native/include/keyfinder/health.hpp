#pragma once

#include <cstdint>
#include <string>

namespace keyfinder::domain {

inline constexpr std::uint32_t kProtocolVersion = 1;

struct Health {
  std::string service;
  std::string engine_version;
  std::uint32_t protocol_version;
};

[[nodiscard]] Health health();

}  // namespace keyfinder::domain
