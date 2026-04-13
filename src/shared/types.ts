export type StartupSourceType = 'registry-run' | 'startup-folder';

export type StartupScope = 'user' | 'machine';

export type SupportedLanguage = 'en' | 'zh-CN';

export type LanguagePreference = 'system' | SupportedLanguage;

export type StartupDisableStrategy =
  | 'startup-approved-run'
  | 'startup-approved-startup-folder';

export interface WindowBoundsState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface AppSettings {
  selfAutostart: boolean;
  windowBounds: WindowBoundsState | null;
  windowLayoutVersion: number;
  languagePreference: LanguagePreference;
  resolvedLanguage: SupportedLanguage;
}

export interface StartupItem {
  id: string;
  name: string;
  command: string;
  targetPath: string;
  sourceType: StartupSourceType;
  scope: StartupScope;
  enabled: boolean;
  requiresAdmin: boolean;
  sourceLocation: string;
  disableStrategy: StartupDisableStrategy;
}

export interface ToggleStartupPayload {
  id: string;
  targetEnabled: boolean;
}

export interface ToggleStartupResult {
  success: boolean;
  item?: StartupItem;
  errorMessage?: string;
  elevated?: boolean;
}

export type CreateStartupFromDropStatus =
  | 'created'
  | 'enabled_existing'
  | 'already_enabled'
  | 'blocked_system_level'
  | 'unsupported'
  | 'error';

export interface CreateStartupFromDropEntry {
  sourcePath: string;
  status: CreateStartupFromDropStatus;
  displayName: string;
  itemId?: string;
  message: string;
}

export interface CreateStartupFromDropPayload {
  paths: string[];
}

export interface CreateStartupFromDropResult {
  entries: CreateStartupFromDropEntry[];
}

export interface StartupManagerApi {
  listStartupItems: () => Promise<StartupItem[]>;
  refreshStartupItems: () => Promise<StartupItem[]>;
  toggleStartupItem: (payload: ToggleStartupPayload) => Promise<ToggleStartupResult>;
  openStartupItemLocation: (id: string) => Promise<boolean>;
  getStartupItemIcon: (id: string) => Promise<string | null>;
  getStartupItemIcons: (ids: string[]) => Promise<Record<string, string | null>>;
  createStartupFromDrop: (payload: CreateStartupFromDropPayload) => Promise<CreateStartupFromDropResult>;
  getPathsForDroppedFiles: (files: File[]) => string[];
  getSettings: () => Promise<AppSettings>;
  setSelfAutostart: (enabled: boolean) => Promise<AppSettings>;
  setLanguagePreference: (language: LanguagePreference) => Promise<AppSettings>;
  onForceRefresh: (listener: () => void) => () => void;
  onSettingsUpdated: (listener: (settings: AppSettings) => void) => () => void;
}
