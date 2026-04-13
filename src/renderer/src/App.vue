<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Fuse from 'fuse.js';

import type {
  AppSettings,
  CreateStartupFromDropEntry,
  LanguagePreference,
  StartupItem,
  SupportedLanguage
} from '../../shared/types';

type BannerTone = 'error' | 'success' | 'info';

type MessageSchema = {
  searchPlaceholder: string;
  refresh: string;
  settings: string;
  tipText: string;
  showDisabled: string;
  showAdvanced: string;
  language: string;
  followSystem: string;
  enabled: string;
  disabled: string;
  loading: string;
  emptyTitle: string;
  emptyHint: string;
  readFailed: string;
  startupUpdateFailed: string;
  startupUnexpectedFailed: string;
  locationMissing: string;
  autostartUpdateFailed: string;
  languageUpdateFailed: string;
  rightClickHint: string;
  noCommand: string;
  dropOverlay: string;
  dropUnsupported: string;
};

const messages: Record<SupportedLanguage, MessageSchema> = {
  en: {
    searchPlaceholder: 'Search startup apps',
    refresh: 'Refresh',
    settings: 'Settings',
    tipText: '1. Left click toggle  2. Right click open location  3. Drag icon or .exe to add',
    showDisabled: 'Show disabled',
    showAdvanced: 'Show advanced',
    language: 'Language',
    followSystem: 'Default follows system language',
    enabled: 'Enabled',
    disabled: 'Disabled',
    loading: 'Scanning startup items...',
    emptyTitle: 'No startup apps to show',
    emptyHint: 'Try searching, or enable disabled / advanced items in settings.',
    readFailed: 'Failed to read startup items.',
    startupUpdateFailed: 'Failed to update the startup item.',
    startupUnexpectedFailed: 'Unexpected error while switching the startup item.',
    locationMissing: 'No valid location was found for this startup item.',
    autostartUpdateFailed: 'Failed to update app autostart setting.',
    languageUpdateFailed: 'Failed to update language preference.',
    rightClickHint: 'Right click to open location',
    noCommand: 'No launch command available.',
    dropOverlay: 'Drop .exe or .lnk files here to create startup items',
    dropUnsupported: 'Only .exe and .lnk files are supported.'
  },
  'zh-CN': {
    searchPlaceholder: '搜索启动项',
    refresh: '刷新',
    settings: '设置',
    tipText: '1. 左键开关  2. 右键文件位置  3. 拖拽图标或 exe 新增',
    showDisabled: '显示已关闭',
    showAdvanced: '显示高级项',
    language: '语言',
    followSystem: '默认跟随系统语言',
    enabled: '启用',
    disabled: '关闭',
    loading: '正在扫描启动项...',
    emptyTitle: '当前没有可显示的启动项',
    emptyHint: '可以尝试搜索，或在设置里开启已关闭 / 高级项显示。',
    readFailed: '读取启动项失败。',
    startupUpdateFailed: '更新启动项状态失败。',
    startupUnexpectedFailed: '切换启动项时出现异常。',
    locationMissing: '没有找到该启动项对应的位置。',
    autostartUpdateFailed: '更新本软件开机启动设置失败。',
    languageUpdateFailed: '更新语言设置失败。',
    rightClickHint: '右键打开位置',
    noCommand: '没有可显示的启动命令。',
    dropOverlay: '把 .exe 或 .lnk 应用拖到这里，创建开机自启动',
    dropUnsupported: '仅支持拖入 .exe 和 .lnk 文件。'
  }
};

const SEARCH_STORAGE_KEY = 'startup-tray-manager.search';
const HINT_DISMISSED_STORAGE_KEY = 'startup-tray-manager.hint-dismissed-v2';

const fallbackLanguage: SupportedLanguage = navigator.language.toLowerCase().startsWith('zh')
  ? 'zh-CN'
  : 'en';

const sorter = new Intl.Collator('zh-CN', {
  sensitivity: 'base',
  numeric: true
});

const items = ref<StartupItem[]>([]);
const loading = ref(true);
const bannerMessage = ref('');
const bannerTone = ref<BannerTone>('info');
const searchText = ref(localStorage.getItem(SEARCH_STORAGE_KEY) || '');
const busyIds = ref<Record<string, boolean>>({});
const iconUrls = ref<Record<string, string | null>>({});
const settings = ref<AppSettings | null>(null);
const languageSaving = ref(false);
const showDisabled = ref(false);
const showAdvanced = ref(false);
const isSettingsOpen = ref(false);
const isHintVisible = ref(localStorage.getItem(HINT_DISMISSED_STORAGE_KEY) !== '1');
const dragDepth = ref(0);
const isDropOverlayVisible = ref(false);
const focusedItemId = ref<string | null>(null);

