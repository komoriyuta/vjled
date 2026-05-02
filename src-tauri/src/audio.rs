use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const FFT_SIZE: usize = 2048;
const FFT_BANDS: usize = 32;
const MIN_BEAT_INTERVAL: f64 = 0.28;
const MAX_INTERVALS: usize = 12;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_input: bool,
    pub is_output: bool,
}

#[derive(Debug, Clone, Serialize)]
struct AudioAnalysisPayload {
    volume: f64,
    bass: f64,
    mid: f64,
    treble: f64,
    fft: Vec<f64>,
    bpm: f64,
    beat: bool,
    beat_phase: f64,
    beat_confidence: f64,
    beat_count: u64,
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sorted[sorted.len() / 2]
}

fn normalize_bpm(bpm: f64) -> f64 {
    let mut v = bpm;
    while v < 70.0 {
        v *= 2.0;
    }
    while v > 180.0 {
        v /= 2.0;
    }
    if v >= 70.0 && v <= 180.0 {
        v
    } else {
        0.0
    }
}

fn band_average(magnitude: &[f64], bin_count: usize, start: usize, end: usize) -> f64 {
    let from = start.min(bin_count.saturating_sub(1));
    let to = end.max(from + 1).min(bin_count);
    if from >= to {
        return 0.0;
    }
    let sum: f64 = magnitude[from..to].iter().sum();
    sum / (to - from) as f64
}

struct AnalysisState {
    bass_avg: f64,
    last_beat_time: f64,
    intervals: Vec<f64>,
    beat_count: u64,
    bpm: f64,
    confidence: f64,
}

pub struct AudioCapture {
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

unsafe impl Send for AudioCapture {}
unsafe impl Sync for AudioCapture {}

impl AudioCapture {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }

    pub fn list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
        let host = cpal::default_host();
        let mut devices: Vec<AudioDeviceInfo> = Vec::new();

        if let Ok(iter) = host.input_devices() {
            for d in iter {
                let name = d.name().unwrap_or_else(|_| "Unknown".into());
                devices.push(AudioDeviceInfo {
                    name,
                    is_input: true,
                    is_output: false,
                });
            }
        }

        if let Ok(iter) = host.output_devices() {
            for d in iter {
                let name = d.name().unwrap_or_else(|_| "Unknown".into());
                if let Some(info) = devices.iter_mut().find(|i| i.name == name) {
                    info.is_output = true;
                } else {
                    devices.push(AudioDeviceInfo {
                        name,
                        is_input: false,
                        is_output: true,
                    });
                }
            }
        }

