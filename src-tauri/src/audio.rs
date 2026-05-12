use aubio::{OnsetMode, Tempo};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use crossbeam::channel::{bounded, Receiver, Sender};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const FFT_SIZE: usize = 1024;
const HOP_SIZE: usize = 256;
const FFT_BANDS: usize = 32;
const AUBIO_BUF_SIZE: usize = 2048;
const AUBIO_HOP_SIZE: usize = 512;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_input: bool,
    pub is_output: bool,
    pub is_default: bool,
    pub is_loopback: bool,
}

#[derive(Debug, Clone, Serialize)]
struct AudioAnalysisPayload {
    fft: Vec<f64>,
    bpm: f64,
    beat: bool,
    beat_phase: f64,
    beat_count: u64,
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
    fft_floor: Vec<f64>,
    fft_peak: Vec<f64>,
    fft_smooth: Vec<f64>,
    tempo: Tempo,
    aubio_buf: Vec<f32>,
    bpm_history: Vec<f64>,
    bpm: f64,
    last_beat_time: f64,
    beat_count: u64,
    emitted_beat_count: u64,
}

impl AnalysisState {
    fn new(sample_rate: u32) -> Self {
        let tempo = Tempo::new(
            OnsetMode::SpecFlux,
            AUBIO_BUF_SIZE,
            AUBIO_HOP_SIZE,
            sample_rate,
        )
        .expect("Failed to create aubio Tempo");

        Self {
            fft_floor: vec![0.0; FFT_BANDS],
            fft_peak: vec![0.0001; FFT_BANDS],
            fft_smooth: vec![0.0; FFT_BANDS],
            tempo,
            aubio_buf: Vec::with_capacity(AUBIO_HOP_SIZE),
            bpm_history: Vec::with_capacity(8),
            bpm: 0.0,
            last_beat_time: 0.0,
            beat_count: 0,
            emitted_beat_count: 0,
        }
    }

    fn feed_aubio(&mut self, mono_samples: &[f32], now: f64) {
        self.aubio_buf.extend_from_slice(mono_samples);
        while self.aubio_buf.len() >= AUBIO_HOP_SIZE {
            let chunk: Vec<f32> = self.aubio_buf[..AUBIO_HOP_SIZE].to_vec();
            self.aubio_buf.drain(..AUBIO_HOP_SIZE);

            if let Ok(is_beat) = self.tempo.do_result(&chunk) {
                if is_beat > 0.0 {
                    self.last_beat_time = now;
                    self.beat_count += 1;
                }
            }

            let aubio_bpm = self.tempo.get_bpm();
            if aubio_bpm > 0.0 {
                let mut normalized = aubio_bpm as f64;
                while normalized < 70.0 {
                    normalized *= 2.0;
                }
                while normalized > 180.0 {
                    normalized /= 2.0;
                }
                self.bpm_history.push(normalized);
                if self.bpm_history.len() > 8 {
                    self.bpm_history.remove(0);
                }
                self.bpm = self.bpm_history.iter().sum::<f64>() / self.bpm_history.len() as f64;
            }
        }
    }

    fn is_new_beat(&mut self) -> bool {
        if self.beat_count != self.emitted_beat_count {
            self.emitted_beat_count = self.beat_count;
            true
        } else {
            false
        }
    }

    fn beat_phase(&self, now: f64) -> f64 {
        if self.bpm <= 0.0 || self.last_beat_time <= 0.0 {
            return 0.0;
        }
        let beat_len = 60.0 / self.bpm;
        let elapsed = now - self.last_beat_time;
        ((elapsed / beat_len) % 1.0).clamp(0.0, 1.0)
    }

