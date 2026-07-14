#include "keyfinder/waveform.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/mathematics.h>
#include <libswresample/swresample.h>
}

#include "keyfinder/model.hpp"

namespace keyfinder::domain {
namespace {

std::string ffmpeg_error(int code) {
  std::array<char, AV_ERROR_MAX_STRING_SIZE> buffer{};
  av_strerror(code, buffer.data(), buffer.size());
  return buffer.data();
}

void require_ffmpeg(int result, const std::string& action) {
  if (result < 0) throw std::runtime_error(action + ": " + ffmpeg_error(result));
}

struct FormatDeleter {
  void operator()(AVFormatContext* context) const {
    if (context != nullptr) avformat_close_input(&context);
  }
};
struct CodecDeleter {
  void operator()(AVCodecContext* context) const { avcodec_free_context(&context); }
};
struct FrameDeleter {
  void operator()(AVFrame* frame) const { av_frame_free(&frame); }
};
struct PacketDeleter {
  void operator()(AVPacket* packet) const { av_packet_free(&packet); }
};
struct SwrDeleter {
  void operator()(SwrContext* context) const { swr_free(&context); }
};

std::vector<float> resize_envelope(const std::vector<float>& source,
                                   std::size_t points) {
  std::vector<float> result(points, 0.0F);
  if (source.empty()) return result;

  if (source.size() >= points) {
    for (std::size_t point = 0; point < points; ++point) {
      const auto begin = point * source.size() / points;
      const auto end = std::max(begin + 1, (point + 1) * source.size() / points);
      result[point] = *std::max_element(source.begin() + static_cast<std::ptrdiff_t>(begin),
                                       source.begin() + static_cast<std::ptrdiff_t>(end));
    }
  } else if (source.size() == 1) {
    std::fill(result.begin(), result.end(), source.front());
  } else {
    for (std::size_t point = 0; point < points; ++point) {
      const double position = static_cast<double>(point) *
                              static_cast<double>(source.size() - 1) /
                              static_cast<double>(points - 1);
      const auto left = static_cast<std::size_t>(position);
      const auto right = std::min(left + 1, source.size() - 1);
      const auto fraction = static_cast<float>(position - static_cast<double>(left));
      result[point] = source[left] * (1.0F - fraction) + source[right] * fraction;
    }
  }

  const float maximum = *std::max_element(result.begin(), result.end());
  if (maximum <= 0.00001F) return result;
  for (auto& peak : result) {
    peak = std::pow(std::clamp(peak / maximum, 0.0F, 1.0F), 0.6F);
  }
  return result;
}

}  // namespace

std::vector<float> generate_waveform(const std::filesystem::path& path,
                                     std::size_t points) {
  if (points < 32 || points > 1024) {
    throw std::invalid_argument("Waveform point count must be between 32 and 1024");
  }

  AVFormatContext* raw_format = nullptr;
  const auto encoded_path = path_to_utf8(path);
  require_ffmpeg(avformat_open_input(&raw_format, encoded_path.c_str(), nullptr, nullptr),
                 "Could not open audio file");
  std::unique_ptr<AVFormatContext, FormatDeleter> format(raw_format);
  require_ffmpeg(avformat_find_stream_info(format.get(), nullptr),
                 "Could not read audio stream information");

  const int stream_index = av_find_best_stream(
      format.get(), AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  require_ffmpeg(stream_index, "Could not find an audio stream");
  AVStream* stream = format->streams[stream_index];
  const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (codec == nullptr) throw std::runtime_error("The audio codec is unsupported");

  std::unique_ptr<AVCodecContext, CodecDeleter> codec_context(avcodec_alloc_context3(codec));
  if (!codec_context) throw std::runtime_error("Could not allocate an audio decoder");
  require_ffmpeg(avcodec_parameters_to_context(codec_context.get(), stream->codecpar),
                 "Could not configure the audio decoder");
  require_ffmpeg(avcodec_open2(codec_context.get(), codec, nullptr),
                 "Could not open the audio decoder");
  if (codec_context->ch_layout.nb_channels <= 0 || codec_context->sample_rate <= 0) {
    throw std::runtime_error("The audio stream has invalid channel or sample-rate data");
  }

  constexpr int kWaveformSampleRate = 8000;
  constexpr int kWaveformChannels = 2;
  constexpr std::size_t kFramesPerPeak = 256;
  AVChannelLayout waveform_layout = AV_CHANNEL_LAYOUT_STEREO;
  SwrContext* raw_resampler = nullptr;
  require_ffmpeg(swr_alloc_set_opts2(&raw_resampler, &waveform_layout,
                                     AV_SAMPLE_FMT_S16, kWaveformSampleRate,
                                     &codec_context->ch_layout, codec_context->sample_fmt,
                                     codec_context->sample_rate, 0, nullptr),
                 "Could not create the waveform resampler");
  std::unique_ptr<SwrContext, SwrDeleter> resampler(raw_resampler);
  require_ffmpeg(swr_init(resampler.get()), "Could not initialize the waveform resampler");

  std::unique_ptr<AVPacket, PacketDeleter> packet(av_packet_alloc());
  std::unique_ptr<AVFrame, FrameDeleter> frame(av_frame_alloc());
  if (!packet || !frame) throw std::runtime_error("Could not allocate decode buffers");

  std::vector<float> block_peaks;
  float current_peak = 0.0F;
  std::size_t current_frames = 0;
  std::uint64_t decoded_frames = 0;

  auto consume_frames = [&]() {
    while (true) {
      const int receive = avcodec_receive_frame(codec_context.get(), frame.get());
      if (receive == AVERROR(EAGAIN) || receive == AVERROR_EOF) return;
      if (receive == AVERROR_INVALIDDATA) {
        av_frame_unref(frame.get());
        return;
      }
      require_ffmpeg(receive, "Could not decode an audio frame");

      const int capacity = av_rescale_rnd(
          swr_get_delay(resampler.get(), codec_context->sample_rate) + frame->nb_samples,
          kWaveformSampleRate, codec_context->sample_rate, AV_ROUND_UP);
      std::vector<std::int16_t> samples(
          static_cast<std::size_t>(capacity) * kWaveformChannels);
      std::array<std::uint8_t*, 1> output{
          reinterpret_cast<std::uint8_t*>(samples.data())};
      const int converted = swr_convert(resampler.get(), output.data(), capacity,
                                        frame->extended_data, frame->nb_samples);
      require_ffmpeg(converted, "Could not normalize decoded audio");
      decoded_frames += static_cast<std::uint64_t>(converted);

      for (int sample = 0; sample < converted; ++sample) {
        const auto offset = static_cast<std::size_t>(sample) * kWaveformChannels;
        const int left = std::abs(static_cast<int>(samples[offset]));
        const int right = std::abs(static_cast<int>(samples[offset + 1]));
        current_peak = std::max(
            current_peak, static_cast<float>(std::max(left, right)) / 32768.0F);
        if (++current_frames == kFramesPerPeak) {
          block_peaks.push_back(current_peak);
          current_peak = 0.0F;
          current_frames = 0;
        }
      }
      av_frame_unref(frame.get());
    }
  };

  auto submit_packet = [&](const AVPacket* input, const std::string& action) {
    while (true) {
      const int submitted = avcodec_send_packet(codec_context.get(), input);
      if (submitted >= 0 || submitted == AVERROR_EOF) return true;
      if (submitted == AVERROR(EAGAIN)) {
        consume_frames();
        continue;
      }
      if (submitted == AVERROR_INVALIDDATA) return false;
      require_ffmpeg(submitted, action);
    }
  };

  int consecutive_read_errors = 0;
  while (true) {
    const int read = av_read_frame(format.get(), packet.get());
    if (read == AVERROR_EOF) break;
    if (read == AVERROR_INVALIDDATA && ++consecutive_read_errors <= 32) {
      av_packet_unref(packet.get());
      continue;
    }
    require_ffmpeg(read, "Could not read an audio packet");
    consecutive_read_errors = 0;
    if (packet->stream_index == stream_index &&
        submit_packet(packet.get(), "Could not submit an audio packet")) {
      consume_frames();
    }
    av_packet_unref(packet.get());
  }
  if (submit_packet(nullptr, "Could not flush the audio decoder")) consume_frames();
  if (current_frames > 0) block_peaks.push_back(current_peak);
  if (decoded_frames == 0) throw std::runtime_error("No decodable audio frames were found");
  return resize_envelope(block_peaks, points);
}

}  // namespace keyfinder::domain
