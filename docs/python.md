# LED Control From Camera — アプリケーション仕様書

## 1. 概要

**カメラ映像から人物位置を検出し、リアルタイムにNeoPixel LEDを制御するデスクトップアプリケーション。**

2台のカメラ（床上カメラ＝床全体撮影、ソースカメラ＝LED投影対象の撮影）を使用し、床上の人物位置を検出 → 対応するLEDピクセルの色を抽出 → UDPでESP32等のLEDコントローラに送信する。

PyQt6のGUIで透視変換の四隅をドラッグ操作でき、キャリブレーション機能でLEDランタンの物理位置を自動マッピングする。WebSocketサーバーで外部クライアントに位置情報を配信する。

---

## 2. アーキテクチャ

```
┌──────────────────────────────────────────────────────────┐
│                    MainWindow (PyQt6)                     │
│  ┌─────────┐  ┌──────────┐  ┌───────────────────────┐    │
│  │CameraPool│  │GraphicsScene│  │  Control Panel       │    │
│  │(2 cam)  │  │(1280x720)  │  │  Camera select        │    │
│  └────┬────┘  └─────┬──────┘  │  Save/Load Project    │    │
│       │             │         │  Auto-Calibration      │    │
│       │             │         │  Color Gain R/G/B      │    │
│       │             │         │  Brightness            │    │
│       │             │         └───────────────────────┘    │
│       │             │                                      │
│  ┌────▼─────────────▼──────────────────────────────┐      │
│  │              FrameProcessor (QThread)             │      │
│  │  ┌───────────────────────────────────────────┐   │      │
│  │  │ WholebodyONNXDetector                     │   │      │
│  │  │ (DEIM WholeBody34 / onnxruntime)          │   │      │
│  │  │ → body bbox + foot bbox → 足元中点        │   │      │
│  │  └───────────────────────────────────────────┘   │      │
│  └────────┬──────────────────────────────────────────┘      │
│           │ raw_points + mapped_positions                   │
│  ┌────────▼─────────┐  ┌──────────────────────┐            │
│  │ PositionSmoother  │  │ AutoCalibrator       │            │
│  │ (指数平滑+ホールド) │  │ (LED位置自動マッピング)│            │
│  └────────┬──────────┘  └──────────────────────┘            │
│           │                                                │
│  ┌────────▼──────────────────────┐                         │
│  │ _refresh_lantern_items()      │                         │
│  │  warped frame からLED座標色抽出 │                         │
│  │  brightness × gain → 曲線変換  │                         │
│  └────────┬──────────────────────┘                         │
│           │ color_payload: {lantern_id: (R,G,B)}            │
│  ┌────────▼──────────────────────┐  ┌───────────────────┐  │
│  │ NeoPixelController            │  │ PositionBroadcaster│  │
│  │ (UDP: NeoPixel Protocol)      │  │ (WebSocket :8080)  │  │
│  │ → ESP32 × N台                 │  │ → 外部クライアント   │  │
│  └───────────────────────────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. モジュール構成

```
src/
├── app/
│   ├── main.py          # MainWindow + エントリーポイント (PyQt6 GUI)
│   └── color_utils.py   # 輝度カーブ適用 (gain × square curve)
├── detection/
│   ├── detect.py            # HumanDetector: カメラから人物検出
│   ├── detect_wholebody.py  # WholebodyONNXDetector: ONNX推論ラッパー
│   └── detect_skeleton.py   # HumanPoseDetector: レガシーAPIアダプタ
├── pipeline/
│   ├── processing.py        # FrameProcessor: 非同期推論 + 透視変換
│   └── position_filter.py   # PositionSmoother: 指数平滑 + ホールド
├── hardware/
│   ├── protocol.py          # NeoPixel UDPパケットビルダ + 送信
│   ├── layout.py            # hardware_layout.json ローダ
│   └── controllers.py       # NeoPixelController / MultiDeviceLEDController
├── calibration/
│   └── controller.py        # AutoCalibrator: LED位置自動キャリブレーション
├── state/
│   └── app_state.py         # AppState: アプリ状態の単一データホルダー
├── io/
│   └── project_io.py        # プロジェクト設定のSave/Load (JSON)
├── config/
│   └── paths.py             # 設定ファイルパス解決
├── network/
│   └── ws_server.py         # WebSocket位置配信サーバー
├── cli/
│   └── led_test_cli.py      # LED一括点灯テストCLI
└── utils/
    └── backgrounds.py       # ダミー背景生成ユーティリティ
