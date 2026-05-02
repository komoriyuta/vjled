# VJLED 実装計画 & 進捗

## 概要
AI生成ネイティブなVJアプリ。Rust + Tauri v2 + React + TypeScript + Vite。
LED制御はRustにフル移植予定。

## 全体フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 | 基本スキャフォールド (Tauri v2 + React + Vite + 2ウィンドウ) | **完了** |
| 2 | レンダリングエンジン統合 (GLSL, p5.js, Three.js, Video) | **完了** |
| 3 | VJコントロール (A/Bバス、クロスフェーダー、プレビュー、Monacoエディタ) | **完了** |
| 4 | 音声解析統合 (Mic入力, FFT, BPM, beat同期) | **完了** || 5 | LED統合 (Rust: カメラ→人物検出→UDP送信) | 未着手 |
| 6 | AI統合 (コード生成, 映像生成) | 未着手 |

---

## ビルド方法

```bash
# 開発モード (ホットリロード付き、2ウィンドウ起動)
npm run tauri dev

# リリースビルド (アプリ + DMG 生成)
npm run tauri build
# → src-tauri/target/release/bundle/macos/VJLED.app
# → src-tauri/target/release/bundle/dmg/VJLED_0.1.0_aarch64.dmg
```

---

## アーキテクチャ

### 2ウィンドウ構成
- **Control ウィンドウ** (`/`, 1024x720): VJ操作パネル
  - 左: シーンライブラリ専用 (タイプ別色分け、A/Bバスアサイン、シーン追加/削除)
  - 中央上: Program Outputを主プレビューとして配置し、Bus A/B/Selectedの小プレビューを監視用に分離
  - 中央下: クロスフェーダー (CUT A/B, FADE A/B, PLAY/PAUSE)
  - 中央下: Monacoコードエディタ / Video専用コントロール
  - 右: Project / Output / Audio / AI / LED のタブ付き操作バー
    - Project: Save/Load とプロジェクト状態
    - Output: 出力ウィンドウ設定、LED Mapping起動、Python仕様との差分メモ
    - Audio: マイク選択、FFT/BPM/beat解析状態、レンダラ変数確認
    - AI: 生成/編集プロンプトとAPI設定
    - LED: 単一カメラLEDマッピング、UDP出力、キャリブレーション
- **Output ウィンドウ** (`/output.html`, 1280x720, フレームレス): フルスクリーン映像出力

### ウィンドウ間通信
- `useVJStore.subscribe()` → `emit("vj-state", state)` で状態変更を即座に通知
- 両ウィンドウが `listen("vj-state")` で受信
- 各ウィンドウが独立してレンダリング (出力=フル解像度、制御=1/4解像度プレビュー)

### レンダリングパイプライン
```
Bus A Scene → RendererA → offscreen canvas A ─┐
                                                ├→ Compositor → Output Canvas
Bus B Scene → RendererB → offscreen canvas B ─┘
                      ↑
               crossfade (0=A〜1=B)
```

### 音声解析パイプライン
```
Selected Mic → Web Audio AnalyserNode ─┬→ volume / bass / mid / treble
                                       ├→ 32-band FFT
                                       └→ bass transient beat detection → BPM / beatPhase

Control Window Zustand audio state → emit("vj-state") → Output Window
Renderer.update(time, dt, audio) → GLSL / p5 / Three.js / Video
```

- マイクは Control ウィンドウの Audio タブで選択する。
- BPMは低域エネルギーのトランジェント間隔から推定し、70〜180 BPMへ正規化する。
- Videoレンダラは `BPM LOOP` 有効時、`loopStart` から `beatsPerLoop` 拍ぶんをループ長として扱い、BPMビート境界で再同期する。
- GLSL uniforms: `iAudioVolume`, `iAudioBass`, `iAudioMid`, `iAudioTreble`, `iBpm`, `iBeat`, `iBeatPhase`, `iBeatCount`, `iFft[32]`
- p5 globals: `audioVolume`, `audioBass`, `audioMid`, `audioTreble`, `bpm`, `beat`, `beatPhase`, `beatCount`, `fft`
- Three.js: `update(state, time, dt, audio)` の第4引数で同じ値を受け取る。`state.audio` でもアクセス可能。

