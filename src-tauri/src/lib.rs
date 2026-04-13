mod settings;
mod startup;

use std::collections::HashMap;

use tauri::{
    async_runtime::spawn_blocking,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindowBuilder, WindowEvent,
};

use settings::{load_settings, save_settings, AppSettings};
use startup::{
    apply_self_autostart_setting, create_startup_from_drop as startup_create_startup_from_drop,
    get_startup_item_icon as startup_get_startup_item_icon,
    get_startup_item_icons as startup_get_startup_item_icons, is_hidden_launch,
    is_self_autostart_enabled, list_startup_items as startup_list_startup_items,
    open_startup_item_location as startup_open_startup_item_location,
    refresh_startup_items as startup_refresh_startup_items, self_autostart_supported,
    toggle_startup_item as startup_toggle_startup_item, CreateStartupFromDropPayload,
    CreateStartupFromDropResult, StartupItem, StartupState, ToggleStartupPayload,
    ToggleStartupResult,
};

fn app_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).expect("valid icon")
}

fn attach_main_window_close_behavior(window: &tauri::WebviewWindow) {
    let app_handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.hide();
            }
        }
    });
}

fn t(settings: &AppSettings, key: &str) -> &'static str {
    match (settings.resolved_language.as_str(), key) {
        ("zh-CN", "tray.open") => "打开管理器",
        ("zh-CN", "tray.refresh") => "刷新启动项",
        ("zh-CN", "tray.launch") => "本软件开机启动",
        ("zh-CN", "tray.lang") => "语言",
        ("zh-CN", "tray.lang.en") => "English",
        ("zh-CN", "tray.lang.zh") => "简体中文",
        ("zh-CN", "tray.exit") => "退出",
        (_, "tray.open") => "Open Manager",
        (_, "tray.refresh") => "Refresh Startup Items",
        (_, "tray.launch") => "Launch This App At Login",
        (_, "tray.lang") => "Language",
        (_, "tray.lang.en") => "English",
        (_, "tray.lang.zh") => "简体中文",
        _ => "Exit",
    }
}

fn ensure_main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok(window);
    }

    let settings = load_settings(app);
    let bounds = settings
        .window_bounds
        .unwrap_or(settings::WindowBoundsState {
            x: None,
            y: None,
            width: 460,
            height: 560,
        });

    let mut builder =
        WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Startup Tray Manager")
            .inner_size(bounds.width as f64, bounds.height as f64)
            .min_inner_size(400.0, 520.0)
            .visible(false)
            .icon(app_icon())?;

    if let (Some(x), Some(y)) = (bounds.x, bounds.y) {
        builder = builder.position(x as f64, y as f64);
    }

    let window = builder.build()?;
    attach_main_window_close_behavior(&window);
    Ok(window)
}

fn show_main_window(app: &AppHandle) {
    if let Ok(window) = ensure_main_window(app) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn current_settings(app: &AppHandle, repair_missing_self_autostart: bool) -> AppSettings {
    let mut settings = load_settings(app);

    if !self_autostart_supported() {
        return settings;
    }

    let mut actual_self_autostart = is_self_autostart_enabled();
    if repair_missing_self_autostart
        && settings.self_autostart
        && !actual_self_autostart
        && !cfg!(debug_assertions)
        && apply_self_autostart_setting(true).is_ok()
    {
        actual_self_autostart = is_self_autostart_enabled();
    }

    if actual_self_autostart && !settings.self_autostart {
        settings.self_autostart = true;
        if let Ok(saved) = save_settings(app, settings.clone()) {
            return saved;
        }
    }

    settings.self_autostart = actual_self_autostart;
    settings
}

fn emit_settings(app: &AppHandle) {
    let _ = app.emit("settings-updated", current_settings(app, false));
}

fn rebuild_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = current_settings(app, false);
    let open = MenuItemBuilder::with_id("open", t(&settings, "tray.open")).build(app)?;
    let refresh = MenuItemBuilder::with_id("refresh", t(&settings, "tray.refresh")).build(app)?;
    let launch = CheckMenuItemBuilder::with_id("self_autostart", t(&settings, "tray.launch"))
        .checked(settings.self_autostart)
        .build(app)?;
    let lang_en = CheckMenuItemBuilder::with_id("lang_en", t(&settings, "tray.lang.en"))
        .checked(settings.resolved_language == "en")
        .build(app)?;
    let lang_zh = CheckMenuItemBuilder::with_id("lang_zh", t(&settings, "tray.lang.zh"))
        .checked(settings.resolved_language == "zh-CN")
        .build(app)?;
    let lang_menu = SubmenuBuilder::new(app, t(&settings, "tray.lang"))
        .item(&lang_en)
        .item(&lang_zh)
        .build()?;
    let quit = MenuItemBuilder::with_id("quit", t(&settings, "tray.exit")).build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&refresh)
        .separator()
        .item(&launch)
        .item(&lang_menu)
        .separator()
        .item(&quit)
        .build()?;

    if app.tray_by_id("main-tray").is_none() {
        TrayIconBuilder::with_id("main-tray")
            .icon(app_icon())
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(&tray.app_handle());
                }
            })
            .on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_main_window(app),
                "refresh" => {
                    let _ = app.emit("startup-force-refresh", ());
                }
                "self_autostart" => {
                    let mut settings = current_settings(app, false);
                    settings.self_autostart = !settings.self_autostart;
                    if apply_self_autostart_setting(settings.self_autostart).is_ok() {
                        let _ = save_settings(app, settings);
                        emit_settings(app);
                        let _ = rebuild_tray(app);
                    }
                }
                "lang_en" => {
                    let mut settings = load_settings(app);
                    settings.language_preference = "en".into();
                    let _ = save_settings(app, settings);
                    emit_settings(app);
                    let _ = rebuild_tray(app);
                }
                "lang_zh" => {
                    let mut settings = load_settings(app);
                    settings.language_preference = "zh-CN".into();
                    let _ = save_settings(app, settings);
                    emit_settings(app);
                    let _ = rebuild_tray(app);
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;
    } else if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}

