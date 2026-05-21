# discogs-effnet-bsdynamic-1.onnx 使い方

`models/discogs-effnet-bsdynamic-1.onnx` は Essentia が配布している
Discogs EffNet の ONNX モデルです。Discogs taxonomy に基づく 400 個の
音楽スタイル分類と、1280 次元の埋め込み抽出に使えます。

Source:

- Model: https://essentia.upf.edu/models/music-style-classification/discogs-effnet/discogs-effnet-bsdynamic-1.onnx
- Metadata: https://essentia.upf.edu/models/music-style-classification/discogs-effnet/discogs-effnet-bsdynamic-1.json

## 重要な前提

この ONNX は、音声波形を直接受け取るモデルではありません。

入力は 16 kHz mono 音声から作ったメルスペクトログラムのパッチです。

```text
audio waveform
-> resample to 16 kHz mono
-> mel-spectrogram extraction
-> split into [128, 96] patches
-> ONNX inference
-> 400 style probabilities + 1280-d embedding
```

Essentia で使う場合、この前処理は `TensorflowPredictEffnetDiscogs` が内部で
行います。ONNX Runtime だけで使う場合は、同等のメルスペクトログラム前処理を
自前で実装する必要があります。

## モデル仕様

メタデータ `models/discogs-effnet-bsdynamic-1.json` 上の仕様は以下です。

| 項目 | 値 |
| --- | --- |
| モデル名 | `EffnetDiscogs` |
| タスク | Music style classification and embeddings |
| 入力名 | `serving_default_melspectrogram` |
| 入力 shape | `[n, 128, 96]` |
| 入力 dtype | `float32` |
| 分類出力名 | `PartitionedCall:0` |
| 分類出力 shape | `[n, 400]` |
| 分類出力 activation | Sigmoid |
| 埋め込み出力名 | `PartitionedCall:1` |
| 埋め込み出力 shape | `[n, 1280]` |
| 推奨 sample rate | 16000 Hz |

`n` はパッチ数です。1曲から複数パッチを作るため、曲全体の最終スコアは
通常 `n` 個の出力を平均して使います。

## 出力ラベル

400 個のラベルは JSON メタデータの `classes` に入っています。

例:

```python
import json
from pathlib import Path

metadata = json.loads(Path("models/discogs-effnet-bsdynamic-1.json").read_text(encoding="utf-8"))
labels = metadata["classes"]
```

ラベルは `Rock---Alternative Rock` のように、上位ジャンルと詳細スタイルを
`---` でつないだ形式です。

## ONNX Runtime での最小推論

以下は、すでに `[n, 128, 96]` のメルスペクトログラムパッチを持っている場合の
最小コードです。

```python
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

model_path = Path("models/discogs-effnet-bsdynamic-1.onnx")
metadata_path = Path("models/discogs-effnet-bsdynamic-1.json")

metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
labels = metadata["classes"]

session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])

input_name = "serving_default_melspectrogram"
genre_output_name = "PartitionedCall:0"
embedding_output_name = "PartitionedCall:1"

# Example only: replace this with real mel-spectrogram patches.
patches = np.random.normal(size=(8, 128, 96)).astype(np.float32)

genre_scores, embeddings = session.run(
    [genre_output_name, embedding_output_name],
    {input_name: patches},
)

# Average patch-level predictions into one track-level prediction.
track_scores = genre_scores.mean(axis=0)
top_indices = np.argsort(track_scores)[::-1][:10]

for index in top_indices:
    print(f"{labels[index]}: {track_scores[index]:.4f}")

print("embeddings shape:", embeddings.shape)
```

## 音声ファイルから使う場合

音声ファイルから使うには、ONNX 推論の前に以下が必要です。

1. 音声を mono で読み込む
2. 16 kHz にリサンプリングする
3. Essentia の `TensorflowPredictEffnetDiscogs` 相当のメルスペクトログラムを作る
4. `[128, 96]` のパッチに切る
5. パッチごとに ONNX 推論する
6. パッチごとの 400 次元スコアを平均する

公式 Essentia の TensorFlow 実行例は以下の考え方です。

```python
from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs

audio = MonoLoader(filename="audio.wav", sampleRate=16000, resampleQuality=4)()
model = TensorflowPredictEffnetDiscogs(
    graphFilename="discogs-effnet-bs64-1.pb",
    output="PartitionedCall:0",
)
predictions = model(audio)
```

この repository で ONNX Runtime だけに寄せる場合、上記の
`TensorflowPredictEffnetDiscogs` が隠しているメルスペクトログラム前処理を
Python 側で再現します。

## スコアの読み方

分類出力は Softmax ではなく Sigmoid です。そのため、400 ラベルは排他的な
1ジャンル分類ではなく、複数ラベルが同時に高くなり得るスタイルタグとして
扱います。

推奨される使い方:

- `top-k` で上位ラベルを表示する
- 必要ならしきい値を決めて複数タグを採用する
- 曲全体ではパッチごとのスコアを平均または中央値で集約する

## 注意点

- 入力 shape は `[n, 128, 96]` です。音声波形 `[samples]` は直接入れられません。
- 推奨 sample rate は 16000 Hz です。
- `n` は任意のパッチ数です。`bsdynamic` 版なので動的 batch に対応しています。
- 公式前処理と完全一致させたい場合は Essentia の
  `TensorflowPredictEffnetDiscogs` / `TensorflowInputMusiCNN` 相当の処理に合わせます。
- モデルは Discogs の細かいスタイル分類です。一般的な単一ジャンル分類器とは
  出力の意味が少し違います。