const settingsButtonRef = ref<HTMLElement | null>(null);
const settingsPanelRef = ref<HTMLElement | null>(null);
const listShellRef = ref<HTMLElement | null>(null);

let removeForceRefreshListener: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

watch(searchText, (value) => {
  localStorage.setItem(SEARCH_STORAGE_KEY, value);
});

const currentLanguage = computed<SupportedLanguage>(() => {
  return settings.value?.resolvedLanguage || fallbackLanguage;
});

const copy = computed(() => messages[currentLanguage.value]);

watch(currentLanguage, (language) => {
  document.documentElement.lang = language;
});

function applySearch(pool: StartupItem[]): StartupItem[] {
  const keyword = searchText.value.trim();
  if (!keyword) {
    return pool;
  }

  const fuse = new Fuse(pool, {
    threshold: 0.3,
    ignoreLocation: true,
    keys: [
      { name: 'name', weight: 0.7 },
      { name: 'command', weight: 0.2 },
      { name: 'targetPath', weight: 0.1 }
    ]
  });

  return fuse.search(keyword).map((entry) => entry.item);
}

function sortItems(pool: StartupItem[]): StartupItem[] {
  return [...pool].sort((left, right) => {
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }

    return sorter.compare(left.name, right.name);
  });
}

const userItems = computed(() => items.value.filter((item) => !item.requiresAdmin));
const visibleBaseItems = computed(() => (showAdvanced.value ? items.value : userItems.value));

const visibleItems = computed(() => {
  const searched = sortItems(applySearch(visibleBaseItems.value));

  if (searchText.value.trim()) {
    return searched;
  }

  if (showDisabled.value) {
    return searched;
  }

  return searched.filter((item) => item.enabled);
});

watch(
  () => visibleItems.value.map((item) => item.id),
  async (ids) => {
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(iconUrls.value, id)) {
        continue;
      }

      iconUrls.value = {
        ...iconUrls.value,
        [id]: null
      };

      const iconDataUrl = await window.startupManager.getStartupItemIcon(id);
      iconUrls.value = {
        ...iconUrls.value,
        [id]: iconDataUrl
      };
    }

    if (focusedItemId.value && ids.includes(focusedItemId.value)) {
      await nextTick();
      document
        .querySelector<HTMLElement>(`[data-item-id="${focusedItemId.value}"]`)
        ?.scrollIntoView({ block: 'nearest' });
      focusedItemId.value = null;
    }
  },
  { immediate: true }
);

function closeSettingsPanelOnOutsideClick(event: MouseEvent): void {
  if (!isSettingsOpen.value) {
    return;
  }

  const target = event.target as Node | null;
  const clickedInsideButton = settingsButtonRef.value?.contains(target ?? null);
  const clickedInsidePanel = settingsPanelRef.value?.contains(target ?? null);

  if (!clickedInsideButton && !clickedInsidePanel) {
    isSettingsOpen.value = false;
  }
}

async function loadSettings(): Promise<void> {
  settings.value = await window.startupManager.getSettings();
}

async function loadItems(): Promise<void> {
  return loadItemsInternal(true);
}

async function loadItemsInternal(clearBanner: boolean): Promise<void> {
  loading.value = true;
  if (clearBanner) {
    bannerMessage.value = '';
  }

  try {
    items.value = await window.startupManager.refreshStartupItems();
  } catch {
    bannerTone.value = 'error';
    bannerMessage.value = copy.value.readFailed;
  } finally {
    loading.value = false;
  }
}

async function handleRefresh(): Promise<void> {
  await loadItems();
  await nextTick();
  listShellRef.value?.scrollTo({
    top: 0
  });
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadSettings(), loadItems()]);
}

function setBusy(id: string, value: boolean): void {
  busyIds.value = {
    ...busyIds.value,
    [id]: value
  };
}

