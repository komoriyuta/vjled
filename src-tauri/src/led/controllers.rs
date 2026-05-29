use crate::led::layout::{HardwareLayout, ResolvedLayout};
use crate::led::protocol::{NeoPixelProtocol, UdpSendReport};
use std::collections::HashMap;
use std::sync::Mutex;

pub struct MultiDeviceLEDController {
    protocol: Mutex<NeoPixelProtocol>,
    layout: ResolvedLayout,
}

impl MultiDeviceLEDController {
    pub fn from_layout(layout: &HardwareLayout) -> Result<Self, String> {
        let resolved = layout.resolve();
        let protocol = NeoPixelProtocol::new()?;
        Ok(Self {
            protocol: Mutex::new(protocol),
            layout: resolved,
        })
    }

    pub fn simple(
        target_ip: &str,
        port: u16,
        device_id: u16,
        pixel_count: usize,
    ) -> Result<Self, String> {
        let layout_json = serde_json::json!({
            "udp": {
                "broadcast_ip": target_ip,
                "port": port,
            },
            "devices": [{
                "key": "default",
                "device_id": device_id,
                "controller_ip": target_ip,
                "strips": [{"pin": 16, "pixel_count": pixel_count}]
            }]
        });
        let layout: HardwareLayout =
            serde_json::from_value(layout_json).map_err(|e| format!("Layout error: {}", e))?;
        Self::from_layout(&layout)
    }

    #[allow(dead_code)]
    pub fn total_pixels(&self) -> usize {
        self.layout.total_pixels
    }

    #[allow(dead_code)]
    pub fn device_count(&self) -> usize {
        self.layout.devices.len()
    }

    pub fn apply_colors(&self, colors: &HashMap<usize, [u8; 3]>) -> Result<(), String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let port = self.layout.port;

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
                    if let Some(start) = start_local {
                        proto.send_set_pixel_range_to(
                            device.device_id,
                            start as u16,
                            &pixels,
                            &device.controller_ip,
                            port,
                        )?;
                    }
                    start_local = None;
                    pixels.clear();
                }
            }

            if let Some(start) = start_local {
                proto.send_set_pixel_range_to(
                    device.device_id,
                    start as u16,
                    &pixels,
                    &device.controller_ip,
                    port,
                )?;
            }

            proto.send_show_to(device.device_id, &device.controller_ip, port)?;
        }

        Ok(())
    }

    pub fn apply_sampled_frame(
        &self,
        lantern_ids: &[usize],
        rgba_data: &[u8],
    ) -> Result<(), String> {
        if rgba_data.len() < lantern_ids.len() * 4 {
            return Err("Sampled frame rgba_data is shorter than lantern_ids".to_string());
        }

        let mut frame = vec![None; self.layout.total_pixels];
        for (i, lantern_id) in lantern_ids.iter().enumerate() {
            if *lantern_id >= frame.len() {
                continue;
            }
            let offset = i * 4;
            frame[*lantern_id] = Some([
                rgba_data[offset],
                rgba_data[offset + 1],
                rgba_data[offset + 2],
            ]);
        }

        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let port = self.layout.port;

        for device in &self.layout.devices {
            let mut pixels: Vec<(u8, u8, u8)> = Vec::new();
            let mut start_local: Option<usize> = None;

            for local_idx in 0..device.total_pixels {
                let global_idx = device.global_start + local_idx;
                if let Some([r, g, b]) = frame[global_idx] {
                    if start_local.is_none() {
                        start_local = Some(local_idx);
                        pixels.clear();
                    }
                    pixels.push((r, g, b));
                } else if start_local.is_some() {
                    if let Some(start) = start_local {
                        proto.send_set_pixel_range_to(
                            device.device_id,
                            start as u16,
                            &pixels,
                            &device.controller_ip,
                            port,
                        )?;
                    }
                    start_local = None;
                    pixels.clear();
                }
            }

            if let Some(start) = start_local {
                proto.send_set_pixel_range_to(
                    device.device_id,
                    start as u16,
                    &pixels,
                    &device.controller_ip,
                    port,
                )?;
            }

            proto.send_show_to(device.device_id, &device.controller_ip, port)?;
        }

        Ok(())
    }

    pub fn fill_all(&self, r: u8, g: u8, b: u8) -> Result<(), String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let port = self.layout.port;

        for device in &self.layout.devices {
            proto.send_fill_color_to(device.device_id, r, g, b, &device.controller_ip, port)?;
            proto.send_show_to(device.device_id, &device.controller_ip, port)?;
        }
        Ok(())
    }

    pub fn debug_fill_all(&self, r: u8, g: u8, b: u8) -> Result<Vec<UdpSendReport>, String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let port = self.layout.port;
        let mut reports = Vec::new();

        for device in &self.layout.devices {
            reports.push(proto.send_fill_color_report_to(
                device.device_id,
                r,
                g,
                b,
                &device.controller_ip,
                port,
            )?);
            reports.push(proto.send_show_report_to(
                device.device_id,
                &device.controller_ip,
                port,
            )?);
        }
        Ok(reports)
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
        let port = self.layout.port;

        for device in &self.layout.devices {
            proto.send_ping_to(device.device_id, &device.controller_ip, port)?;
        }
        Ok(())
    }

    pub fn debug_ping(&self) -> Result<Vec<UdpSendReport>, String> {
        let mut proto = self
            .protocol
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let port = self.layout.port;
        let mut reports = Vec::new();

        for device in &self.layout.devices {
            reports.push(proto.send_ping_report_to(
                device.device_id,
                &device.controller_ip,
                port,
            )?);
        }
        Ok(reports)
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
