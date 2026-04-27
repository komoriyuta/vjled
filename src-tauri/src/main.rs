// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn ensure_gstreamer_plugins() {
    use std::env;

    let existing = env::var("GST_PLUGIN_SYSTEM_PATH_1_0").unwrap_or_default();
    let arch = env::var("ARCH").unwrap_or_else(|_| {
        if cfg!(target_arch = "aarch64") {
            "aarch64".to_string()
        } else {
            "x86_64".to_string()
        }
    });

    let system_paths = format!(
        "/usr/lib/{}-linux-gnu/gstreamer-1.0:/usr/lib/gstreamer-1.0:/usr/lib64/gstreamer-1.0",
        arch
    );

    if !existing.split(':').any(|p| p.starts_with("/usr/lib")) {
        let new_path = if existing.is_empty() {
            system_paths.clone()
        } else {
            format!("{}:{}", existing, system_paths)
        };
        env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &new_path);
    }

    let home = env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let registry = format!("{}/.cache/gstreamer-1.0/registry-vjled-{}.bin", home, arch);
    env::set_var("GST_REGISTRY_1_0", &registry);
}

#[cfg(not(target_os = "linux"))]
fn ensure_gstreamer_plugins() {}

fn main() {
    ensure_gstreamer_plugins();
    vjled_app_lib::run()
}