config/
└── hardware_layout.json     # ハードウェア構成 (ESP32 × N台、LEDストリップ定義)
assets/models/wholebody/     # ONNXモデルファイル
```

---

## 4. 詳細仕様

### 4.1 エントリーポイント (`main.py:842`)

```
python -m src.app.main [OPTIONS]
```

| オプション | 動作 |
|---|---|
| (なし) | PyQt6 GUI起動 |
| `--detect` | HumanDetectorを1回実行して人物数と足元座標を出力し終了 |
| `--detect-skeleton` | HumanPoseDetectorを1回実行して終了 |
| `--auto-calibrate` | GUI起動後1.5秒で自動キャリブレーションを開始 |

### 4.2 GUI (`MainWindow`)

- **解像度**: 1280×720 固定
- **左側**: QGraphicsScene（背景レイヤ + ソースカメラ透視変換オーバーレイ + ドラッグハンドル4つ + LEDノード + 人物マーカー）
- **右側**: コントロールパネル（カメラ選択×2、Rescan、Save/Load、Auto-Calibration、色Gain、Settle Frames）
- **フレームレート**: 33ms タイマー (~30fps)

### 4.3 カメラ管理 (`CameraPool`)

- カメラIDごとに `cv2.VideoCapture` をプールする参照カウント管理
- Floor Camera と Source Camera が同一IDの場合は同じキャプチャを共有（フレームをcopyして使用）
- 最大20台までスキャン

### 4.4 人物検出パイプライン

1. **WholebodyONNXDetector** (`detect_wholebody.py`):
   - ONNXモデル: `deimv2_hgnetv2_pico_wholebody34_340query_640x640.onnx` (デフォルト)
   - 入力: BGR画像 → resize → CHW float32 blob
   - 出力テンソルから body(class 0) と foot(class 33) のbboxを分離
   - NMS適用 (body IoU 0.45, foot IoU 0.30)
   - bodyトラッキング (IoUマッチング、max_age=15フレーム)
   - 各bodyに属する2つのfoot bboxの中点を計算 → `PersonFootPoint`
   - 最大16人検出

2. **FrameProcessor** (`processing.py`):
   - バックグラウンドスレッドで推論実行
   - キューサイズ1（最新フレームのみ処理、古いフレームは破棄）
   - 検出結果をQt Signalでメインスレッドに通知

3. **射影変換**:
   - 床カメラの人物位置をソースカメラ座標系にマッピング
   - `cv2.perspectiveTransform(points, inverse_homography)` で変換
   - 結果は0.0~1.0の正規化座標

### 4.5 位置フィルタリング (`PositionSmoother`)

- **指数平滑**: `x += alpha * (obs_x - x)`、alpha は時間定数から自動計算（または固定値オーバーライド）
- **ホールド**: 最後に観測されてから `hold_seconds` (デフォ0.4s) 以内なら表示維持
- **マッチング**: 観測と既存トラックを距離で紐付け（max_match_distance = 0.12）
- 2系統: `_position_filter`（マッピング済み座標）、`_floor_point_filter`（床カメラ生座標）

### 4.6 透視変換オーバーレイ

- ソースカメラ映像を `src_points` (4点) で定義された四角形に `cv2.findHomography` + `cv2.warpPerspective` で射影変換
- 変換後画像をシーンに半透明(Opacity=0.5)でオーバーレイ
- 4つの `CornerHandle` をドラッグしてリアルタイムに領域変更可能

### 4.7 LED色抽出と送信

キャリブレーション済みの各LEDノードについて:

1. warped frame の該当ピクセル座標からBGR色をサンプリング
2. チャンネルごとに `brightness × color_gain[i]` を掛ける
3. `apply_brightness_curve(value, factor)`: `min(1.0, (value/255) * factor)² × 255` で非線形カーブ適用
4. `NeoPixelController.apply_colors({lantern_id: (R,G,B)})` でUDP送信

### 4.8 自動キャリブレーション (`AutoCalibrator`)

LEDランタンの物理位置をカメラ画像上で自動特定する:

1. 全LEDをOFFにしてベースライン画像を取得
2. ランタンID=1を点灯 → `settle_frames` フレーム分待機
3. ベースラインとの差分（`cv2.subtract`）→ 二値化 → メディアンフィルタ
4. 重心（moments）を計算 → そのランタンのカメラ上の位置として記録
5. 検出失敗時は `max_attempts` 回リトライ → それでもダメならスキップ
6. 次のランタンに進む（全ランタン完了まで繰り返し）

### 4.9 UDPプロトコル (`protocol.py`)

**パケット構造**:

```
Header (9 bytes):
  device_id   : uint16 LE
  command     : uint8
  flags       : uint8
  frame_no    : uint32 LE
  count       : uint8

