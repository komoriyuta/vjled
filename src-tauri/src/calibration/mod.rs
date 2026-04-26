use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationConfig {
    #[serde(default = "default_settle_frames")]
    pub settle_frames: u32,
    #[serde(default = "default_max_attempts")]
    pub max_attempts: u32,
    #[serde(default = "default_threshold")]
    pub threshold: u8,
    #[serde(default = "default_color")]
    pub calibration_color: [u8; 3],
}

fn default_settle_frames() -> u32 {
    3
}
fn default_max_attempts() -> u32 {
    3
}
fn default_threshold() -> u8 {
    30
}
fn default_color() -> [u8; 3] {
    [255, 255, 255]
}

impl Default for CalibrationConfig {
    fn default() -> Self {
        Self {
            settle_frames: default_settle_frames(),
            max_attempts: default_max_attempts(),
            threshold: default_threshold(),
            calibration_color: default_color(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct CalibrationResult {
    pub lantern_positions: HashMap<usize, (f64, f64)>,
    pub total_lanterns: usize,
    pub detected: usize,
}

pub struct Calibrator {
    config: CalibrationConfig,
    baseline: Option<Vec<u8>>,
    width: usize,
    height: usize,
}

impl Calibrator {
    pub fn new(config: CalibrationConfig) -> Self {
        Self {
            config,
            baseline: None,
            width: 0,
            height: 0,
        }
    }

    pub fn set_baseline(&mut self, rgba_data: &[u8], width: usize, height: usize) {
        self.width = width;
        self.height = height;
        self.baseline = Some(rgba_data.to_vec());
    }

    pub fn has_baseline(&self) -> bool {
        self.baseline.is_some()
    }

    pub fn detect_led(
        &self,
        lit_frame: &[u8],
        width: usize,
        height: usize,
    ) -> Option<(f64, f64)> {
        let baseline = self.baseline.as_ref()?;
        if baseline.len() != lit_frame.len() || width != self.width || height != self.height {
            return None;
        }

        let mut sum_x = 0.0f64;
        let mut sum_y = 0.0f64;
        let mut count = 0usize;

        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) * 4;
                let dr = (lit_frame[idx] as i16 - baseline[idx] as i16).unsigned_abs() as u8;
                let dg = (lit_frame[idx + 1] as i16 - baseline[idx + 1] as i16).unsigned_abs() as u8;
                let db = (lit_frame[idx + 2] as i16 - baseline[idx + 2] as i16).unsigned_abs() as u8;

                let diff = dr.max(dg).max(db);
                if diff > self.config.threshold {
                    sum_x += x as f64;
                    sum_y += y as f64;
                    count += 1;
                }
            }
        }

        if count == 0 {
            return None;
        }

        Some((
            sum_x / count as f64 / width as f64,
            sum_y / count as f64 / height as f64,
        ))
    }
}
