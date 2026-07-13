#include "keyfinder/engine.hpp"

#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include "keyfinder/file_scanner.hpp"
#include "keyfinder/health.hpp"
#include "keyfinder/settings.hpp"
#include "keyfinder/writer.hpp"

namespace keyfinder::domain {
namespace {

void require_array(const nlohmann::json& params, const char* member,
                   const std::string& request_id) {
  if (!params.contains(member) || !params[member].is_array()) {
    throw protocol::ProtocolError(request_id, "INVALID_PARAMS",
                                  std::string(member) + " must be an array");
  }
}

}  // namespace

Engine::Engine(EventSink sink) : jobs_(std::move(sink)) {}

nlohmann::json Engine::dispatch(const protocol::Request& request) {
  if (request.version != kProtocolVersion) {
    throw protocol::ProtocolError(request.request_id, "UNSUPPORTED_VERSION",
                                  "Unsupported protocol version");
  }
  if (request.method == "health") return protocol::dispatch(request);

  if (request.method == "expandFiles") {
    require_array(request.params, "paths", request.request_id);
    std::vector<std::filesystem::path> paths;
    for (const auto& value : request.params["paths"]) {
      if (!value.is_string()) {
        throw protocol::ProtocolError(request.request_id, "INVALID_PARAMS",
                                      "Every path must be a string");
      }
      paths.push_back(path_from_utf8(value.get<std::string>()));
    }
    const auto settings = settings_from_json(request.params.value("settings", nlohmann::json::object()));
    const auto scan = scan_paths(paths, settings);
    nlohmann::json tracks = nlohmann::json::array();
    for (const auto& track : scan.tracks) tracks.push_back(to_json(track));
    nlohmann::json warnings = nlohmann::json::array();
    for (const auto& warning : scan.warnings) {
      warnings.push_back({{"path", warning.path},
                          {"code", warning.code},
                          {"message", warning.message}});
    }
    return protocol::success_envelope(
        request.request_id, {{"tracks", tracks}, {"warnings", warnings}});
  }

  if (request.method == "startAnalysis") {
    require_array(request.params, "tracks", request.request_id);
    std::vector<Track> tracks;
    for (const auto& value : request.params["tracks"]) {
      tracks.push_back(track_from_json(value));
    }
    const auto settings = settings_from_json(request.params.value("settings", nlohmann::json::object()));
    const auto job_id = jobs_.start(std::move(tracks), settings);
    return protocol::success_envelope(request.request_id, {{"jobId", job_id}});
  }

  if (request.method == "cancelJob") {
    const auto job_id = request.params.value("jobId", "");
    if (job_id.empty()) {
      throw protocol::ProtocolError(request.request_id, "INVALID_PARAMS",
                                    "jobId must be a non-empty string");
    }
    return protocol::success_envelope(
        request.request_id, {{"cancelled", jobs_.cancel(job_id)}});
  }

  if (request.method == "writeTracks") {
    require_array(request.params, "tracks", request.request_id);
    const auto settings = settings_from_json(request.params.value("settings", nlohmann::json::object()));
    nlohmann::json tracks = nlohmann::json::array();
    for (const auto& value : request.params["tracks"]) {
      tracks.push_back(to_json(write_detected_key(track_from_json(value), settings)));
    }
    return protocol::success_envelope(request.request_id, {{"tracks", tracks}});
  }

  throw protocol::ProtocolError(request.request_id, "UNKNOWN_METHOD",
                                "Unknown protocol method: " + request.method);
}

}  // namespace keyfinder::domain
