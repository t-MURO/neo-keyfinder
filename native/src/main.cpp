#include <iostream>
#include <mutex>
#include <string>

#include "keyfinder/engine.hpp"
#include "keyfinder/protocol.hpp"

int main() {
  std::ios::sync_with_stdio(false);

  std::mutex output_mutex;
  const auto write = [&](const nlohmann::json& message) {
    std::lock_guard lock(output_mutex);
    std::cout << message.dump() << '\n' << std::flush;
  };
  keyfinder::domain::Engine engine(write);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }
    try {
      write(engine.dispatch(keyfinder::protocol::parse_request(line)));
    } catch (const keyfinder::protocol::ProtocolError& error) {
      write(keyfinder::protocol::error_envelope(error.request_id(), error.code(),
                                                error.what()));
    } catch (const std::exception&) {
      write(keyfinder::protocol::error_envelope(
          "unknown", "INTERNAL_ERROR",
          "The native engine could not process the request"));
    }
  }

  return 0;
}
