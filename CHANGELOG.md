# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-14

### Added

- Tauri-based Windows desktop build with system tray support
- Rust backend for scanning and managing startup items
- Batch icon loading and frontend Tauri invoke/listen bridge
- Drag-and-drop support for `.exe` and `.lnk` startup item creation
- English and Simplified Chinese interface support

### Changed

- Migrated the app from Electron to Tauri to reduce footprint while preserving core behavior
- Switched the frontend build chain to `Vite + Tauri`

### Fixed

- Hidden command execution to avoid black console window flashes
- Better startup item command alignment between frontend and backend
- Window close behavior now hides to tray instead of exiting directly
- Improved startup self-autostart state synchronization
- Faster drag-to-add flow by reducing repeated full refreshes
