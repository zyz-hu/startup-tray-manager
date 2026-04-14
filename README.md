# Startup Tray Manager

Tiny Windows startup apps manager that lives in the tray.

Startup Tray Manager 是一个偏 Geek 风格、低心智负担的 Windows 启动项托盘小工具。

[![Release](https://img.shields.io/github/v/release/zyz-hu/startup-tray-manager?style=flat-square)](https://github.com/zyz-hu/startup-tray-manager/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?style=flat-square)
![Vue](https://img.shields.io/badge/Vue-3.x-42B883?style=flat-square)
![Stars](https://img.shields.io/github/stars/zyz-hu/startup-tray-manager?style=flat-square)

This project focuses on a simple daily workflow:

- Search startup apps fast
- Left click to enable or disable
- Right click to open file location
- Drag `.exe` or `.lnk` files into the window to add them

It aims to feel more like a compact desktop utility than a bloated settings panel.

## Why This Exists

- Windows startup entries are spread across the registry and Startup folders.
- Built-in tools only cover part of the picture.
- Many desktop utilities feel too heavy for something you use for a few seconds.
- The original Electron version worked, but the install size felt too large for this kind of tool.

The Tauri migration keeps the core workflow and makes the app much lighter.

## Features

- Tray-resident app that stays out of the way
- Clicking the window close button hides the app back to the tray
- Scans `HKCU/HKLM Run` and both user/common `Startup` folders
- Compact single-column list focused on icon + name
- Fuzzy search for app name, command, and target path
- Left click to enable or disable a startup item
- Right click to open the file location
- Drag `.exe` or `.lnk` files into the window to create a startup item
- Batch icon loading with hidden Windows command execution to avoid black console flashes
- English and Simplified Chinese UI
- Optional self-autostart for Startup Tray Manager itself

## Download

- Latest release: [GitHub Releases](https://github.com/zyz-hu/startup-tray-manager/releases/latest)
- Current installer: `Startup Tray Manager_1.0.0_x64-setup.exe`
- Target OS: Windows 10/11 x64

## Interaction

1. Left click: enable or disable a startup item
2. Right click: open file location
3. Drag `.exe` or `.lnk`: add a startup item
4. Click the window `X`: hide to tray
5. Exit the app: use the tray menu

## Supported Startup Sources

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`
- `%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp`

## Tech Stack

- Tauri 2
- Rust
- Vue 3
- Vite

## Build From Source

### Prerequisites

- Node.js 20+
- Rust / Cargo
- Windows build tools required by Tauri

### Development

```bash
npm install
npm run tauri:dev
```

### Build Installer

```bash
npm run dist
```

Installer output:

```text
src-tauri\target\release\bundle\nsis\Startup Tray Manager_1.0.0_x64-setup.exe
```

## Project Status

`v1.0.0` is the first public Tauri release.

Current focus:

- Daily-use stability
- Fast drag-to-add behavior
- Reliable startup state synchronization
- Continued UI polish while keeping the compact utility feel

## Feedback

Issues, bug reports, and suggestions are welcome.

If this tool saves you a few clicks every boot, starring the repo helps more people find it.