    fn normalize_fft(&mut self, raw_fft_bands: &[f64]) -> Vec<f64> {
        let mut fft_bands = Vec::with_capacity(FFT_BANDS);
        for (i, &raw) in raw_fft_bands.iter().enumerate() {
            if self.fft_floor[i] == 0.0 {
                self.fft_floor[i] = raw;
            }
            self.fft_floor[i] = if raw < self.fft_floor[i] {
                self.fft_floor[i] * 0.82 + raw * 0.18
            } else {
                self.fft_floor[i] * 0.997 + raw * 0.003
            };
            self.fft_peak[i] = (self.fft_peak[i] * 0.992)
                .max(raw)
                .max(self.fft_floor[i] + 0.00002);

            let normalized = ((raw - self.fft_floor[i]) / (self.fft_peak[i] - self.fft_floor[i]))
                .clamp(0.0, 1.0)
                .sqrt();
            self.fft_smooth[i] = self.fft_smooth[i] * 0.58 + normalized * 0.42;
            fft_bands.push((self.fft_smooth[i] * 10000.0).round() / 10000.0);
        }
        fft_bands
    }
}

enum CaptureTarget {
    Input(cpal::Device),
    OutputLoopback(cpal::Device),
}

impl CaptureTarget {
    fn device(&self) -> &cpal::Device {
        match self {
            CaptureTarget::Input(device) | CaptureTarget::OutputLoopback(device) => device,
        }
    }

    fn is_output_loopback(&self) -> bool {
        matches!(self, CaptureTarget::OutputLoopback(_))
    }
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
        #[cfg(target_os = "linux")]
        if let Some(devices) = list_pipewire_devices() {
            return Ok(devices);
        }

        let host = cpal::default_host();
        let mut devices: Vec<AudioDeviceInfo> = Vec::new();

        devices.push(AudioDeviceInfo {
            id: "system-loopback".into(),
            name: "System audio (loopback)".into(),
            is_input: false,
            is_output: true,
            is_default: true,
            is_loopback: true,
        });

        if let Some(d) = host.default_input_device() {
            let name = d.name().unwrap_or_else(|_| "Default input".into());
            devices.push(AudioDeviceInfo {
                id: "default-input".into(),
                name: format!("Default input ({})", name),
                is_input: true,
                is_output: false,
                is_default: true,
                is_loopback: is_loopback_name(&name),
            });
        }

        if let Ok(iter) = host.input_devices() {
            for d in iter {
                let name = d.name().unwrap_or_else(|_| "Unknown".into());
                devices.push(AudioDeviceInfo {
                    id: format!("input:{}", name),
                    is_loopback: is_loopback_name(&name),
                    name,
                    is_input: true,
                    is_output: false,
                    is_default: false,
                });
            }
        }

        #[cfg(target_os = "windows")]
        if let Ok(iter) = host.output_devices() {
            for d in iter {
                let name = d.name().unwrap_or_else(|_| "Unknown".into());
                devices.push(AudioDeviceInfo {
                    id: format!("output:{}", name),
                    is_loopback: true,
                    name,
                    is_input: false,
                    is_output: true,
                    is_default: false,
                });
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
                let app_for_error = app.clone();
                if let Err(e) = run_capture(device_name, running.clone(), app) {
                    let message = e.to_string();
                    eprintln!("Audio capture error: {}", message);
                    let _ = app_for_error.emit("audio-error", message);
                }
            })
            .map_err(|e| format!("Failed to spawn audio thread: {}", e))?;

        self.thread = Some(handle);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("pkill")
                .arg("-f")
                .arg("pw-record")
                .output();
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn is_loopback_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "loopback",
        "monitor",
        ".monitor",
        "stereo mix",
        "what u hear",
        "blackhole",
        "soundflower",
        "vb-audio",
        "cable output",
        "aggregate",
    ]
    .iter()
    .any(|needle| n.contains(needle))
}

fn find_input_by_name(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    if let Ok(iter) = host.input_devices() {
        for d in iter {
            if d.name().map(|n| n == name).unwrap_or(false) {
                return Some(d);
            }
        }
    }
    None
}

fn find_output_by_name(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    if let Ok(iter) = host.output_devices() {
        for d in iter {
            if d.name().map(|n| n == name).unwrap_or(false) {
                return Some(d);
            }
        }
    }
    None
}

