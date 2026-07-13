cmake_minimum_required(VERSION 3.24)

project(
  neo_keyfinder_native
  VERSION 0.1.0
  DESCRIPTION "Native engine for the KeyFinder rebuild"
  LANGUAGES CXX
)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON)

option(NKF_BUILD_TESTS "Build native engine tests" ON)

# Pinned to the commit behind nlohmann/json v3.12.0. Native dependencies must
# never follow a moving branch.
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG 55f93686c01528224f448c19128836e7df245f72
  GIT_SHALLOW FALSE
)
FetchContent_MakeAvailable(nlohmann_json)

add_library(keyfinder_domain STATIC
  src/health.cpp
)
target_include_directories(keyfinder_domain PUBLIC include)
target_compile_definitions(
  keyfinder_domain
  PUBLIC NKF_ENGINE_VERSION="${PROJECT_VERSION}"
)

add_library(keyfinder_protocol STATIC
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

if(MSVC)
  target_compile_options(keyfinder_domain PRIVATE /W4 /permissive-)
  target_compile_options(keyfinder_protocol PRIVATE /W4 /permissive-)
  target_compile_options(keyfinder-native PRIVATE /W4 /permissive-)
else()
  target_compile_options(keyfinder_domain PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(keyfinder_protocol PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(keyfinder-native PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(NKF_BUILD_TESTS)
  enable_testing()

  add_executable(protocol-tests tests/protocol_tests.cpp)
  target_link_libraries(protocol-tests PRIVATE keyfinder_protocol)
  add_test(NAME protocol-tests COMMAND protocol-tests)

  add_executable(domain-tests tests/health_tests.cpp)
  target_link_libraries(domain-tests PRIVATE keyfinder_domain)
  add_test(NAME domain-tests COMMAND domain-tests)
endif()

install(TARGETS keyfinder-native RUNTIME DESTINATION bin)
