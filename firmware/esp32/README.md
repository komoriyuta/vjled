# VJLED ESP32 ファームウェア

ESP32無印（`esp32dev`）用。起動するとGPIO16・17・18の**各100灯**に、16灯の尾を引く光を流します。3本は同じ動きで、青→赤のグラデーションのうち、最後の1灯（99番）だけ白です。1灯25 ms、100灯を約2.5秒で一周します。明るさは32/255。Wi-Fi設定なしで動きます。

WS2812B互換の800 kHz・GRB・RGB LEDを想定しています。過去の受信ファームウェアもGRB出力でした。GPIOはESP32の番号で、LEDのDINへ接続します。LEDには外部5 V電源を使い、ESP32とGNDを共通にしてください。

| GPIO | 灯数 | デバイス内のUDPピクセル番号 |
| --- | --- | --- |
| 16 | 100 | 0〜99 |
| 17 | 100 | 100〜199 |
| 18 | 100 | 200〜299 |

## ビルド・書き込み

このディレクトリで実行します。

```sh
pio run
pio run -t upload --upload-port /dev/cu.usbserial-10
pio device monitor --port /dev/cu.usbserial-10 --baud 115200
```

接続先は`pio device list`で確認します。ビルド結果は`.pio/build/esp32dev/firmware.bin`です。リセット後は自動で流れ始め、シリアルに設定と5秒ごとの動作状況を出します。

## 設定変更とVJLED接続

`include/config.example.h`を`include/vjled_config.h`へコピーすると、ローカル設定を優先してビルドします。このファイルはGit対象外です。GPIO・灯数・明るさ・速度・尾の長さ、Wi-FiのSSIDとパスワードを変更できます。PINや灯数の変更は再書き込みが必要です。

Wi-Fiを設定するとDHCPで接続し、シリアルにIPを表示します。VJLED側で「NeoPixel UDP」、表示されたIP、ポート7777、device_id 1、300灯を指定します。Layout JSONを使う場合は、上の3本を同じ順番で指定してください。旧設定の固定IPには自動接続しません。

最初の正常なSET_RANGE・FILL・SHOWを受けるとテスト演出を止め、アプリ制御へ切り替えます。PINGでは止まりません。アプリ制御中、最後のSHOWから5秒経過またはWi-Fi切断で消灯します。テストへ戻すにはリセットしてください。`kBootAnimation = false`で起動時の演出を無効にできます。

## 旧プロトコルとの互換性

`src-tauri/src/led/protocol.rs`と`docs/python.md`に合わせた9バイトヘッダーです。整数はlittle endian。

```text
device_id:u16 command:u8 flags:u8 frame_no:u32 count:u8
00 SET_RANGE  + start:u16 count:u8 RGB×count（最大255灯）
01 FILL       + RGB（header count=1）
02 SHOW       ヘッダーのみ（count=0）
FF PING       ヘッダーのみ（count=0、ACKなし）
```

SET_RANGEとFILLはバッファを更新し、SHOWで出力します。device_id 0は過去の受信実装と同じ全台指定です。frame_noはパケットごとに増える番号なので、フレーム分割の識別や順序拒否には使いません。flagsは0のみ。切れたパケット、範囲外、count不一致、不明なコマンドを受信してもLEDを変更しません。UDP欠落時の再送やフレーム全体の原子性は、この旧プロトコルでは保証しません。

PINの調査元は`/Users/yuta/Dev/imp/multiNeopixelControl/config/hardware_layout.json`と`src/main.cpp`です。今回はユーザー指定に合わせてGPIO16・17・18、各100灯へ変更しています。Wi-Fi認証情報はコピーしていません。

依存仕様：[PlatformIO ESP32 Dev Module](https://docs.platformio.org/en/stable/boards/espressif32/esp32dev.html)、[Adafruit NeoPixel](https://adafruit.github.io/Adafruit_NeoPixel/html/class_adafruit___neo_pixel.html)。PlatformIOプラットフォームとライブラリの版は`platformio.ini`で固定しています。

## テスト

```sh
python3 tests/run_tests.py
```

既存Rust送信側のバイト列、255+45灯の分割、切れたデータ・範囲外・別デバイスの拒否、青→赤の端点と循環、タイムアウトの時計周回をホスト上で検証します。実際のLED出力は実機で確認してください。
