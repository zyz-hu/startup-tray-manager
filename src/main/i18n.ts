import type { AppSettings, SupportedLanguage } from '../shared/types';

type MessageKey =
  | 'app.title'
  | 'tray.open'
  | 'tray.refresh'
  | 'tray.launchAtLogin'
  | 'tray.language'
  | 'tray.language.en'
  | 'tray.language.zh'
  | 'tray.exit';

const messages: Record<SupportedLanguage, Record<MessageKey, string>> = {
  en: {
    'app.title': 'Startup Tray Manager',
    'tray.open': 'Open Manager',
    'tray.refresh': 'Refresh Startup Items',
    'tray.launchAtLogin': 'Launch This App At Login',
    'tray.language': 'Language',
    'tray.language.en': 'English',
    'tray.language.zh': '简体中文',
    'tray.exit': 'Exit'
  },
  'zh-CN': {
    'app.title': '启动项托盘管理器',
    'tray.open': '打开管理器',
    'tray.refresh': '刷新启动项',
    'tray.launchAtLogin': '本软件开机启动',
    'tray.language': '语言',
    'tray.language.en': 'English',
    'tray.language.zh': '简体中文',
    'tray.exit': '退出'
  }
};

export function t(settings: AppSettings, key: MessageKey): string {
  return messages[settings.resolvedLanguage][key];
}
