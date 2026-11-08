#pragma once

#include <cstddef>
#include <cstdint>

namespace vjled {
constexpr size_t kHeaderSize = 9;
constexpr size_t kMaxPacketSize = kHeaderSize + 3 + 255 * 3;

enum class Command : uint8_t { Range = 0x00, Fill = 0x01, Show = 0x02, Ping = 0xff };

struct Packet {
  Command command;
  uint32_t frame;
  uint16_t start;
  uint8_t count;
  const uint8_t* rgb;
};

inline uint16_t read16(const uint8_t* p) {
  return uint16_t(p[0]) | (uint16_t(p[1]) << 8);
}

// Validate the entire datagram before allowing any LED buffer changes.
inline bool decode(const uint8_t* data, size_t length, uint16_t deviceId,
                   size_t pixelCount, Packet& out) {
  if (!data || length < kHeaderSize || length > kMaxPacketSize) return false;
  const uint16_t target = read16(data);
  if ((target != deviceId && target != 0) || data[3] != 0) return false;
  Packet packet{};
  packet.command = static_cast<Command>(data[2]);
  packet.frame = uint32_t(data[4]) | (uint32_t(data[5]) << 8) |
                 (uint32_t(data[6]) << 16) | (uint32_t(data[7]) << 24);
  packet.count = data[8];
  switch (packet.command) {
    case Command::Range:
      if (length < kHeaderSize + 3) return false;
      packet.start = read16(data + kHeaderSize);
      if (packet.count == 0 || data[11] != packet.count ||
          length != kHeaderSize + 3 + size_t(packet.count) * 3 ||
          size_t(packet.start) + packet.count > pixelCount) return false;
      packet.rgb = data + kHeaderSize + 3;
      break;
    case Command::Fill:
      if (length != kHeaderSize + 3 || packet.count != 1) return false;
      packet.rgb = data + kHeaderSize;
      break;
    case Command::Show:
    case Command::Ping:
      if (length != kHeaderSize || packet.count != 0) return false;
      break;
    default:
      return false;
  }
  out = packet;
  return true;
}

class FrameTimeout {
 public:
  void mark(uint32_t now) { last_ = now; active_ = true; }
  void reset() { active_ = false; }
  bool expired(uint32_t now, uint32_t timeout) const {
    return active_ && timeout != 0 && uint32_t(now - last_) >= timeout;
  }
 private:
  uint32_t last_ = 0;
  bool active_ = false;
};
}  // namespace vjled
