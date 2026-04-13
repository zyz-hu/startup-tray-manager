use std::{
    collections::HashMap,
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, MutexGuard},
};

use base64::Engine;
use serde::{Deserialize, Serialize};

const USER_RUN_REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const MACHINE_RUN_REG_PATH: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
const USER_RUN_PS_PATH: &str =
    r"Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run";
const MACHINE_RUN_PS_PATH: &str =
    r"Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Run";
const USER_APPROVED_RUN_REG_PATH: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const MACHINE_APPROVED_RUN_REG_PATH: &str =
    r"HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const USER_APPROVED_RUN_PS_PATH: &str = r"Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const MACHINE_APPROVED_RUN_PS_PATH: &str = r"Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const USER_APPROVED_STARTUP_REG_PATH: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
const MACHINE_APPROVED_STARTUP_REG_PATH: &str =
    r"HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
const USER_APPROVED_STARTUP_PS_PATH: &str = r"Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
const MACHINE_APPROVED_STARTUP_PS_PATH: &str = r"Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
pub const SELF_AUTOSTART_SHORTCUT_NAME: &str = "Startup Tray Manager.lnk";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub id: String,
    pub name: String,
    pub command: String,
    pub target_path: String,
    pub source_type: String,
    pub scope: String,
    pub enabled: bool,
    pub requires_admin: bool,
    pub source_location: String,
    pub disable_strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleStartupPayload {
    pub id: String,
    pub target_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleStartupResult {
    pub success: bool,
    pub item: Option<StartupItem>,
    pub error_message: Option<String>,
    pub elevated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStartupFromDropPayload {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStartupFromDropEntry {
    pub source_path: String,
    pub status: String,
    pub display_name: String,
    pub item_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStartupFromDropResult {
    pub entries: Vec<CreateStartupFromDropEntry>,
}

#[derive(Debug, Clone)]
pub struct InternalStartupItem {
    pub item: StartupItem,
    approved_registry_path: String,
    approved_value_name: String,
    approved_bytes: Option<Vec<u8>>,
    launch_file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryValueRecord {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Value")]
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ApprovedValueRecord {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Base64")]
    base64: String,
}

#[derive(Debug, Clone, Deserialize)]
struct StartupFolderRecord {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "FullName")]
    full_name: String,
    #[serde(rename = "TargetPath")]
    target_path: String,
    #[serde(rename = "Command")]
    command: String,
    #[serde(rename = "Extension")]
    extension: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StartupSnapshotJson {
    #[serde(default)]
    user_run: serde_json::Value,
    #[serde(default)]
    machine_run: serde_json::Value,
    #[serde(default)]
    user_approved_run: serde_json::Value,
    #[serde(default)]
    machine_approved_run: serde_json::Value,
    #[serde(default)]
    user_startup_folder: serde_json::Value,
    #[serde(default)]
    machine_startup_folder: serde_json::Value,
    #[serde(default)]
    user_approved_startup_folder: serde_json::Value,
    #[serde(default)]
    machine_approved_startup_folder: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
struct ShortcutInfo {
    #[serde(rename = "TargetPath")]
    target_path: String,
    #[serde(rename = "Arguments")]
    arguments: String,
    #[serde(rename = "WorkingDirectory")]
    working_directory: String,
    #[serde(rename = "IconLocation")]
    icon_location: String,
}

#[derive(Debug, Clone)]
struct ResolvedDropInput {
    display_name: String,
    target_path: String,
    arguments: String,
    working_directory: String,
    icon_location: String,
}

#[derive(Default, Clone)]
pub struct StartupState {
    pub startup_cache: Arc<Mutex<Option<Vec<InternalStartupItem>>>>,
    pub icon_cache: Arc<Mutex<HashMap<String, Option<String>>>>,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub fn user_startup_folder() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\"))
        .join("Microsoft\\Windows\\Start Menu\\Programs\\Startup")
}

pub fn common_startup_folder() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
        .join("Microsoft\\Windows\\Start Menu\\Programs\\StartUp")
}

fn powershell(script: &str) -> Result<String, String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect::<Vec<u8>>(),
    );

    let output = hidden_command("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(clean_output(&String::from_utf8_lossy(&output.stdout)))
}

fn clean_output(output: &str) -> String {
    let trimmed = output.trim();
    if let Some(index) = trimmed.find("#< CLIXML") {
        trimmed[..index].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn escape_ps(value: &str) -> String {
    value.replace('\'', "''")
}

fn ensure_array<T: for<'a> Deserialize<'a>>(value: &serde_json::Value) -> Vec<T> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
        serde_json::Value::Object(map) if map.is_empty() => Vec::new(),
        serde_json::Value::Null => Vec::new(),
        other => serde_json::from_value(other.clone())
            .map(|v| vec![v])
            .unwrap_or_default(),
    }
}

fn approved_map(value: &serde_json::Value) -> HashMap<String, Vec<u8>> {
    ensure_array::<ApprovedValueRecord>(value)
        .into_iter()
        .filter_map(|entry| {
            base64::engine::general_purpose::STANDARD
                .decode(entry.base64)
                .ok()
                .map(|bytes| (entry.name, bytes))
        })
        .collect()
}

fn resolve_env_segments(value: &str) -> String {
    let mut result = value.to_string();
    for (key, val) in std::env::vars() {
        result = result.replace(&format!("%{}%", key), &val);
    }
    result
}

fn normalize_path(input: &str) -> String {
    resolve_env_segments(input)
        .replace('/', "\\")
        .to_lowercase()
}

fn extract_executable_path(command: &str) -> String {
    let trimmed = resolve_env_segments(command.trim());
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(stripped) = trimmed.strip_prefix('"') {
        if let Some(end) = stripped.find('"') {
            return stripped[..end].to_string();
        }
    }

    if let Some(pos) = trimmed.to_lowercase().find(".exe") {
        return trimmed[..pos + 4].to_string();
    }

    trimmed
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

fn to_title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|segment| {
            let mut chars = segment.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn friendly_name_from_target(target_path: &str) -> String {
    let stem = Path::new(target_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if stem.is_empty() {
        return String::new();
    }

    let lower = stem.to_lowercase();
    let known = HashMap::from([
        ("msedge", "Microsoft Edge"),
        ("onedrive", "OneDrive"),
        ("utools", "uTools"),
        ("docker desktop", "Docker Desktop"),
        ("dockerdesktop", "Docker Desktop"),
        ("feishu", "Feishu"),
        ("ollama app", "Ollama"),
        ("apifoxappagent", "Apifox"),
        ("securityhealthsystray", "Windows Security"),
        ("rtkauduservice64", "Realtek Audio Service"),
        ("everything", "Everything"),
        ("wemeetapp", "腾讯会议"),
        ("wechat", "微信"),
        ("weixin", "微信"),
        ("qq", "QQ"),
    ]);

    if let Some(name) = known.get(lower.as_str()) {
        return (*name).to_string();
    }

    let cleaned = stem
        .replace("AppAgent", "")
        .replace("Launcher", "")
        .replace("AutoLaunch", "")
        .replace("app", "")
        .replace(['_', '-'], " ");

    to_title_case(cleaned.trim())
}

fn looks_technical_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("autolaunch") || name.contains('.') || name.contains('_') || name.len() > 28
}

fn display_name(name: &str, target_path: &str, extension: Option<&str>) -> String {
    let normalized = if extension == Some(".lnk") {
        Path::new(name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(name)
            .trim()
            .to_string()
    } else {
        name.trim().to_string()
    };

    let friendly = friendly_name_from_target(target_path);
    if !friendly.is_empty() && (normalized.is_empty() || looks_technical_name(&normalized)) {
        return friendly;
    }

    if normalized
        .to_lowercase()
        .starts_with("microsoftedgeautolaunch_")
    {
        return "Microsoft Edge".to_string();
    }

    if normalized.is_empty() {
        friendly
    } else {
        normalized
    }
}

fn build_command(target_path: &str, arguments: &str) -> String {
    if arguments.trim().is_empty() {
        target_path.to_string()
    } else {
        format!("\"{target_path}\" {arguments}")
    }
}

fn is_enabled(bytes: Option<&Vec<u8>>) -> bool {
    match bytes.and_then(|bytes| bytes.first()) {
        None => true,
        Some(0x02) | Some(0x06) => true,
        _ => false,
    }
}

fn build_approved_bytes(enabled: bool, existing: Option<&Vec<u8>>) -> Vec<u8> {
    let mut bytes = vec![0u8; 12];
    if let Some(existing) = existing {
        for (index, byte) in existing.iter().enumerate().take(12) {
            bytes[index] = *byte;
        }
    }
    if enabled {
        bytes[0] = 0x02;
        bytes[4..].fill(0);
    } else {
        bytes[0] = 0x03;
    }
    bytes
}

fn item_id(parts: &[&str]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(parts.join("|"))
}

fn snapshot_script() -> String {
    format!(
        r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Get-RegistryEntries($path) {{
  $result = @()
  if (Test-Path -LiteralPath $path) {{
    $key = Get-Item -LiteralPath $path
    foreach ($name in $key.GetValueNames()) {{
      $result += [PSCustomObject]@{{
        Name = $name
        Value = [string]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }}
    }}
  }}
  return @($result)
}}

function Get-ApprovedEntries($path) {{
  $result = @()
  if (Test-Path -LiteralPath $path) {{
    $key = Get-Item -LiteralPath $path
    foreach ($name in $key.GetValueNames()) {{
      $bytes = [byte[]]$key.GetValue($name)
      if ($bytes) {{
        $result += [PSCustomObject]@{{
          Name = $name
          Base64 = [Convert]::ToBase64String($bytes)
        }}
      }}
    }}
  }}
  return @($result)
}}

function Get-StartupFolderEntries($folder) {{
  $result = @()
  if (Test-Path -LiteralPath $folder) {{
    $shell = New-Object -ComObject WScript.Shell
    foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {{
      if ($item.Name -eq 'desktop.ini') {{ continue }}
      $targetPath = $item.FullName
      $arguments = ''
      $command = $item.FullName
      if ($item.Extension -ieq '.lnk') {{
        try {{
          $shortcut = $shell.CreateShortcut($item.FullName)
          if ($shortcut.TargetPath) {{ $targetPath = $shortcut.TargetPath }}
          if ($shortcut.Arguments) {{ $arguments = $shortcut.Arguments }}
        }} catch {{}}
      }}
      if ($arguments) {{
        $command = ('""{{0}}"" {{1}}' -f $targetPath, $arguments)
      }} elseif ($targetPath) {{
        $command = $targetPath
      }}
      $result += [PSCustomObject]@{{
        Name = $item.Name
        FullName = $item.FullName
        TargetPath = $targetPath
        Arguments = $arguments
        Command = $command
        Extension = $item.Extension
      }}
    }}
  }}
  return @($result)
}}

$result = [PSCustomObject]@{{
  userRun = Get-RegistryEntries '{user_run_ps}'
  machineRun = Get-RegistryEntries '{machine_run_ps}'
  userApprovedRun = Get-ApprovedEntries '{user_approved_run_ps}'
  machineApprovedRun = Get-ApprovedEntries '{machine_approved_run_ps}'
  userStartupFolder = Get-StartupFolderEntries '{user_startup}'
  machineStartupFolder = Get-StartupFolderEntries '{machine_startup}'
  userApprovedStartupFolder = Get-ApprovedEntries '{user_approved_startup_ps}'
  machineApprovedStartupFolder = Get-ApprovedEntries '{machine_approved_startup_ps}'
}}
$result | ConvertTo-Json -Compress -Depth 6
"#,
        user_run_ps = escape_ps(USER_RUN_PS_PATH),
        machine_run_ps = escape_ps(MACHINE_RUN_PS_PATH),
        user_approved_run_ps = escape_ps(USER_APPROVED_RUN_PS_PATH),
        machine_approved_run_ps = escape_ps(MACHINE_APPROVED_RUN_PS_PATH),
        user_startup = escape_ps(&user_startup_folder().to_string_lossy()),
        machine_startup = escape_ps(&common_startup_folder().to_string_lossy()),
        user_approved_startup_ps = escape_ps(USER_APPROVED_STARTUP_PS_PATH),
        machine_approved_startup_ps = escape_ps(MACHINE_APPROVED_STARTUP_PS_PATH),
    )
}

fn build_registry_items(
    scope: &str,
    run_reg_path: &str,
    approved_reg_path: &str,
    values: Vec<RegistryValueRecord>,
    approved: HashMap<String, Vec<u8>>,
) -> Vec<InternalStartupItem> {
    values
        .into_iter()
        .map(|entry| {
            let approved_bytes = approved.get(&entry.name).cloned();
            let target_path = extract_executable_path(&entry.value);
            InternalStartupItem {
                item: StartupItem {
                    id: item_id(&[scope, "registry-run", run_reg_path, &entry.name]),
                    name: display_name(&entry.name, &target_path, None),
                    command: entry.value,
                    target_path: target_path.clone(),
                    source_type: "registry-run".to_string(),
                    scope: scope.to_string(),
                    enabled: is_enabled(approved_bytes.as_ref()),
                    requires_admin: scope == "machine",
                    source_location: run_reg_path.to_string(),
                    disable_strategy: "startup-approved-run".to_string(),
                },
                approved_registry_path: approved_reg_path.to_string(),
                approved_value_name: entry.name,
                approved_bytes,
                launch_file_path: if target_path.is_empty() {
                    None
                } else {
                    Some(target_path)
                },
            }
        })
        .collect()
}

fn build_startup_folder_items(
    scope: &str,
    folder_path: &str,
    approved_reg_path: &str,
    entries: Vec<StartupFolderRecord>,
    approved: HashMap<String, Vec<u8>>,
) -> Vec<InternalStartupItem> {
    entries
        .into_iter()
        .map(|entry| {
            let approved_bytes = approved.get(&entry.name).cloned();
            let target_path = resolve_env_segments(&entry.target_path);
            InternalStartupItem {
                item: StartupItem {
                    id: item_id(&[scope, "startup-folder", folder_path, &entry.full_name]),
                    name: display_name(&entry.name, &target_path, Some(&entry.extension)),
                    command: if entry.command.is_empty() {
                        entry.full_name.clone()
                    } else {
                        entry.command.clone()
                    },
                    target_path: target_path.clone(),
                    source_type: "startup-folder".to_string(),
                    scope: scope.to_string(),
                    enabled: is_enabled(approved_bytes.as_ref()),
                    requires_admin: scope == "machine",
                    source_location: folder_path.to_string(),
                    disable_strategy: "startup-approved-startup-folder".to_string(),
                },
                approved_registry_path: approved_reg_path.to_string(),
                approved_value_name: entry.name,
                approved_bytes,
                launch_file_path: Some(entry.full_name),
            }
        })
        .collect()
}

fn sort_items(items: &mut [InternalStartupItem]) {
    items.sort_by(|left, right| {
        left.item
            .name
            .to_lowercase()
            .cmp(&right.item.name.to_lowercase())
            .then(left.item.scope.cmp(&right.item.scope))
            .then(left.item.source_type.cmp(&right.item.source_type))
            .then(left.item.id.cmp(&right.item.id))
    });
}

fn write_approved_state(
    registry_path: &str,
    value_name: &str,
    enabled: bool,
    existing: Option<&Vec<u8>>,
) -> Result<(), String> {
    let bytes = build_approved_bytes(enabled, existing);
    let hex = bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    let output = hidden_command("reg.exe")
        .args([
            "add",
            registry_path,
            "/v",
            value_name,
            "/t",
            "REG_BINARY",
            "/d",
            &hex,
            "/f",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn find_existing_by_target<'a>(
    items: &'a [InternalStartupItem],
    target_path: &str,
) -> Option<&'a InternalStartupItem> {
    let normalized = normalize_path(target_path);
    items
        .iter()
        .find(|item| normalize_path(&item.item.target_path) == normalized)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn next_shortcut_path(display_name: &str) -> PathBuf {
    let mut base = sanitize_filename(display_name);
    if base.is_empty() {
        base = "Startup App".to_string();
    }
    let mut candidate = user_startup_folder().join(format!("{base}.lnk"));
    let mut index = 2;
    while candidate.exists() {
        candidate = user_startup_folder().join(format!("{base} ({index}).lnk"));
        index += 1;
    }
    candidate
}

fn shortcut_info(path: &str) -> Result<ResolvedDropInput, String> {
    let script = format!(
        r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('{path}')
[PSCustomObject]@{{
  TargetPath = [string]$shortcut.TargetPath
  Arguments = [string]$shortcut.Arguments
  WorkingDirectory = [string]$shortcut.WorkingDirectory
  IconLocation = [string]$shortcut.IconLocation
}} | ConvertTo-Json -Compress
"#,
        path = escape_ps(path)
    );
    let raw = powershell(&script)?;
    let info = serde_json::from_str::<ShortcutInfo>(&raw).map_err(|e| e.to_string())?;
    if !info.target_path.to_lowercase().ends_with(".exe") {
        return Err("unsupported".to_string());
    }

    Ok(ResolvedDropInput {
        display_name: display_name(
            Path::new(path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(path),
            &info.target_path,
            Some(".lnk"),
        ),
        target_path: info.target_path.clone(),
        arguments: info.arguments,
        working_directory: if info.working_directory.is_empty() {
            Path::new(&info.target_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            info.working_directory
        },
        icon_location: if info.icon_location.is_empty() {
            info.target_path
        } else {
            info.icon_location
        },
    })
}

fn resolve_drop_input(path: &str) -> Result<ResolvedDropInput, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("unsupported".to_string());
    }
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "exe" => Ok(ResolvedDropInput {
            display_name: display_name(
                Path::new(path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(path),
                path,
                Some(".exe"),
            ),
            target_path: path.to_string(),
            arguments: String::new(),
            working_directory: Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            icon_location: path.to_string(),
        }),
        "lnk" => shortcut_info(path),
        _ => Err("unsupported".to_string()),
    }
}

fn create_shortcut(input: &ResolvedDropInput) -> Result<String, String> {
    let shortcut_path = next_shortcut_path(&input.display_name);
    let script = format!(
        r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('{shortcut_path}')
$shortcut.TargetPath = '{target_path}'
$shortcut.Arguments = '{arguments}'
$shortcut.WorkingDirectory = '{working_directory}'
$shortcut.IconLocation = '{icon_location}'
$shortcut.Save()
Write-Output '{shortcut_path}'
"#,
        shortcut_path = escape_ps(&shortcut_path.to_string_lossy()),
        target_path = escape_ps(&input.target_path),
        arguments = escape_ps(&input.arguments),
        working_directory = escape_ps(&input.working_directory),
        icon_location = escape_ps(&input.icon_location),
    );
    let output = powershell(&script)?;
    Ok(if output.is_empty() {
        shortcut_path.to_string_lossy().to_string()
    } else {
        output
    })
}

fn create_user_startup_item(
    resolved: &ResolvedDropInput,
    shortcut_path: &str,
    approved_bytes: Option<Vec<u8>>,
) -> InternalStartupItem {
    let folder_path = user_startup_folder().to_string_lossy().to_string();
    let shortcut_name = Path::new(shortcut_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    InternalStartupItem {
        item: StartupItem {
            id: item_id(&["user", "startup-folder", &folder_path, shortcut_path]),
            name: display_name(&shortcut_name, &resolved.target_path, Some(".lnk")),
            command: build_command(&resolved.target_path, &resolved.arguments),
            target_path: resolved.target_path.clone(),
            source_type: "startup-folder".to_string(),
            scope: "user".to_string(),
            enabled: is_enabled(approved_bytes.as_ref()),
            requires_admin: false,
            source_location: folder_path,
            disable_strategy: "startup-approved-startup-folder".to_string(),
        },
        approved_registry_path: USER_APPROVED_STARTUP_REG_PATH.to_string(),
        approved_value_name: shortcut_name,
        approved_bytes,
        launch_file_path: Some(shortcut_path.to_string()),
    }
}

pub fn read_startup_items(
    state: &StartupState,
    force: bool,
) -> Result<Vec<InternalStartupItem>, String> {
    if !force {
        if let Some(items) = lock_or_recover(&state.startup_cache).clone() {
            return Ok(items);
        }
    }

    let snapshot = serde_json::from_str::<StartupSnapshotJson>(&powershell(&snapshot_script())?)
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    items.extend(build_registry_items(
        "user",
        USER_RUN_REG_PATH,
        USER_APPROVED_RUN_REG_PATH,
        ensure_array::<RegistryValueRecord>(&snapshot.user_run),
        approved_map(&snapshot.user_approved_run),
    ));
    items.extend(build_registry_items(
        "machine",
        MACHINE_RUN_REG_PATH,
        MACHINE_APPROVED_RUN_REG_PATH,
        ensure_array::<RegistryValueRecord>(&snapshot.machine_run),
        approved_map(&snapshot.machine_approved_run),
    ));
    items.extend(build_startup_folder_items(
        "user",
        &user_startup_folder().to_string_lossy(),
        USER_APPROVED_STARTUP_REG_PATH,
        ensure_array::<StartupFolderRecord>(&snapshot.user_startup_folder),
        approved_map(&snapshot.user_approved_startup_folder),
    ));
    items.extend(build_startup_folder_items(
        "machine",
        &common_startup_folder().to_string_lossy(),
        MACHINE_APPROVED_STARTUP_REG_PATH,
        ensure_array::<StartupFolderRecord>(&snapshot.machine_startup_folder),
        approved_map(&snapshot.machine_approved_startup_folder),
    ));
    sort_items(&mut items);
    *lock_or_recover(&state.startup_cache) = Some(items.clone());
    Ok(items)
}

pub fn list_startup_items(state: &StartupState) -> Result<Vec<StartupItem>, String> {
    Ok(read_startup_items(state, false)?
        .into_iter()
        .map(|item| item.item)
        .collect())
}

pub fn refresh_startup_items(state: &StartupState) -> Result<Vec<StartupItem>, String> {
    Ok(read_startup_items(state, true)?
        .into_iter()
        .map(|item| item.item)
        .collect())
}

pub fn toggle_startup_item(
    state: &StartupState,
    payload: ToggleStartupPayload,
) -> ToggleStartupResult {
    let Ok(items) = read_startup_items(state, false) else {
        return ToggleStartupResult {
            success: false,
            item: None,
            error_message: Some("Failed to read startup items.".into()),
            elevated: None,
        };
    };
    let Some(item) = items.iter().find(|item| item.item.id == payload.id) else {
        return ToggleStartupResult {
            success: false,
            item: None,
            error_message: Some("Startup item was not found.".into()),
            elevated: None,
        };
    };
    if let Err(err) = write_approved_state(
        &item.approved_registry_path,
        &item.approved_value_name,
        payload.target_enabled,
        item.approved_bytes.as_ref(),
    ) {
        return ToggleStartupResult {
            success: false,
            item: None,
            error_message: Some(err),
            elevated: Some(item.item.requires_admin),
        };
    }
    let latest = read_startup_items(state, true).ok().and_then(|items| {
        items
            .into_iter()
            .find(|candidate| candidate.item.id == payload.id)
            .map(|candidate| candidate.item)
    });
    ToggleStartupResult {
        success: true,
        item: latest,
        error_message: None,
        elevated: Some(item.item.requires_admin),
    }
}

pub fn open_startup_item_location(state: &StartupState, id: &str) -> Result<bool, String> {
    let items = read_startup_items(state, false)?;
    let Some(item) = items.iter().find(|item| item.item.id == id) else {
        return Ok(false);
    };
    for candidate in [
        item.launch_file_path.as_deref(),
        Some(item.item.target_path.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        if Path::new(candidate).exists() {
            let _ = Command::new("explorer")
                .args(["/select,", candidate])
                .spawn();
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn get_startup_item_icon(state: &StartupState, id: &str) -> Result<Option<String>, String> {
    let items = read_startup_items(state, false)?;
    let Some(item) = items.iter().find(|item| item.item.id == id) else {
        return Ok(None);
    };
    for candidate in [
        Some(item.item.target_path.as_str()),
        item.launch_file_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !Path::new(candidate).exists() {
            continue;
        }
        if let Some(cached) = lock_or_recover(&state.icon_cache).get(candidate).cloned() {
            return Ok(cached);
        }
        let script = format!(
            r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{path}')
if ($icon) {{
  $bitmap = $icon.ToBitmap()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
}}
"#,
            path = escape_ps(candidate)
        );
        let icon = powershell(&script).ok().and_then(|raw| {
            if raw.is_empty() {
                None
            } else {
                Some(format!("data:image/png;base64,{raw}"))
            }
        });
        lock_or_recover(&state.icon_cache).insert(candidate.to_string(), icon.clone());
        if icon.is_some() {
            return Ok(icon);
        }
    }
    Ok(None)
}

pub fn get_startup_item_icons(
    state: &StartupState,
    ids: &[String],
) -> Result<HashMap<String, Option<String>>, String> {
    let items = read_startup_items(state, false)?;
    let mut result: HashMap<String, Option<String>> = HashMap::new();
    let mut pending: Vec<(String, String)> = Vec::new();

    for id in ids {
        let Some(item) = items.iter().find(|item| item.item.id == *id) else {
            result.insert(id.clone(), None);
            continue;
        };

        let candidate = [
            Some(item.item.target_path.as_str()),
            item.launch_file_path.as_deref(),
        ]
        .into_iter()
        .flatten()
        .find(|path| Path::new(path).exists())
        .map(|path| path.to_string());

        let Some(candidate_path) = candidate else {
            result.insert(id.clone(), None);
            continue;
        };

        if let Some(cached) = lock_or_recover(&state.icon_cache)
            .get(&candidate_path)
            .cloned()
        {
            result.insert(id.clone(), cached);
        } else {
            pending.push((id.clone(), candidate_path));
        }
    }

    if !pending.is_empty() {
        let mut script = String::from(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nAdd-Type -AssemblyName System.Drawing\n$items = @()\n",
      );
        for (id, path) in &pending {
            script.push_str(&format!(
                "$items += [PSCustomObject]@{{ Id = '{id}'; Path = '{path}' }}\n",
                id = escape_ps(id),
                path = escape_ps(path)
            ));
        }
        script.push_str(
            r#"$result = @()
foreach ($item in $items) {
  $base64 = ''
  try {
    if (Test-Path -LiteralPath $item.Path) {
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($item.Path)
      if ($icon) {
        $bitmap = $icon.ToBitmap()
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $base64 = [Convert]::ToBase64String($stream.ToArray())
      }
    }
  } catch {
  }
  $result += [PSCustomObject]@{ Id = $item.Id; Path = $item.Path; Base64 = $base64 }
}
$result | ConvertTo-Json -Compress
"#,
        );

        let raw = powershell(&script)?;
        let parsed: Vec<serde_json::Value> = ensure_array(
            &serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())?,
        );
        let mut cache = lock_or_recover(&state.icon_cache);
        for entry in parsed {
            let id = entry
                .get("Id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let path = entry
                .get("Path")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let base64 = entry
                .get("Base64")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let icon = if base64.is_empty() {
                None
            } else {
                Some(format!("data:image/png;base64,{base64}"))
            };
            if !path.is_empty() {
                cache.insert(path, icon.clone());
            }
            if !id.is_empty() {
                result.insert(id, icon);
            }
        }
    }

    for id in ids {
        result.entry(id.clone()).or_insert(None);
    }

    Ok(result)
}

pub fn create_startup_from_drop(
    state: &StartupState,
    payload: CreateStartupFromDropPayload,
) -> Result<CreateStartupFromDropResult, String> {
    let mut items = read_startup_items(state, true)?;
    let mut entries = Vec::new();
    let mut items_changed = false;
    for original in payload.paths {
        match resolve_drop_input(&original) {
            Ok(resolved) => {
                if let Some(existing) =
                    find_existing_by_target(&items, &resolved.target_path).cloned()
                {
                    if existing.item.requires_admin {
                        entries.push(CreateStartupFromDropEntry {
                            source_path: original,
                            status: "blocked_system_level".into(),
                            display_name: existing.item.name.clone(),
                            item_id: Some(existing.item.id.clone()),
                            message: "该应用已存在系统级启动项，请在高级项中管理。".into(),
                        });
                        continue;
                    }
                    if existing.item.enabled {
                        entries.push(CreateStartupFromDropEntry {
                            source_path: original,
                            status: "already_enabled".into(),
                            display_name: existing.item.name.clone(),
                            item_id: Some(existing.item.id.clone()),
                            message: "该应用已在管理中。".into(),
                        });
                        continue;
                    }
                    match write_approved_state(
                        &existing.approved_registry_path,
                        &existing.approved_value_name,
                        true,
                        existing.approved_bytes.as_ref(),
                    ) {
                        Ok(()) => {
                            let next_approved =
                                build_approved_bytes(true, existing.approved_bytes.as_ref());
                            if let Some(item) = items
                                .iter_mut()
                                .find(|item| item.item.id == existing.item.id)
                            {
                                item.item.enabled = true;
                                item.approved_bytes = Some(next_approved);
                            }
                            items_changed = true;
                            entries.push(CreateStartupFromDropEntry {
                                source_path: original,
                                status: "enabled_existing".into(),
                                display_name: existing.item.name.clone(),
                                item_id: Some(existing.item.id.clone()),
                                message: "已启用已有启动项。".into(),
                            });
                        }
                        Err(err) => {
                            entries.push(CreateStartupFromDropEntry {
                                source_path: original,
                                status: "error".into(),
                                display_name: existing.item.name.clone(),
                                item_id: Some(existing.item.id.clone()),
                                message: err,
                            });
                        }
                    }
                    continue;
                }
                match create_shortcut(&resolved) {
                    Ok(shortcut_path) => {
                        let shortcut_name = Path::new(&shortcut_path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or_default()
                            .to_string();
                        let _ = write_approved_state(
                            USER_APPROVED_STARTUP_REG_PATH,
                            &shortcut_name,
                            true,
                            None,
                        );
                        let created = create_user_startup_item(
                            &resolved,
                            &shortcut_path,
                            Some(build_approved_bytes(true, None)),
                        );
                        let created_item = created.item.clone();
                        items.push(created);
                        items_changed = true;
                        entries.push(CreateStartupFromDropEntry {
                            source_path: original,
                            status: "created".into(),
                            display_name: created_item.name,
                            item_id: Some(created_item.id),
                            message: "已创建并启用新的开机启动项。".into(),
                        });
                    }
                    Err(_) => entries.push(CreateStartupFromDropEntry {
                        source_path: original,
                        status: "error".into(),
                        display_name: resolved.display_name,
                        item_id: None,
                        message: "创建开机自启动项失败。".into(),
                    }),
                }
            }
            Err(_) => entries.push(CreateStartupFromDropEntry {
                source_path: original.clone(),
                status: "unsupported".into(),
                display_name: Path::new(&original)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&original)
                    .to_string(),
                item_id: None,
                message: "仅支持拖入 .exe 或 .lnk 应用文件。".into(),
            }),
        }
    }
    if items_changed {
        sort_items(&mut items);
        *lock_or_recover(&state.startup_cache) = Some(items);
    }
    Ok(CreateStartupFromDropResult { entries })
}

pub fn is_hidden_launch(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--hidden")
}

pub fn self_autostart_supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn is_self_autostart_enabled() -> bool {
    user_startup_folder()
        .join(SELF_AUTOSTART_SHORTCUT_NAME)
        .exists()
}

pub fn apply_self_autostart_setting(enabled: bool) -> Result<(), String> {
    if !self_autostart_supported() {
        return Ok(());
    }
    let shortcut = user_startup_folder().join(SELF_AUTOSTART_SHORTCUT_NAME);
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let working_directory = exe
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let script = format!(
            r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('{shortcut}')
$shortcut.TargetPath = '{target}'
$shortcut.Arguments = '--hidden'
$shortcut.WorkingDirectory = '{working}'
$shortcut.IconLocation = '{target}'
$shortcut.Save()
"#,
            shortcut = escape_ps(&shortcut.to_string_lossy()),
            target = escape_ps(&exe.to_string_lossy()),
            working = escape_ps(&working_directory)
        );
        powershell(&script)?;
    } else if shortcut.exists() {
        fs::remove_file(shortcut).map_err(|e| e.to_string())?;
    }
    Ok(())
}
