#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

#include "keyfinder/model.hpp"
#include "keyfinder/playlists.hpp"
#include "keyfinder/settings.hpp"

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

void write_text(const std::filesystem::path& path, const std::string& text) {
  std::ofstream output(path, std::ios::binary);
  output << text;
}

void write_be32(std::ofstream& output, std::uint32_t value) {
  for (int shift = 24; shift >= 0; shift -= 8) {
    output.put(static_cast<char>((value >> shift) & 0xffU));
  }
}

void write_utf16be(std::ofstream& output, const std::string& value) {
  for (const unsigned char character : value) {
    output.put('\0');
    output.put(static_cast<char>(character));
  }
}

void write_serato_crate(const std::filesystem::path& path,
                        const std::string& track) {
  std::ofstream output(path, std::ios::binary);
  output.write("vrsn", 4);
  output.write("\0\0", 2);
  write_utf16be(output, "81.0");
  write_utf16be(output, "/Serato ScratchLive Crate");
  output.write("otrk", 4);
  write_be32(output, static_cast<std::uint32_t>(8 + track.size() * 2));
  output.write("\0\0\0\0\0\0\0\0", 8);
  write_utf16be(output, track);
}

}  // namespace

int main() {
  using keyfinder::domain::path_to_utf8;
  const auto suffix = std::to_string(
      std::chrono::steady_clock::now().time_since_epoch().count());
  const auto temporary =
      std::filesystem::temp_directory_path() / ("neo-keyfinder-playlists-" + suffix);
  std::filesystem::create_directories(temporary / "Subcrates");

  const auto m3u = temporary / "set.m3u8";
  write_text(m3u, "#EXTM3U\r\ntrack one.wav\r\nfile:///Music/second%20track+mix.mp3\n");
  const auto m3u_result = keyfinder::domain::load_standalone_playlist(m3u);
  expect(m3u_result.playlists.size() == 1, "M3U creates one playlist");
  expect(m3u_result.playlists[0].tracks.size() == 2, "M3U reads entries and comments");
  expect(m3u_result.playlists[0].tracks[0] == temporary / "track one.wav",
         "M3U resolves relative entries");
  expect(path_to_utf8(m3u_result.playlists[0].tracks[1]).find("second track+mix.mp3") !=
             std::string::npos,
         "M3U decodes file URLs");

  const auto itunes = temporary / "iTunes.xml";
  write_text(itunes, R"xml(<?xml version="1.0"?><plist><dict>
<key>Tracks</key><dict><key>1</key><dict><key>Track ID</key><integer>1</integer><key>Location</key><string>file://localhost/Music/One%20Song.m4a</string></dict></dict>
<key>Playlists</key><array>
<dict><key>Name</key><string>Music</string><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1</integer></dict></array></dict>
<dict><key>Name</key><string>My Set</string><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1</integer></dict></array></dict>
</array></dict></plist>)xml");

  const auto traktor = temporary / "collection.nml";
  write_text(traktor, R"xml(<NML><PLAYLISTS>
<NODE TYPE="PLAYLIST" NAME="Preparation"><PLAYLIST><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Disk/:Ignored.mp3"/></ENTRY></PLAYLIST></NODE>
<NODE TYPE="PLAYLIST" NAME="Club"><PLAYLIST><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Disk/:Music/:Track.mp3"/></ENTRY></PLAYLIST></NODE>
</PLAYLISTS></NML>)xml");

  const auto serato_database = temporary / "database V2";
  write_text(serato_database, "database");
  write_serato_crate(temporary / "Subcrates" / "Warmup%%House.crate",
                     "Music/Serato Track.mp3");

  keyfinder::domain::Settings settings;
  settings.itunes_library_path = path_to_utf8(itunes);
  settings.traktor_library_path = path_to_utf8(traktor);
  settings.serato_library_path = path_to_utf8(serato_database);
  const auto libraries = keyfinder::domain::discover_libraries(settings);
  expect(libraries.warnings.empty(), "valid libraries do not warn");
  expect(libraries.playlists.size() == 3,
         "default playlists are hidden and all providers are combined");
  expect(libraries.playlists[0].name == "My Set" &&
             libraries.playlists[0].tracks.size() == 1,
         "iTunes playlist resolves track IDs");
  expect(libraries.playlists[1].name == "Club" &&
             libraries.playlists[1].tracks.size() == 1,
         "Traktor playlist resolves primary keys");
  expect(libraries.playlists[2].name == "Warmup/House" &&
             libraries.playlists[2].tracks.size() == 1,
         "Serato crate names and entries are decoded");

  keyfinder::domain::Settings serato_folder_settings;
  serato_folder_settings.serato_library_path = path_to_utf8(temporary);
  const auto serato_folder = keyfinder::domain::discover_libraries(serato_folder_settings);
  expect(serato_folder.playlists.size() == 1 &&
             serato_folder.playlists[0].source == "serato",
         "Serato accepts the _Serato_ folder as well as database V2");

  const auto standalone = keyfinder::domain::load_standalone_playlist(itunes);
  expect(standalone.playlists.size() == 1 && standalone.playlists[0].name == "Music",
         "standalone iTunes XML selects its first playlist");

  settings.itunes_library_path = path_to_utf8(temporary / "missing.xml");
  const auto missing = keyfinder::domain::discover_libraries(settings);
  expect(!missing.warnings.empty() && missing.warnings[0].code == "LIBRARY_NOT_FOUND",
         "missing configured libraries return structured warnings");

  std::filesystem::remove_all(temporary);
  return 0;
}
