#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>

#include "keyfinder/output_rules.hpp"
#include "keyfinder/settings.hpp"

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

void expect_value(const std::optional<std::string>& actual,
                  const std::string& expected,
                  const std::string& message) {
  expect(actual.has_value() && *actual == expected, message);
}

}  // namespace

int main() {
  using keyfinder::domain::OutputMode;
  using keyfinder::domain::apply_output_rule;
  constexpr std::size_t limit = keyfinder::domain::kMetadataCharacterLimit;

  expect(!apply_output_rule("key", "data", limit, OutputMode::none, " - "),
         "disabled output does not write");
  expect_value(apply_output_rule("key", "data", limit, OutputMode::overwrite,
                                 " - "),
               "key", "overwrite replaces existing data");
  expect(!apply_output_rule("key", "key", limit, OutputMode::overwrite, " - "),
         "overwrite skips the same value");
  expect_value(apply_output_rule("key", "data", limit, OutputMode::prepend, "_"),
               "key_data", "prepend uses the configured delimiter");
  expect(!apply_output_rule("key", "key - data", limit, OutputMode::prepend, "_"),
         "prepend recognizes a different non-alphanumeric delimiter");
  expect_value(apply_output_rule("Am", "Amazon", limit, OutputMode::prepend, "_"),
               "Am_Amazon", "prepend does not mistake an alphanumeric boundary");
  expect_value(apply_output_rule("key", "data", limit, OutputMode::append, "_"),
               "data_key", "append uses the configured delimiter");
  expect(!apply_output_rule("key", "data.key", limit, OutputMode::append, "_"),
         "append recognizes an unexpected non-alphanumeric delimiter");
  expect_value(apply_output_rule("ÅßÇΔ", "", 3, OutputMode::overwrite, " - "),
               "ÅßÇ", "character limits preserve complete Unicode characters");

  keyfinder::domain::Settings settings;
  const auto codes = keyfinder::domain::all_key_codes(settings);
  expect(!apply_output_rule("", "Em - data", limit, OutputMode::prepend, " - ",
                            codes),
         "skip checks recognize every standard key code");

  settings.notation = keyfinder::domain::NotationMode::custom;
  settings.custom_codes[0] = "XXX and a bunch of other data";
  const auto custom_codes = keyfinder::domain::all_key_codes(settings);
  expect(!apply_output_rule("", "XXX", 3, OutputMode::overwrite, " - ",
                            custom_codes),
         "skip checks apply output character limits");

  expect(keyfinder::domain::key_code(0, settings) ==
             "XXX and a bunch of other data",
         "custom notation is returned when configured");
  settings.notation = keyfinder::domain::NotationMode::combined;
  expect(keyfinder::domain::key_code(0, settings) ==
             "XXX and a bunch of other data A",
         "combined notation joins custom and standard codes");

  return 0;
}