fn select_target(host: &cpal::Host, requested: Option<&str>) -> Result<CaptureTarget, String> {
    match requested.filter(|s| !s.is_empty()) {
        Some("default-input") => host
            .default_input_device()
            .map(CaptureTarget::Input)
            .ok_or("No default audio input device available".into()),
        Some("system-loopback") | Some("default-output-loopback") => {
            find_default_loopback(host).ok_or_else(loopback_unavailable_message)
        }
        Some(id) if id.starts_with("input:") => {
            let name = &id["input:".len()..];
            find_input_by_name(host, name)
                .map(CaptureTarget::Input)
                .ok_or_else(|| format!("Input device not found: {}", name))
        }
        Some(id) if id.starts_with("output:") => {
            let name = &id["output:".len()..];
            find_output_by_name(host, name)
                .map(CaptureTarget::OutputLoopback)
                .ok_or_else(|| format!("Output device not found: {}", name))
        }
        Some(name) => find_input_by_name(host, name)
            .map(CaptureTarget::Input)
            .or_else(|| find_output_by_name(host, name).map(CaptureTarget::OutputLoopback))
            .ok_or_else(|| format!("Device not found: {}", name)),
        None => {
            #[cfg(target_os = "macos")]
            {
                Ok(host.default_input_device()
                    .map(CaptureTarget::Input)
                    .or_else(|| find_default_loopback(host))
                    .ok_or::<String>("No audio input device available".into())?)
            }
            #[cfg(not(target_os = "macos"))]
            {
                find_default_loopback(host)
                    .or_else(|| host.default_input_device().map(CaptureTarget::Input))
                    .ok_or("No audio input device available".into())
            }
        }
    }
}

fn loopback_unavailable_message() -> String {
    #[cfg(target_os = "macos")]
    {
        return "System audio loopback requires a virtual audio driver.\nInstall BlackHole (free): https://github.com/existentialaudio/blackhole\nThen select the BlackHole device as input.".into();
    }

    #[cfg(target_os = "linux")]
    {
        return "No system audio loopback input found. Select a PulseAudio/PipeWire monitor source if it is listed.".into();
    }

    #[cfg(target_os = "windows")]
    {
        return "No default audio output device available for WASAPI loopback.".into();
    }

    #[allow(unreachable_code)]
    "No system audio loopback device available on this platform.".into()
}

#[cfg(target_os = "linux")]
fn list_pipewire_devices() -> Option<Vec<AudioDeviceInfo>> {
    if Command::new("pw-record")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .filter(|s| s.success())
        .is_none()
    {
        return None;
    }

    let mut devices = vec![
        AudioDeviceInfo {
            id: "system-loopback".into(),
            name: "System audio (PipeWire monitor)".into(),
            is_input: false,
            is_output: true,
            is_default: true,
            is_loopback: true,
        },
        AudioDeviceInfo {
            id: "pipewire-default-input".into(),
            name: "Default input (PipeWire)".into(),
            is_input: true,
            is_output: false,
            is_default: true,
            is_loopback: false,
        },
    ];

    let output = Command::new("wpctl").arg("status").output().ok()?;
    if !output.status.success() {
        return Some(devices);
    }

    let status = String::from_utf8_lossy(&output.stdout);
    let mut in_sources = false;

    for line in status.lines() {
        if line.contains("Sources:") {
            in_sources = true;
            continue;
        }
        if in_sources && (line.contains("Source endpoints:") || line.contains("Sinks:")) {
            break;
        }
        if !in_sources {
            continue;
        }

        let trimmed = line.trim().trim_start_matches('*').trim();
        let Some((id_part, rest)) = trimmed.split_once('.') else {
            continue;
        };
        let Ok(id) = id_part.trim().parse::<u32>() else {
            continue;
        };
        let name = rest.split("[vol:").next().unwrap_or(rest).trim();
        if name.is_empty() {
            continue;
        }

        devices.push(AudioDeviceInfo {
            id: format!("pipewire:{}", id),
            name: name.into(),
            is_input: true,
            is_output: false,
            is_default: line.contains('*'),
            is_loopback: is_loopback_name(name),
        });
    }

    Some(devices)
}

#[cfg(target_os = "linux")]
fn should_use_pipewire(requested: Option<&str>) -> bool {
    match requested.filter(|s| !s.is_empty()) {
        None | Some("system-loopback") | Some("pipewire-default-input") => true,
        Some(id) => id.starts_with("pipewire:"),
    }
}

