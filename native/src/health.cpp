#include "keyfinder/health.hpp"

namespace keyfinder::domain {

Health health() {
  return Health{
      .service = "keyfinder-native",
      .engine_version = NKF_ENGINE_VERSION,
      .protocol_version = kProtocolVersion,
  };
}

}  // namespace keyfinder::domain
