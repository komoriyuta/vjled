#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/gpio.h>
#include <new>

#if __has_include("vjled_config.h")
#include "vjled_config.h"
#else
#include "config.example.h"
#endif
#include "protocol.h"
#include "animation.h"

namespace {
constexpr size_t kStripCount = sizeof(config::kStrips) / sizeof(config::kStrips[0]);
static_assert(kStripCount > 0, "Configure at least one LED strip");
static_assert(config::kAnimationStepMs > 0, "Animation interval must be positive");
static_assert(config::kTailPixels > 0, "Animation tail must be positive");
static_assert(config::kDeviceId > 0, "Device ID 0 is reserved for broadcast");

Adafruit_NeoPixel* strips[kStripCount]{};
WiFiUDP udp;
uint8_t packetBuffer[vjled::kMaxPacketSize];
size_t totalPixels = 0;
bool ready = false;
bool bootAnimation = config::kBootAnimation;
bool listening = false;
uint32_t lastAnimation = 0;
uint32_t animationStep = 0;
uint32_t lastStatus = 0;
uint32_t lastWifiAttempt = 0;
uint32_t lastBindAttempt = 0;
vjled::FrameTimeout frameTimeout;

void show() {
  for (auto* strip : strips) strip->show();
}

void fill(uint8_t r, uint8_t g, uint8_t b) {
  for (auto* strip : strips) strip->fill(strip->Color(r, g, b));
}

void blackout() {
  fill(0, 0, 0);
  show();
  frameTimeout.reset();
}

void setPixel(size_t index, const uint8_t* rgb) {
  for (auto* strip : strips) {
    if (index < strip->numPixels()) {
      strip->setPixelColor(index, rgb[0], rgb[1], rgb[2]);
      return;
    }
    index -= strip->numPixels();
  }
}

void animate() {
  for (auto* strip : strips) {
    for (size_t i = 0; i < strip->numPixels(); ++i) {
      const auto rgb = vjled::flowingPixel(i, strip->numPixels(), animationStep,
                                         config::kTailPixels);
      strip->setPixelColor(i, rgb.r, rgb.g, rgb.b);
    }
  }
  show();
}

void handlePacket(const uint8_t* data, size_t length) {
  vjled::Packet packet{};
  if (!vjled::decode(data, length, config::kDeviceId, totalPixels, packet)) return;
  if (packet.command == vjled::Command::Ping) {
    Serial.printf("PING frame=%lu\n", static_cast<unsigned long>(packet.frame));
    return;
  }
  if (bootAnimation) {
    bootAnimation = false;
    blackout();
    Serial.println("Flow test stopped; receiving VJLED frames");
  }
  switch (packet.command) {
    case vjled::Command::Range:
      for (size_t i = 0; i < packet.count; ++i)
        setPixel(size_t(packet.start) + i, packet.rgb + i * 3);
      break;
    case vjled::Command::Fill:
      fill(packet.rgb[0], packet.rgb[1], packet.rgb[2]);
      break;
    case vjled::Command::Show:
      show();
      frameTimeout.mark(millis());
      break;
    case vjled::Command::Ping:
      break;
  }
}

void ensureWifi(uint32_t now) {
  if (config::kWifiSsid[0] == '\0') return;
  if (WiFi.status() != WL_CONNECTED) {
    if (listening) {
      udp.stop();
      listening = false;
      if (!bootAnimation) blackout();
      Serial.println("Wi-Fi disconnected");
    }
    if (uint32_t(now - lastWifiAttempt) >= 10000) {
      lastWifiAttempt = now;
      WiFi.reconnect();
    }
    return;
  }
  if (!listening && uint32_t(now - lastBindAttempt) >= 1000) {
    lastBindAttempt = now;
    listening = udp.begin(config::kUdpPort) != 0;
    if (listening) {
      Serial.printf("Wi-Fi IP=%s, UDP=%u, device=%u\n",
                    WiFi.localIP().toString().c_str(), config::kUdpPort, config::kDeviceId);
    }
  }
}

void readPackets() {
  // Bound each batch so animation, timeout, and the scheduler keep running under load.
  for (size_t i = 0; i < 32; ++i) {
    const int length = udp.parsePacket();
    if (length <= 0) break;
    if (size_t(length) > sizeof(packetBuffer)) {
      udp.flush();
      continue;
    }
    const int received = udp.read(packetBuffer, size_t(length));
    if (received == length) handlePacket(packetBuffer, size_t(received));
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  // Check all settings before assigning any output pin.
  for (size_t i = 0; i < kStripCount; ++i) {
    const auto& cfg = config::kStrips[i];
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg.pin) || cfg.pixels == 0 || cfg.pixels > 16383) {
      Serial.println("Invalid strip GPIO or pixel count");
      return;
    }
    for (size_t j = 0; j < i; ++j) {
      if (cfg.pin == config::kStrips[j].pin) {
        Serial.println("Duplicate strip GPIO");
        return;
      }
    }
    totalPixels += cfg.pixels;
  }
  if (totalPixels > 65536) {
    Serial.println("Total pixel count exceeds protocol capacity");
    return;
  }
  for (size_t i = 0; i < kStripCount; ++i) {
    const auto& cfg = config::kStrips[i];
    strips[i] = new (std::nothrow) Adafruit_NeoPixel(cfg.pixels, cfg.pin, config::kPixelType);
    if (!strips[i] || strips[i]->numPixels() != cfg.pixels || !strips[i]->begin()) {
      Serial.println("LED initialization failed");
      return;
    }
    strips[i]->setBrightness(config::kBrightness);
    strips[i]->clear();
    strips[i]->show();
    Serial.printf("GPIO%d: %u pixels\n", cfg.pin, cfg.pixels);
  }
  ready = true;
  if (bootAnimation) {
    animate();
    lastAnimation = millis();
    Serial.println("Flow test: GPIO16/17/18, 100 pixels each, 25 ms step, only final pixel white (default)");
  }
  if (config::kWifiSsid[0] != '\0') {
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(false);
    WiFi.begin(config::kWifiSsid, config::kWifiPassword);
    lastWifiAttempt = millis();
  } else {
    Serial.println("Wi-Fi disabled; flow test runs offline");
  }
}

void loop() {
  if (!ready) { delay(100); return; }
  ensureWifi(millis());
  if (listening) readPackets();
  const uint32_t now = millis();
  if (bootAnimation && uint32_t(now - lastAnimation) >= config::kAnimationStepMs) {
    lastAnimation = now;
    ++animationStep;
    animate();
  }
  if (!bootAnimation && frameTimeout.expired(now, config::kFrameTimeoutMs)) {
    blackout();
    Serial.println("No SHOW received; LEDs cleared");
  }
  if (uint32_t(now - lastStatus) >= 5000) {
    lastStatus = now;
    Serial.printf("Running: mode=%s, pixels=%u, step=%lu\n",
                  bootAnimation ? "flow" : "udp", unsigned(totalPixels),
                  static_cast<unsigned long>(animationStep));
  }
  delay(1);
}
