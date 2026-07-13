#include "keyfinder/playlists.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <optional>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

#include <pugixml.hpp>

#include "keyfinder/model.hpp"

namespace keyfinder::domain {
namespace {

const std::unordered_set<std::string> kDefaultItunesPlaylists = {
    "Library",      "Music",       "Movies",       "Films",
    "TV Shows",     "TV Programmes", "Podcasts",    "Books",
    "Purchased",    "Genius",      "iTunes DJ",    "Audiobooks",
    "Music Videos", "Rentals",     "Home Videos",  "iTunes U",
    "PDFs",         "####!####"};
const std::unordered_set<std::string> kDefaultTraktorPlaylists = {
    "_LOOPS", "_RECORDINGS", "Preparation"};

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char byte) {
    return static_cast<char>(std::tolower(byte));
  });
  return value;
}

std::string playlist_id(const std::string& source, const std::string& origin,
                        const std::string& name) {
  return stable_track_id(path_from_utf8(source + "\n" + origin + "\n" + name));
}

Playlist make_playlist(std::string name, std::string source,
                       const std::filesystem::path& origin) {
  Playlist playlist;
  playlist.name = std::move(name);
  playlist.source = std::move(source);
  playlist.origin = path_to_utf8(origin);
  playlist.id = playlist_id(playlist.source, playlist.origin, playlist.name);
  return playlist;
}

void warn(PlaylistResult& result, const std::string& source,
          const std::filesystem::path& path, std::string code,
          std::string message) {
  result.warnings.push_back(
      {source, path_to_utf8(path), std::move(code), std::move(message)});
}

std::string percent_decode(const std::string& input) {
  std::string output;
  output.reserve(input.size());
  for (std::size_t index = 0; index < input.size(); ++index) {
    if (input[index] == '%' && index + 2 < input.size()) {
      const auto hex = input.substr(index + 1, 2);
      char* end = nullptr;
      const auto value = std::strtol(hex.c_str(), &end, 16);
      if (end == hex.c_str() + 2) {
        output.push_back(static_cast<char>(value));
        index += 2;
        continue;
      }
    }
    output.push_back(input[index]);
  }
  return output;
}

std::filesystem::path file_url_path(std::string address) {
  constexpr std::array prefixes = {"file://localhost", "file://"};
  for (const auto* prefix : prefixes) {
    if (address.starts_with(prefix)) {
      address.erase(0, std::char_traits<char>::length(prefix));
      break;
    }
  }
  address = percent_decode(address);
#if defined(_WIN32)
  if (address.size() > 2 && address.front() == '/' && address[2] == ':') {
    address.erase(0, 1);
  }
#endif
  return path_from_utf8(address);
}

pugi::xml_node plist_value(const pugi::xml_node& dictionary,
                           const std::string& key) {
  for (auto node = dictionary.first_child(); node; node = node.next_sibling()) {
    if (std::string(node.name()) == "key" && node.child_value() == key) {
      return node.next_sibling();
    }
  }
  return {};
}

PlaylistResult read_itunes(const std::filesystem::path& path,
                           bool standalone) {
  PlaylistResult result;
  pugi::xml_document document;
  const auto loaded = document.load_file(path_to_utf8(path).c_str());
  if (!loaded) {
    warn(result, "iTunes", path, "PLAYLIST_PARSE_FAILED", loaded.description());
    return result;
  }
  const auto root = document.child("plist").child("dict");
  const auto tracks_node = plist_value(root, "Tracks");
  const auto playlists_node = plist_value(root, "Playlists");
  std::unordered_map<std::string, std::filesystem::path> tracks;
  for (auto key = tracks_node.first_child(); key;) {
    const auto dictionary = key.next_sibling("dict");
    if (!dictionary) break;
    const auto id = plist_value(dictionary, "Track ID");
    const auto location = plist_value(dictionary, "Location");
    const auto identifier = id ? id.child_value() : key.child_value();
    if (location && *location.child_value()) {
      tracks[identifier] = file_url_path(location.child_value());
    }
    key = dictionary.next_sibling("key");
  }
  for (const auto dictionary : playlists_node.children("dict")) {
    const auto name_node = plist_value(dictionary, "Name");
    if (!name_node) continue;
    const std::string name = name_node.child_value();
    if (!standalone && kDefaultItunesPlaylists.contains(name)) continue;
    auto playlist = make_playlist(name.empty() ? path.stem().string() : name,
                                  "itunes", path);
    const auto items = plist_value(dictionary, "Playlist Items");
    for (const auto item : items.children("dict")) {
      const auto id = plist_value(item, "Track ID");
      const auto found = tracks.find(id.child_value());
      if (found != tracks.end()) playlist.tracks.push_back(found->second);
    }
    result.playlists.push_back(std::move(playlist));
    if (standalone) break;
  }
  if (standalone && result.playlists.empty()) {
    warn(result, "iTunes", path, "PLAYLIST_EMPTY",
         "The iTunes XML contains no playlist");
  }
  return result;
}

