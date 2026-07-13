#pragma once

#include <nlohmann/json.hpp>

#include "keyfinder/job_manager.hpp"
#include "keyfinder/protocol.hpp"

namespace keyfinder::domain {

class Engine {
 public:
  explicit Engine(EventSink sink);
  [[nodiscard]] nlohmann::json dispatch(const protocol::Request& request);

 private:
  JobManager jobs_;
};

}  // namespace keyfinder::domain
