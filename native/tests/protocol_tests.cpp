#include <cstdlib>
#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

#include "keyfinder/protocol.hpp"

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

nlohmann::json process(const std::string& line) {
  return nlohmann::json::parse(keyfinder::protocol::process_line(line));
}

}  // namespace

int main() {
  const auto request = keyfinder::protocol::parse_request(
      R"({"version":1,"requestId":"test-1","method":"health","params":{}})");
  expect(request.version == 1, "request version is parsed");
  expect(request.request_id == "test-1", "request ID is parsed");
  expect(request.method == "health", "method is parsed");

  const auto success = keyfinder::protocol::dispatch(request);
  expect(success["version"] == 1, "response version is serialized");
  expect(success["requestId"] == "test-1", "response correlates request ID");
  expect(success.contains("result"), "success uses result envelope");
  expect(!success.contains("error"), "success never includes error");
  expect(success["result"]["service"] == "keyfinder-native",
         "health result names service");

  const auto malformed = process("not-json");
  expect(malformed["requestId"] == "unknown",
         "invalid JSON has a stable fallback request ID");
  expect(malformed["error"]["code"] == "INVALID_JSON",
         "invalid JSON has a typed error code");

  const auto unknown_method = process(
      R"({"version":1,"requestId":"test-2","method":"analyze","params":{}})");
  expect(unknown_method["requestId"] == "test-2",
         "errors preserve the request ID");
  expect(unknown_method["error"]["code"] == "UNKNOWN_METHOD",
         "unknown methods have a typed error code");
  expect(!unknown_method.contains("result"), "errors never include result");

  const auto wrong_version = process(
      R"({"version":2,"requestId":"test-3","method":"health","params":{}})");
  expect(wrong_version["error"]["code"] == "UNSUPPORTED_VERSION",
         "unsupported versions are rejected");

  const auto invalid_params = process(
      R"({"version":1,"requestId":"test-4","method":"health","params":{"extra":true}})");
  expect(invalid_params["error"]["code"] == "INVALID_PARAMS",
         "health rejects unexpected parameters");

  return 0;
}
