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

    pub fn detect_led(&self, lit_frame: &[u8], width: usize, height: usize) -> Option<(f64, f64)> {
        let baseline = self.baseline.as_ref()?;
        if baseline.len() != lit_frame.len() || width != self.width || height != self.height {
            return None;
        }

        let mut diffs = vec![0.0f64; width * height];
        let mut best_x = 0usize;
        let mut best_y = 0usize;
        let mut best_diff = 0.0f64;

        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) * 4;
                let px = y * width + x;
                let lit_luma = 0.2126 * lit_frame[idx] as f64
                    + 0.7152 * lit_frame[idx + 1] as f64
                    + 0.0722 * lit_frame[idx + 2] as f64;
                let base_luma = 0.2126 * baseline[idx] as f64
                    + 0.7152 * baseline[idx + 1] as f64
                    + 0.0722 * baseline[idx + 2] as f64;

                let diff = lit_luma - base_luma;
                diffs[px] = diff.max(0.0);
                if diff > best_diff {
                    best_diff = diff;
                    best_x = x;
                    best_y = y;
                }
            }
        }

        if best_diff <= self.config.threshold as f64 {
            return None;
        }

        let adaptive_threshold = (self.config.threshold as f64).max(best_diff * 0.55);
        let radius = ((width.max(height) as f64) * 0.025).round().clamp(4.0, 28.0) as isize;
        let x0 = best_x as isize;
        let y0 = best_y as isize;
        let mut weighted_x = 0.0f64;
        let mut weighted_y = 0.0f64;
        let mut weight_sum = 0.0f64;

        for y in (y0 - radius).max(0)..=(y0 + radius).min(height as isize - 1) {
            for x in (x0 - radius).max(0)..=(x0 + radius).min(width as isize - 1) {
                let dx = x - x0;
                let dy = y - y0;
                if dx * dx + dy * dy > radius * radius {
                    continue;
                }
                let diff = diffs[y as usize * width + x as usize];
                if diff < adaptive_threshold {
                    continue;
                }
                let weight = diff - adaptive_threshold;
                weighted_x += (x as f64 + 0.5) * weight;
                weighted_y += (y as f64 + 0.5) * weight;
                weight_sum += weight;
            }
        }

        if weight_sum > 0.0 {
            return Some((
                weighted_x / weight_sum / width as f64,
                weighted_y / weight_sum / height as f64,
            ));
        }

        Some((
            (best_x as f64 + 0.5) / width as f64,
            (best_y as f64 + 0.5) / height as f64,
        ))
    }
}
