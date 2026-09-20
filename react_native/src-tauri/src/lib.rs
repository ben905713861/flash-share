use std::{
  collections::HashMap,
  fs::{File, OpenOptions},
  io::Write,
  path::PathBuf,
  sync::{Mutex, OnceLock},
};

static RECEIVE_FILE_HANDLES: OnceLock<Mutex<HashMap<PathBuf, File>>> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      pick_receive_directory,
      open_receive_file,
      append_receive_file,
      close_receive_file,
      delete_receive_file,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
fn pick_receive_directory() -> Option<String> {
  rfd::FileDialog::new()
    .pick_folder()
    .map(|path| path.to_string_lossy().into_owned())
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
