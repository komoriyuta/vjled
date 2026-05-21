use anyhow::anyhow;
use crossbeam::channel::{bounded, Receiver, Sender};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use tract_onnx::prelude::*;

const MODEL_SAMPLE_RATE: u32 = 16_000;
const MEL_BANDS: usize = 96;
const MEL_FRAMES: usize = 128;
const FFT_SIZE: usize = 512;
const HOP_SIZE: usize = 256;
const BUFFER_SAMPLES: usize = FFT_SIZE + HOP_SIZE * (MEL_FRAMES - 1);
const CLASSIFY_INTERVAL_SECONDS: usize = 8;

const TAG_LIMIT: usize = 5;

#[derive(Debug, Clone, Serialize)]
pub struct GenrePrediction {
    pub label: String,
    pub confidence: f32,
    pub tags: Vec<MusicTag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MusicTag {
    pub label: String,
    pub confidence: f32,
}

type RunnableModel = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

pub struct GenreClassifier {
    sample_tx: Option<Sender<Vec<f32>>>,
    prediction_rx: Receiver<GenrePrediction>,
    resampled: VecDeque<f32>,
    resample_pos: f64,
    samples_since_classify: usize,
    sample_rate: u32,
    last_prediction: Option<GenrePrediction>,
}

impl GenreClassifier {
    pub fn new(sample_rate: u32) -> Self {
        let (sample_tx, sample_rx) = bounded::<Vec<f32>>(1);
        let (prediction_tx, prediction_rx) = bounded::<GenrePrediction>(2);
        let worker_sample_tx = Some(sample_tx);

        let _ = std::thread::Builder::new()
            .name("music-genre-inference".into())
            .spawn(move || run_genre_worker(sample_rx, prediction_tx));

        Self {
            sample_tx: worker_sample_tx,
            prediction_rx,
            resampled: VecDeque::with_capacity(BUFFER_SAMPLES + MODEL_SAMPLE_RATE as usize),
            resample_pos: 0.0,
            samples_since_classify: 0,
            sample_rate,
            last_prediction: None,
        }
    }

    pub fn push_mono(&mut self, mono: &[f32]) -> Option<GenrePrediction> {
        for prediction in self.prediction_rx.try_iter() {
            self.last_prediction = Some(prediction);
        }

        self.append_resampled(mono);
        if self.resampled.len() < BUFFER_SAMPLES {
            return self.last_prediction.clone();
        }

        self.samples_since_classify += mono.len();
        if self.samples_since_classify < self.sample_rate as usize * CLASSIFY_INTERVAL_SECONDS {
            return self.last_prediction.clone();
        }
        self.samples_since_classify = 0;

        if let Some(sample_tx) = &self.sample_tx {
            let samples: Vec<f32> = self
                .resampled
                .iter()
                .skip(self.resampled.len().saturating_sub(BUFFER_SAMPLES))
                .copied()
                .collect();
            let _ = sample_tx.try_send(samples);
        }

        self.last_prediction.clone()
    }

    fn append_resampled(&mut self, mono: &[f32]) {
        if mono.is_empty() {
            return;
        }

        let step = self.sample_rate as f64 / MODEL_SAMPLE_RATE as f64;
        while self.resample_pos < mono.len() as f64 {
            let idx = self.resample_pos.floor() as usize;
            let frac = (self.resample_pos - idx as f64) as f32;
            let a = mono[idx.min(mono.len() - 1)];
            let b = mono[(idx + 1).min(mono.len() - 1)];
            self.resampled.push_back(a + (b - a) * frac);
            self.resample_pos += step;
        }
        self.resample_pos -= mono.len() as f64;

        let max_len = BUFFER_SAMPLES + MODEL_SAMPLE_RATE as usize;
        while self.resampled.len() > max_len {
            self.resampled.pop_front();
        }
    }
}

struct GenreModelRuntime {
    embedding_model: RunnableModel,
    labels: Vec<String>,
    fft: Arc<dyn Fft<f32>>,
    fft_buffer: Vec<Complex<f32>>,
    mel_filters: Vec<Vec<(usize, f32)>>,
}

impl GenreModelRuntime {
    fn load() -> TractResult<Self> {
        let embedding_path = model_path("discogs-effnet-bsdynamic-1.onnx")
            .filter(|path| path.exists())
            .ok_or_else(|| anyhow!("Discogs EffNet model is not bundled"))?;
        let labels = load_labels(&embedding_path)?;
        let embedding_model = load_embedding_model(&embedding_path)?;
        let mut planner = FftPlanner::new();

        Ok(Self {
            embedding_model,
            labels,
            fft: planner.plan_fft_forward(FFT_SIZE),
            fft_buffer: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            mel_filters: build_mel_filters(),
        })
    }

    fn predict(&mut self, samples: &[f32]) -> TractResult<GenrePrediction> {
        let features = self.log_mel(samples);
        let input = tract_ndarray::Array3::from_shape_vec((1, MEL_FRAMES, MEL_BANDS), features)?
            .into_tensor();
        let embedding_result = self.embedding_model.run(tvec!(input.into()))?;
        let scores = embedding_result[0]
            .to_array_view::<f32>()?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let mut tags = scores
            .into_iter()
            .zip(self.labels.iter())
            .map(|(confidence, label)| MusicTag {
                label: label.clone(),
                confidence,
            })
            .collect::<Vec<_>>();
        tags.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
        tags.truncate(TAG_LIMIT);
        let primary = &tags[0];

        Ok(GenrePrediction {
            label: genre_from_discogs_label(&primary.label),
            confidence: primary.confidence,
            tags,
        })
    }