---

## 実装済みモジュール一覧

### フロントエンド (`src/`)

| ファイル | 役割 |
|----------|------|
| `types/index.ts` | `Scene`, `SceneType`, `BusLabel`, `VJState` 型定義 |
| `defaults.ts` | タイプ別デフォルトコード (Shadertoy GLSL, Three.js, p5.js) |
| `stores/vjStore.ts` | Zustandグローバル状態: シーンCRUD, A/Bバス, クロスフェーダー, フェードアニメーション |
| `hooks/useAudioAnalysis.ts` | Web Audio APIによるマイク選択、FFT、BPM/beat解析 |
| `hooks/useEngine.ts` | レンダリングエンジンフック: レンダラ生成/破棄, コンポジタ, アニメーションループ |
| `renderers/types.ts` | `Renderer` インターフェース: `init`, `setCode`, `update`, `resize`, `destroy` |
| `renderers/glsl/GLSLRenderer.ts` | GLSL/Shadertoyレンダラ (mainImage自動ラップ, iTime/iResolution/iFrame対応) |
| `renderers/threejs/ThreeJSRenderer.ts` | Three.jsレンダラ (setup/updateパターン, 動的評価) |
| `renderers/p5/P5Renderer.ts` | p5.jsレンダラ (インスタンスモード, グローバル関数エイリアス) |
| `renderers/video/VideoRenderer.ts` | HTML5 Videoレンダラ (ループ再生, Canvas 2D描画) |
| `renderers/compositor.ts` | WebGLコンポジタ (A/Bテクスチャ→クロスフェード合成) |
| `renderers/index.ts` | `createRenderer()` ファクトリ |
| `windows/control/ControlApp.tsx` | VJ制御パネルUI (シーンライブラリ, バスプレビュー, フェーダー, Monacoエディタ) |
| `windows/output/OutputApp.tsx` | 出力ウィンドウ (フルスクリーン レンダリング) |
| `main.tsx` | Control ウィンドウ エントリポイント |
| `output.tsx` | Output ウィンドウ エントリポイント |

### Rust (`src-tauri/`)

| ファイル | 役割 |
|----------|------|
| `src/main.rs` | エントリポイント |
| `src/lib.rs` | Tauriコマンド定義, マルチウィンドウsetup |
| `tauri.conf.json` | 2ウィンドウ定義, CSP=null, バンドル設定 |
| `capabilities/default.json` | ウィンドウ/イベント権限 |

---

## Phase 1: 基本スキャフォールド **完了**

### Step 1.1: プロジェクト初期化
- [x] Tauri v2 + React + TypeScript + Vite テンプレート
- [x] npm依存: `three`, `@types/three`, `p5`, `zustand`, `@monaco-editor/react`

### Step 1.2: マルチウィンドウ設定
- [x] `tauri.conf.json`: `control` (1024x720) + `output` (1280x720, decorations=false)
- [x] Vite マルチページ設定 (`index.html` + `output.html`)

### Step 1.3: ディレクトリ & 状態管理
- [x] Zustand `vjStore.ts`: A/Bバスモデル
- [x] Tauri イベントでウィンドウ間同期

### Step 1.4: コンパイル確認
- [x] `npm run build`, `cargo build`, `cargo tauri build` 全て通る

---

## Phase 2: レンダリングエンジン **完了**

### GLSL/Shadertoy レンダラ
- [x] `mainImage(out vec4, in vec2)` 自動検出→`gl_FragCoord`でラップ
- [x] `void main()` 直書きも対応
- [x] Shadertoy uniforms: `iTime`, `iResolution`, `iMouse`, `iFrame`
- [x] `preserveDrawingBuffer: true` でコンポジタ読み取り対応

### Three.js レンダラ
- [x] `setup(scene, camera, renderer)` / `update(state, time, dt)` パターン
- [x] コード変更時シーンクリーンアップ (geometry/material dispose)
- [x] `preserveDrawingBuffer: true`

