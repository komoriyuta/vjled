# Audio

## 概要

このリポジトリの音声処理は、`src-tauri/src/audio.rs` が担当しています。
入力音声から `fft`, `bpm`, `beat`, `beatPhase`, `beatCount` を作り、Tauri イベント `audio-analysis` でフロントへ流します。

## 現在の構成

```
audio_start
  -> AudioCapture::start
  -> capture thread
  -> AnalysisRuntime
  -> audio-analysis event
  -> useAudioAnalysis hook
  -> useVJStore.audio
```

## Rust 側の処理

### 依存

- `cpal`: 音声デバイス取得とストリーム
- `aubio`: BPM/拍検出
- `rustfft`: FFT
- `crossbeam`: キャプチャスレッドと解析ループの受け渡し

`Cargo.toml` では `aubio = { version = "0.2.1", features = ["bindgen"] }` を使っています。

### 解析の流れ

1. `AudioCapture::start()` で別スレッドを起動する。
2. `run_capture()` でデバイスごとの音声を取り込む。
3. `AnalysisRuntime::push_mono()` でモノラル化して解析する。
4. FFT と aubio の結果をまとめて `audio-analysis` を emit する。

### FFT

- `FFT_SIZE = 1024`
- `HOP_SIZE = 256`
- `FFT_BANDS = 32`

FFT は見た目用のメーターとして使っていて、`fft` 配列は `0..1` に正規化された 32 バンド値です。
`src/defaults.ts` や各レンダラがこの値を参照します。

### aubio

aubio は拍検出と BPM 推定に使っています。

- `Tempo::new(OnsetMode::SpecFlux, 2048, 512, sample_rate)`
- `do_result()` が `0.0` より大きいと beat 扱い
- `get_bpm()` の値を使って `bpm` を更新

`bpm` はそのまま使わず、次の補正をしています。

- 70〜180 の範囲に収まるよう 2倍/1/2倍で正規化
- 直近 8 件を平均して平滑化

`beatPhase` は、最後の beat 時刻と `bpm` から計算します。

### イベント

Rust から送るイベントの payload は次です。

- `fft: Vec<f64>`
- `bpm: f64`
- `beat: bool`
- `beat_phase: f64`
- `beat_count: u64`

エラー時は `audio-error` を emit します。

## フロント側

`src/hooks/useAudioAnalysis.ts` が `audio-analysis` を受けて `useVJStore.audio` を更新します。

- `enabled: true`
- `permission: "ready"`
- `fft`
- `bpm`
- `beat`
- `beatPhase`
- `beatCount`

音声を有効化すると `audio_start` を呼び、無効化時は `audio_stop` を呼びます。

## デバイス選択

`audio_list_devices` で以下のデバイス情報を返します。

- `system-loopback`
- `default-input`
- `input:<name>`
- `output:<name>`（Windows など）
- Linux では PipeWire の source も列挙する

Linux では可能なら `pw-record` を使って内部音声を取り、なければ CPAL 入力にフォールバックします。
macOS は仮想入力デバイス経由での内部音声キャプチャを前提にしています。

## 利用箇所

- `src/defaults.ts`: `audio.bpm`, `audio.beat`, `audio.beatPhase`, `audio.beatCount`, `audio.fft` を使う
- `src/renderers/glsl/GLSLRenderer.ts`: `iBpm` などの uniforms に反映
- `src/renderers/p5/P5Renderer.ts`: グローバル変数 `bpm` などに反映
- `src/renderers/video/VideoRenderer.ts`: BPM 同期や beat 連動再生に使用
- `src/windows/control/ControlApp.tsx`: UI 上の BPM/beat 表示や説明文に使用

## 注意点

- この実装は実際に aubio を使っています。以前の「aubio を使わない」という方針文書は現状と一致しません。
- `beat` はフロントの見た目用フラグではなく、Rust 側の解析結果として送られる。
- `audio_stop` はアプリ終了時や無効化時の後始末に使われる。
