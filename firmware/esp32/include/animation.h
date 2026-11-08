#pragma once

#include <cstddef>
#include <cstdint>

namespace vjled {
struct Rgb { uint8_t r, g, b; };

// Each output has its own 0..(count-1) loop; the tail wraps at the strip end.
// Keep the blue-to-red gradient; only the final physical pixel is white.
inline Rgb flowingPixel(size_t pixel, size_t count, uint32_t step, size_t tail) {
  if (count == 0 || pixel >= count || tail == 0) return {0, 0, 0};
  if (tail > count) tail = count;
  const size_t distance = (step % count + count - pixel) % count;
  if (distance >= tail) return {0, 0, 0};
  const uint16_t level = uint16_t((tail - distance) * 255 / tail);
  const uint8_t red = count > 1 ? uint8_t(pixel * 255 / (count - 1)) : 0;
  const Rgb color = pixel == count - 1 ? Rgb{255, 255, 255}
                                       : Rgb{red, 0, uint8_t(255 - red)};
  return {uint8_t(uint16_t(color.r) * level / 255),
          uint8_t(uint16_t(color.g) * level / 255),
          uint8_t(uint16_t(color.b) * level / 255)};
}
}  // namespace vjled
