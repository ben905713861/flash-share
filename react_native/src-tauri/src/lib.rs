use std::{
  collections::HashMap,
  fs::{File, OpenOptions},
  io::{Write},
  path::PathBuf,
  sync::{Mutex, OnceLock},
};

use serde::Serialize;
use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Manager,
};

static RECEIVE_FILE_HANDLES: OnceLock<Mutex<HashMap<PathBuf, File>>> = OnceLock::new();

#[derive(Serialize)]
struct TransferFile {
  name: String,
  path: String,
  size: u64,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      pick_transfer_files,
      pick_receive_directory,
      allow_receive_file,
      open_receive_file,
      append_receive_file,
      close_receive_file,
      delete_receive_file,
    ]);

  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.show();
      let _ = window.unminimize();
      let _ = window.set_focus();
    }
  }));

  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let minimize = MenuItem::with_id(app, "minimize", "Minimize", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&minimize, &quit])?;

      let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found".to_string())?;
      let window_for_close = main_window.clone();
      main_window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = window_for_close.hide();
        }
      });

      let window_for_tray = main_window.clone();
      let app_for_menu = app.handle().clone();

      TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
          "The default window icon is not configured".to_string()
        })?)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |_app, event| match event.id.as_ref() {
          "minimize" => {
            let _ = window_for_tray.minimize();
          }
          "quit" => {
            app_for_menu.exit(0);
          }
          _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            let _ = main_window.show();
            let _ = main_window.unminimize();
            let _ = main_window.set_focus();
          }
        })
        .build(app)?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
fn pick_transfer_files() -> Result<Option<Vec<TransferFile>>, String> {
  let Some(paths) = rfd::FileDialog::new().pick_files() else {
    return Ok(None);
  };

  paths
    .into_iter()
    .map(|path| {
      let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
      let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file has an invalid name".to_string())?;

      Ok(TransferFile {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
      })
    })
    .collect::<Result<Vec<_>, String>>()
    .map(Some)
}

#[tauri::command]
fn pick_receive_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let Some(path) = rfd::FileDialog::new()
    .pick_folder()
  else {
    return Ok(None);
  };
  app
    .asset_protocol_scope()
    .allow_directory(&path, true)
    .map_err(|error| error.to_string())?;
  Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn allow_receive_file(app: tauri::AppHandle, directory: String, filename: String) -> Result<(), String> {
  let path = receive_file_path(&directory, &filename)?;
  app
    .asset_protocol_scope()
    .allow_file(path)
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_receive_file(directory: String, filename: String) -> Result<(), String> {
  let path = receive_file_path(&directory, &filename)?;
  let file = OpenOptions::new()
    .create(true)
    .write(true)
    .truncate(true)
    .open(&path)
    .map_err(|error| error.to_string())?;
  let handles = RECEIVE_FILE_HANDLES.get_or_init(|| Mutex::new(HashMap::new()));
  handles
    .lock()
    .map_err(|_| "Receive file handle lock poisoned".to_string())?
    .insert(path, file);
  Ok(())
}

#[tauri::command]
fn append_receive_file(
  directory: String,
  filename: String,
  bytes: Vec<u8>,
) -> Result<(), String> {
  let path = receive_file_path(&directory, &filename)?;
  let handles = RECEIVE_FILE_HANDLES.get_or_init(|| Mutex::new(HashMap::new()));
  let mut handles = handles
    .lock()
    .map_err(|_| "Receive file handle lock poisoned".to_string())?;

  handles
    .get_mut(&path)
    .ok_or_else(|| "Receive file was not initialized".to_string())?
    .write_all(&bytes)
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn close_receive_file(directory: String, filename: String) -> Result<(), String> {
  let path = receive_file_path(&directory, &filename)?;
  remove_cached_receive_file(&path)
}

#[tauri::command]
fn delete_receive_file(directory: String, filename: String) -> Result<(), String> {
  let path = receive_file_path(&directory, &filename)?;
  remove_cached_receive_file(&path)?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn remove_cached_receive_file(path: &PathBuf) -> Result<(), String> {
  if let Some(handles) = RECEIVE_FILE_HANDLES.get() {
    handles
      .lock()
      .map_err(|_| "Receive file handle lock poisoned".to_string())?
      .remove(path);
  }
  Ok(())
}

fn receive_file_path(directory: &str, filename: &str) -> Result<std::path::PathBuf, String> {
  let safe_name = std::path::Path::new(filename)
    .file_name()
    .and_then(|name| name.to_str())
    .filter(|name| *name == filename)
    .ok_or_else(|| "Invalid file name".to_string())?;
  Ok(std::path::Path::new(directory).join(safe_name))
}