#[cfg(target_os = "linux")]
fn pipewire_target(requested: Option<&str>) -> Option<String> {
    match requested.filter(|s| !s.is_empty()) {
        Some("system-loopback") | None => Some("@DEFAULT_AUDIO_SINK@".into()),
        Some("pipewire-default-input") => None,
        Some(id) if id.starts_with("pipewire:") => Some(id["pipewire:".len()..].into()),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn pipewire_capture_sink(requested: Option<&str>) -> bool {
    matches!(
        requested.filter(|s| !s.is_empty()),
        None | Some("system-loopback")
    )
}

fn run_analysis_loop(
    rx: Receiver<Vec<f32>>,
    sample_rate: u32,
    running: Arc<AtomicBool>,
    app: AppHandle,
    channels: usize,
) {
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut fft_buffer: Vec<Complex<f64>> = vec![Complex::new(0.0, 0.0); FFT_SIZE];
    let mut sample_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let start_time = std::time::Instant::now();
    let mut state = AnalysisState::new(sample_rate);

    while running.load(Ordering::SeqCst) {
        let data = match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let mono: Vec<f32> = if channels <= 1 {
            data
        } else {
            data.chunks_exact(channels)
                .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
                .collect()
        };

        sample_buffer.extend_from_slice(&mono);

        state.feed_aubio(&mono, start_time.elapsed().as_secs_f64());

        while sample_buffer.len() >= FFT_SIZE {
            let chunk: Vec<f32> = sample_buffer[..FFT_SIZE].to_vec();
            sample_buffer.drain(..HOP_SIZE);
            let now = start_time.elapsed().as_secs_f64();

            let rms: f64 =
                chunk.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / FFT_SIZE as f64;
            if rms.sqrt() < 0.002 {
                continue;
            }

            for (i, s) in chunk.iter().enumerate() {
                let w = 0.5
                    * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (FFT_SIZE - 1) as f64).cos());
                fft_buffer[i] = Complex::new(*s as f64 * w, 0.0);
            }

            fft.process(&mut fft_buffer);

            let bin_count = FFT_SIZE / 2;
            let magnitude: Vec<f64> = fft_buffer[..bin_count]
                .iter()
                .map(|c| (c.re * c.re + c.im * c.im).sqrt() / FFT_SIZE as f64)
                .collect();

            let bin_for_hz = |hz: f64| -> usize {
                ((hz * FFT_SIZE as f64 / sample_rate as f64).round() as usize).min(bin_count)
            };

            let raw_fft_bands: Vec<f64> = (0..FFT_BANDS)
                .map(|i| {
                    let min_hz = 30.0_f64;
                    let max_hz = (sample_rate as f64 / 2.0).min(16_000.0);
                    let t0 = i as f64 / FFT_BANDS as f64;
                    let t1 = (i + 1) as f64 / FFT_BANDS as f64;
                    let start_hz = min_hz * (max_hz / min_hz).powf(t0);
                    let end_hz = min_hz * (max_hz / min_hz).powf(t1);
                    let bs = bin_for_hz(start_hz).max(1);
                    let be = bin_for_hz(end_hz).max(bs + 1);
                    band_average(&magnitude, bin_count, bs, be)
                })
                .collect();

            let fft_bands = state.normalize_fft(&raw_fft_bands);

            let beat_phase = state.beat_phase(now);
            let payload = AudioAnalysisPayload {
                fft: fft_bands,
                bpm: (state.bpm * 10.0).round() / 10.0,
                beat: state.is_new_beat(),
                beat_phase: (beat_phase * 10000.0).round() / 10000.0,
                beat_count: state.beat_count,
            };

            let _ = app.emit("audio-analysis", &payload);
        }

        let keep = FFT_SIZE - 1;
        if sample_buffer.len() > keep {
            sample_buffer.drain(..sample_buffer.len() - keep);
        }
    }
}

