import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, shell } from 'electron';

import type { AppSettings, LanguagePreference, ToggleStartupPayload } from '../shared/types';
import { t } from './i18n';
import { loadSettings, saveSettings, updateSettings, updateWindowBounds } from './settings';
import {
  applySelfAutostartSetting,
  createStartupItemsFromDrop,
  getStartupItemIcon,
  isSelfAutostartEnabled,
  refreshStartupItems,
  isHiddenLaunch,
  listStartupItems,
  openStartupItemLocation,
  parseElevatedToggleAction,
  performElevatedToggleAction,
  selfAutostartSupported,
  toggleStartupItem
} from './startup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.mjs');
const rendererIndexPath = path.join(__dirname, '../renderer/index.html');
const APP_ID = 'com.zyz.startuptraymanager';

const EMBEDDED_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAUNSURBVHhe7ZrfixxFEMfzF4iIEsQgeBiMhmD8FY/Nebmsd+sREMUfIAoqqGDWuxhznpcnfRDEB59E8MUHPRMv3mFM/BFjfPE/a/kMrE6qu2aqZnomh3sPn5fZ3e6qb1dXV9fsvtv2z4RpZp98MG3sCSAfTBt7AsgH08YtEeD2AwfDgYUnI3guv9s1vQhw36mnwqMfvxKWrqyF5b/O18L3Hv/0tTDz3InORelMAJzGCavTGqNr6+HY56+H+18aRnPkILsAhPL8N+9GjuTg5NZqERVyzjZkE+DuY4+F2S/ejIzuAgRGaGlDE7II8ODbpyIj+4C80jZHtBKAydnn0rA+Of71O+GOmUORbVYaC3DnAw91tte9kBvYgtJGC40EuOvwkWJSacithNOmiQhuAQj73bLyEhaFyJQ2V+EWINeeX/ztw4jlGxvR97wMvnzLlRhdArTJ9qM/1sPC5Q/C3A8rYfa70yqDiyth4aezYenaejSGlUfOvxzZrmEWgP0lJ7Iwuv5RmN8586+DL1z8JKxsfaXC55Pvzl1abSwElaj0IYVZAEJLTlIHKz67Ob5phXHy28t/q/C5jAoiwrs9TmyOTVvBJABqygmqeObPjTC//d+qtxUA5rZWwui6T4RDbyxHvkhMAniyPs5X7fOmAsDgwnvFlpJzagx3ztZGQa0A3tWf+3E1MjyXAIC4nu1QFwW1AnguOMWeTxidUwCY33k/mluDXCB9MgtA+HAfl4OmIFvLhJcihwBQ1A0JO1JQuUrfTAJw95aDaWhJT5JLgGIrJOxIQf0ifTMJYK36itVPGJkilwDw9C+2bhM3RumbSQBr+Fv2/oScAnhygXZlVgVg/8tBNChfpXEaOQUYfD82nwj7jx6NfKwUgMQhB0lBcSINqyKnALD4uy1KtRaaKgA/kIOkIBtLo0Cr+T/b3o6cLsPn8jdQviOUGV49F9mUQusqqwJYT4Dh1bXIKKhbaS9aZJB/pE0ptJNAFeDgq0vRICmGV85FRu1GAQ6ffjbysVIAQkYOkoIQlEb9LwRomwP6EqCzHMCxIQdJQadHGtWnAIu/2krie0eDyMdKASgc5CAanMfSsF4E2BwX129pTwqtY6wKAHIQDSoyaVwfAtAyk7ZoaN3iSgGsbTBqcmlcH3UAJ5C0JQXtcumbSQDrUQhVXaAydZGRWukUgwv2MvjImecj30wCEDZyMI1UFKTIJcDJn23HH9xz/InIN5MAwFVSDqhRbn9r5BCABqmcW4O+oPTJJQA9NTmoBhmZxqU0OKcAnDiexujDay9GPrkE4FqMinJgDeqC1LGYRYDNsasVRj9Dy/5mAcATBUCHSIuEpgIgqsd5qFt9MAngjQIo3g9cilvkTQTghPGEPVhWH0wCgPV6LOG6XI4GrT6YUD7vWXVPti+jXX8lZgHA847gJm5sFEVL3UuT8orjuLXMlfAmq+6N0ASXANwPeNEgJ/SAU+xlrrESLjbe938StmrVewCJSwBg8LZ/fuwK9n1V0ZPCLQDQK7C2zPukyZ8oGwkAiLBbIoHF0BoedTQWAGiatM0JbWERvGFfppUAQGJsfDq0hGzvSXgpWgswgWrRWyw1hZCnyam97vKQTQDAIAzrMkHyDzBLhWclqwATMJA6PFdEsM/5Y3TbcE/RiQBlaEYihvevtYjHamvv9HLRuQBlEAOHaFGzVSQ853Otg9sFvQqwG9kTQD6YNvYEkA+mjX8AmWKaLPirqB0AAAAASUVORK5CYII=';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function getDebugLogPath(): string {
  return path.join(app.getPath('userData'), 'startup-tray-manager-debug.log');
}