#[tauri::command]
async fn list_startup_items(
    state: tauri::State<'_, StartupState>,
) -> Result<Vec<StartupItem>, String> {
    let state = state.inner().clone();
    spawn_blocking(move || startup_list_startup_items(&state))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn refresh_startup_items(
    state: tauri::State<'_, StartupState>,
) -> Result<Vec<StartupItem>, String> {
    let state = state.inner().clone();
    spawn_blocking(move || startup_refresh_startup_items(&state))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn toggle_startup_item(
    state: tauri::State<'_, StartupState>,
    payload: ToggleStartupPayload,
) -> Result<ToggleStartupResult, String> {
    let state = state.inner().clone();
    Ok(
        spawn_blocking(move || startup_toggle_startup_item(&state, payload))
            .await
            .unwrap_or(ToggleStartupResult {
                success: false,
                item: None,
                error_message: Some("后台执行切换失败。".into()),
                elevated: None,
            }),
    )
}

#[tauri::command]
async fn open_startup_item_location(
    state: tauri::State<'_, StartupState>,
    id: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    spawn_blocking(move || startup_open_startup_item_location(&state, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_startup_item_icon(
    state: tauri::State<'_, StartupState>,
    id: String,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    spawn_blocking(move || startup_get_startup_item_icon(&state, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_startup_item_icons(
    state: tauri::State<'_, StartupState>,
    ids: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let state = state.inner().clone();
    spawn_blocking(move || startup_get_startup_item_icons(&state, &ids))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_startup_from_drop(
    state: tauri::State<'_, StartupState>,
    payload: CreateStartupFromDropPayload,
) -> Result<CreateStartupFromDropResult, String> {
    let state = state.inner().clone();
    spawn_blocking(move || startup_create_startup_from_drop(&state, payload))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    current_settings(&app, false)
}

#[tauri::command]
async fn set_self_autostart(app: AppHandle, enabled: bool) -> Result<AppSettings, String> {
    spawn_blocking(move || apply_self_autostart_setting(enabled))
        .await
        .map_err(|e| e.to_string())??;

    let mut settings = load_settings(&app);
    settings.self_autostart = enabled;
    let _ = save_settings(&app, settings)?;
    let saved = current_settings(&app, false);
    emit_settings(&app);
    let _ = rebuild_tray(&app);
    Ok(saved)
}

#[tauri::command]
fn set_language_preference(
    app: AppHandle,
    language_preference: String,
) -> Result<AppSettings, String> {
    let mut settings = load_settings(&app);
    settings.language_preference = language_preference;
    let saved = save_settings(&app, settings)?;
    emit_settings(&app);
    let _ = rebuild_tray(&app);
    Ok(saved)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !startup::is_hidden_launch(&argv) {
                show_main_window(app);
            }
        }))
        .manage(StartupState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(window) = handle.get_webview_window("main") {
                attach_main_window_close_behavior(&window);
            }
            let _ = current_settings(&handle, true);
            let _ = rebuild_tray(&handle);
            ensure_main_window(&handle)?;
            if !is_hidden_launch(&std::env::args().collect::<Vec<_>>()) {
                show_main_window(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_startup_items,
            refresh_startup_items,
            toggle_startup_item,
            open_startup_item_location,
            get_startup_item_icon,
            get_startup_item_icons,
            create_startup_from_drop,
            get_settings,
            set_self_autostart,
            set_language_preference
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
