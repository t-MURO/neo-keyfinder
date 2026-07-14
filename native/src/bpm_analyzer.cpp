#include "keyfinder/bpm_analyzer.hpp"

#include <cmath>
#include <memory>
#include <mutex>
#include <vector>

#if NKF_HAS_ESSENTIA
#include <essentia/algorithmfactory.h>
#include <essentia/essentia.h>
#endif

namespace keyfinder::domain {

bool bpm_detection_available() {
#if NKF_HAS_ESSENTIA
  return true;
#else
  return false;
#endif
}

std::optional<double> detect_bpm(const std::vector<float>& mono_samples) {
#if NKF_HAS_ESSENTIA
  if (mono_samples.size() < 44100U * 8U) return std::nullopt;

  try {
    static std::once_flag initialized;
    std::call_once(initialized, [] { essentia::init(); });

    using essentia::Real;
    using essentia::standard::Algorithm;
    using essentia::standard::AlgorithmFactory;

    std::unique_ptr<Algorithm> rhythm(AlgorithmFactory::create(
        "RhythmExtractor2013", "method", "degara", "minTempo", 40,
        "maxTempo", 208));
    Real bpm = 0.0F;
    Real confidence = 0.0F;
    std::vector<Real> ticks;
    std::vector<Real> estimates;
    std::vector<Real> intervals;
    rhythm->input("signal").set(mono_samples);
    rhythm->output("bpm").set(bpm);
    rhythm->output("ticks").set(ticks);
    rhythm->output("confidence").set(confidence);
    rhythm->output("estimates").set(estimates);
    rhythm->output("bpmIntervals").set(intervals);
    rhythm->compute();

    if (!std::isfinite(bpm) || bpm <= 0.0F) return std::nullopt;
    return std::round(static_cast<double>(bpm) * 10.0) / 10.0;
  } catch (...) {
    // BPM is an additional descriptor. A rhythm failure must not discard a
    // successfully detected musical key.
    return std::nullopt;
  }
#else
  (void)mono_samples;
  return std::nullopt;
#endif
}

}  // namespace keyfinder::domain