#[cfg(target_os = "linux")]
fn run_pipewire_capture(
    requested: Option<&str>,
    running: Arc<AtomicBool>,
    app: AppHandle,
) -> Result<(), String> {
    let sample_rate: u32 = 48_000;
    let channels = 2;

    let mut command = Command::new("pw-record");
    command
        .arg("--format")
        .arg("f32")
        .arg("--rate")
        .arg(sample_rate.to_string())
        .arg("--channels")
        .arg(channels.to_string())
        .arg("--latency")
        .arg("128");
    if pipewire_capture_sink(requested) {
        command.arg("-P").arg("{ stream.capture.sink=true }");
    }
    if let Some(target) = pipewire_target(requested) {
        command.arg("--target").arg(target);
    }
    command
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start pw-record: {}", e))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Failed to read pw-record stdout")?;

    eprintln!(
        "Audio: using PipeWire {}",
        pipewire_target(requested).unwrap_or_else(|| "default input".into())
    );

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut fft_buffer: Vec<Complex<f64>> = vec![Complex::new(0.0, 0.0); FFT_SIZE];
    let mut sample_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let start_time = std::time::Instant::now();
    let mut state = AnalysisState::new(sample_rate);

    let mut bytes = vec![0_u8; 4096 * channels * std::mem::size_of::<f32>()];
    while running.load(Ordering::SeqCst) {
        let n = match stdout.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };

        if !running.load(Ordering::SeqCst) {
            break;
        }

        let mut samples = Vec::with_capacity(n / 4);
        for chunk in bytes[..n].chunks_exact(4) {
            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }

        let mono: Vec<f32> = samples
            .chunks_exact(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
            .collect();

        sample_buffer.extend_from_slice(&mono);

        state.feed_aubio(&mono, start_time.elapsed().as_secs_f64());

        while sample_buffer.len() >= FFT_SIZE {
            let chunk: Vec<f32> = sample_buffer[..FFT_SIZE].to_vec();
            sample_buffer.drain(..HOP_SIZE);
            let now = start_time.elapsed().as_secs_f64();

            let rms: f64 =
                chunk.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / FFT_SIZE as f64;
            if rms.sqrt() < 0.002 {
                continue;
            }

            for (i, s) in chunk.iter().enumerate() {
                let w = 0.5
                    * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (FFT_SIZE - 1) as f64).cos());
                fft_buffer[i] = Complex::new(*s as f64 * w, 0.0);
            }

            fft.process(&mut fft_buffer);

            let bin_count = FFT_SIZE / 2;
            let magnitude: Vec<f64> = fft_buffer[..bin_count]
                .iter()
                .map(|c| (c.re * c.re + c.im * c.im).sqrt() / FFT_SIZE as f64)
                .collect();

            let bin_for_hz = |hz: f64| -> usize {
                ((hz * FFT_SIZE as f64 / sample_rate as f64).round() as usize).min(bin_count)
            };

            let raw_fft_bands: Vec<f64> = (0..FFT_BANDS)
                .map(|i| {
                    let min_hz = 30.0_f64;
                    let max_hz = (sample_rate as f64 / 2.0).min(16_000.0);
                    let t0 = i as f64 / FFT_BANDS as f64;
                    let t1 = (i + 1) as f64 / FFT_BANDS as f64;
                    let start_hz = min_hz * (max_hz / min_hz).powf(t0);
                    let end_hz = min_hz * (max_hz / min_hz).powf(t1);
                    let bs = bin_for_hz(start_hz).max(1);
                    let be = bin_for_hz(end_hz).max(bs + 1);
                    band_average(&magnitude, bin_count, bs, be)
                })
                .collect();

            let fft_bands = state.normalize_fft(&raw_fft_bands);

            let beat_phase = state.beat_phase(now);
            let payload = AudioAnalysisPayload {
                fft: fft_bands,
                bpm: (state.bpm * 10.0).round() / 10.0,
                beat: state.is_new_beat(),
                beat_phase: (beat_phase * 10000.0).round() / 10000.0,
                beat_count: state.beat_count,
            };

            let _ = app.emit("audio-analysis", &payload);
        }

        let keep = FFT_SIZE - 1;
        if sample_buffer.len() > keep {
            sample_buffer.drain(..sample_buffer.len() - keep);
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    running.store(false, Ordering::SeqCst);
    Ok(())
}