        Ok(devices)
    }

    pub fn start(&mut self, device_name: Option<String>, app: AppHandle) -> Result<(), String> {
        self.stop();

        let running = Arc::new(AtomicBool::new(true));
        self.running = running.clone();

        let handle = std::thread::Builder::new()
            .name("audio-capture".into())
            .spawn(move || {
                if let Err(e) = run_capture(device_name, running.clone(), app) {
                    eprintln!("Audio capture error: {}", e);
                }
            })
            .map_err(|e| format!("Failed to spawn audio thread: {}", e))?;

        self.thread = Some(handle);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn run_capture(
    device_name: Option<String>,
    running: Arc<AtomicBool>,
    app: AppHandle,
) -> Result<(), String> {
    let host = cpal::default_host();

    let device = match &device_name {
        Some(name) => {
            let mut found: Option<cpal::Device> = None;
            if let Ok(iter) = host.input_devices() {
                for d in iter {
                    if d.name().map(|n| n == *name).unwrap_or(false) {
                        found = Some(d);
                        break;
                    }
                }
            }
            if found.is_none() {
                if let Ok(iter) = host.output_devices() {
                    for d in iter {
                        if d.name().map(|n| n == *name).unwrap_or(false) {
                            found = Some(d);
                            break;
                        }
                    }
                }
            }
            found.ok_or_else(|| format!("Device not found: {}", name))?
        }
        None => host
            .default_output_device()
            .or_else(|| host.default_input_device())
            .ok_or("No audio device available")?,
    };

    let config = device
        .supported_input_configs()
        .ok()
        .and_then(|mut c| c.next())
        .or_else(|| {
            device
                .supported_output_configs()
                .ok()
                .and_then(|mut c| c.next())
        })
        .ok_or("No supported audio config")?;

    let sample_rate = config.min_sample_rate().0 as usize;
    let stream_config = config
        .with_sample_rate(cpal::SampleRate(sample_rate as u32))
        .config();

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut fft_buffer: Vec<Complex<f64>> = vec![Complex::new(0.0, 0.0); FFT_SIZE];
    let mut sample_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let start_time = std::time::Instant::now();

    let mut state = AnalysisState {
        bass_avg: 0.0,
        last_beat_time: 0.0,
        intervals: Vec::new(),
        beat_count: 0,
        bpm: 0.0,
        confidence: 0.0,
    };

    let err_fn = |err: cpal::StreamError| {
        eprintln!("Audio stream error: {}", err);
    };

    let running_cb = running.clone();
    let stream = device
        .build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !running_cb.load(Ordering::SeqCst) {
                    return;
                }

                sample_buffer.extend_from_slice(data);

                while sample_buffer.len() >= FFT_SIZE {
                    let chunk: Vec<f32> = sample_buffer.drain(..FFT_SIZE).collect();
                    let now = start_time.elapsed().as_secs_f64();

                    let rms: f64 = chunk.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>()
                        / FFT_SIZE as f64;
                    let volume = (rms.sqrt() * 2.2).min(1.0).max(0.0);

                    for (i, s) in chunk.iter().enumerate() {
                        let w = 0.5
                            * (1.0
                                - (2.0 * std::f64::consts::PI * i as f64 / (FFT_SIZE - 1) as f64)
                                    .cos());
                        fft_buffer[i] = Complex::new(*s as f64 * w, 0.0);
                    }

                    fft.process(&mut fft_buffer);

                    let bin_count = FFT_SIZE / 2;
                    let magnitude: Vec<f64> = fft_buffer[..bin_count]
                        .iter()
                        .map(|c| (c.re * c.re + c.im * c.im).sqrt() / FFT_SIZE as f64)
                        .collect();

                    let bass_end = (18.0 * FFT_SIZE as f64 / sample_rate as f64) as usize;
                    let mid_end = (120.0 * FFT_SIZE as f64 / sample_rate as f64) as usize;
                    let treble_end = (420.0 * FFT_SIZE as f64 / sample_rate as f64) as usize;

                    let bass = band_average(&magnitude, bin_count, 1, bass_end.max(2));
                    let mid =
                        band_average(&magnitude, bin_count, bass_end, mid_end.max(bass_end + 1));
                    let treble =
                        band_average(&magnitude, bin_count, mid_end, treble_end.max(mid_end + 1));

                    let fft_bands: Vec<f64> = (0..FFT_BANDS)
                        .map(|i| {
                            let bs = (i * bin_count / FFT_BANDS).max(1);
                            let be = ((i + 1) * bin_count / FFT_BANDS).max(bs + 1);
                            let v = band_average(&magnitude, bin_count, bs, be);
                            (v * 10000.0).round() / 10000.0
                        })
                        .collect();

                    state.bass_avg = if state.bass_avg == 0.0 {
                        bass
                    } else {
                        state.bass_avg * 0.96 + bass * 0.04
                    };

                    let threshold = (state.bass_avg * 1.45).max(0.00012);
                    let can_beat = now - state.last_beat_time > MIN_BEAT_INTERVAL;
                    let beat = can_beat && bass > threshold && volume > 0.004;

                    if beat {
                        if state.last_beat_time > 0.0 {
                            let interval = now - state.last_beat_time;
                            if interval >= 0.28 && interval <= 1.6 {
                                state.intervals.push(interval);
                                if state.intervals.len() > MAX_INTERVALS {
                                    let excess = state.intervals.len() - MAX_INTERVALS;
                                    state.intervals.drain(..excess);
                                }
                                let detected_bpm = normalize_bpm(60.0 / median(&state.intervals));
                                if detected_bpm > 0.0 {
                                    state.bpm = if state.bpm > 0.0 {
                                        state.bpm * 0.82 + detected_bpm * 0.18
                                    } else {
                                        detected_bpm
                                    };
                                }
                                state.confidence = (state.intervals.len() as f64 / 8.0).min(1.0);
                            }
                        }
                        state.last_beat_time = now;
                        state.beat_count += 1;
                    }

                    let beat_len = if state.bpm > 0.0 {
                        60.0 / state.bpm
                    } else {
                        0.0
                    };
                    let beat_phase = if beat_len > 0.0 && state.last_beat_time > 0.0 {
                        ((now - state.last_beat_time) % beat_len / beat_len).min(1.0)
                    } else {
                        0.0
                    };

                    let payload = AudioAnalysisPayload {
                        volume: (volume * 10000.0).round() / 10000.0,
                        bass: (bass * 10000.0).round() / 10000.0,
                        mid: (mid * 10000.0).round() / 10000.0,
                        treble: (treble * 10000.0).round() / 10000.0,
                        fft: fft_bands,
                        bpm: (state.bpm * 10.0).round() / 10.0,
                        beat,
                        beat_phase: (beat_phase * 10000.0).round() / 10000.0,
                        beat_confidence: (state.confidence * 10000.0).round() / 10000.0,
                        beat_count: state.beat_count,
                    };

                    let _ = app.emit("audio-analysis", &payload);
                }

                let keep = FFT_SIZE - 1;
                if sample_buffer.len() > keep {
                    sample_buffer.drain(..sample_buffer.len() - keep);
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("Failed to build stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to play: {}", e))?;

    while running.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    drop(stream);
    Ok(())
}