### p5.js レンダラ
- [x] インスタンスモード + グローバル関数エイリアス (createCanvas, fill, ellipse等)
- [x] 動的 `new Function` 評価

### Video レンダラ
- [x] HTML5 Video → Canvas 2D
- [x] ループ再生, 自動play

### コンポジタ
- [x] WebGL 2テクスチャ入力 → crossfade ブレンド
- [x] `u_texA`, `u_texB`, `u_crossfade`, `u_hasA`, `u_hasB` uniforms

### レンダリングエンジンフック
- [x] `useEngine(containerRef, preview)`: レンダラ/コンポジタのライフサイクル管理
- [x] プレビューモード: 1/4解像度, 出力モード: フル解像度
- [x] active/bus切り替え時のレンダラ生成/破棄

---

## Phase 3: VJコントロール **完了**

### シーン管理
- [x] タイプ別追加 (GLSL/p5/Three/Video), 色分けボタン
- [x] 削除, 選択
- [x] デフォルトコード自動挿入 (Shadertoy, Three.js, p5.js)

### A/Bバス + クロスフェーダー
- [x] シーン→A/Bバスアサイン (各シーンにA/Bボタン)
- [x] クロスフェーダースライダー (0=busA, 1=busB)
- [x] CUT A/B: 即時切り替え
- [x] FADE A/B: 1秒イージング遷移
- [x] PLAY/PAUSE

### プレビュー
- [x] バスA/Bプレビューカード (シーン名, タイプ表示)
- [x] 出力プレビュー (useEngine, 1/4解像度)

### コードエディタ
- [x] Monaco Editor (`@monaco-editor/react`)
- [x] GLSL→cpp, JavaScript→javascript シンタックスハイライト
- [x] vs-dark テーマ, minimap無効, 自動レイアウト

---

## ビルド確認履歴

| 日時 | コマンド | 結果 |
|------|----------|------|
| Phase 1完了時 | `npm run build` | ✅ 通る |
| Phase 1完了時 | `cargo build` | ✅ 通る |
| Phase 1完了時 | `cargo tauri build` | ✅ VJLED.app + DMG 生成 |
| Phase 3完了時 | `npm run build` | ✅ 通る |
| Phase 3完了時 | `cargo tauri build` | ✅ VJLED.app + DMG 生成 |

---

## バグ修正履歴

### 2026-04-24: レンダリング全面修正

#### 原因: Shadertoy GLSLが全くレンダリングされず、連鎖的に全プレビュー・出力が死んでいた

**修正1: GLSLRenderer `gl_FragCoord` 型エラー** (`renderers/glsl/GLSLRenderer.ts`)
- `mainImage(_fragColor, gl_FragCoord)` → `mainImage(_fragColor, gl_FragCoord.xy)` に修正
- `gl_FragCoord` は `vec4` だが `mainImage` の第2引数は `in vec2` → シェーダーコンパイルエラーで全GLSLが描画不能だった

**修正2: Compositor テクスチャメモリリーク** (`renderers/compositor.ts`)
- 毎フレーム `gl.createTexture()` を呼んでテクスチャを無限生成していた
- 永続テクスチャ2枚 (`texA`, `texB`) を `init()` で作成し、`render()` では `texImage2D` で再利用する方式に変更
- フラグメントシェーダーの過度に複雑なアルファ計算をシンプルな線形ブレンドに修正

**修正3: p5.js レンダラのキャンバス切断** (`renderers/p5/P5Renderer.ts`)
- p5.jsインスタンスが独自キャンバスを作成するが、それがcompositorと繋がっていなかった
- `update()` で p5キャンバス → オフスクリーン2Dキャンバスに `drawImage` コピーする方式に変更
- p5コンテナを `position:fixed; top:-9999px` に配置してDOM干渉を防止

**修正4: p5.js グローバル変数エイリアスのバグ** (`renderers/p5/P5Renderer.ts`)
- `width`, `height`, `mouseX`, `mouseY`, `frameCount` を `function` として定義していた → 呼び出しで `NaN` 発生
- `var` 変数に変更し、`draw()` の毎フレーム先頭で `p.width` 等から同期する方式に修正
- `createCanvas`, `fill` 等も `function() { return p.xxx.apply(p, arguments); }` に修正 (`.apply` で可変長引数対応)