fn mic_error(e: cpal::BuildStreamError) -> String {
    #[cfg(target_os = "macos")]
    {
        format!(
            "Failed to open audio input: {}. If microphone permission was denied, grant it in System Settings > Privacy & Security > Microphone.",
            e
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!("Failed to open audio input: {}", e)
    }
}

fn find_default_loopback(host: &cpal::Host) -> Option<CaptureTarget> {
    if let Ok(iter) = host.input_devices() {
        for d in iter {
            if let Ok(name) = d.name() {
                if is_loopback_name(&name) {
                    return Some(CaptureTarget::Input(d));
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(d) = host.default_output_device() {
        return Some(CaptureTarget::OutputLoopback(d));
    }

    None
}

fn get_best_config(target: &CaptureTarget) -> Option<cpal::SupportedStreamConfigRange> {
    let device = target.device();
    let mut configs: Vec<cpal::SupportedStreamConfigRange> = Vec::new();

    if target.is_output_loopback() {
        if let Ok(supported) = device.supported_output_configs() {
            configs.extend(supported.filter(|c| {
                c.max_sample_rate().0 >= 8000
                    && matches!(
                        c.sample_format(),
                        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
                    )
            }));
        }
    } else if let Ok(supported) = device.supported_input_configs() {
        configs.extend(supported.filter(|c| {
            c.max_sample_rate().0 >= 8000
                && matches!(
                    c.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
                )
        }));
    }

    configs.sort_by(|a, b| {
        let a_priority = match a.sample_format() {
            SampleFormat::F32 => 3,
            SampleFormat::I16 => 2,
            _ => 1,
        };
        let b_priority = match b.sample_format() {
            SampleFormat::F32 => 3,
            SampleFormat::I16 => 2,
            _ => 1,
        };
        b_priority.cmp(&a_priority)
    });

    configs.into_iter().next()
}

fn run_capture(
    device_name: Option<String>,
    running: Arc<AtomicBool>,
    app: AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if should_use_pipewire(device_name.as_deref()) {
        return run_pipewire_capture(device_name.as_deref(), running, app);
    }

    let host = cpal::default_host();

    let target = select_target(&host, device_name.as_deref())?;
    let device = target.device();

    let device_display_name = device.name().unwrap_or_else(|_| "Unknown".into());
    eprintln!(
        "Audio: using {} '{}'",
        if target.is_output_loopback() {
            "output loopback"
        } else {
            "input"
        },
        device_display_name
    );

    let supported = get_best_config(&target).ok_or("No supported audio config for device")?;

    let sample_format = supported.sample_format();
    let target_rate = 48000
        .min(supported.max_sample_rate().0)
        .max(supported.min_sample_rate().0);
    let config = supported
        .with_sample_rate(cpal::SampleRate(target_rate))
        .config();
    let channels = config.channels as usize;

    eprintln!(
        "Audio: format={:?}, rate={}, channels={}",
        sample_format, target_rate, channels
    );

    let (tx, rx): (Sender<Vec<f32>>, Receiver<Vec<f32>>) = bounded(8);

    let analysis_running = running.clone();
    let analysis_app = app.clone();
    std::thread::Builder::new()
        .name("audio-analysis".into())
        .spawn(move || {
            run_analysis_loop(rx, target_rate, analysis_running, analysis_app, channels);
        })
        .map_err(|e| format!("Failed to spawn analysis thread: {}", e))?;

    let err_fn = |err: cpal::StreamError| {
        eprintln!("Audio stream error: {}", err);
    };

    let stream = match sample_format {
        SampleFormat::F32 => {
            let tx = tx.clone();
            device
                .build_input_stream(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let _ = tx.try_send(data.to_vec());
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| mic_error(e))?
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            device
                .build_input_stream(
                    &config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                        let _ = tx.try_send(f32_data);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| mic_error(e))?
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            device
                .build_input_stream(
                    &config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let f32_data: Vec<f32> = data
                            .iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect();
                        let _ = tx.try_send(f32_data);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| mic_error(e))?
        }
        _ => return Err(format!("Unsupported sample format: {:?}", sample_format)),
    };

    stream
        .play()
        .map_err(|e| format!("Failed to play: {}", e))?;

    while running.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    drop(stream);
    drop(tx);
    running.store(false, Ordering::SeqCst);
    Ok(())
}