std::filesystem::path traktor_path(std::string address) {
  std::string needle = "/:";
  for (auto position = address.find(needle); position != std::string::npos;
       position = address.find(needle)) {
    address.replace(position, needle.size(), "/");
  }
#if defined(_WIN32)
  if (address.size() > 1 && address[1] == ':') return path_from_utf8(address);
  return path_from_utf8(address);
#elif defined(__APPLE__)
  return path_from_utf8("/Volumes/" + address);
#else
  if (!address.starts_with('/')) address.insert(address.begin(), '/');
  return path_from_utf8(address);
#endif
}

PlaylistResult read_traktor(const std::filesystem::path& path) {
  PlaylistResult result;
  pugi::xml_document document;
  const auto loaded = document.load_file(path_to_utf8(path).c_str());
  if (!loaded) {
    warn(result, "Traktor", path, "PLAYLIST_PARSE_FAILED", loaded.description());
    return result;
  }
  for (const auto node : document.select_nodes("//PLAYLISTS//NODE[@TYPE='PLAYLIST']")) {
    const auto element = node.node();
    const std::string name = element.attribute("NAME").value();
    if (kDefaultTraktorPlaylists.contains(name)) continue;
    auto playlist = make_playlist(name, "traktor", path);
    for (const auto key : element.select_nodes(".//PRIMARYKEY[@TYPE='TRACK']")) {
      playlist.tracks.push_back(traktor_path(key.node().attribute("KEY").value()));
    }
    result.playlists.push_back(std::move(playlist));
  }
  return result;
}

std::uint32_t read_big_endian(const std::vector<unsigned char>& bytes,
                              std::size_t offset) {
  if (offset + 4 > bytes.size()) return 0;
  return (static_cast<std::uint32_t>(bytes[offset]) << 24U) |
         (static_cast<std::uint32_t>(bytes[offset + 1]) << 16U) |
         (static_cast<std::uint32_t>(bytes[offset + 2]) << 8U) |
         static_cast<std::uint32_t>(bytes[offset + 3]);
}

std::string utf16be(const std::vector<unsigned char>& bytes, std::size_t offset,
                    std::size_t length) {
  std::string output;
  const auto end = std::min(bytes.size(), offset + length);
  for (auto index = offset; index + 1 < end; index += 2) {
    const auto code = static_cast<unsigned>((bytes[index] << 8U) | bytes[index + 1]);
    if (code < 0x80U) output.push_back(static_cast<char>(code));
    else if (code < 0x800U) {
      output.push_back(static_cast<char>(0xc0U | (code >> 6U)));
      output.push_back(static_cast<char>(0x80U | (code & 0x3fU)));
    } else {
      output.push_back(static_cast<char>(0xe0U | (code >> 12U)));
      output.push_back(static_cast<char>(0x80U | ((code >> 6U) & 0x3fU)));
      output.push_back(static_cast<char>(0x80U | (code & 0x3fU)));
    }
  }
  return output;
}

std::vector<std::string> read_serato_crate(const std::filesystem::path& path,
                                           bool smart) {
  std::ifstream input(path, std::ios::binary);
  const std::vector<unsigned char> bytes{std::istreambuf_iterator<char>(input), {}};
  const auto type_length = smart ? std::string("/Serato ScratchLive Smart Crate").size()
                                 : std::string("/Serato ScratchLive Crate").size();
  std::size_t position = 4 + 2 + 4 * 2 + type_length * 2;
  std::vector<std::string> tracks;
  while (position + 8 <= bytes.size()) {
    const std::string name(bytes.begin() + static_cast<std::ptrdiff_t>(position),
                           bytes.begin() + static_cast<std::ptrdiff_t>(position + 4));
    const auto length = read_big_endian(bytes, position + 4);
    position += 8;
    if (position + length > bytes.size()) break;
    if (name.starts_with("otrk") && length >= 8) {
      tracks.push_back(utf16be(bytes, position + 8, length - 8));
    }
    position += length;
  }
  return tracks;
}

std::filesystem::path serato_root(const std::filesystem::path& database) {
  std::error_code error;
  if (std::filesystem::is_directory(database, error)) return database;
  return database.parent_path();
}