**修正5: Bus Preview がテキストのみ** (`windows/control/ControlApp.tsx`)
- Bus A/Bプレビューがシーン名とタイプのテキスト表示だけだった
- リアルタイムcanvasプレビューに変更 (useEngineからcopyCanvasで描画)

**修正6: シーン個別プレビューなし** (`hooks/useEngine.ts`, `windows/control/ControlApp.tsx`)
- BUSに割り当てていないシーンの確認ができなかった
- `selectedPreviewRef` を追加: 選択中シーンをBUSとは独立してレンダリング・プレビュー可能に
- useEngine APIを `UseEngineOptions` オブジェクト引数にリファクタ

**修正7: プレビュー16:9アスペクト比未対応** (同上ファイル群)
- 全プレビューcanvasに `aspectRatio: '16/9'` + `maxWidth/maxHeight: 100%` を設定
- コンポジタcanvasもpreview modeでは16:9で中央配置

**修正8: レイアウトスクロール・余白問題** (`index.html`, `windows/control/ControlApp.tsx`)
- `index.html` に `* { margin:0; padding:0; } html,body { overflow:hidden; }` を追加
- ControlApp全体を `overflow: hidden` で固定レイアウト化
- 行ごとに `flexShrink: 0` + 固定 `height` を設定し、コードエディタのみ `flex: 1` で伸縮

**修正9: Outputプレビューのアスペクト比** (`hooks/useEngine.ts`)
- コンポジタcanvasに `object-fit: contain` を設定し、16:9を維持しつつコンテナにフィット

### 2026-04-24: UI機能追加

**追加1: 出力ウィンドウ タイトルバーON/OFF** (`windows/control/ControlApp.tsx`)
- 右側 Output タブに "Show Bar" / "Hide Bar" トグルボタン追加
- `WebviewWindow.getByLabel("output")` → `setDecorations(bool)` / `isDecorated()` で操作
- タイトルバー非表示時はframeless（ドラッグ不可）、表示時は移動・リサイズ可能

**追加2: ネイティブファイルピッカー for Video** (`windows/control/ControlApp.tsx`, 依存追加)
- `@tauri-apps/plugin-dialog` (npm) + `tauri-plugin-dialog` (Rust) を追加
- Videoシーン選択時、Monacoエディタの代わりに専用UIを表示
  - 「Choose Video File」ボタンでOS標準ファイルダイアログ起動
  - フィルター: mp4, webm, mov, avi, mkv, ogv
  - 選択結果を `file://` URLとしてシーンコードに設定
- ヘッダーにも「Choose File」ボタンを表示

**追加3: 権限追加** (`capabilities/default.json`)
- `core:window:allow-set-decorations`, `core:window:allow-is-decorated` 追加
- `dialog:default`, `dialog:allow-open` 追加

### 2026-04-24: p5.js 生成コード互換性修正

