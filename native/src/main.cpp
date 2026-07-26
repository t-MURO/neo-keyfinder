#include <iostream>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "keyfinder/engine.hpp"
#include "keyfinder/protocol.hpp"

int main() {
  std::ios::sync_with_stdio(false);

  std::mutex output_mutex;
  const auto write_output = [&](const nlohmann::json& message) {
    std::lock_guard lock(output_mutex);
    std::cout << message.dump() << '\n' << std::flush;
  };
  std::mutex event_mutex;
  bool request_in_flight = false;
  std::vector<nlohmann::json> deferred_events;
  const auto emit_event = [&](const nlohmann::json& message) {
    {
      std::lock_guard lock(event_mutex);
      if (request_in_flight) {
        deferred_events.push_back(message);
        return;
      }
    }
    write_output(message);
  };
  const auto finish_request = [&](const nlohmann::json& response) {
    write_output(response);
    std::vector<nlohmann::json> events;
    {
      std::lock_guard lock(event_mutex);
      request_in_flight = false;
      events = std::move(deferred_events);
      deferred_events.clear();
    }
    for (const auto& event : events) write_output(event);
  };
  keyfinder::domain::Engine engine(emit_event);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }
    {
      std::lock_guard lock(event_mutex);
      request_in_flight = true;
    }
    std::string request_id = "unknown";
    try {
      const auto request = keyfinder::protocol::parse_request(line);
      request_id = request.request_id;
      finish_request(engine.dispatch(request));
    } catch (const keyfinder::protocol::ProtocolError& error) {
      finish_request(keyfinder::protocol::error_envelope(
          error.request_id(), error.code(), error.what()));
    } catch (const std::exception& error) {
      finish_request(keyfinder::protocol::error_envelope(
          request_id, "INTERNAL_ERROR", error.what()));
    }
  }

  return 0;
}
