#include <iostream>
#include <string>

#include "keyfinder/protocol.hpp"

int main() {
  std::ios::sync_with_stdio(false);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }
    std::cout << keyfinder::protocol::process_line(line) << '\n' << std::flush;
  }

  return 0;
}
