use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const WINDOW_LAYOUT_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBoundsState {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub self_autostart: bool,
    pub window_bounds: Option<WindowBoundsState>,
    pub window_layout_version: u32,
    pub language_preference: String,
    pub resolved_language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    self_autostart: bool,
    window_bounds: Option<WindowBoundsState>,
    window_layout_version: Option<u32>,
    language_preference: String,
}

pub fn default_settings(_app: &AppHandle) -> AppSettings {
    let locale = sys_locale::get_locale()
        .unwrap_or_else(|| "en".to_string())
        .to_lowercase();
    let resolved_language = if locale.starts_with("zh") {
        "zh-CN".to_string()
    } else {
        "en".to_string()
    };

    AppSettings {
        self_autostart: true,
        window_bounds: Some(WindowBoundsState {
            x: None,
            y: None,
            width: 460,
            height: 560,
        }),
        window_layout_version: WINDOW_LAYOUT_VERSION,
        language_preference: "system".to_string(),
        resolved_language,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("settings.json"))
}

fn ensure_parent(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn resolve_language(_app: &AppHandle, preference: &str) -> String {
    if preference == "en" || preference == "zh-CN" {
        return preference.to_string();
    }

    let locale = sys_locale::get_locale()
        .unwrap_or_else(|| "en".to_string())
        .to_lowercase();

    if locale.starts_with("zh") {
        "zh-CN".to_string()
    } else {
        "en".to_string()
    }
}

fn sanitize_bounds(bounds: Option<WindowBoundsState>) -> Option<WindowBoundsState> {
    bounds.map(|bounds| WindowBoundsState {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width.max(400),
        height: bounds.height.max(520),
    })
}

fn migrate_bounds(
    bounds: Option<WindowBoundsState>,
    version: Option<u32>,
) -> Option<WindowBoundsState> {
    if bounds.is_none() {
        return Some(WindowBoundsState {
            x: None,
            y: None,
            width: 460,
            height: 560,
        });
    }

    if version == Some(WINDOW_LAYOUT_VERSION) {
        return sanitize_bounds(bounds);
    }

    let bounds = bounds.unwrap();
    sanitize_bounds(Some(WindowBoundsState {
        x: bounds.x,
        y: bounds.y,
        width: 460,
        height: bounds.height.max(560),
    }))
}

pub fn load_settings(app: &AppHandle) -> AppSettings {
    let defaults = default_settings(app);
    let Ok(path) = settings_path(app) else {
        return defaults;
    };

    let Ok(raw) = fs::read_to_string(path) else {
        return defaults;
    };

    let Ok(stored) = serde_json::from_str::<StoredSettings>(&raw) else {
        return defaults;
    };

    AppSettings {
        self_autostart: stored.self_autostart,
        window_bounds: migrate_bounds(stored.window_bounds, stored.window_layout_version),
        window_layout_version: WINDOW_LAYOUT_VERSION,
        language_preference: stored.language_preference.clone(),
        resolved_language: resolve_language(app, &stored.language_preference),
    }
}

pub fn save_settings(app: &AppHandle, next: AppSettings) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    ensure_parent(&path)?;

    let language_preference = next.language_preference.clone();
    let normalized = AppSettings {
        self_autostart: next.self_autostart,
        window_bounds: sanitize_bounds(next.window_bounds),
        window_layout_version: WINDOW_LAYOUT_VERSION,
        language_preference: language_preference.clone(),
        resolved_language: resolve_language(app, &language_preference),
    };

    let stored = StoredSettings {
        self_autostart: normalized.self_autostart,
        window_bounds: normalized.window_bounds.clone(),
        window_layout_version: Some(WINDOW_LAYOUT_VERSION),
        language_preference: normalized.language_preference.clone(),
    };

    let raw = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())?;
    Ok(normalized)
}
