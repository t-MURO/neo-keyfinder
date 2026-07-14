#include "keyfinder/metadata.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <memory>
#include <system_error>

#include <taglib/audioproperties.h>
#include <taglib/aifffile.h>
#include <taglib/asffile.h>
#include <taglib/flacfile.h>
#include <taglib/mp4file.h>
#include <taglib/mpegfile.h>
#include <taglib/tfile.h>
#include <taglib/tpropertymap.h>
#include <taglib/wavfile.h>

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/error.h>
}

namespace keyfinder::domain {
namespace {

std::string utf8(const TagLib::String& value) {
  return value.isEmpty() ? std::string{} : std::string(value.toCString(true));
}

std::string property(const TagLib::PropertyMap& properties, const char* key) {
  const TagLib::String name(key, TagLib::String::UTF8);
  const auto iterator = properties.find(name);
  if (iterator == properties.end() || iterator->second.isEmpty()) return {};
  return utf8(iterator->second.front());
}

std::string first_property(const TagLib::PropertyMap& properties,
                           std::initializer_list<const char*> keys) {
  for (const auto* key : keys) {
    const auto value = property(properties, key);
    if (!value.empty()) return value;
  }
  return {};
}

std::optional<double> parse_bpm(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    std::size_t consumed = 0;
    const auto bpm = std::stod(value, &consumed);
    while (consumed < value.size() &&
           std::isspace(static_cast<unsigned char>(value[consumed]))) {
      ++consumed;
    }
    if (consumed != value.size() || !std::isfinite(bpm) || bpm <= 0) {
      return std::nullopt;
    }
    return bpm;
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

TagLib::FileName filename(const std::filesystem::path& path) {
#if defined(_WIN32)
  return TagLib::FileName(path.c_str());
#else
  return TagLib::FileName(path.c_str());
#endif
}

std::unique_ptr<TagLib::File> open_file(const std::filesystem::path& path,
                                        bool read_audio_properties) {
  auto extension = path.extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char value) { return std::tolower(value); });
  const auto name = filename(path);
  const auto style = TagLib::AudioProperties::Average;
  if (extension == ".mp3") {
    return std::make_unique<TagLib::MPEG::File>(name, read_audio_properties, style);
  }
  if (extension == ".flac") {
    return std::make_unique<TagLib::FLAC::File>(name, read_audio_properties, style);
  }
  if (extension == ".wma") {
    return std::make_unique<TagLib::ASF::File>(name, read_audio_properties, style);
  }
  if (extension == ".wav") {
    return std::make_unique<TagLib::RIFF::WAV::File>(name, read_audio_properties,
                                                     style);
  }
  if (extension == ".aif" || extension == ".aiff") {
    return std::make_unique<TagLib::RIFF::AIFF::File>(name, read_audio_properties,
                                                      style);
  }
  return {};
}

std::string ffmpeg_error(int code) {
  char buffer[AV_ERROR_MAX_STRING_SIZE]{};
  av_strerror(code, buffer, sizeof(buffer));
  return buffer;
}

std::string dictionary_value(const AVDictionary* dictionary, const char* key) {
  const auto* entry = av_dict_get(dictionary, key, nullptr, 0);
  return entry && entry->value ? entry->value : "";
}

std::string first_dictionary_value(const AVDictionary* dictionary,
                                   std::initializer_list<const char*> keys) {
  for (const auto* key : keys) {
    const auto value = dictionary_value(dictionary, key);
    if (!value.empty()) return value;
  }
  return {};
}

bool read_ffmpeg_metadata(Track& track) {
  AVFormatContext* raw = nullptr;
  const auto path = path_to_utf8(track.path);
  if (avformat_open_input(&raw, path.c_str(), nullptr, nullptr) < 0) return false;
  const auto close = [](AVFormatContext* context) { avformat_close_input(&context); };
  std::unique_ptr<AVFormatContext, decltype(close)> input(raw, close);
  if (avformat_find_stream_info(input.get(), nullptr) < 0) return false;
  track.title = dictionary_value(input->metadata, "title");
  track.artist = dictionary_value(input->metadata, "artist");
  track.album = dictionary_value(input->metadata, "album");
  track.comment = dictionary_value(input->metadata, "comment");
  track.grouping = dictionary_value(input->metadata, "grouping");
  track.initial_key = dictionary_value(input->metadata, "initialkey");
  if (track.initial_key.empty()) {
    track.initial_key = dictionary_value(input->metadata, "initial_key");
  }
  track.initial_bpm = parse_bpm(first_dictionary_value(
      input->metadata, {"bpm", "tbpm", "tmpo", "tempo"}));
  if (input->duration != AV_NOPTS_VALUE) {
    track.duration_ms = input->duration / (AV_TIME_BASE / 1000);
  }
  return true;
}

std::string ffmpeg_field(const std::string& field) {
  if (field == "TITLE") return "title";
  if (field == "ARTIST") return "artist";
  if (field == "ALBUM") return "album";
  if (field == "COMMENT") return "comment";
  if (field == "GROUPING") return "grouping";
  if (field == "INITIALKEY") return "initialkey";
  if (field == "BPM") return "tmpo";
  return {};
}

MutationResult remux_metadata_field(const std::filesystem::path& path,
                                    const std::string& field,
                                    const std::string& value) {
  AVFormatContext* raw_input = nullptr;
  const auto input_path = path_to_utf8(path);
  auto result = avformat_open_input(&raw_input, input_path.c_str(), nullptr, nullptr);
  if (result < 0) return {false, {}, ffmpeg_error(result)};
  const auto close_input = [](AVFormatContext* context) { avformat_close_input(&context); };
  std::unique_ptr<AVFormatContext, decltype(close_input)> input(raw_input, close_input);
  result = avformat_find_stream_info(input.get(), nullptr);
  if (result < 0) return {false, {}, ffmpeg_error(result)};

  auto temporary = path.parent_path() /
                   (path.stem().string() + ".keyfinder-tmp" + path.extension().string());
  for (unsigned suffix = 1; std::filesystem::exists(temporary); ++suffix) {
    temporary = path.parent_path() /
                (path.stem().string() + ".keyfinder-tmp-" +
                 std::to_string(suffix) + path.extension().string());
  }
  const auto output_path = path_to_utf8(temporary);
  AVFormatContext* raw_output = nullptr;
  result = avformat_alloc_output_context2(&raw_output, nullptr, nullptr,
                                           output_path.c_str());
  if (result < 0 || !raw_output) return {false, {}, ffmpeg_error(result)};
  const auto free_output = [](AVFormatContext* context) {
    if (!(context->oformat->flags & AVFMT_NOFILE) && context->pb) avio_closep(&context->pb);
    avformat_free_context(context);
  };
  std::unique_ptr<AVFormatContext, decltype(free_output)> output(raw_output, free_output);

  for (unsigned index = 0; index < input->nb_streams; ++index) {
    auto* output_stream = avformat_new_stream(output.get(), nullptr);
    if (!output_stream) return {false, {}, "Could not allocate output stream"};
    result = avcodec_parameters_copy(output_stream->codecpar,
                                     input->streams[index]->codecpar);
    if (result < 0) return {false, {}, ffmpeg_error(result)};
    output_stream->codecpar->codec_tag = 0;
    output_stream->time_base = input->streams[index]->time_base;
  }
  av_dict_copy(&output->metadata, input->metadata, 0);
  const auto key = ffmpeg_field(field);
  if (key.empty()) return {false, {}, "Unknown metadata field"};
  av_dict_set(&output->metadata, key.c_str(), value.c_str(), 0);

  if (!(output->oformat->flags & AVFMT_NOFILE)) {
    result = avio_open(&output->pb, output_path.c_str(), AVIO_FLAG_WRITE);
    if (result < 0) return {false, {}, ffmpeg_error(result)};
  }
  AVDictionary* muxer_options = nullptr;
  av_dict_set(&muxer_options, "movflags", "use_metadata_tags", 0);
  result = avformat_write_header(output.get(), &muxer_options);
  av_dict_free(&muxer_options);
  if (result < 0) return {false, {}, ffmpeg_error(result)};

  AVPacket* packet = av_packet_alloc();
  if (!packet) return {false, {}, "Could not allocate media packet"};
  while ((result = av_read_frame(input.get(), packet)) >= 0) {
    const auto index = packet->stream_index;
    av_packet_rescale_ts(packet, input->streams[index]->time_base,
                         output->streams[index]->time_base);
    packet->pos = -1;
    result = av_interleaved_write_frame(output.get(), packet);
    av_packet_unref(packet);
    if (result < 0) break;
  }
  av_packet_free(&packet);
  if (result != AVERROR_EOF && result < 0) {
    std::filesystem::remove(temporary);
    return {false, {}, ffmpeg_error(result)};
  }
  result = av_write_trailer(output.get());
  if (result < 0) {
    std::filesystem::remove(temporary);
    return {false, {}, ffmpeg_error(result)};
  }
  output.reset();
  input.reset();

  const auto backup = path.parent_path() /
                      (path.filename().string() + ".keyfinder-backup");
  std::error_code error;
  std::filesystem::rename(path, backup, error);
  if (error) {
    std::filesystem::remove(temporary);
    return {false, {}, error.message()};
  }
  std::filesystem::rename(temporary, path, error);
  if (error) {
    std::error_code ignored;
    std::filesystem::rename(backup, path, ignored);
    std::filesystem::remove(temporary, ignored);
    return {false, {}, error.message()};
  }
  std::filesystem::remove(backup, error);
  return {true, value, {}};
}

std::string property_for_file(const std::filesystem::path& path,
                              const std::string& field) {
  if (field != "GROUPING") return field;
  auto extension = path.extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char value) { return std::tolower(value); });
  if (extension == ".mp3" || extension == ".wav" || extension == ".aif" ||
      extension == ".aiff" || extension == ".wma") {
    return "WORK";
  }
  return field;
}

}  // namespace

