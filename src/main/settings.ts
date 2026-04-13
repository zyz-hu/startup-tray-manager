import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type {
  AppSettings,
  LanguagePreference,
  SupportedLanguage,
  WindowBoundsState
} from '../shared/types';

const WINDOW_LAYOUT_VERSION = 2;

const DEFAULT_SETTINGS: AppSettings = {
  selfAutostart: true,
  languagePreference: 'system',
  resolvedLanguage: 'en',
  windowLayoutVersion: WINDOW_LAYOUT_VERSION,
  windowBounds: {
    width: 460,
    height: 560
  }
};

function resolveLanguage(languagePreference: LanguagePreference | undefined): SupportedLanguage {
  if (languagePreference === 'en' || languagePreference === 'zh-CN') {
    return languagePreference;
  }

  const locale = app.getLocale().toLowerCase();
  return locale.startsWith('zh') ? 'zh-CN' : 'en';
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sanitizeBounds(bounds: WindowBoundsState | null | undefined): WindowBoundsState | null {
  if (!bounds) {
    return null;
  }

  return {
    x: typeof bounds.x === 'number' ? bounds.x : undefined,
    y: typeof bounds.y === 'number' ? bounds.y : undefined,
    width: Math.max(400, Math.floor(bounds.width || DEFAULT_SETTINGS.windowBounds?.width || 460)),
    height: Math.max(520, Math.floor(bounds.height || DEFAULT_SETTINGS.windowBounds?.height || 720))
  };
}

function migrateWindowBounds(
  bounds: WindowBoundsState | null | undefined,
  savedLayoutVersion: number | undefined
): WindowBoundsState | null {
  if (!bounds) {
    return DEFAULT_SETTINGS.windowBounds;
  }

  if (savedLayoutVersion === WINDOW_LAYOUT_VERSION) {
    return sanitizeBounds(bounds);
  }

  return sanitizeBounds({
    x: bounds.x,
    y: bounds.y,
    width: DEFAULT_SETTINGS.windowBounds?.width || 460,
    height: Math.max(
      Math.floor(bounds.height || 0),
      DEFAULT_SETTINGS.windowBounds?.height || 560
    )
  });
}

export function loadSettings(): AppSettings {
  try {
    const filePath = getSettingsPath();
    if (!fs.existsSync(filePath)) {
      return DEFAULT_SETTINGS;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const languagePreference = parsed.languagePreference ?? DEFAULT_SETTINGS.languagePreference;
    const savedLayoutVersion =
      typeof parsed.windowLayoutVersion === 'number'
        ? parsed.windowLayoutVersion
        : undefined;
    return {
      selfAutostart: parsed.selfAutostart ?? DEFAULT_SETTINGS.selfAutostart,
      languagePreference,
      resolvedLanguage: resolveLanguage(languagePreference),
      windowLayoutVersion: WINDOW_LAYOUT_VERSION,
      windowBounds: migrateWindowBounds(parsed.windowBounds, savedLayoutVersion)
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      resolvedLanguage: resolveLanguage(DEFAULT_SETTINGS.languagePreference)
    };
  }
}

export function saveSettings(nextSettings: AppSettings): AppSettings {
  const languagePreference = nextSettings.languagePreference ?? DEFAULT_SETTINGS.languagePreference;
  const normalized: AppSettings = {
    selfAutostart: nextSettings.selfAutostart,
    languagePreference,
    resolvedLanguage: resolveLanguage(languagePreference),
    windowLayoutVersion: WINDOW_LAYOUT_VERSION,
    windowBounds: sanitizeBounds(nextSettings.windowBounds)
  };

  const filePath = getSettingsPath();
  ensureParentDirectory(filePath);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        selfAutostart: normalized.selfAutostart,
        languagePreference: normalized.languagePreference,
        windowLayoutVersion: normalized.windowLayoutVersion,
        windowBounds: normalized.windowBounds
      },
      null,
      2
    ),
    'utf8'
  );
  return normalized;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  return saveSettings({
    ...current,
    ...patch
  });
}

export function updateWindowBounds(bounds: WindowBoundsState): AppSettings {
  return updateSettings({
    windowBounds: bounds
  });
}