    fn log_mel(&mut self, samples: &[f32]) -> Vec<f32> {
        let mut features = vec![0.0; MEL_FRAMES * MEL_BANDS];
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos()
            })
            .collect();

        for frame in 0..MEL_FRAMES {
            let start = frame * HOP_SIZE;
            for i in 0..FFT_SIZE {
                self.fft_buffer[i] = Complex::new(samples[start + i] * window[i], 0.0);
            }
            self.fft.process(&mut self.fft_buffer);

            let power: Vec<f32> = self.fft_buffer[..FFT_SIZE / 2 + 1]
                .iter()
                .map(|c| (c.re * c.re + c.im * c.im) / FFT_SIZE as f32)
                .collect();

            for band in 0..MEL_BANDS {
                let energy = self.mel_filters[band]
                    .iter()
                    .map(|(bin, weight)| power[*bin] * *weight)
                    .sum::<f32>()
                    .max(1e-10);
                features[frame * MEL_BANDS + band] = energy.log10();
            }
        }

        let mean = features.iter().sum::<f32>() / features.len() as f32;
        let variance = features
            .iter()
            .map(|v| {
                let d = *v - mean;
                d * d
            })
            .sum::<f32>()
            / features.len() as f32;
        let std = variance.sqrt().max(1e-6);
        for v in &mut features {
            *v = (*v - mean) / std;
        }
        features
    }
}

fn run_genre_worker(sample_rx: Receiver<Vec<f32>>, prediction_tx: Sender<GenrePrediction>) {
    let mut runtime = match GenreModelRuntime::load() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("Music genre inference disabled: {}", e);
            return;
        }
    };

    while let Ok(samples) = sample_rx.recv() {
        match runtime.predict(&samples) {
            Ok(prediction) => {
                let _ = prediction_tx.try_send(prediction);
            }
            Err(e) => {
                eprintln!("Music genre inference failed: {}", e);
            }
        }
    }
}

fn model_path(file_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("../Resources/models").join(file_name));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("models").join(file_name));
        candidates.push(cwd.join("src-tauri/models").join(file_name));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .or_else(|| {
            std::env::current_exe().ok().and_then(|exe| {
                exe.parent()?
                    .join("../Resources/models")
                    .join(file_name)
                    .canonicalize()
                    .ok()
            })
        })
}

fn load_embedding_model(path: &PathBuf) -> TractResult<RunnableModel> {
    tract_onnx::onnx()
        .model_for_path(path)?
        .with_input_fact(
            0,
            InferenceFact::dt_shape(f32::datum_type(), tvec!(1, MEL_FRAMES, MEL_BANDS)),
        )?
        .into_optimized()?
        .into_runnable()
}

#[derive(serde::Deserialize)]
struct DiscogsMetadata {
    classes: Vec<String>,
}

fn load_labels(model_path: &std::path::Path) -> TractResult<Vec<String>> {
    let metadata_path = model_path.with_extension("json");
    let content = std::fs::read_to_string(metadata_path)?;
    let metadata: DiscogsMetadata = serde_json::from_str(&content)?;
    Ok(metadata.classes)
}

fn genre_from_discogs_label(label: &str) -> String {
    label
        .split_once("---")
        .map_or(label, |(genre, _)| genre)
        .to_string()
}

fn build_mel_filters() -> Vec<Vec<(usize, f32)>> {
    let min_mel = hz_to_mel(20.0);
    let max_mel = hz_to_mel(MODEL_SAMPLE_RATE as f32 / 2.0);
    let mel_points: Vec<f32> = (0..MEL_BANDS + 2)
        .map(|i| min_mel + (max_mel - min_mel) * i as f32 / (MEL_BANDS + 1) as f32)
        .collect();
    let hz_points: Vec<f32> = mel_points.into_iter().map(mel_to_hz).collect();
    let bins: Vec<usize> = hz_points
        .iter()
        .map(|hz| ((FFT_SIZE + 1) as f32 * *hz / MODEL_SAMPLE_RATE as f32).floor() as usize)
        .map(|bin| bin.min(FFT_SIZE / 2))
        .collect();

    (0..MEL_BANDS)
        .map(|band| {
            let left = bins[band];
            let center = bins[band + 1].max(left + 1);
            let right = bins[band + 2].max(center + 1);
            let mut filter = Vec::new();
            for bin in left..center {
                filter.push((bin, (bin - left) as f32 / (center - left) as f32));
            }
            for bin in center..right.min(FFT_SIZE / 2 + 1) {
                filter.push((bin, (right - bin) as f32 / (right - center) as f32));
            }
            filter
        })
        .collect()
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10_f32.powf(mel / 2595.0) - 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_discogs_effnet_model_runs_one_prediction() {
        let mut runtime = GenreModelRuntime::load().unwrap();
        let samples = vec![0.0; BUFFER_SAMPLES];
        let prediction = runtime.predict(&samples).unwrap();
        assert!(!prediction.label.is_empty());
        assert!(prediction.confidence >= 0.0);
        assert!(prediction.confidence <= 1.0);
    }
}
