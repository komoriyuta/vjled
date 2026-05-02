# Audio 方針

## 目的

VJレンダラが使う `bpm`, `beat`, `beatPhase`, `beatCount`, `fft` を、入力された実音声から自動でリアルタイム追従させる。

手動BPM、Tap Tempo、手動オフセット補正は同期の主経路にしない。DJソフトに近い考え方で、一定時間の音声からテンポと拍グリッドを推定し、その後は低遅延の音声特徴でグリッドを追従させる。

## 非目標

- GPL/LGPL系ライブラリを取り込まない。
- ユーザーに拍同期を手で合わせさせない。
- FFTバーの見た目だけで拍同期を作らない。
- UIスレッドや音声コールバック内で重い解析を直接回さない。

## ライブラリ方針

第一候補は `stratum-dsp`。

- License: `MIT OR Apache-2.0`
- Rust実装
- BPM検出、tempogram、HMM beat tracking、`BeatGrid` を持つ
- DJ用途を意識した解析APIがある

補助候補は `resonant-analysis`。

- License: `MIT OR Apache-2.0`
- Rust実装
- onset strength envelope と tempo estimator を持つ
- BeatGridまでは持たないため、BPM推定のフォールバック候補にする

採用しない候補:

- `aubio`: GPL系なので使わない。
- `beat-detector`: MITだが、BeatGrid/BPM/拍位置の要求に対して機能が足りない。
- `beat-this`: MITだが、モデル依存・オフライン寄りのため、まずはリアルタイムVJ同期の主経路にしない。

## 全体アーキテクチャ

```
Audio Capture
  -> low latency mono ring buffer
  -> FFT / volume / band meter path
  -> analysis worker path

FFT path:
  256 sample hop程度で即時更新
  volume / bass / mid / treble / 32-band FFT を出す

Analysis worker path:
  8-12秒のrolling windowを保持
  解析は1-2秒ごとに別スレッドで実行
  stratum-dspでBPM + BeatGridを推定
  結果をmonotonic clock上のbeat epochに変換

Realtime clock path:
  最新のbeat epoch + beat lengthから毎フレームbeatPhaseを予測
  onsetが拍近傍に来た場合だけ、小さく位相補正
  拍から大きく外れたonsetや16分/8分の細かい反応では二重発火しない
```

## レイテンシ方針

解析結果の時刻は「結果を受け取った現在時刻」ではなく、「解析窓の終端時刻」を基準にする。

例:

- rolling window: 10秒
- window end: monotonic clock `t=123.400`
- `BeatGrid.beats` の最後が窓内 `9.750s`
- beat epoch候補: `123.400 - 10.000 + 9.750`

これにより、解析ワーカーの処理時間ぶんだけ拍が遅れて見える問題を避ける。

## BPM安定化方針

- BPMは70-180の実用域に正規化する。
- 2倍/半分の候補は、低域だけでなく中高域も含めたtempogram候補とBeatGrid安定度で選ぶ。
- 前回BPMから急に大きく変える場合は、confidenceが十分高いときだけ採用する。
- confidenceが低い間はBPMを固定せず、beat出力を弱くする。
- 一度ロックした後は、BPMを連続的にスムーズ更新し、beatPhaseがジャンプしないようepochを補正する。

## 拍位置同期方針

`beat` はオンセット検出そのものではなく、推定されたBeatGridの拍境界で発火する。

オンセットは次の用途だけに使う。

- BeatGridへの位相ロック
- 明らかにズレ続けたときの再ロック判断
- confidence更新

二重発火対策:

- beat発火は `lastBeatIndex` で1拍1回に制限する。
- onsetは最短間隔だけでなく、現在のbeat grid近傍かどうかで採用する。
- 拍の裏、ハイハット、細かいベース連打はbeatとして直接扱わない。

## OS別キャプチャ方針

### Linux

PipeWireがある環境では `pw-record` の sink capture を優先する。

- 内部音声: `@DEFAULT_AUDIO_SINK@` のmonitor相当を取る
- マイク: default inputまたは明示されたsourceを取る
- ALSA/JACKの探索ログに依存しない

PipeWireがない場合はCPAL入力へフォールバックする。

### Windows

WASAPI loopbackで既定出力デバイスを取る。

- 内部音声: output loopback
- マイク: input device
- デバイス一覧では input と loopback output を分ける

### macOS

macOS標準だけではアプリが任意のシステム出力音声を直接キャプチャできない。

対応方針:

- マイク入力はCPALで対応する。
- 内部音声はBlackHole、Soundflower、Loopback、Aggregate Deviceなどの仮想入力を選ばせる。
- アプリ側では仮想入力をloopback候補として検出し、明示的なエラーメッセージを出す。

## UI方針

Audio UIは自動同期の状態確認に絞る。

- device selector
- volume / bass / mid / treble
- FFT
- BPM
- beat confidence
- lock状態

置かないもの:

- Tap Tempo
- Manual BPM
- Manual Offset
- Syncボタン

## 実装順

1. 既存Audio実装を「capture」「meter/FFT」「beat tracking」「Tauri event」に分ける。
2. rolling mono ring bufferと解析ワーカーを追加する。
3. `stratum-dsp` を追加し、8-12秒窓でBPM + BeatGridを推定する。
4. BeatGrid結果をmonotonic clock上のepochに変換する。
5. `beatPhase` と `beat` をBeatGrid由来に切り替える。
6. OS別キャプチャを整理し、Linux/Windows/macOSの失敗メッセージを分ける。
7. synthetic click、four-on-the-floor、half/double-time候補のテストを追加する。

## 完了条件

- 120 BPM click trackで `beat` が1拍1回だけ発火する。
- 90/120/128/140 BPMでBPMが安定する。
- 半分/2倍へ頻繁に誤ロックしない。
- UI上のbeatPhaseが音より遅れて見えない。
- Linux内部音声、Windows内部音声、macOS仮想入力、通常マイク入力の扱いが明確。
- GPL/LGPL依存が入っていない。
