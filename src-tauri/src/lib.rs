mod ai;
mod calibration;
mod led;

use calibration::{Calibrator, CalibrationConfig};
use led::controllers::{LayoutInfo, MultiDeviceLEDController};
use led::layout::HardwareLayout;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;
use tauri::State;

struct AppState {
    controller: Mutex<Option<MultiDeviceLEDController>>,
    calibrator: Mutex<Calibrator>,
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
fn project_save(path: String, data: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
fn project_load(path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            controller: Mutex::new(None),
            calibrator: Mutex::new(Calibrator::new(CalibrationConfig::default())),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ai_generate,
            project_save,
            project_load,
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
        ])
        .setup(|app| {
            if let Some(output_window) = app.get_webview_window("output") {
                let _ = output_window.set_title("VJLED - Output");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
