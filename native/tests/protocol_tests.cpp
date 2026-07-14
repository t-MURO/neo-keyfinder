#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "keyfinder/engine.hpp"
#include "keyfinder/metadata.hpp"
#include "keyfinder/model.hpp"
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

  std::mutex events_mutex;
  std::vector<nlohmann::json> events;
  {
    keyfinder::domain::Engine engine([&](const nlohmann::json& event) {
      std::lock_guard lock(events_mutex);
      events.push_back(event);
    });
    const auto start = keyfinder::protocol::parse_request(
        R"({"version":1,"requestId":"window-job","method":"startAnalysis","params":{"owner":"batch-7","tracks":[{"id":"missing","path":"/definitely/missing.wav","filename":"missing.wav","status":"ready"}],"settings":{}}})");
    const auto response = engine.dispatch(start);
    expect(response["result"]["jobId"].is_string(),
           "analysis starts with an owning window");
  }
  expect(!events.empty(), "analysis emits a terminal event");
  for (const auto& event : events) {
    expect(event["owner"] == "batch-7",
           "every asynchronous event preserves its owning window");
  }

  std::mutex ordered_mutex;
  std::condition_variable ordered_condition;
  std::vector<std::string> analyzing_order;
  bool ordered_finished = false;
  {
    keyfinder::domain::Engine engine([&](const nlohmann::json& event) {
      std::lock_guard lock(ordered_mutex);
      if (event.value("event", "") == "trackUpdated" &&
          event["payload"]["track"].value("status", "") == "analyzing") {
        analyzing_order.push_back(event["payload"]["track"].value("id", ""));
      }
      if (event.value("event", "") == "jobFinished") {
        ordered_finished = true;
        ordered_condition.notify_all();
      }
    });
    const auto start = keyfinder::protocol::parse_request(
        R"({"version":1,"requestId":"ordered-job","method":"startAnalysis","params":{"owner":"batch-8","tracks":[{"id":"first","path":"missing-first.wav","filename":"missing-first.wav","status":"ready"},{"id":"second","path":"missing-second.wav","filename":"missing-second.wav","status":"ready"},{"id":"third","path":"missing-third.wav","filename":"missing-third.wav","status":"ready"}],"settings":{"parallel":true}}})");
    (void)engine.dispatch(start);
    std::unique_lock lock(ordered_mutex);
    expect(ordered_condition.wait_for(lock, std::chrono::seconds(5),
                                      [&] { return ordered_finished; }),
           "parallel analysis finishes within the test timeout");
    expect(analyzing_order == std::vector<std::string>{"first", "second", "third"},
           "parallel analysis starts tracks in request order");
  }

  const auto suffix = std::to_string(
      std::chrono::steady_clock::now().time_since_epoch().count());
  const auto temporary =
      std::filesystem::temp_directory_path() / ("neo-keyfinder-write-guard-" + suffix);
  std::filesystem::create_directories(temporary);
  const auto guarded_file = temporary / "guarded.wav";
  std::filesystem::copy_file(
      std::filesystem::path(NKF_LEGACY_FIXTURES_DIR) / "readTags/wav.wav",
      guarded_file);
  keyfinder::domain::Track guarded_track;
  guarded_track.id = "guarded";
  guarded_track.path = std::filesystem::canonical(guarded_file);
  guarded_track.filename = guarded_file.filename().string();
  keyfinder::domain::read_metadata(guarded_track);
  const auto original_comment = guarded_track.comment;

  std::mutex guarded_mutex;
  std::condition_variable guarded_condition;
  bool guarded_finished = false;
  {
    keyfinder::domain::Engine engine([&](const nlohmann::json& event) {
      std::lock_guard lock(guarded_mutex);
      if (event.value("event", "") == "jobFinished") {
        guarded_finished = true;
        guarded_condition.notify_all();
      }
    });
    const auto response = engine.dispatch(keyfinder::protocol::Request{
        1,
        "guarded-job",
        "startAnalysis",
        {{"owner", "batch-guarded"},
         {"tracks", nlohmann::json::array({keyfinder::domain::to_json(guarded_track)})},
         {"settings",
          {{"automaticWrites", true},
           {"outputs", {{"comment", "prepend"}}}}}}});
    expect(response["result"]["jobId"].is_string(),
           "guarded analysis starts");
    std::unique_lock lock(guarded_mutex);
    expect(guarded_condition.wait_for(lock, std::chrono::seconds(5),
                                      [&] { return guarded_finished; }),
           "guarded analysis finishes within the test timeout");
  }
  auto reread = guarded_track;
  keyfinder::domain::read_metadata(reread);
  expect(reread.comment == original_comment,
         "analysis cannot write comments without explicit authorization");
  std::filesystem::remove_all(temporary);

  return 0;
}
