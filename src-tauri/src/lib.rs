mod ai;
mod audio;
mod calibration;
mod genre;
mod led;
mod video_server;

use audio::{AudioCapture, AudioDeviceInfo};
use calibration::{CalibrationConfig, Calibrator};
use led::controllers::{LayoutInfo, MultiDeviceLEDController};
use led::layout::HardwareLayout;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;
use tauri::State;

#[derive(Debug, serde::Serialize)]
struct NativeGpuDiagnostics {
    renderer: String,
    vendor: String,
    direct_rendering: Option<bool>,
    source: String,
}

struct AppState {
    controller: Mutex<Option<MultiDeviceLEDController>>,
    calibrator: Mutex<Calibrator>,
    audio: Mutex<AudioCapture>,
    video_server_port: u16,
}

#[cfg(target_os = "linux")]
fn configure_webview<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    window
        .with_webview(|webview| {
            use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

            let inner = webview.inner();
            if let Some(settings) = inner.settings() {
                settings.set_hardware_acceleration_policy(
                    webkit2gtk::HardwareAccelerationPolicy::Always,
                );
                settings.set_enable_webgl(true);
                settings.set_enable_media(true);
                settings.set_enable_media_stream(true);
            }

            inner.connect_permission_request(|_, request| {
                request.allow();
                true
            });
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn configure_webview<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn camera_prepare_window(window: tauri::WebviewWindow) -> Result<(), String> {
    configure_webview(&window)
}

#[tauri::command]
fn led_load_layout(path: String, state: State<AppState>) -> Result<LayoutInfo, String> {
    let layout = HardwareLayout::load(std::path::Path::new(&path))?;
    let ctrl = MultiDeviceLEDController::from_layout(&layout)?;
    let info = ctrl.layout_info();
    *state.controller.lock().map_err(|e| e.to_string())? = Some(ctrl);
    Ok(info)
}

#[tauri::command]
fn led_init_simple(
    broadcast_ip: String,
    port: u16,
    device_id: u16,
    pixel_count: usize,
    state: State<AppState>,
) -> Result<LayoutInfo, String> {
    let ctrl = MultiDeviceLEDController::simple(&broadcast_ip, port, device_id, pixel_count)?;
    let info = ctrl.layout_info();
    *state.controller.lock().map_err(|e| e.to_string())? = Some(ctrl);
    Ok(info)
}

#[tauri::command]
fn led_send_colors(colors: HashMap<usize, [u8; 3]>, state: State<AppState>) -> Result<(), String> {
    let guard = state.controller.lock().map_err(|e| e.to_string())?;
    let ctrl = guard.as_ref().ok_or("LED controller not initialized")?;
    ctrl.apply_colors(&colors)
}

#[tauri::command]
fn led_fill(r: u8, g: u8, b: u8, state: State<AppState>) -> Result<(), String> {
    let guard = state.controller.lock().map_err(|e| e.to_string())?;
    let ctrl = guard.as_ref().ok_or("LED controller not initialized")?;
    ctrl.fill_all(r, g, b)
}

#[tauri::command]
fn led_set_pixel(
    lantern_id: usize,
    r: u8,
    g: u8,
    b: u8,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.controller.lock().map_err(|e| e.to_string())?;
    let ctrl = guard.as_ref().ok_or("LED controller not initialized")?;
    ctrl.set_pixel(lantern_id, r, g, b)
}

#[tauri::command]
fn led_all_off(state: State<AppState>) -> Result<(), String> {
    let guard = state.controller.lock().map_err(|e| e.to_string())?;
    let ctrl = guard.as_ref().ok_or("LED controller not initialized")?;
    ctrl.all_off()
}

#[tauri::command]
fn led_ping(state: State<AppState>) -> Result<(), String> {
    let guard = state.controller.lock().map_err(|e| e.to_string())?;
    let ctrl = guard.as_ref().ok_or("LED controller not initialized")?;
    ctrl.ping()
}

#[tauri::command]
fn led_layout_info(state: State<AppState>) -> Result<LayoutInfo, String> {
    let guard = state.controller.lock().map_err(|e| e.to_string())?;
    let ctrl = guard.as_ref().ok_or("LED controller not initialized")?;
    Ok(ctrl.layout_info())
}

#[tauri::command]
fn calibration_set_baseline(
    rgba_data: Vec<u8>,
    width: usize,
    height: usize,
    state: State<AppState>,
) -> Result<(), String> {
    let mut cal = state.calibrator.lock().map_err(|e| e.to_string())?;
    cal.set_baseline(&rgba_data, width, height);
    Ok(())
}

#[tauri::command]
fn calibration_detect_led(
    rgba_data: Vec<u8>,
    width: usize,
    height: usize,
    state: State<AppState>,
) -> Result<Option<(f64, f64)>, String> {
    let cal = state.calibrator.lock().map_err(|e| e.to_string())?;
    Ok(cal.detect_led(&rgba_data, width, height))
}

#[tauri::command]
fn calibration_has_baseline(state: State<AppState>) -> Result<bool, String> {
    let cal = state.calibrator.lock().map_err(|e| e.to_string())?;
    Ok(cal.has_baseline())
}

#[tauri::command]
fn calibration_reset(state: State<AppState>) -> Result<(), String> {
    let config = CalibrationConfig::default();
    *state.calibrator.lock().map_err(|e| e.to_string())? = Calibrator::new(config);
    Ok(())
}

#[tauri::command]
async fn ai_generate(
    base_url: String,
    api_key: String,
    model: String,
    scene_type: String,
    prompt: String,
    existing_code: Option<String>,
) -> Result<String, String> {
    ai::generate_code(
        &base_url,
        &api_key,
        &model,
        &scene_type,
        &prompt,
        existing_code.as_deref(),
    )
    .await
}

#[tauri::command]
async fn ai_decide_auto_vj(
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    ai::decide_auto_vj(&base_url, &api_key, &model, &prompt).await
}

#[tauri::command]
fn project_save(path: String, data: serde_json::Value) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(&data).map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
fn project_load(path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn get_video_server_port(state: State<AppState>) -> u16 {
    state.video_server_port
}

#[tauri::command]
fn audio_list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    AudioCapture::list_devices()
}

#[tauri::command]
fn audio_start(
    device: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut audio = state.audio.lock().map_err(|e| e.to_string())?;
    audio.start(device, app)
}

#[tauri::command]
fn audio_stop(state: State<AppState>) -> Result<(), String> {
    let mut audio = state.audio.lock().map_err(|e| e.to_string())?;
    audio.stop();
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn native_gpu_diagnostics() -> NativeGpuDiagnostics {
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        if let Ok(output) = Command::new("glxinfo").arg("-B").output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut renderer = String::from("unknown");
                let mut vendor = String::from("unknown");
                let mut direct_rendering = None;

                for line in text.lines() {
                    if let Some(value) = line.strip_prefix("OpenGL renderer string:") {
                        renderer = value.trim().to_string();
                    } else if let Some(value) = line.strip_prefix("OpenGL vendor string:") {
                        vendor = value.trim().to_string();
                    } else if let Some(value) = line.strip_prefix("direct rendering:") {
                        direct_rendering = Some(value.trim().eq_ignore_ascii_case("yes"));
                    }
                }

                return NativeGpuDiagnostics {
                    renderer,
                    vendor,
                    direct_rendering,
                    source: "glxinfo -B".to_string(),
                };
            }
        }
    }

    NativeGpuDiagnostics {
        renderer: "unknown".to_string(),
        vendor: "unknown".to_string(),
        direct_rendering: None,
        source: "unavailable".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            camera_prepare_window,
            get_video_server_port,
            ai_generate,
            ai_decide_auto_vj,
            project_save,
            project_load,
            audio_list_devices,
            audio_start,
            audio_stop,
            led_load_layout,
            led_init_simple,
            led_send_colors,
            led_fill,
            led_set_pixel,
            led_all_off,
            led_ping,
            led_layout_info,
            calibration_set_baseline,
            calibration_detect_led,
            calibration_has_baseline,
            calibration_reset,
            native_gpu_diagnostics,
        ])
        .setup(|app| {
            let server = video_server::VideoFileServer::start();
            app.manage(AppState {
                controller: Mutex::new(None),
                calibrator: Mutex::new(Calibrator::new(CalibrationConfig::default())),
                audio: Mutex::new(AudioCapture::new()),
                video_server_port: server.port,
            });
            if let Some(output_window) = app.get_webview_window("output") {
                let _ = output_window.set_title("VJLED - Output");
                let _ = configure_webview(&output_window);
            }
            if let Some(control_window) = app.get_webview_window("control") {
                let _ = configure_webview(&control_window);
            }
            if let Some(mapping_window) = app.get_webview_window("led-mapping") {
                let _ = configure_webview(&mapping_window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
