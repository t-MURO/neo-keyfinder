#include "keyfinder/analyzer.hpp"

#include <algorithm>
#include <array>
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

#include <keyfinder/audiodata.h>
#include <keyfinder/keyfinder.h>

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

}  // namespace

AnalysisResult analyze_file(const std::filesystem::path& path,
                            unsigned int max_duration_minutes,
                            const CancellationCheck& is_cancelled,
                            const ProgressCallback& progress) {
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

  if (format->duration > 0) {
    const auto maximum = static_cast<std::int64_t>(max_duration_minutes) * 60 * AV_TIME_BASE;
    if (format->duration > maximum) {
      throw std::runtime_error("Track duration exceeds the configured maximum");
    }
  }

  const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (codec == nullptr) throw std::runtime_error("The audio codec is unsupported");
  std::unique_ptr<AVCodecContext, CodecDeleter> codec_context(avcodec_alloc_context3(codec));
  if (!codec_context) throw std::runtime_error("Could not allocate an audio decoder");
  require_ffmpeg(avcodec_parameters_to_context(codec_context.get(), stream->codecpar),
                 "Could not configure the audio decoder");
  require_ffmpeg(avcodec_open2(codec_context.get(), codec, nullptr),
                 "Could not open the audio decoder");

  const int channels = codec_context->ch_layout.nb_channels;
  if (channels <= 0 || codec_context->sample_rate <= 0) {
    throw std::runtime_error("The audio stream has invalid channel or sample-rate data");
  }

  SwrContext* raw_resampler = nullptr;
  require_ffmpeg(swr_alloc_set_opts2(&raw_resampler, &codec_context->ch_layout,
                                     AV_SAMPLE_FMT_S16, codec_context->sample_rate,
                                     &codec_context->ch_layout, codec_context->sample_fmt,
                                     codec_context->sample_rate, 0, nullptr),
                 "Could not create the audio resampler");
  std::unique_ptr<SwrContext, SwrDeleter> resampler(raw_resampler);
  require_ffmpeg(swr_init(resampler.get()), "Could not initialize the audio resampler");

  std::unique_ptr<AVPacket, PacketDeleter> packet(av_packet_alloc());
  std::unique_ptr<AVFrame, FrameDeleter> frame(av_frame_alloc());
  if (!packet || !frame) throw std::runtime_error("Could not allocate decode buffers");

  KeyFinder::Workspace workspace;
  KeyFinder::KeyFinder analyzer;

  auto consume_frames = [&]() {
    while (true) {
      const int receive = avcodec_receive_frame(codec_context.get(), frame.get());
      if (receive == AVERROR(EAGAIN) || receive == AVERROR_EOF) return;
      require_ffmpeg(receive, "Could not decode an audio frame");
      if (is_cancelled()) throw std::runtime_error("ANALYSIS_CANCELLED");

      const int capacity = av_rescale_rnd(
          swr_get_delay(resampler.get(), codec_context->sample_rate) + frame->nb_samples,
          codec_context->sample_rate, codec_context->sample_rate, AV_ROUND_UP);
      std::vector<std::int16_t> samples(
          static_cast<std::size_t>(capacity) * static_cast<std::size_t>(channels));
      std::array<std::uint8_t*, 1> output{
          reinterpret_cast<std::uint8_t*>(samples.data())};
      const int converted = swr_convert(resampler.get(), output.data(), capacity,
                                        frame->extended_data,
                                        frame->nb_samples);
      require_ffmpeg(converted, "Could not normalize decoded audio");
      samples.resize(static_cast<std::size_t>(converted) *
                     static_cast<std::size_t>(channels));

      KeyFinder::AudioData audio;
      audio.setFrameRate(static_cast<unsigned int>(codec_context->sample_rate));
      audio.setChannels(static_cast<unsigned int>(channels));
      audio.addToSampleCount(static_cast<unsigned int>(samples.size()));
      for (std::size_t index = 0; index < samples.size(); ++index) {
        audio.setSample(static_cast<unsigned int>(index), samples[index]);
      }
      analyzer.progressiveChromagram(audio, workspace);
      av_frame_unref(frame.get());
    }
  };

  while (av_read_frame(format.get(), packet.get()) >= 0) {
    if (is_cancelled()) throw std::runtime_error("ANALYSIS_CANCELLED");
    if (packet->stream_index == stream_index) {
      require_ffmpeg(avcodec_send_packet(codec_context.get(), packet.get()),
                     "Could not submit an audio packet");
      consume_frames();
      if (packet->pts != AV_NOPTS_VALUE && stream->duration > 0) {
        progress(std::clamp(static_cast<double>(packet->pts) /
                                static_cast<double>(stream->duration),
                            0.0, 1.0));
      }
    }
    av_packet_unref(packet.get());
  }

  require_ffmpeg(avcodec_send_packet(codec_context.get(), nullptr),
                 "Could not flush the audio decoder");
  consume_frames();
  if (is_cancelled()) throw std::runtime_error("ANALYSIS_CANCELLED");

  analyzer.finalChromagram(workspace);
  progress(1.0);
  return {static_cast<int>(analyzer.keyOfChromagram(workspace))};
}

}  // namespace keyfinder::domain
