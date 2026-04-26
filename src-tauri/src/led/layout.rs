use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StripConfig {
    pub pin: u8,
    pub pixel_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub key: String,
    pub device_id: u16,
    #[serde(default)]
    pub controller_ip: Option<String>,
    pub strips: Vec<StripConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UdpConfig {
    #[serde(default = "default_broadcast_ip")]
    pub broadcast_ip: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_controller_ip_start")]
    pub controller_ip_start: Option<String>,
    #[serde(default)]
    pub controller_ip_stride: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WifiConfig {
    #[serde(default)]
    pub ssid: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareLayout {
    #[serde(default)]
    pub wifi: WifiConfig,
    pub udp: UdpConfig,
    pub devices: Vec<DeviceConfig>,
}

fn default_broadcast_ip() -> String {
    "192.168.11.255".to_string()
}
fn default_port() -> u16 {
    7777
}
fn default_controller_ip_start() -> Option<String> {
    None
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ResolvedStrip {
    pub pin: u8,
    pub pixel_count: usize,
    pub global_start: usize,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ResolvedDevice {
    pub key: String,
    pub device_id: u16,
    pub controller_ip: String,
    pub strips: Vec<ResolvedStrip>,
    pub total_pixels: usize,
    pub global_start: usize,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ResolvedLayout {
    pub broadcast_ip: String,
    pub port: u16,
    pub devices: Vec<ResolvedDevice>,
    pub total_pixels: usize,
    pub lantern_map: HashMap<usize, (usize, usize)>,
}

impl HardwareLayout {
    pub fn load(path: &Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read layout file: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse layout JSON: {}", e))
    }

    pub fn resolve(&self) -> ResolvedLayout {
        let mut devices = Vec::new();
        let mut global_offset = 0usize;
        let mut lantern_map = HashMap::new();

        let ip_start = self.udp.controller_ip_start.as_deref().unwrap_or("192.168.11.120");
        let ip_stride = self.udp.controller_ip_stride.unwrap_or(1);

        for (di, dev) in self.devices.iter().enumerate() {
            let controller_ip = dev.controller_ip.clone().unwrap_or_else(|| {
                let parts: Vec<u8> = ip_start
                    .split('.')
                    .filter_map(|p| p.parse().ok())
                    .collect();
                if parts.len() == 4 {
                    let last = parts[3] as u32 + (di as u32) * ip_stride;
                    format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], last)
                } else {
                    ip_start.to_string()
                }
            });

            let mut strips = Vec::new();
            let mut dev_total = 0usize;
            let dev_global_start = global_offset;

            for strip in &dev.strips {
                strips.push(ResolvedStrip {
                    pin: strip.pin,
                    pixel_count: strip.pixel_count,
                    global_start: global_offset,
                });
                for i in 0..strip.pixel_count {
                    let lantern_id = global_offset + i;
                    lantern_map.insert(lantern_id, (dev.device_id as usize, dev_total + i));
                }
                global_offset += strip.pixel_count;
                dev_total += strip.pixel_count;
            }

            devices.push(ResolvedDevice {
                key: dev.key.clone(),
                device_id: dev.device_id,
                controller_ip,
                strips,
                total_pixels: dev_total,
                global_start: dev_global_start,
            });
        }

        ResolvedLayout {
            broadcast_ip: self.udp.broadcast_ip.clone(),
            port: self.udp.port,
            devices,
            total_pixels: global_offset,
            lantern_map,
        }
    }
}
