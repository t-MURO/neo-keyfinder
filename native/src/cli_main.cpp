#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

#include "keyfinder/analyzer.hpp"
#include "keyfinder/metadata.hpp"
#include "keyfinder/model.hpp"
#include "keyfinder/settings.hpp"
#include "keyfinder/writer.hpp"

namespace {

constexpr int kSuccess = 0;
constexpr int kAnalysisError = 1;
constexpr int kWriteError = 2;

void print_usage(std::ostream& output) {
  output << "Usage: keyfinder -f <path> [-w]\n"
            "       keyfinder --file <path> [--write] [--max-duration <minutes>]\n\n"
            "Options:\n"
            "  -f, --file <path>          Analyze one audio file\n"
            "  -w, --write                Prepend the detected key to its comment tag\n"
            "      --max-duration <min>   Reject longer tracks (default: 60)\n"
            "  -h, --help                 Show this help\n"
            "  -V, --version              Show the engine version\n";
}

struct Options {
  std::filesystem::path file;
  bool write{false};
  unsigned int max_duration{60};
  bool help{false};
  bool version{false};
};

Options parse_options(int argc, char* argv[]) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "-h" || argument == "--help") {
      options.help = true;
    } else if (argument == "-V" || argument == "--version") {
      options.version = true;
    } else if (argument == "-w" || argument == "--write") {
      options.write = true;
    } else if (argument == "-f" || argument == "--file") {
      if (++index >= argc) throw std::invalid_argument(argument + " requires a path");
      options.file = keyfinder::domain::path_from_utf8(argv[index]);
    } else if (argument == "--max-duration") {
      if (++index >= argc) throw std::invalid_argument("--max-duration requires minutes");
      try {
        const auto value = std::stoul(argv[index]);
        if (value == 0 || value > 1440) throw std::out_of_range("duration");
        options.max_duration = static_cast<unsigned int>(value);
      } catch (const std::exception&) {
        throw std::invalid_argument("--max-duration must be between 1 and 1440");
      }
    } else {
      throw std::invalid_argument("Unknown option: " + argument);
    }
  }
  return options;
}

}  // namespace

int main(int argc, char* argv[]) {
  std::ios::sync_with_stdio(false);
  Options options;
  try {
    options = parse_options(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << "keyfinder: " << error.what() << '\n';
    print_usage(std::cerr);
    return kAnalysisError;
  }

  if (options.help) {
    print_usage(std::cout);
    return kSuccess;
  }
  if (options.version) {
    std::cout << "keyfinder " << NKF_ENGINE_VERSION << '\n';
    return kSuccess;
  }
  if (options.file.empty()) {
    std::cerr << "keyfinder: -f/--file is required\n";
    print_usage(std::cerr);
    return kAnalysisError;
  }

  try {
    auto path = std::filesystem::weakly_canonical(options.file);
    keyfinder::domain::Settings settings;
    settings.max_duration_minutes = options.max_duration;
    auto track = keyfinder::domain::Track{
        .id = keyfinder::domain::stable_track_id(path),
        .path = path,
        .filename = keyfinder::domain::path_to_utf8(path.filename()),
    };
    keyfinder::domain::read_metadata(track);
    const auto analysis = keyfinder::domain::analyze_file(
        path, options.max_duration, false, [] { return false; }, [](double) {});
    track.detected_key = analysis.key;
    track.detected_code = keyfinder::domain::key_code(analysis.key, settings);
    track.status = keyfinder::domain::TrackStatus::completed;
    std::cout << track.detected_code << '\n';

    if (options.write) {
      const auto written = keyfinder::domain::write_analysis_results(std::move(track), settings);
      if (written.error && written.error->stage == "write") {
        std::cerr << "keyfinder: " << written.error->message << '\n';
        return kWriteError;
      }
    }
    return kSuccess;
  } catch (const std::exception& error) {
    std::cerr << "keyfinder: " << error.what() << '\n';
    return kAnalysisError;
  }
}
