#include "keyfinder/protocol.hpp"

#include <utility>

#include "keyfinder/health.hpp"

namespace keyfinder::protocol {
namespace {

constexpr const char* kUnknownRequestId = "unknown";

std::string request_id_from(const nlohmann::json& document) {
  if (document.is_object() && document.contains("requestId") &&
      document["requestId"].is_string()) {
    return document["requestId"].get<std::string>();
  }
  return kUnknownRequestId;
}

void require_object_member(const nlohmann::json& document,
                           const char* member,
                           const std::string& request_id) {
  if (!document.contains(member)) {
    throw ProtocolError(request_id, "INVALID_REQUEST",
                        std::string("Missing required member: ") + member);
  }
}

}  // namespace

ProtocolError::ProtocolError(std::string request_id,
                             std::string code,
                             std::string message)
    : std::runtime_error(std::move(message)),
      request_id_(std::move(request_id)),
      code_(std::move(code)) {}

const std::string& ProtocolError::request_id() const noexcept {
  return request_id_;
}

const std::string& ProtocolError::code() const noexcept {
  return code_;
}

Request parse_request(const std::string& line) {
  nlohmann::json document;
  try {
    document = nlohmann::json::parse(line);
  } catch (const nlohmann::json::parse_error&) {
    throw ProtocolError(kUnknownRequestId, "INVALID_JSON",
                        "Request is not valid JSON");
  }

  const auto request_id = request_id_from(document);
  if (!document.is_object()) {
    throw ProtocolError(request_id, "INVALID_REQUEST",
                        "Request must be a JSON object");
  }

  require_object_member(document, "version", request_id);
  require_object_member(document, "requestId", request_id);
  require_object_member(document, "method", request_id);
  require_object_member(document, "params", request_id);

  if (!document["version"].is_number_unsigned() ||
      !document["requestId"].is_string() ||
      document["requestId"].get_ref<const std::string&>().empty() ||
      !document["method"].is_string() ||
      document["method"].get_ref<const std::string&>().empty() ||
      !document["params"].is_object()) {
    throw ProtocolError(request_id, "INVALID_REQUEST",
                        "Request members have invalid types or values");
  }

  return Request{
      .version = document["version"].get<std::uint32_t>(),
      .request_id = document["requestId"].get<std::string>(),
      .method = document["method"].get<std::string>(),
      .params = document["params"],
  };
}

nlohmann::json success_envelope(const std::string& request_id,
                                const nlohmann::json& result) {
  return {
      {"version", domain::kProtocolVersion},
      {"requestId", request_id},
      {"result", result},
  };
}

nlohmann::json error_envelope(const std::string& request_id,
                              const std::string& code,
                              const std::string& message) {
  return {
      {"version", domain::kProtocolVersion},
      {"requestId", request_id},
      {"error", {{"code", code}, {"message", message}}},
  };
}

nlohmann::json dispatch(const Request& request) {
  if (request.version != domain::kProtocolVersion) {
    throw ProtocolError(request.request_id, "UNSUPPORTED_VERSION",
                        "Unsupported protocol version");
  }

  if (request.method != "health") {
    throw ProtocolError(request.request_id, "UNKNOWN_METHOD",
                        "Unknown protocol method: " + request.method);
  }

  if (!request.params.empty()) {
    throw ProtocolError(request.request_id, "INVALID_PARAMS",
                        "The health method does not accept parameters");
  }

  const auto status = domain::health();
  return success_envelope(
      request.request_id,
      {
          {"service", status.service},
          {"engineVersion", status.engine_version},
          {"protocolVersion", status.protocol_version},
      });
}

std::string process_line(const std::string& line) {
  try {
    return dispatch(parse_request(line)).dump();
  } catch (const ProtocolError& error) {
    return error_envelope(error.request_id(), error.code(), error.what()).dump();
  } catch (const std::exception&) {
    return error_envelope(kUnknownRequestId, "INTERNAL_ERROR",
                          "The native engine could not process the request")
        .dump();
  }
}

}  // namespace keyfinder::protocol
