use crate::led::layout::{HardwareLayout, ResolvedLayout};
use crate::led::protocol::NeoPixelProtocol;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct MultiDeviceLEDController {
    protocol: Mutex<NeoPixelProtocol>,
    layout: ResolvedLayout,
}

impl MultiDeviceLEDController {
    pub fn from_layout(layout: &HardwareLayout) -> Result<Self, String> {
        let resolved = layout.resolve();
        let protocol = NeoPixelProtocol::new(&resolved.broadcast_ip, resolved.port)?;
        Ok(Self {
            protocol: Mutex::new(protocol),
            layout: resolved,
        })
    }

    pub fn simple(
        broadcast_ip: &str,
        port: u16,
        device_id: u16,
        pixel_count: usize,
    ) -> Result<Self, String> {
        let layout_json = serde_json::json!({
            "udp": {
                "broadcast_ip": broadcast_ip,
                "port": port,
            },
            "devices": [{
                "key": "default",
                "device_id": device_id,
                "strips": [{"pin": 16, "pixel_count": pixel_count}]
            }]
        });
        let layout: HardwareLayout =
            serde_json::from_value(layout_json).map_err(|e| format!("Layout error: {}", e))?;
        Self::from_layout(&layout)
    }

    pub fn total_pixels(&self) -> usize {
        self.layout.total_pixels
    }

    pub fn device_count(&self) -> usize {
        self.layout.devices.len()
    }

    pub fn apply_colors(&self, colors: &HashMap<usize, [u8; 3]>) -> Result<(), String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        for device in &self.layout.devices {
            let mut pixels: Vec<(u8, u8, u8)> = Vec::new();
            let mut start_local: Option<usize> = None;

            for local_idx in 0..device.total_pixels {
                let global_idx = device.global_start + local_idx;
                if let Some([r, g, b]) = colors.get(&global_idx) {
                    if start_local.is_none() {
                        start_local = Some(local_idx);
                        pixels.clear();
                    }
                    pixels.push((*r, *g, *b));
                } else if start_local.is_some() {
                    if !pixels.is_empty() {
                        proto.send_set_pixel_range(
                            device.device_id,
                            start_local.unwrap() as u16,
                            &pixels,
                        )?;
                    }
                    start_local = None;
                    pixels.clear();
                }
            }

            if !pixels.is_empty() {
                proto.send_set_pixel_range(
                    device.device_id,
                    start_local.unwrap() as u16,
                    &pixels,
                )?;
            }

            proto.send_show(device.device_id)?;
        }

        Ok(())
    }

    pub fn fill_all(&self, r: u8, g: u8, b: u8) -> Result<(), String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        for device in &self.layout.devices {
            proto.send_fill_color(device.device_id, r, g, b)?;
            proto.send_show(device.device_id)?;
        }
        Ok(())
    }

    pub fn all_off(&self) -> Result<(), String> {
        self.fill_all(0, 0, 0)
    }

    pub fn set_pixel(&self, lantern_id: usize, r: u8, g: u8, b: u8) -> Result<(), String> {
        let mut colors = HashMap::new();
        colors.insert(lantern_id, [r, g, b]);
        self.apply_colors(&colors)
    }

    pub fn ping(&self) -> Result<(), String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        for device in &self.layout.devices {
            proto.send_ping(device.device_id)?;
        }
        Ok(())
    }

    pub fn layout_info(&self) -> LayoutInfo {
        LayoutInfo {
            total_pixels: self.layout.total_pixels,
            device_count: self.layout.devices.len(),
            devices: self
                .layout
                .devices
                .iter()
                .map(|d| DeviceInfo {
                    key: d.key.clone(),
                    device_id: d.device_id,
                    total_pixels: d.total_pixels,
                    controller_ip: d.controller_ip.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub key: String,
    pub device_id: u16,
    pub total_pixels: usize,
    pub controller_ip: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutInfo {
    pub total_pixels: usize,
    pub device_count: usize,
    pub devices: Vec<DeviceInfo>,
}