Commands:
  0x00 SET_PIXEL_RANGE: header + start(uint16 LE) + count(uint8) + R,G,B × count
  0x01 FILL_COLOR:      header + R,G,B
  0x02 SHOW:            header only
  0xFF PING:            header only
```

- 送信先: `broadcast_ip`:`port` (デフォルト `192.168.11.255:7777`)
- UDPブロードキャスト有効 (`SO_BROADCAST`)
- frame_no はパケットごとにインクリメント (uint32 ラップアラウンド)

### 4.10 マルチデバイス制御 (`MultiDeviceLEDController`)

- `hardware_layout.json` から複数ESP32デバイス構成を読み込み
- 各デバイスのストリップのグローバルピクセルインデックスを管理
- `lantern_id` → `(device_id, local_index)` に解決して該当デバイスに送信
- 連続ピクセルは `SET_PIXEL_RANGE` で一括送信、255ピクセルごとにチャンク分割

### 4.11 ハードウェアレイアウト (`hardware_layout.json`)

```json
{
  "wifi": { "ssid", "password", "use_static_ip", "local_ip_start", "gateway", "subnet" },
  "udp": { "broadcast_ip", "port", "controller_ip_start", "controller_ip_stride" },
  "devices": [
    {
      "key": "esp32_1",
      "device_id": 1,
      "controller_ip": "192.168.11.120",
      "strips": [
        {"pin": 16, "pixel_count": 25}
      ]
    }
  ]
}
```

- `global_start` はデバイス/ストリップ順に自動採番
- `controller_ip` 未指定時は `controller_ip_start` から `controller_ip_stride` ごとに自動採番

### 4.12 WebSocket位置配信 (`PositionBroadcaster`)

- `ws://0.0.0.0:8080/` でリッスン
- 全クライアントに JSON `{ "positions": [{"x": 0.5, "y": 0.3, "id": "person-1"}, ...] }` を配信
- 新規接続時は最後のメッセージを即座に送信
- バックグラウンドスレッドで asyncio イベントループ駆動

### 4.13 プロジェクト保存/読込 (`project_io.py`)

`project.json` に以下を保存:

- `src_points`: 透視変換4点座標
- `lantern_nodes`: {lantern_id: (x, y)} キャリブレーション結果
- `num_lanterns`: ランタン数
- `bg_size`: [幅, 高さ]
- `calibration_color`: (R, G, B)
- `color_gain`: [R_gain, G_gain, B_gain]
- `calibration_settle_frames`: キャリブレーション安定フレーム数
- `calibration_max_attempts`: リトライ回数