void read_metadata(Track& track) {
  try {
    auto extension = track.path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char value) { return std::tolower(value); });
    if ((extension == ".m4a" || extension == ".mp4") &&
        read_ffmpeg_metadata(track)) {
      track.status = TrackStatus::ready;
      track.error.reset();
      return;
    }
    auto file = open_file(track.path, true);
    if (!file || !file->isValid()) {
      track.status = TrackStatus::ready;
      track.error = TrackError{"METADATA_UNSUPPORTED", "metadata",
                               "Metadata is unavailable for this file type"};
      return;
    }

    const auto properties = file->properties();
    track.title = property(properties, "TITLE");
    track.artist = property(properties, "ARTIST");
    track.album = property(properties, "ALBUM");
    track.comment = property(properties, "COMMENT");
    track.grouping = first_property(
        properties, {"GROUPING", "WORK", "CONTENTGROUP",
                     "WM/CONTENTGROUPDESCRIPTION"});
    track.initial_key = property(properties, "INITIALKEY");
    track.initial_bpm = parse_bpm(first_property(
        properties, {"BPM", "TBPM", "TEMPO", "WM/BEATSPERMINUTE"}));
    if (const auto* audio = file->audioProperties(); audio != nullptr) {
      track.duration_ms = audio->lengthInMilliseconds();
    }
    track.status = TrackStatus::ready;
    track.error.reset();
  } catch (const std::exception& error) {
    track.status = TrackStatus::ready;
    track.error = TrackError{"METADATA_READ_FAILED", "metadata", error.what()};
  }
}

MutationResult write_metadata_field(const std::filesystem::path& path,
                                    const std::string& field,
                                    const std::string& value) {
  try {
    auto extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char value) { return std::tolower(value); });
    if (extension == ".m4a" || extension == ".mp4") {
      return remux_metadata_field(path, field, value);
    }
    auto file = open_file(path, false);
    if (!file || !file->isValid()) {
      return {false, {}, "Metadata is unavailable for this file type"};
    }
    auto properties = file->properties();
    const TagLib::String key(property_for_file(path, field), TagLib::String::UTF8);
    properties.replace(key, TagLib::StringList(TagLib::String(value, TagLib::String::UTF8)));
    const auto unsupported = file->setProperties(properties);
    if (unsupported.contains(key)) {
      return {false, {}, "The metadata field is unsupported for this file type"};
    }
    if (!file->save()) {
      return {false, {}, "TagLib could not save the metadata change"};
    }
    return {true, value, {}};
  } catch (const std::exception& error) {
    return {false, {}, error.what()};
  }
}

}  // namespace keyfinder::domain