**修正10: Markdownフェンス付きp5コードの実行失敗** (`renderers/p5/P5Renderer.ts`)
- AI出力をそのまま貼ると ```` ``` ```` フェンスが `new Function` に渡り、構文エラーになるケースがあった
- `setCode()` 入力時に先頭/末尾の Markdown コードフェンスを除去する正規化処理を追加

**修正11: p5.js グローバルAPIの取りこぼし** (`renderers/p5/P5Renderer.ts`)
- p5 v2 では `exp`, `floor`, `map`, `noise`, `color`, `push/pop`, `translate`, `rectMode` などが単一prototype列挙だけでは拾えないことがある
- p5インスタンス自身からprototype chain全体まで走査して関数エイリアスを生成する方式に変更
- `abs/sin/cos/exp/floor` 等は Math fallback、`map/constrain/random` は軽量fallbackも追加し、p5グローバルモード前提のAI生成コードを通しやすくした

**修正12: p5.js イベント/resize時のグローバル同期** (`renderers/p5/P5Renderer.ts`)
- `windowResized`, key/mouseイベント実行前に `width`, `height`, `mouseX`, `frameCount`, `windowWidth` などを同期
- `deltaTime`, `mouseIsPressed`, `key`, `keyCode` もグローバル変数として追加

**修正13: p5.js エイリアス生成時の予約語構文エラー** (`renderers/p5/P5Renderer.ts`)
- p5 v2 の関数/プロパティ名に `break` が含まれ、`var break = ...` を生成して `SyntaxError: Unexpected token 'break'` が発生していた
- JavaScript予約語をエイリアス生成対象から除外し、デフォルトp5シーンが実行できるように修正
- `WEBGL`, `P2D`, `P2DHDR`, `WEBGL2`, `WEBGPU` など、p5インスタンス上に露出しない場合がある定数にはfallback値を追加

**修正14: Tauriイベント同期の初回取り逃がしとブラウザ確認不能** (`events/vjEvents.ts`, `hooks/useEngine.ts`, `windows/control/ControlApp.tsx`)
- Outputウィンドウが起動タイミングによって初回 `vj-state` を取り逃がす可能性があった
- `vj-state-request` を追加し、各レンダリングエンジン起動時にControlウィンドウへ最新状態を要求する方式を追加
- Tauri IPCがないブラウザ確認時はローカルDOMイベントにfallbackし、`listen/emit` のrejectでレンダリングループが止まらないようにした

**確認: p5.js シーン互換スモークテスト**
- ブラウザ上で `P5Renderer` に直接コードを流し、console errorなし + canvas描画ピクセルありを確認
- 通過ケース: デフォルト風2D、Markdownフェンス付き、`noise/color/transform` グリッド、ユーザー提示のTechno Geometric系コード、`createCanvas(..., WEBGL)`、`createVector/random/colorMode(HSB)` + mouse event

### 2026-04-24: Video Output ループ修正

**修正15: Output側VideoRendererの終端ループ漏れ** (`renderers/video/VideoRenderer.ts`)
- `timeupdate` だけで手動ループしていたため、動画終端で `ended` になった場合にOutput側が巻き戻し・再生しないケースがあった
- フル尺ループはHTMLVideoElementのnative `loop` を使い、ABループ時は `timeupdate` / `ended` / `update()` の3箇所で終端を検知して `loopStart` に戻すよう修正

**修正16: Video command のレンダラ生成前取り逃がし** (`hooks/useEngine.ts`)
- Outputウィンドウ側でVideoRendererがまだ作られていない状態で `loop`, `loopStart`, `loopEnd`, `seek`, `play/pause` が届くと反映されなかった
- sceneIdごとに最新control commandをキャッシュし、レンダラ生成時と動画src更新後に再適用するよう修正

---

## 現在のディレクトリ構造

```
vjled/
├── docs/
│   ├── app.md
│   ├── python.md
│   └── plan.md
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/default.json
├── src/
│   ├── main.tsx
│   ├── output.tsx
│   ├── types/index.ts
│   ├── defaults.ts
│   ├── stores/vjStore.ts
│   ├── hooks/useEngine.ts
│   ├── renderers/
│   │   ├── types.ts
│   │   ├── index.ts
│   │   ├── glsl/GLSLRenderer.ts
│   │   ├── threejs/ThreeJSRenderer.ts
│   │   ├── p5/P5Renderer.ts
│   │   ├── video/VideoRenderer.ts
│   │   └── compositor.ts
│   └── windows/
│       ├── control/ControlApp.tsx
│       └── output/OutputApp.tsx
├── index.html
├── output.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 次のステップ (Phase 4: LED統合)

Rust側で実装予定:
- `src-tauri/src/led/protocol.rs`: NeoPixel UDPパケットビルダ
- `src-tauri/src/led/controllers.rs`: マルチデバイスLED制御
- `src-tauri/src/led/layout.rs`: hardware_layout.json ローダ
- `src-tauri/src/detection/`: ONNX人物検出
- `src-tauri/src/camera/`: カメラキャプチャ
- `src-tauri/src/calibration/`: 自動キャリブレーション
