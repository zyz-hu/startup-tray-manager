import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type {
  CreateStartupFromDropPayload,
  StartupManagerApi,
  ToggleStartupPayload
} from '../shared/types';

const startupManagerApi: StartupManagerApi = {
  listStartupItems: () => ipcRenderer.invoke('startup:list'),
  refreshStartupItems: () => ipcRenderer.invoke('startup:refresh'),
  toggleStartupItem: (payload: ToggleStartupPayload) => ipcRenderer.invoke('startup:toggle', payload),
  openStartupItemLocation: (id: string) => ipcRenderer.invoke('startup:open-location', id),
  getStartupItemIcon: (id: string) => ipcRenderer.invoke('startup:get-icon', id),
  createStartupFromDrop: (payload: CreateStartupFromDropPayload) =>
    ipcRenderer.invoke('startup:create-from-drop', payload),
  getPathsForDroppedFiles: (files: File[]) =>
    files
      .map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSelfAutostart: (enabled: boolean) => ipcRenderer.invoke('app:set-self-autostart', enabled),
  setLanguagePreference: (language) => ipcRenderer.invoke('app:set-language-preference', language),
  onForceRefresh: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on('startup:force-refresh', wrapped);
    return () => ipcRenderer.removeListener('startup:force-refresh', wrapped);
  },
  onSettingsUpdated: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, settings: Awaited<ReturnType<StartupManagerApi['getSettings']>>) =>
      listener(settings);
    ipcRenderer.on('app:settings-updated', wrapped);
    return () => ipcRenderer.removeListener('app:settings-updated', wrapped);
  }
};

contextBridge.exposeInMainWorld('startupManager', startupManagerApi);
