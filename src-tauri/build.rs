use std::path::{Path, PathBuf};
use std::process::Command;

const BUILD_TIME_MODELS: &[(&str, &str)] = &[
    (
        "music-style-classification/discogs-effnet",
        "discogs-effnet-bsdynamic-1.onnx",
    ),
    (
        "music-style-classification/discogs-effnet",
        "discogs-effnet-bsdynamic-1.json",
    ),
    (
        "classification-heads/mood_happy",
        "mood_happy-discogs-effnet-1.onnx",
    ),
    (
        "classification-heads/mood_happy",
        "mood_happy-discogs-effnet-1.json",
    ),
    (
        "classification-heads/mood_party",
        "mood_party-discogs-effnet-1.onnx",
    ),
    (
        "classification-heads/mood_party",
        "mood_party-discogs-effnet-1.json",
    ),
    (
        "classification-heads/mood_relaxed",
        "mood_relaxed-discogs-effnet-1.onnx",
    ),
    (
        "classification-heads/mood_relaxed",
        "mood_relaxed-discogs-effnet-1.json",
    ),
    (
        "classification-heads/mood_sad",
        "mood_sad-discogs-effnet-1.onnx",
    ),
    (
        "classification-heads/mood_sad",
        "mood_sad-discogs-effnet-1.json",
    ),
    (
        "classification-heads/mood_aggressive",
        "mood_aggressive-discogs-effnet-1.onnx",
    ),
    (
        "classification-heads/mood_aggressive",
        "mood_aggressive-discogs-effnet-1.json",
    ),
    (
        "classification-heads/danceability",
        "danceability-discogs-effnet-1.onnx",
    ),
    (
        "classification-heads/danceability",
        "danceability-discogs-effnet-1.json",
    ),
];

fn main() {
    download_build_time_models();
    tauri_build::build()
}

fn download_build_time_models() {
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let models_dir = manifest_dir.join("models");
    std::fs::create_dir_all(&models_dir).expect("failed to create models directory");

    for (model_dir, file_name) in BUILD_TIME_MODELS {
        let target = models_dir.join(file_name);
        if file_exists(&target) {
            continue;
        }

        let url = format!("https://essentia.upf.edu/models/{model_dir}/{file_name}");
        download_with_curl(&url, &target);
    }
}

fn file_exists(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
}

fn download_with_curl(url: &str, target: &Path) {
    let tmp = target.with_extension("tmp");
    let status = Command::new("curl")
        .arg("--fail")
        .arg("--location")
        .arg("--retry")
        .arg("3")
        .arg("--output")
        .arg(&tmp)
        .arg(url)
        .status()
        .unwrap_or_else(|error| panic!("failed to start curl for {url}: {error}"));

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        panic!("failed to download {url}");
    }

    std::fs::rename(&tmp, target).unwrap_or_else(|error| {
        let _ = std::fs::remove_file(&tmp);
        panic!(
            "failed to move downloaded model to {}: {error}",
            target.display()
        );
    });
}
