import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

import type {
  AppSettings,
  CreateStartupFromDropPayload,
  CreateStartupFromDropResult,
  StartupManagerApi,
  StartupItem,
  ToggleStartupPayload,
  ToggleStartupResult
} from '../../shared/types';

const startupManagerApi: StartupManagerApi = {
  listStartupItems: () => invoke<StartupItem[]>('list_startup_items'),
  refreshStartupItems: () => invoke<StartupItem[]>('refresh_startup_items'),
  toggleStartupItem: (payload: ToggleStartupPayload) =>
    invoke<ToggleStartupResult>('toggle_startup_item', { payload }),
  openStartupItemLocation: (id: string) =>
    invoke<boolean>('open_startup_item_location', { id }),
  getStartupItemIcon: (id: string) =>
    invoke<string | null>('get_startup_item_icon', { id }),
  getStartupItemIcons: (ids: string[]) =>
    invoke<Record<string, string | null>>('get_startup_item_icons', { ids }),
  createStartupFromDrop: (payload: CreateStartupFromDropPayload) =>
    invoke<CreateStartupFromDropResult>('create_startup_from_drop', { payload }),
  getPathsForDroppedFiles: () => [],
  getSettings: () => invoke<AppSettings>('get_settings'),
  setSelfAutostart: (enabled: boolean) =>
    invoke<AppSettings>('set_self_autostart', { enabled }),
  setLanguagePreference: (language) =>
    invoke<AppSettings>('set_language_preference', { languagePreference: language }),
  onForceRefresh: (listener) => {
    let unlisten: (() => void) | null = null;
    void listen('startup-force-refresh', () => {
      listener();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  },
  onSettingsUpdated: (listener) => {
    let unlisten: (() => void) | null = null;
    void listen<AppSettings>('settings-updated', (event) => {
      listener(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }
};

declare global {
  interface Window {
    startupManager: StartupManagerApi;
  }
}

window.startupManager = startupManagerApi;

export {};
