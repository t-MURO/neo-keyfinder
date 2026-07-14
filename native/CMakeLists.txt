cmake_minimum_required(VERSION 3.24)

project(
  neo_keyfinder_native
  VERSION 0.1.0
  DESCRIPTION "Native engine for the NeoKeyAndBpmFinder rebuild"
  LANGUAGES CXX
)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON)
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

option(NKF_BUILD_TESTS "Build native engine tests" ON)
option(NKF_ENABLE_ESSENTIA "Enable Essentia BPM detection when available" ON)
set(ESSENTIA_ROOT "" CACHE PATH "Root of a static Essentia installation")

# Pinned to the commit behind nlohmann/json v3.12.0. Native dependencies must
# never follow a moving branch.
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG 55f93686c01528224f448c19128836e7df245f72
  GIT_SHALLOW FALSE
)
FetchContent_MakeAvailable(nlohmann_json)

# Pinned pugixml v1.15 for read-only iTunes and Traktor XML parsing.
FetchContent_Declare(
  pugixml
  GIT_REPOSITORY https://github.com/zeux/pugixml.git
  GIT_TAG ee86beb30e4973f5feffe3ce63bfa4fbadf72f38
  GIT_SHALLOW FALSE
)
set(PUGIXML_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(PUGIXML_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(pugixml)

find_package(PkgConfig REQUIRED)
pkg_check_modules(TAGLIB REQUIRED IMPORTED_TARGET taglib>=2.0)
if(MSVC)
  find_package(KeyFinder CONFIG REQUIRED)
  set(NKF_KEYFINDER_TARGET KeyFinder::keyfinder)
else()
  pkg_check_modules(KEYFINDER REQUIRED IMPORTED_TARGET libkeyfinder=2.2.8)
  set(NKF_KEYFINDER_TARGET PkgConfig::KEYFINDER)
endif()
pkg_check_modules(
  FFMPEG
  REQUIRED
  IMPORTED_TARGET
  libavformat
  libavcodec
  libavutil
  libswresample
)

set(NKF_HAS_ESSENTIA OFF)
if(NKF_ENABLE_ESSENTIA)
  find_path(
    ESSENTIA_INCLUDE_DIR
    NAMES essentia/essentia.h
    HINTS "${ESSENTIA_ROOT}/include" "$ENV{ESSENTIA_ROOT}/include"
  )
  find_library(
    ESSENTIA_LIBRARY
    NAMES essentia
    HINTS "${ESSENTIA_ROOT}/lib" "$ENV{ESSENTIA_ROOT}/lib"
  )
  find_path(
    EIGEN3_INCLUDE_DIR
    NAMES unsupported/Eigen/CXX11/Tensor
    HINTS
      "${ESSENTIA_ROOT}/include"
      "$ENV{ESSENTIA_ROOT}/include"
      "/opt/homebrew/include/eigen3"
      "/usr/local/include/eigen3"
      "/usr/include/eigen3"
  )
  if(ESSENTIA_INCLUDE_DIR AND ESSENTIA_LIBRARY AND EIGEN3_INCLUDE_DIR)
    set(NKF_HAS_ESSENTIA ON)
    message(STATUS "Essentia BPM detection enabled: ${ESSENTIA_LIBRARY}")
  else()
    message(STATUS "Essentia not found; BPM detection will be unavailable")
  endif()
endif()

# CMake's FindPkgConfig can duplicate the value half of repeated macOS
# `-framework Name` pairs as standalone link options. The framework libraries
# themselves remain correctly represented in INTERFACE_LINK_LIBRARIES.
if(APPLE)
  set_property(TARGET PkgConfig::FFMPEG PROPERTY INTERFACE_LINK_OPTIONS "")
endif()

add_library(keyfinder_domain STATIC
  src/analyzer.cpp
  src/bpm_analyzer.cpp
  src/file_scanner.cpp
  src/health.cpp
  src/job_manager.cpp
  src/metadata.cpp
  src/model.cpp
  src/output_rules.cpp
  src/playlists.cpp
  src/settings.cpp
  src/waveform.cpp
  src/writer.cpp
)
target_include_directories(keyfinder_domain PUBLIC include)
target_compile_definitions(
  keyfinder_domain
  PUBLIC
    NKF_ENGINE_VERSION="${PROJECT_VERSION}"
    NKF_HAS_ESSENTIA=$<BOOL:${NKF_HAS_ESSENTIA}>
)
if(NKF_HAS_ESSENTIA)
  target_include_directories(
    keyfinder_domain
    SYSTEM PRIVATE "${ESSENTIA_INCLUDE_DIR}" "${EIGEN3_INCLUDE_DIR}"
  )
endif()
target_link_libraries(
  keyfinder_domain
  PUBLIC
    nlohmann_json::nlohmann_json
    pugixml::pugixml
  PRIVATE
    PkgConfig::FFMPEG
    ${NKF_KEYFINDER_TARGET}
    PkgConfig::TAGLIB
)
if(NKF_HAS_ESSENTIA)
  target_link_libraries(keyfinder_domain PRIVATE "${ESSENTIA_LIBRARY}")
endif()

add_library(keyfinder_protocol STATIC
  src/engine.cpp
  src/protocol.cpp
)
target_include_directories(keyfinder_protocol PUBLIC include)
target_link_libraries(
  keyfinder_protocol
  PUBLIC
    keyfinder_domain
    nlohmann_json::nlohmann_json
)

add_executable(keyfinder-native src/main.cpp)
target_link_libraries(keyfinder-native PRIVATE keyfinder_protocol)

add_executable(keyfinder-cli src/cli_main.cpp)
set_target_properties(keyfinder-cli PROPERTIES OUTPUT_NAME keyfinder)
target_link_libraries(keyfinder-cli PRIVATE keyfinder_domain)

if(MSVC)
  target_compile_options(keyfinder_domain PRIVATE /W4 /permissive-)
  target_compile_options(keyfinder_protocol PRIVATE /W4 /permissive-)
  target_compile_options(keyfinder-native PRIVATE /W4 /permissive-)
  target_compile_options(keyfinder-cli PRIVATE /W4 /permissive-)
else()
  target_compile_options(keyfinder_domain PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(keyfinder_protocol PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(keyfinder-native PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(keyfinder-cli PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(NKF_BUILD_TESTS)
  enable_testing()

  add_executable(protocol-tests tests/protocol_tests.cpp)
  target_link_libraries(protocol-tests PRIVATE keyfinder_protocol)
  target_compile_definitions(
    protocol-tests
    PRIVATE NKF_LEGACY_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../is_KeyFinder/test-resources"
  )
  add_test(NAME protocol-tests COMMAND protocol-tests)

  add_executable(domain-tests tests/health_tests.cpp)
  target_link_libraries(domain-tests PRIVATE keyfinder_domain)
  add_test(NAME domain-tests COMMAND domain-tests)

  add_executable(output-rule-tests tests/output_rule_tests.cpp)
  target_link_libraries(output-rule-tests PRIVATE keyfinder_domain)
  add_test(NAME output-rule-tests COMMAND output-rule-tests)

  add_executable(metadata-tests tests/metadata_tests.cpp)
  target_link_libraries(metadata-tests PRIVATE keyfinder_domain)
  target_compile_definitions(
    metadata-tests
    PRIVATE NKF_LEGACY_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../is_KeyFinder/test-resources"
  )
  add_test(NAME metadata-tests COMMAND metadata-tests)

  add_executable(analyzer-tests tests/analyzer_tests.cpp)
  target_link_libraries(analyzer-tests PRIVATE keyfinder_domain)
  target_compile_definitions(
    analyzer-tests
    PRIVATE NKF_LEGACY_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../is_KeyFinder/test-resources"
  )
  add_test(NAME analyzer-tests COMMAND analyzer-tests)

  add_executable(filesystem-tests tests/filesystem_tests.cpp)
  target_link_libraries(filesystem-tests PRIVATE keyfinder_domain)
  target_compile_definitions(
    filesystem-tests
    PRIVATE NKF_LEGACY_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../is_KeyFinder/test-resources"
  )
  add_test(NAME filesystem-tests COMMAND filesystem-tests)

  add_executable(playlist-tests tests/playlist_tests.cpp)
  target_link_libraries(playlist-tests PRIVATE keyfinder_domain)
  add_test(NAME playlist-tests COMMAND playlist-tests)

  add_test(NAME cli-help COMMAND keyfinder-cli --help)
  set_tests_properties(cli-help PROPERTIES PASS_REGULAR_EXPRESSION "Usage: keyfinder")
  add_test(NAME cli-version COMMAND keyfinder-cli --version)
  set_tests_properties(cli-version PROPERTIES PASS_REGULAR_EXPRESSION "keyfinder 0.1.0")
endif()

install(TARGETS keyfinder-native keyfinder-cli RUNTIME DESTINATION bin)