function writeDebugLog(message: string): void {
  try {
    const logPath = getDebugLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${os.EOL}`, 'utf8');
  } catch {
    // ignore
  }
}

function getIconImage() {
  return nativeImage
    .createFromBuffer(Buffer.from(EMBEDDED_ICON_PNG, 'base64'))
    .resize({ width: 18, height: 18 });
}

function currentSettings(): AppSettings {
  writeDebugLog('currentSettings()');
  const settings = loadSettings();
  if (!selfAutostartSupported()) {
    return settings;
  }

  const actualEnabled = isSelfAutostartEnabled();
  if (settings.selfAutostart === actualEnabled) {
    return settings;
  }

  writeDebugLog(`selfAutostart mismatch settings=${settings.selfAutostart} actual=${actualEnabled}`);
  return saveSettings({
    ...settings,
    selfAutostart: actualEnabled
  });
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  writeDebugLog('refreshTrayMenu()');
  const settings = currentSettings();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: t(settings, 'tray.open'),
      click: () => {
        writeDebugLog('tray menu -> open');
        void openMainWindow('tray-menu');
      }
    },
    {
      label: t(settings, 'tray.refresh'),
      click: () => {
        writeDebugLog('tray menu -> refresh');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('startup:force-refresh');
        }
      }
    },
    { type: 'separator' },
    {
      label: t(settings, 'tray.launchAtLogin'),
      type: 'checkbox',
      checked: settings.selfAutostart,
      click: async (menuItem) => {
        writeDebugLog(`tray menu -> selfAutostart ${menuItem.checked}`);
        const next = updateSettings({ selfAutostart: menuItem.checked });
        await applySelfAutostartSetting(next.selfAutostart);
        syncSettingsToUi(next);
      }
    },
    {
      label: t(settings, 'tray.language'),
      submenu: [
        {
          label: t(settings, 'tray.language.en'),
          type: 'radio',
          checked: settings.resolvedLanguage === 'en',
          click: () => {
            writeDebugLog('tray menu -> language en');
            syncSettingsToUi(updateSettings({ languagePreference: 'en' }));
          }
        },
        {
          label: t(settings, 'tray.language.zh'),
          type: 'radio',
          checked: settings.resolvedLanguage === 'zh-CN',
          click: () => {
            writeDebugLog('tray menu -> language zh-CN');
            syncSettingsToUi(updateSettings({ languagePreference: 'zh-CN' }));
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: t(settings, 'tray.exit'),
      click: () => {
        writeDebugLog('tray menu -> exit');
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Startup Tray Manager');
  tray.setContextMenu(contextMenu);
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    writeDebugLog('createMainWindow(): reuse existing');
    return mainWindow;
  }

  writeDebugLog('createMainWindow(): create new');
  const settings = currentSettings();
  const bounds = settings.windowBounds || {
    width: 460,
    height: 560
  };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 400,
    minHeight: 520,
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: t(settings, 'app.title'),
    backgroundColor: '#08111c',
    icon: getIconImage(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('close', (event) => {
    writeDebugLog(`window close event isQuitting=${isQuitting}`);
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    if (!mainWindow) {
      return;
    }

    if (!mainWindow.isMinimized()) {
      const [x, y] = mainWindow.getPosition();
      const [width, height] = mainWindow.getSize();
      updateWindowBounds({ x, y, width, height });
    }
    mainWindow.hide();
    writeDebugLog('window hidden from close event');
  });

  mainWindow.on('show', () => writeDebugLog('window show'));
  mainWindow.on('hide', () => writeDebugLog('window hide'));
  mainWindow.on('focus', () => writeDebugLog('window focus'));
  mainWindow.on('blur', () => writeDebugLog('window blur'));

  mainWindow.webContents.on('dom-ready', () => writeDebugLog('webContents dom-ready'));
  mainWindow.webContents.on('did-finish-load', () => writeDebugLog('webContents did-finish-load'));

  if (process.env.ELECTRON_RENDERER_URL) {
    writeDebugLog(`createMainWindow(): loadURL ${process.env.ELECTRON_RENDERER_URL}`);
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    writeDebugLog(`createMainWindow(): loadFile ${rendererIndexPath}`);
    void mainWindow.loadFile(rendererIndexPath);
  }

  return mainWindow;
}

async function openMainWindow(source: string): Promise<void> {
  writeDebugLog(`openMainWindow() source=${source}`);
  const window = await createMainWindow();
  writeDebugLog(`openMainWindow(): exists minimized=${window.isMinimized()} visible=${window.isVisible()}`);
  window.setSkipTaskbar(false);
  if (window.isMinimized()) {
    writeDebugLog('openMainWindow(): restore()');
    window.restore();
  }
  writeDebugLog('openMainWindow(): show()');
  window.show();
  writeDebugLog('openMainWindow(): moveTop()');
  window.moveTop();
  writeDebugLog('openMainWindow(): setAlwaysOnTop(true)');
  window.setAlwaysOnTop(true);
  writeDebugLog('openMainWindow(): focus()');
  window.focus();
  setTimeout(() => {
    if (!window.isDestroyed()) {
      writeDebugLog('openMainWindow(): setAlwaysOnTop(false)');
      window.setAlwaysOnTop(false);
    }
  }, 120);
}

function syncSettingsToUi(nextSettings: AppSettings): void {
  writeDebugLog('syncSettingsToUi()');
  refreshTrayMenu();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(t(nextSettings, 'app.title'));
    mainWindow.webContents.send('app:settings-updated', nextSettings);
  }
}

function createTray(): void {
  writeDebugLog('createTray()');
  tray = new Tray(getIconImage());
  tray.on('double-click', () => {
    writeDebugLog('tray double-click');
    void openMainWindow('tray-double-click');
  });
  refreshTrayMenu();
}

function registerIpcHandlers(): void {
  writeDebugLog('registerIpcHandlers()');
  ipcMain.handle('startup:list', async () => listStartupItems());
  ipcMain.handle('startup:refresh', async () => refreshStartupItems());
  ipcMain.handle('startup:toggle', async (_event, payload: ToggleStartupPayload) =>
    toggleStartupItem(payload.id, payload.targetEnabled)
  );
  ipcMain.handle('startup:open-location', async (_event, id: string) =>
    openStartupItemLocation(id)
  );
  ipcMain.handle('startup:get-icon', async (_event, id: string) => getStartupItemIcon(id));
  ipcMain.handle('startup:create-from-drop', async (_event, payload: { paths: string[] }) =>
    createStartupItemsFromDrop(payload.paths)
  );
  ipcMain.handle('app:get-settings', async () => currentSettings());
  ipcMain.handle('app:set-self-autostart', async (_event, enabled: boolean) => {
    const next = saveSettings({
      ...currentSettings(),
      selfAutostart: enabled
    });
    await applySelfAutostartSetting(next.selfAutostart);
    syncSettingsToUi(next);
    return next;
  });
  ipcMain.handle('app:set-language-preference', async (_event, languagePreference: LanguagePreference) => {
    const next = saveSettings({
      ...currentSettings(),
      languagePreference
    });
    syncSettingsToUi(next);
    return next;
  });
}

async function bootstrap(): Promise<void> {
  writeDebugLog('bootstrap() start');
  app.setAppUserModelId(APP_ID);
  createTray();
  registerIpcHandlers();
  writeDebugLog('bootstrap(): skip applySelfAutostartSetting on startup');
  writeDebugLog('bootstrap() complete');
}

const elevatedAction = parseElevatedToggleAction(process.argv);
writeDebugLog(`process argv=${JSON.stringify(process.argv)}`);
writeDebugLog(`elevatedAction=${elevatedAction ? 'yes' : 'no'}`);

if (!elevatedAction) {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  writeDebugLog(`requestSingleInstanceLock() => ${hasSingleInstanceLock}`);
  if (!hasSingleInstanceLock) {
    writeDebugLog('no single instance lock -> quit()');
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      writeDebugLog(`second-instance argv=${JSON.stringify(argv)}`);
      if (isHiddenLaunch(argv)) {
        writeDebugLog('second-instance ignored because hidden');
        return;
      }

      app.focus();
      void openMainWindow('second-instance');
    });
  }
}

app.on('before-quit', () => {
  writeDebugLog('before-quit');
  isQuitting = true;
});

app.whenReady().then(async () => {
  writeDebugLog('app.whenReady()');
  if (elevatedAction) {
    try {
      writeDebugLog('performElevatedToggleAction()');
      await performElevatedToggleAction(elevatedAction);
      app.exit(0);
    } catch {
      writeDebugLog('performElevatedToggleAction() failed');
      app.exit(1);
    }
    return;
  }

  await bootstrap();

  if (!isHiddenLaunch(process.argv)) {
    writeDebugLog('manual launch -> openMainWindow');
    await openMainWindow('manual-launch');
  } else {
    writeDebugLog('hidden launch -> keep window hidden');
  }
});

app.on('activate', () => {
  writeDebugLog('activate');
  void openMainWindow('activate');
});

app.on('window-all-closed', () => {
  writeDebugLog('window-all-closed');
  if (process.platform !== 'darwin') {
    return;
  }
});

app.on('web-contents-created', (_event, contents) => {
  writeDebugLog('web-contents-created');
  contents.setWindowOpenHandler(({ url }) => {
    writeDebugLog(`setWindowOpenHandler -> ${url}`);
    void shell.openExternal(url);
    return { action: 'deny' };
  });
});