std::filesystem::path serato_track_path(const std::filesystem::path& database,
                                        const std::string& track) {
  auto relative = path_from_utf8(track);
  if (relative.is_absolute()) return relative;
#if defined(_WIN32)
  return database.root_path() / relative;
#elif defined(__APPLE__)
  const auto text = path_to_utf8(database);
  if (text.starts_with("/Volumes/")) {
    const auto slash = text.find('/', std::string("/Volumes/").size());
    if (slash != std::string::npos) return path_from_utf8(text.substr(0, slash)) / relative;
  }
#endif
  return std::filesystem::path("/") / relative;
}

PlaylistResult read_serato(const std::filesystem::path& database) {
  PlaylistResult result;
  const auto root = serato_root(database);
  for (const auto& [folder, extension, smart] :
       std::array{std::tuple{"Subcrates", ".crate", false},
                  std::tuple{"SmartCrates", ".scrate", true}}) {
    const auto directory = root / folder;
    std::error_code error;
    if (!std::filesystem::exists(directory, error)) continue;
    for (const auto& entry : std::filesystem::directory_iterator(directory, error)) {
      if (entry.path().extension() != extension) continue;
      auto name = entry.path().stem().string();
      for (auto position = name.find("%%"); position != std::string::npos;
           position = name.find("%%", position + 1)) name.replace(position, 2, "/");
      auto playlist = make_playlist(name, "serato", entry.path());
      for (const auto& track : read_serato_crate(entry.path(), smart)) {
        playlist.tracks.push_back(serato_track_path(database, track));
      }
      result.playlists.push_back(std::move(playlist));
    }
  }
  return result;
}

PlaylistResult read_m3u(const std::filesystem::path& path) {
  PlaylistResult result;
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    warn(result, "M3U", path, "PLAYLIST_READ_FAILED", "Could not open playlist");
    return result;
  }
  auto playlist = make_playlist(path.stem().string(), "m3u", path);
  std::string line;
  while (std::getline(input, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line.front() == '#') continue;
    auto track = file_url_path(line);
    if (track.is_relative()) track = path.parent_path() / track;
    playlist.tracks.push_back(track.lexically_normal());
  }
  result.playlists.push_back(std::move(playlist));
  return result;
}

void append(PlaylistResult& target, PlaylistResult source) {
  target.playlists.insert(target.playlists.end(),
                          std::make_move_iterator(source.playlists.begin()),
                          std::make_move_iterator(source.playlists.end()));
  target.warnings.insert(target.warnings.end(),
                         std::make_move_iterator(source.warnings.begin()),
                         std::make_move_iterator(source.warnings.end()));
}

}  // namespace

PlaylistResult discover_libraries(const Settings& settings) {
  PlaylistResult result;
  const auto add_if_present = [&](const std::string& source,
                                  const std::string& configured,
                                  auto reader) {
    if (configured.empty()) return;
    const auto path = path_from_utf8(configured);
    std::error_code error;
    if (!std::filesystem::exists(path, error)) {
      warn(result, source, path, "LIBRARY_NOT_FOUND", "Configured library was not found");
      return;
    }
    append(result, reader(path));
  };
  add_if_present("iTunes", settings.itunes_library_path,
                 [](const auto& path) { return read_itunes(path, false); });
  add_if_present("Traktor", settings.traktor_library_path, read_traktor);
  add_if_present("Serato", settings.serato_library_path, read_serato);
  return result;
}

PlaylistResult load_standalone_playlist(const std::filesystem::path& path) {
  const auto extension = lowercase(path.extension().string());
  if (extension == ".m3u" || extension == ".m3u8") return read_m3u(path);
  if (extension == ".xml") return read_itunes(path, true);
  PlaylistResult result;
  warn(result, "Playlist", path, "PLAYLIST_UNSUPPORTED",
       "Only M3U, M3U8, and iTunes XML playlists are supported");
  return result;
}

nlohmann::json to_json(const Playlist& playlist) {
  nlohmann::json tracks = nlohmann::json::array();
  for (const auto& track : playlist.tracks) tracks.push_back(path_to_utf8(track));
  return {{"id", playlist.id},       {"name", playlist.name},
          {"source", playlist.source}, {"origin", playlist.origin},
          {"tracks", tracks},       {"readOnly", playlist.read_only}};
}

nlohmann::json to_json(const PlaylistWarning& warning) {
  return {{"source", warning.source}, {"path", warning.path},
          {"code", warning.code},     {"message", warning.message}};
}

}  // namespace keyfinder::domain
