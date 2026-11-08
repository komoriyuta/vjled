#include "animation.h"
#include "protocol.h"
#include <cassert>
#include <cstdio>
#include <vector>

using vjled::Command;

std::vector<uint8_t> header(uint16_t device, Command command, uint8_t count) {
  return {uint8_t(device), uint8_t(device >> 8), uint8_t(command), 0,
          0x78, 0x56, 0x34, 0x12, count};
}

std::vector<uint8_t> range(uint16_t start, uint8_t count) {
  auto data = header(1, Command::Range, count);
  data.insert(data.end(), {uint8_t(start), uint8_t(start >> 8), count});
  for (size_t i = 0; i < count; ++i)
    data.insert(data.end(), {uint8_t(i), uint8_t(i + 1), uint8_t(i + 2)});
  return data;
}

void protocolTests() {
  vjled::Packet packet{};
  // Exact packet emitted by the existing Rust NeoPixel encoder.
  const uint8_t golden[] = {0x34, 0x12, 0, 0, 0x78, 0x56, 0x34, 0x12,
                           2, 0, 1, 2, 1, 2, 3, 4, 5, 6};
  assert(vjled::decode(golden, sizeof(golden), 0x1234, 300, packet));
  assert(packet.frame == 0x12345678 && packet.start == 256 && packet.count == 2);
  assert(packet.rgb[0] == 1 && packet.rgb[5] == 6);
  for (size_t length = 0; length < sizeof(golden); ++length)
    assert(!vjled::decode(golden, length, 0x1234, 300, packet));
  assert(!vjled::decode(nullptr, 9, 1, 300, packet));

  // A 300-pixel frame is sent in 255+45 chunks, then SHOW.
  for (auto data : {range(0, 255), range(255, 45), range(99, 2), range(199, 2)}) {
    assert(vjled::decode(data.data(), data.size(), 1, 300, packet));
    data.push_back(0);
    assert(!vjled::decode(data.data(), data.size(), 1, 300, packet));
  }
  auto data = range(299, 1);
  assert(vjled::decode(data.data(), data.size(), 1, 300, packet));
  data = range(299, 2);
  assert(!vjled::decode(data.data(), data.size(), 1, 300, packet));
  data = range(65535, 2);
  assert(!vjled::decode(data.data(), data.size(), 1, 65536, packet));
  data = range(0, 0);
  assert(!vjled::decode(data.data(), data.size(), 1, 300, packet));
  data = range(0, 2);
  data[11] = 1;
  assert(!vjled::decode(data.data(), data.size(), 1, 300, packet));

  for (auto command : {Command::Fill, Command::Show, Command::Ping}) {
    data = header(1, command, command == Command::Fill ? 1 : 0);
    if (command == Command::Fill) data.insert(data.end(), {255, 128, 64});
    assert(vjled::decode(data.data(), data.size(), 1, 300, packet));
    assert(!vjled::decode(data.data(), data.size(), 2, 300, packet));
    data[0] = 0;  // Legacy device broadcast ID.
    assert(vjled::decode(data.data(), data.size(), 2, 300, packet));
    data[3] = 1;
    assert(!vjled::decode(data.data(), data.size(), 2, 300, packet));
    data[3] = 0;
    data[8] = 17;
    assert(!vjled::decode(data.data(), data.size(), 2, 300, packet));
  }
  data = header(1, static_cast<Command>(0x70), 0);
  assert(!vjled::decode(data.data(), data.size(), 1, 300, packet));
}

void animationTests() {
  const auto blue = vjled::flowingPixel(0, 100, 0, 16);
  const auto red = vjled::flowingPixel(98, 100, 98, 16);
  const auto white = vjled::flowingPixel(99, 100, 99, 16);
  assert(blue.r == 0 && blue.g == 0 && blue.b == 255);
  assert(red.r == 252 && red.g == 0 && red.b == 3);
  assert(white.r == 255 && white.g == 255 && white.b == 255);
  // Every earlier LED retains its original blue-to-red color.
  for (size_t i = 0; i < 99; ++i) {
    const auto rgb = vjled::flowingPixel(i, 100, uint32_t(i), 16);
    assert(rgb.r == i * 255 / 99 && rgb.g == 0 && rgb.b == 255 - rgb.r);
  }
  // Head wraps, only 16 LEDs are lit, brightness fades behind the head.
  for (uint32_t step = 0; step < 300; ++step) {
    size_t lit = 0;
    for (size_t i = 0; i < 100; ++i) {
      auto rgb = vjled::flowingPixel(i, 100, step, 16);
      if (rgb.r || rgb.g || rgb.b) ++lit;
    }
    assert(lit == 16);
    auto head = vjled::flowingPixel(step % 100, 100, step, 16);
    if (step % 100 == 99) assert(head.r == 255 && head.g == 255 && head.b == 255);
    else assert(head.r + head.b == 255 && head.g == 0);
    auto off = vjled::flowingPixel((step + 1) % 100, 100, step, 16);
    assert(off.r == 0 && off.g == 0 && off.b == 0);
  }
  auto zero = vjled::flowingPixel(0, 0, 0, 16);
  assert(zero.r == 0 && zero.b == 0);
  auto single = vjled::flowingPixel(0, 1, UINT32_MAX, 16);
  assert(single.r == 255 && single.g == 255 && single.b == 255);
}

void timeoutTests() {
  vjled::FrameTimeout timeout;
  assert(!timeout.expired(100000, 5000));
  timeout.mark(100);
  assert(!timeout.expired(5099, 5000));
  assert(timeout.expired(5100, 5000));
  assert(!timeout.expired(100000, 0));
  timeout.mark(UINT32_MAX - 100);
  assert(!timeout.expired(4898, 5000));
  assert(timeout.expired(4899, 5000));
  timeout.reset();
  assert(!timeout.expired(100000, 5000));
}

int main() {
  protocolTests();
  animationTests();
  timeoutTests();
  std::puts("PASS: sender compatibility, malformed packets, 300-pixel chunks, blue/red flow with final pixel white, timeout rollover");
}
