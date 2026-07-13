#include <cstdlib>
#include <iostream>
#include <string>

#include "keyfinder/health.hpp"

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

}  // namespace

int main() {
  const auto health = keyfinder::domain::health();
  expect(health.service == "keyfinder-native", "service name is stable");
  expect(health.engine_version == "0.1.0", "engine version is compiled in");
  expect(health.protocol_version == 1, "protocol version starts at one");
  return 0;
}
