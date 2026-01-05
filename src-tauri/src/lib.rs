use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageFormat};
use mouse_position::mouse_position::Mouse;
use std::fs;
use std::io::Cursor;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
use xcap::{Monitor, Window};

#[derive(serde::Serialize)]
struct WindowInfo {
    id: u32,
    title: String,
    app_name: String,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize)]
struct MonitorInfo {
    id: u32,
    name: String,
    width: u32,
    height: u32,
    is_primary: bool,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor_infos = monitors
        .into_iter()
        .map(|m| MonitorInfo {
            id: m.id().unwrap_or(0),
            name: m.name().unwrap_or_default(),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            is_primary: m.is_primary().unwrap_or(false),
        })
        .collect();
    Ok(monitor_infos)
}

#[tauri::command]
fn capture_screen(monitor_id: Option<u32>) -> Result<String, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = if let Some(id) = monitor_id {
        monitors
            .iter()
            .find(|m| m.id().unwrap_or(0) == id)
            .ok_or("Monitor not found")?
    } else {
        monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or(monitors.first())
            .ok_or("No monitor found")?
    };

    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    let dynamic_image = DynamicImage::ImageRgba8(image);
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    dynamic_image
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let encoded = general_purpose::STANDARD.encode(&buffer);
    Ok(encoded)
}

#[tauri::command]
fn get_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| e.to_string())?;
    let window_infos = windows
        .into_iter()
        .filter_map(|w| {
            let id = w.id().ok()?;
            let title = w.title().unwrap_or_default();
            let app_name = w.app_name().unwrap_or_default();
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);

            // Filter out very small windows (likely system overlays or hidden windows)
            if width < 50 || height < 50 {
                return None;
            }

            Some(WindowInfo {
                id,
                title,
                app_name,
                width,
                height,
            })
        })
        .collect();
    Ok(window_infos)
}

#[tauri::command]
fn capture_window(id: u32) -> Result<String, String> {
    let windows = Window::all().map_err(|e| e.to_string())?;
    let window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == id)
        .ok_or("Window not found")?;
    let image = window.capture_image().map_err(|e| e.to_string())?;

    let dynamic_image = DynamicImage::ImageRgba8(image);
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    dynamic_image
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let encoded = general_purpose::STANDARD.encode(&buffer);
    Ok(encoded)
}

#[tauri::command]
fn save_image(path: String, data: String) -> Result<(), String> {
    let bytes = general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_video(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(path, data).map_err(|e| e.to_string())?;
    Ok(())
}

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};

struct AppState {
    is_streaming: Arc<AtomicBool>,
}

#[tauri::command]
fn start_streaming(
    window: tauri::Window,
    state: State<'_, AppState>,
    monitor_id: Option<u32>,
) -> Result<(), String> {
    let is_streaming = state.is_streaming.clone();
    if is_streaming.load(Ordering::SeqCst) {
        return Ok(());
    }
    is_streaming.store(true, Ordering::SeqCst);

    let is_streaming_clone = is_streaming.clone();

    thread::spawn(move || {
        let monitors = match Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                println!("Error getting monitors: {}", e);
                return;
            }
        };

        // Find monitor to record
        let monitor = if let Some(id) = monitor_id {
            monitors.into_iter().find(|m| m.id().unwrap_or(0) == id)
        } else {
            monitors
                .into_iter()
                .find(|m| m.is_primary().unwrap_or(false))
        };

        if let Some(target_monitor) = monitor {
            println!(
                "Starting capture on monitor: {}",
                target_monitor.name().unwrap_or_default()
            );
            while is_streaming_clone.load(Ordering::SeqCst) {
                let start = std::time::Instant::now();
                match target_monitor.capture_image() {
                    Ok(image) => {
                        let dynamic_image = DynamicImage::ImageRgba8(image);
                        let rgb_image = dynamic_image.to_rgb8();
                        let width = rgb_image.width();
                        let height = rgb_image.height();
                        let mut buffer = Vec::new();
                        let mut cursor = Cursor::new(&mut buffer);

                        // Use JPEG with high quality (90) and RGB8 to avoid gray screen and artifacts
                        let mut encoder =
                            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
                        match encoder.encode(
                            &rgb_image,
                            width,
                            height,
                            image::ExtendedColorType::Rgb8,
                        ) {
                            Ok(_) => {
                                let encoded = general_purpose::STANDARD.encode(&buffer);
                                let _ = window.emit("screen-frame", encoded);
                            }
                            Err(e) => println!("Encoding error: {}", e),
                        }
                    }
                    Err(e) => println!("Capture error: {}", e),
                }

                // Cap at ~30 FPS (33ms)
                let elapsed = start.elapsed();
                if elapsed < Duration::from_millis(33) {
                    thread::sleep(Duration::from_millis(33) - elapsed);
                }
            }
        } else {
            println!("Monitor not found!");
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_streaming(state: State<'_, AppState>) -> Result<(), String> {
    state.is_streaming.store(false, Ordering::SeqCst);
    Ok(())
}

fn get_monitor_at_cursor() -> Option<Monitor> {
    let position = Mouse::get_mouse_position();
    let (mouse_x, mouse_y) = match position {
        Mouse::Position { x, y } => (x, y),
        _ => return None,
    };

    let monitors = Monitor::all().ok()?;

    for m in monitors {
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        let width = m.width().unwrap_or(0) as i32;
        let height = m.height().unwrap_or(0) as i32;

        if mouse_x >= x && mouse_x < x + width && mouse_y >= y && mouse_y < y + height {
            return Some(m);
        }
    }
    None
}

fn capture_monitor_at_cursor(app_handle: tauri::AppHandle) {
    if let Some(monitor) = get_monitor_at_cursor() {
        match monitor.capture_image() {
            Ok(image) => {
                let dynamic_image = DynamicImage::ImageRgba8(image);
                let mut buffer = Vec::new();
                let mut cursor = Cursor::new(&mut buffer);
                if let Ok(_) = dynamic_image.write_to(&mut cursor, ImageFormat::Png) {
                    let encoded = general_purpose::STANDARD.encode(&buffer);
                    let _ = app_handle.emit("start-area-capture", encoded);

                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            Err(e) => println!("Failed to capture monitor: {}", e),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(vec![
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F11),
                    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::F11),
                ])
                .unwrap()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let ctrl_shift_f11 =
                            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F11);
                        let cmd_shift_f11 =
                            Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::F11);

                        if shortcut == &ctrl_shift_f11 || shortcut == &cmd_shift_f11 {
                            let app_handle = app.clone();
                            thread::spawn(move || {
                                capture_monitor_at_cursor(app_handle);
                            });
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                println!("Window close requested, hiding window...");
                if let Err(e) = window.hide() {
                    println!("Error hiding window: {}", e);
                }
                api.prevent_close();
            }
            _ => {}
        })
        .manage(AppState {
            is_streaming: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            capture_screen,
            get_monitors,
            get_windows,
            capture_window,
            save_image,
            save_video,
            start_streaming,
            stop_streaming
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