### 4.14 LEDテストCLI (`led_test_cli.py`)

```
python -m src.cli.led_test_cli [COLOR] [--hold SEC] [--no-turn-off] [--layout PATH] [--gains R,G,B]
```

- 全デバイスの全ピクセルを指定色で一括fill → show → 指定秒数保持 → OFF

---

## 5. 環境変数

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `LED_APP_SOURCE_PREVIEW_SCALE` | `0.85` | ソースカメラプレビューのスケール (0.05~2.0) |
| `LED_APP_OUTPUT_BRIGHTNESS` | `0.65` | 出力輝度 (0.05~1.0) |
| `LED_APP_GAIN_R/G/B` | `1.0` | RGBチャンネル別ゲイン (0.1~2.0) |
| `LED_APP_ONNX_MODEL` | (自動) | ONNXモデルパス |
| `LED_APP_ONNX_PROVIDER` | (自動) | `cpu`, `cuda`, `auto` またはカンマ区切り |
| `LED_APP_ONNX_THRESHOLD` | `0.45` | 検出信頼度閾値 |
| `LED_APP_USE_CUDA_WARP` | `auto` | `auto`, `cuda`, `cpu` |
| `LED_APP_CONTROLLER_IP` | `192.168.1.255` | UDP送信先IP (レイアウト未使用時) |
| `LED_APP_CONTROLLER_PORT` | `7777` | UDP送信先ポート |
| `LED_APP_PIXEL_COUNT` | (num_lanterns) | ピクセル数 (レイアウト未使用時) |
| `LED_APP_DEVICE_ID` | `1` | デバイスID (レイアウト未使用時) |
| `LED_APP_BROADCAST` | `1` | UDPブロードキャスト有効 |
| `LED_APP_SETTLE` | `0.05` | LED点灯後待機秒 |
| `LED_APP_LAYOUT_PATH` | `config/hardware_layout.json` | レイアウトファイルパス |
| `LED_APP_POSITION_HOLD_SECONDS` | `0.4` | 位置ホールド時間 |
| `LED_APP_POSITION_TIME_CONSTANT` | `0.2` | 平滑化時定数 |
| `LED_APP_POSITION_MATCH_DISTANCE` | `0.12` | トラッキングマッチ距離 |
| `LED_APP_POSITION_ALPHA` | `0.35` | 平滑化α固定値 (≤0で自動) |
| `LED_APP_DEBUG_POSITIONS` | (未設定) | 設定時、位置デバグ出力 |

---

## 6. 依存関係

- Python ≥ 3.12
- numpy ≥ 2.3.4
- opencv-python ≥ 4.11
- PyQt6 ≥ 6.9
- onnxruntime ≥ 1.20
- websockets ≥ 15.0
- pytest ≥ 8.4 (テスト用)

---

## 7. データフロー（1フレームの処理サイクル）

```
1. 33msタイマー発火
2. Floor Camera → floor_frame (resize to 1280x720)
3. Source Camera → source_frame (resize to 1280x720)
4. floor_frame → GraphicsScene背景レイヤに表示
5. source_frame → src_pointsで射影変換 → 半透明オーバーレイ表示
6. floor_frame → FrameProcessor.submit(frame, inverse_homography)
   a. バックグラウンドスレッドでWholebodyONNX推論
   b. body + foot → 足元中点リスト (raw_points)
   c. perspectiveTransform → マッピング済み正規化座標 (mapped_positions)
   d. Qt Signal でメインスレッドに通知
7. メインスレッド受信:
   a. raw_points → PositionSmoother → 緑マーカー表示
   b. mapped_positions → PositionSmoother → WebSocket配信
   c. 各lantern_nodeの座標で warped frame から色抽出
   d. brightness × gain × square curve 適用
   e. NeoPixelController.apply_colors() → UDP送信
   f. キャリブレーション処理中なら AutoCalibrator.process_frame() 実行
```