async function toggleItem(item: StartupItem): Promise<void> {
  if (busyIds.value[item.id]) {
    return;
  }

  setBusy(item.id, true);
  bannerMessage.value = '';

  try {
    const result = await window.startupManager.toggleStartupItem({
      id: item.id,
      targetEnabled: !item.enabled
    });

    if (!result.success) {
      bannerTone.value = 'error';
      bannerMessage.value = result.errorMessage || copy.value.startupUpdateFailed;
      return;
    }

    if (result.item) {
      items.value = items.value.map((current) =>
        current.id === result.item?.id ? result.item : current
      );
    } else {
      await loadItems();
    }
  } catch {
    bannerTone.value = 'error';
    bannerMessage.value = copy.value.startupUnexpectedFailed;
  } finally {
    setBusy(item.id, false);
  }
}

async function openLocation(item: StartupItem): Promise<void> {
  const opened = await window.startupManager.openStartupItemLocation(item.id);
  if (!opened) {
    bannerTone.value = 'error';
    bannerMessage.value = copy.value.locationMissing;
  }
}

async function updateLanguagePreference(languagePreference: LanguagePreference): Promise<void> {
  if (languageSaving.value) {
    return;
  }

  languageSaving.value = true;
  bannerMessage.value = '';

  try {
    settings.value = await window.startupManager.setLanguagePreference(languagePreference);
  } catch {
    bannerTone.value = 'error';
    bannerMessage.value = copy.value.languageUpdateFailed;
  } finally {
    languageSaving.value = false;
  }
}

function dismissHint(): void {
  isHintVisible.value = false;
  localStorage.setItem(HINT_DISMISSED_STORAGE_KEY, '1');
}

function extractDroppedPaths(event: DragEvent): string[] {
  const files = Array.from(event.dataTransfer?.files || []);
  return window.startupManager.getPathsForDroppedFiles(files);
}

function summarizeDropEntries(entries: CreateStartupFromDropEntry[]): { tone: BannerTone; message: string } {
  const created = entries.filter((entry) => entry.status === 'created');
  const enabledExisting = entries.filter((entry) => entry.status === 'enabled_existing');
  const alreadyEnabled = entries.filter((entry) => entry.status === 'already_enabled');
  const blocked = entries.filter((entry) => entry.status === 'blocked_system_level');
  const unsupported = entries.filter((entry) => entry.status === 'unsupported');
  const errors = entries.filter((entry) => entry.status === 'error');

  const parts: string[] = [];
  const isChinese = currentLanguage.value === 'zh-CN';

  if (created.length) {
    parts.push(isChinese ? `已创建 ${created.length} 个` : `Created ${created.length}`);
  }
  if (enabledExisting.length) {
    parts.push(
      isChinese
        ? `已启用已有项 ${enabledExisting.length} 个`
        : `Enabled existing ${enabledExisting.length}`
    );
  }
  if (alreadyEnabled.length) {
    parts.push(
      isChinese
        ? `已在管理中 ${alreadyEnabled.length} 个`
        : `Already managed ${alreadyEnabled.length}`
    );
  }
  if (blocked.length) {
    parts.push(
      isChinese
        ? `系统级阻止 ${blocked.length} 个`
        : `Blocked by system-level item ${blocked.length}`
    );
  }
  if (unsupported.length) {
    parts.push(isChinese ? `不支持 ${unsupported.length} 个` : `Unsupported ${unsupported.length}`);
  }
  if (errors.length) {
    parts.push(isChinese ? `失败 ${errors.length} 个` : `Failed ${errors.length}`);
  }

  if (errors.length) {
    return {
      tone: 'error',
      message: parts.join(isChinese ? '，' : ', ')
    };
  }

  if (blocked.length || unsupported.length) {
    return {
      tone: 'info',
      message: parts.join(isChinese ? '，' : ', ')
    };
  }

  return {
    tone: 'success',
    message: parts.join(isChinese ? '，' : ', ')
  };
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  dragDepth.value = 0;
  isDropOverlayVisible.value = false;

  const paths = extractDroppedPaths(event);
  if (paths.length === 0) {
    bannerTone.value = 'info';
    bannerMessage.value = copy.value.dropUnsupported;
    return;
  }

  bannerMessage.value = '';

  const result = await window.startupManager.createStartupFromDrop({ paths });
  const summary = summarizeDropEntries(result.entries);
  bannerTone.value = summary.tone;
  bannerMessage.value = summary.message || copy.value.dropUnsupported;

  const focusTarget = result.entries.find((entry) => entry.itemId)?.itemId;
  if (focusTarget) {
    focusedItemId.value = focusTarget;
  }

  await loadItemsInternal(false);
  await nextTick();
  listShellRef.value?.scrollTo({
    top: 0
  });
}

function handleDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }

  event.preventDefault();
  dragDepth.value += 1;
  isDropOverlayVisible.value = true;
}

function handleDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  isDropOverlayVisible.value = true;
}

function handleDragLeave(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }

  event.preventDefault();
  dragDepth.value = Math.max(0, dragDepth.value - 1);
  if (dragDepth.value === 0) {
    isDropOverlayVisible.value = false;
  }
}

onMounted(async () => {
  document.addEventListener('mousedown', closeSettingsPanelOnOutsideClick);

  removeForceRefreshListener = window.startupManager.onForceRefresh(() => {
    void handleRefresh();
  });
  removeSettingsListener = window.startupManager.onSettingsUpdated((nextSettings) => {
    settings.value = nextSettings;
  });

  await refreshAll();
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeSettingsPanelOnOutsideClick);
  removeForceRefreshListener?.();
  removeSettingsListener?.();
});
</script>

<template>
  <main
    class="compact-shell"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <section class="toolbar">
      <label class="toolbar__search">
        <input
          v-model.trim="searchText"
          type="text"
          :placeholder="copy.searchPlaceholder"
        />
      </label>

      <button class="toolbar__button" :disabled="loading" @click="handleRefresh">
        {{ copy.refresh }}
      </button>

      <div class="toolbar__settings">
        <button
          ref="settingsButtonRef"
          class="toolbar__button"
          @click="isSettingsOpen = !isSettingsOpen"
        >
          {{ copy.settings }}
        </button>

        <section
          v-if="isSettingsOpen"
          ref="settingsPanelRef"
          class="settings-panel"
        >
          <div class="settings-panel__group">
            <span class="settings-panel__label">{{ copy.language }}</span>
            <small>{{ copy.followSystem }}</small>
            <div class="segmented">
              <button
                class="segmented__item"
                :class="{ 'segmented__item--active': currentLanguage === 'en' }"
                :disabled="languageSaving"
                @click="updateLanguagePreference('en')"
              >
                EN
              </button>
              <button
                class="segmented__item"
                :class="{ 'segmented__item--active': currentLanguage === 'zh-CN' }"
                :disabled="languageSaving"
                @click="updateLanguagePreference('zh-CN')"
              >
                中
              </button>
            </div>
          </div>

          <label class="settings-check">
            <input v-model="showDisabled" type="checkbox" />
            <span>{{ copy.showDisabled }}</span>
          </label>

          <label class="settings-check">
            <input v-model="showAdvanced" type="checkbox" />
            <span>{{ copy.showAdvanced }}</span>
          </label>
        </section>
      </div>
    </section>

    <section
      v-if="bannerMessage"
      class="status-strip"
      :class="bannerTone === 'error' ? 'status-strip--error' : bannerTone === 'success' ? 'status-strip--success' : ''"
    >
      {{ bannerMessage }}
    </section>

    <section ref="listShellRef" class="list-shell">
      <div v-if="loading" class="list-empty">
        {{ copy.loading }}
      </div>

      <div v-else-if="visibleItems.length === 0" class="list-empty">
        <strong>{{ copy.emptyTitle }}</strong>
        <span>{{ copy.emptyHint }}</span>
      </div>

      <template v-else>
        <article
          v-if="isHintVisible"
          class="hint-row"
        >
          <span>{{ copy.tipText }}</span>
          <button class="hint-row__close" @click="dismissHint">x</button>
        </article>

        <article
          v-for="item in visibleItems"
          :key="item.id"
          :data-item-id="item.id"
          class="list-row"
          :title="`${item.command || item.targetPath || copy.noCommand}\n${copy.rightClickHint}`"
          :class="item.enabled ? 'list-row--enabled' : 'list-row--disabled'"
          @click="toggleItem(item)"
          @contextmenu.prevent="openLocation(item)"
        >
          <span class="list-row__icon">
            <img v-if="iconUrls[item.id]" :src="iconUrls[item.id] || ''" alt="" />
            <span v-else>{{ item.name.slice(0, 1).toUpperCase() }}</span>
          </span>
          <strong class="list-row__name">{{ item.name }}</strong>
        </article>
      </template>
    </section>

    <section v-if="isDropOverlayVisible" class="drop-overlay">
      {{ copy.dropOverlay }}
    </section>
  </main>
</template>
