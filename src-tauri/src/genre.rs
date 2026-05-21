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
const MEL_LOG_SCALE: f32 = 10_000.0;
const MIN_SCORE_RANGE: f32 = 1e-6;

const TAG_LIMIT: usize = 5;
const DISCOGS_CLASSIFIER_OUTPUT: &str = "activations";
const DISCOGS_EMBEDDING_OUTPUT: &str = "embeddings";
const MOOD_HEAD_OUTPUT: &str = "model/Softmax";
const EMBEDDING_SIZE: usize = 1280;

const MOOD_HEADS: [MoodHeadSpec; 6] = [
    MoodHeadSpec {
        file_name: "mood_happy-discogs-effnet-1.onnx",
        positive_label: "happy",
        display_label: "Happy",
    },
    MoodHeadSpec {
        file_name: "mood_party-discogs-effnet-1.onnx",
        positive_label: "party",
        display_label: "Party",
    },
    MoodHeadSpec {
        file_name: "mood_relaxed-discogs-effnet-1.onnx",
        positive_label: "relaxed",
        display_label: "Relaxed",
    },
    MoodHeadSpec {
        file_name: "mood_sad-discogs-effnet-1.onnx",
        positive_label: "sad",
        display_label: "Sad",
    },
    MoodHeadSpec {
        file_name: "mood_aggressive-discogs-effnet-1.onnx",
        positive_label: "aggressive",
        display_label: "Aggressive",
    },
    MoodHeadSpec {
        file_name: "danceability-discogs-effnet-1.onnx",
        positive_label: "danceable",
        display_label: "Danceable",
    },
];

#[derive(Debug, Clone, Serialize)]
pub struct GenrePrediction {
    pub label: String,
    pub confidence: f32,
    pub tags: Vec<MusicTag>,
    pub moods: Vec<MoodPrediction>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MusicTag {
    pub label: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoodPrediction {
    pub label: String,
    pub confidence: f32,
}

type RunnableModel = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

struct MoodHeadSpec {
    file_name: &'static str,
    positive_label: &'static str,
    display_label: &'static str,
}

struct MoodHead {
    model: RunnableModel,
    labels: Vec<String>,
    positive_label: &'static str,
    display_label: &'static str,
}

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
    discogs_model: RunnableModel,
    mood_heads: Vec<MoodHead>,
    labels: Vec<String>,
    fft: Arc<dyn Fft<f32>>,
    fft_buffer: Vec<Complex<f32>>,
    mel_filters: Vec<Vec<(usize, f32)>>,
}

impl GenreModelRuntime {
    fn load() -> TractResult<Self> {
        let model_path = model_path("discogs-effnet-bsdynamic-1.onnx")
            .filter(|path| path.exists())
            .ok_or_else(|| anyhow!("Discogs EffNet model is not bundled"))?;
        let labels = load_labels(&model_path)?;
        let discogs_model = load_discogs_model(&model_path)?;
        let mood_heads = load_mood_heads()?;
        let mut planner = FftPlanner::new();

        Ok(Self {
            discogs_model,
            mood_heads,
            labels,
            fft: planner.plan_fft_forward(FFT_SIZE),
            fft_buffer: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            mel_filters: build_mel_filters(),
        })
    }

