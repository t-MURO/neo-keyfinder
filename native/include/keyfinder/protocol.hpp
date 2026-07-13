#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace keyfinder::protocol {

struct Request {
  std::uint32_t version;
  std::string request_id;
  std::string method;
  nlohmann::json params;
};

class ProtocolError final : public std::runtime_error {
 public:
  ProtocolError(std::string request_id, std::string code, std::string message);

  [[nodiscard]] const std::string& request_id() const noexcept;
  [[nodiscard]] const std::string& code() const noexcept;

 private:
  std::string request_id_;
  std::string code_;
};

[[nodiscard]] Request parse_request(const std::string& line);
[[nodiscard]] nlohmann::json dispatch(const Request& request);
[[nodiscard]] nlohmann::json success_envelope(
    const std::string& request_id,
    const nlohmann::json& result);
[[nodiscard]] nlohmann::json error_envelope(
    const std::string& request_id,
    const std::string& code,
    const std::string& message);
[[nodiscard]] std::string process_line(const std::string& line);

}  // namespace keyfinder::protocol
