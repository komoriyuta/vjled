#pragma once

#include <Adafruit_NeoPixel.h>
#include <cstddef>
#include <cstdint>

// Copy this file to vjled_config.h to keep local settings out of git.
namespace config {
struct Strip {
  int16_t pin;
  uint16_t pixels;
};

constexpr Strip kStrips[] = {{16, 100}, {17, 100}, {18, 100}};
constexpr neoPixelType kPixelType = NEO_GRB + NEO_KHZ800;  // WS2812B RGB
constexpr uint8_t kBrightness = 32;  // 0..255, applies to test and UDP output
constexpr bool kBootAnimation = true;
constexpr uint32_t kAnimationStepMs = 25;
constexpr size_t kTailPixels = 16;

// Optional: animation works without Wi-Fi. A valid LED command stops the test.
constexpr char kWifiSsid[] = "";
constexpr char kWifiPassword[] = "";
constexpr uint16_t kDeviceId = 1;  // device_id 0 also addresses all controllers
constexpr uint16_t kUdpPort = 7777;
constexpr uint32_t kFrameTimeoutMs = 5000;  // 0 keeps the last received frame
}  // namespace config