    fn predict(&mut self, samples: &[f32]) -> TractResult<GenrePrediction> {
        let features = self.musicnn_mel_patch(samples);
        let input = tract_ndarray::Array3::from_shape_vec((1, MEL_FRAMES, MEL_BANDS), features)?
            .into_tensor();
        let discogs_result = self.discogs_model.run(tvec!(input.into()))?;
        let scores = discogs_result[0]
            .to_array_view::<f32>()?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        if scores.len() != self.labels.len() {
            return Err(anyhow!(
                "Discogs classifier output length mismatch: got {}, expected {} labels",
                scores.len(),
                self.labels.len()
            )
            .into());
        }
        let (min_score, max_score) = scores
            .iter()
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), score| {
                (min.min(*score), max.max(*score))
            });
        if max_score - min_score < MIN_SCORE_RANGE {
            return Err(anyhow!("Discogs classifier output is flat").into());
        }
        let embedding = discogs_result[1]
            .to_array_view::<f32>()?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        if embedding.len() != EMBEDDING_SIZE {
            return Err(anyhow!(
                "Discogs embedding length mismatch: got {}, expected {}",
                embedding.len(),
                EMBEDDING_SIZE
            )
            .into());
        }
        let moods = self.predict_moods(&embedding)?;
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
            moods,
        })
    }

    fn predict_moods(&mut self, embedding: &[f32]) -> TractResult<Vec<MoodPrediction>> {
        let input = tract_ndarray::Array2::from_shape_vec((1, EMBEDDING_SIZE), embedding.to_vec())?
            .into_tensor();
        let mut moods = Vec::with_capacity(self.mood_heads.len());

        for head in &mut self.mood_heads {
            let result = head.model.run(tvec!(input.clone().into()))?;
            let scores = result[0]
                .to_array_view::<f32>()?
                .iter()
                .copied()
                .collect::<Vec<_>>();
            let confidence = head
                .labels
                .iter()
                .position(|label| label == head.positive_label)
                .and_then(|index| scores.get(index).copied())
                .ok_or_else(|| {
                    anyhow!(
                        "Mood head {} did not expose positive label {}",
                        head.display_label,
                        head.positive_label
                    )
                })?;

            moods.push(MoodPrediction {
                label: head.display_label.to_string(),
                confidence,
            });
        }

        moods.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
        Ok(moods)
    }

    fn musicnn_mel_patch(&mut self, samples: &[f32]) -> Vec<f32> {
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

            let spectrum: Vec<f32> = self.fft_buffer[..FFT_SIZE / 2 + 1]
                .iter()
                .map(|c| (c.re * c.re + c.im * c.im).sqrt())
                .collect();

            for band in 0..MEL_BANDS {
                let mel = self.mel_filters[band]
                    .iter()
                    .map(|(bin, weight)| spectrum[*bin] * *weight)
                    .sum::<f32>()
                    .max(0.0);
                features[frame * MEL_BANDS + band] = (1.0 + MEL_LOG_SCALE * mel).log10();
            }
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

fn load_discogs_model(path: &PathBuf) -> TractResult<RunnableModel> {
    tract_onnx::onnx()
        .model_for_path(path)?
        .with_input_fact(
            0,
            InferenceFact::dt_shape(f32::datum_type(), tvec!(1, MEL_FRAMES, MEL_BANDS)),
        )?
        .with_output_names([DISCOGS_CLASSIFIER_OUTPUT, DISCOGS_EMBEDDING_OUTPUT])?
        .into_optimized()?
        .into_runnable()
}

fn load_mood_heads() -> TractResult<Vec<MoodHead>> {
    MOOD_HEADS
        .iter()
        .map(|spec| {
            let path = model_path(spec.file_name)
                .filter(|path| path.exists())
                .ok_or_else(|| anyhow!("Mood head model is not bundled: {}", spec.file_name))?;
            let labels = load_labels(&path)?;
            let model = tract_onnx::onnx()
                .model_for_path(&path)?
                .with_input_fact(
                    0,
                    InferenceFact::dt_shape(f32::datum_type(), tvec!(1, EMBEDDING_SIZE)),
                )?
                .with_output_names([MOOD_HEAD_OUTPUT])?
                .into_optimized()?
                .into_runnable()?;

            Ok(MoodHead {
                model,
                labels,
                positive_label: spec.positive_label,
                display_label: spec.display_label,
            })
        })
        .collect()
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
    let min_hz = 0.0;
    let max_hz = MODEL_SAMPLE_RATE as f32 / 2.0;
    let min_mel = hz_to_slaney_mel(min_hz);
    let max_mel = hz_to_slaney_mel(max_hz);
    let mel_points = (0..MEL_BANDS + 2)
        .map(|i| min_mel + (max_mel - min_mel) * i as f32 / (MEL_BANDS + 1) as f32)
        .map(slaney_mel_to_hz)
        .collect::<Vec<_>>();
    let fft_freqs = (0..FFT_SIZE / 2 + 1)
        .map(|bin| bin as f32 * MODEL_SAMPLE_RATE as f32 / FFT_SIZE as f32)
        .collect::<Vec<_>>();

    (0..MEL_BANDS)
        .map(|band| {
            let left = mel_points[band];
            let center = mel_points[band + 1];
            let right = mel_points[band + 2];
            let normalizer = 2.0 / (right - left).max(f32::EPSILON);
            let mut filter = Vec::new();
            for (bin, freq) in fft_freqs.iter().enumerate() {
                let lower = (*freq - left) / (center - left).max(f32::EPSILON);
                let upper = (right - *freq) / (right - center).max(f32::EPSILON);
                let weight = lower.min(upper).max(0.0) * normalizer;
                if weight > 0.0 {
                    filter.push((bin, weight));
                }
            }
            filter
        })
        .collect()
}

fn hz_to_slaney_mel(hz: f32) -> f32 {
    const F_SP: f32 = 200.0 / 3.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = MIN_LOG_HZ / F_SP;
    const LOG_STEP: f32 = 1.856_297_99 / 27.0;

    if hz >= MIN_LOG_HZ {
        MIN_LOG_MEL + (hz / MIN_LOG_HZ).ln() / LOG_STEP
    } else {
        hz / F_SP
    }
}

fn slaney_mel_to_hz(mel: f32) -> f32 {
    const F_SP: f32 = 200.0 / 3.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = MIN_LOG_HZ / F_SP;
    const LOG_STEP: f32 = 1.856_297_99 / 27.0;

    if mel >= MIN_LOG_MEL {
        MIN_LOG_HZ * ((mel - MIN_LOG_MEL) * LOG_STEP).exp()
    } else {
        F_SP * mel
    }
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

    #[test]
    fn musicnn_mel_patch_preserves_signal_energy() {
        let mut runtime = GenreModelRuntime::load().unwrap();
        let samples = (0..BUFFER_SAMPLES)
            .map(|i| {
                let t = i as f32 / MODEL_SAMPLE_RATE as f32;
                (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.25
            })
            .collect::<Vec<_>>();
        let features = runtime.musicnn_mel_patch(&samples);

        assert_eq!(features.len(), MEL_FRAMES * MEL_BANDS);
        assert!(features.iter().any(|value| *value > 0.0));
    }
}
