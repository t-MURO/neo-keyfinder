#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "keyfinder/analyzer.hpp"
#include "keyfinder/bpm_analyzer.hpp"
#include "keyfinder/waveform.hpp"

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

template <typename Value>
void write_little_endian(std::ofstream& stream, Value value) {
  for (std::size_t byte = 0; byte < sizeof(Value); ++byte) {
    stream.put(static_cast<char>((value >> (byte * 8)) & 0xff));
  }
}

void write_wave(const std::filesystem::path& path,
                const std::vector<double>& frequencies) {
  constexpr std::uint32_t sample_rate = 44100;
  constexpr std::uint16_t channels = 1;
  constexpr std::uint16_t bits = 16;
  constexpr std::uint32_t seconds = 18;
  constexpr std::uint32_t sample_count = sample_rate * seconds;
  constexpr std::uint32_t data_size = sample_count * channels * (bits / 8);
  std::ofstream output(path, std::ios::binary);
  output.write("RIFF", 4);
  write_little_endian(output, 36U + data_size);
  output.write("WAVEfmt ", 8);
  write_little_endian(output, 16U);
  write_little_endian(output, std::uint16_t{1});
  write_little_endian(output, channels);
  write_little_endian(output, sample_rate);
  write_little_endian(output, sample_rate * channels * (bits / 8));
  write_little_endian(output, std::uint16_t{channels * (bits / 8)});
  write_little_endian(output, bits);
  output.write("data", 4);
  write_little_endian(output, data_size);
  constexpr double pi = 3.14159265358979323846;
  for (std::uint32_t sample = 0; sample < sample_count; ++sample) {
    double value = 0.0;
    for (const auto frequency : frequencies) {
      value += std::sin(2.0 * pi * frequency * sample / sample_rate);
    }
    if (!frequencies.empty()) value /= static_cast<double>(frequencies.size());
    const auto encoded = static_cast<std::int16_t>(value * 22000.0);
    write_little_endian(output, static_cast<std::uint16_t>(encoded));
  }
}

void write_click_track(const std::filesystem::path& path, double bpm) {
  constexpr std::uint32_t sample_rate = 44100;
  constexpr std::uint16_t channels = 1;
  constexpr std::uint16_t bits = 16;
  constexpr std::uint32_t seconds = 30;
  constexpr std::uint32_t sample_count = sample_rate * seconds;
  constexpr std::uint32_t data_size = sample_count * channels * (bits / 8);
  std::ofstream output(path, std::ios::binary);
  output.write("RIFF", 4);
  write_little_endian(output, 36U + data_size);
  output.write("WAVEfmt ", 8);
  write_little_endian(output, 16U);
  write_little_endian(output, std::uint16_t{1});
  write_little_endian(output, channels);
  write_little_endian(output, sample_rate);
  write_little_endian(output, sample_rate * channels * (bits / 8));
  write_little_endian(output, std::uint16_t{channels * (bits / 8)});
  write_little_endian(output, bits);
  output.write("data", 4);
  write_little_endian(output, data_size);
  constexpr double pi = 3.14159265358979323846;
  const auto beat_samples =
      static_cast<std::uint32_t>(sample_rate * 60.0 / bpm);
  for (std::uint32_t sample = 0; sample < sample_count; ++sample) {
    const auto beat_offset = sample % beat_samples;
    double value = 0.0;
    if (beat_offset < sample_rate / 10) {
      value = std::sin(2.0 * pi * 90.0 * beat_offset / sample_rate) *
              std::exp(-static_cast<double>(beat_offset) /
                       (sample_rate * 0.018));
    }
    const auto encoded = static_cast<std::int16_t>(value * 28000.0);
    write_little_endian(output, static_cast<std::uint16_t>(encoded));
  }
}

void expect_failure(const std::filesystem::path& path, unsigned maximum,
                    const std::string& expected) {
  try {
    (void)keyfinder::domain::analyze_file(path, maximum, true, [] { return false; },
                                           [](double) {});
    expect(false, expected + " throws");
  } catch (const std::exception& error) {
    expect(std::string(error.what()).find(expected) != std::string::npos,
           expected + " has a useful error, got: " + error.what());
  }
}

}  // namespace

int main() {
  const auto fixtures = std::filesystem::path(NKF_LEGACY_FIXTURES_DIR);
  expect_failure(fixtures / "missing.wav", 60, "Could not open audio file");
  expect_failure(fixtures / "notAV.pdf", 60, "Could not open audio file");
  expect_failure(fixtures / "noAudioStream.jpg", 60,
                 "Could not find an audio stream");
  expect_failure(fixtures / "90secondsine.mp3", 1,
                 "Track duration exceeds the configured maximum");

  const auto suffix = std::to_string(
      std::chrono::steady_clock::now().time_since_epoch().count());
  const auto temporary =
      std::filesystem::temp_directory_path() / ("neo-keyfinder-analysis-" + suffix);
  std::filesystem::create_directories(temporary);
  const auto major = temporary / "a-major.wav";
  const auto minor = temporary / "a-minor.wav";
  const auto silent = temporary / "silence.wav";
  const auto click_track = temporary / "120-bpm.wav";
  write_wave(major, {220.0, 277.1826, 329.6276});
  write_wave(minor, {220.0, 261.6256, 329.6276});
  write_wave(silent, {});
  write_click_track(click_track, 120.0);

  const auto analyze = [](const auto& path) {
    return keyfinder::domain::analyze_file(path, 60, true, [] { return false; },
                                            [](double) {});
  };
  expect(analyze(major).key == 0, "synthetic A major golden");
  expect(analyze(minor).key == 1, "synthetic A minor golden");
  expect(analyze(silent).key == 24, "synthetic silence golden");
  const auto waveform = keyfinder::domain::generate_waveform(major, 128);
  expect(waveform.size() == 128, "waveform has the requested resolution");
  expect(*std::max_element(waveform.begin(), waveform.end()) > 0.99F,
         "waveform peaks are normalized");
  const auto silent_waveform = keyfinder::domain::generate_waveform(silent, 64);
  expect(std::all_of(silent_waveform.begin(), silent_waveform.end(),
                     [](float peak) { return peak == 0.0F; }),
         "silent waveform remains flat");
  if (keyfinder::domain::bpm_detection_available()) {
    const auto bpm = analyze(click_track).bpm;
    expect(bpm && std::abs(*bpm - 120.0) <= 1.0,
           "Essentia detects a synthetic 120 BPM pulse");
  }
  const auto key_only = keyfinder::domain::analyze_file(
      click_track, 60, false, [] { return false; }, [](double) {});
  expect(!key_only.bpm, "disabled BPM analysis does not run tempo detection");
  try {
    (void)keyfinder::domain::analyze_file(
        major, 60, true, [] { return true; }, [](double) {});
    expect(false, "cancellation throws");
  } catch (const std::exception& error) {
    expect(std::string(error.what()) == "ANALYSIS_CANCELLED",
           "cancellation has a stable sentinel");
  }
  std::filesystem::remove_all(temporary);
  return 0;
}
