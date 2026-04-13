import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app, shell } from 'electron';

import type {
  CreateStartupFromDropEntry,
  CreateStartupFromDropResult,
  StartupDisableStrategy,
  StartupItem,
  ToggleStartupResult
} from '../shared/types';

const execFileAsync = promisify(execFile);

const USER_RUN_REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MACHINE_RUN_REG_PATH = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const USER_RUN_PS_PATH = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MACHINE_RUN_PS_PATH = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const USER_APPROVED_RUN_REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const MACHINE_APPROVED_RUN_REG_PATH =
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const USER_APPROVED_RUN_PS_PATH =
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const MACHINE_APPROVED_RUN_PS_PATH =
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

const USER_APPROVED_STARTUP_REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
const MACHINE_APPROVED_STARTUP_REG_PATH =
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
const USER_APPROVED_STARTUP_PS_PATH =
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
const MACHINE_APPROVED_STARTUP_PS_PATH =
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';

const USER_STARTUP_FOLDER = path.join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const SELF_AUTOSTART_SHORTCUT_NAME = 'Startup Tray Manager.lnk';
const COMMON_STARTUP_FOLDER = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'StartUp'
);

const SORTER = new Intl.Collator('zh-CN', {
  sensitivity: 'base',
  numeric: true
});

interface RegistryValueRecord {
  Name: string;
  Value: string;
  Kind: string;
}

interface ApprovedValueRecord {
  Name: string;
  Base64: string;
}

interface StartupSnapshotJson {
  userRun?: RegistryValueRecord[] | RegistryValueRecord;
  machineRun?: RegistryValueRecord[] | RegistryValueRecord;
  userApprovedRun?: ApprovedValueRecord[] | ApprovedValueRecord;
  machineApprovedRun?: ApprovedValueRecord[] | ApprovedValueRecord;
  userStartupFolder?: StartupFolderRecord[] | StartupFolderRecord;
  machineStartupFolder?: StartupFolderRecord[] | StartupFolderRecord;
  userApprovedStartupFolder?: ApprovedValueRecord[] | ApprovedValueRecord;
  machineApprovedStartupFolder?: ApprovedValueRecord[] | ApprovedValueRecord;
}

interface StartupFolderRecord {
  Name: string;
  FullName: string;
  TargetPath: string;
  Arguments: string;
  Command: string;
  Extension: string;
}

interface InternalStartupItem extends StartupItem {
  approvedRegistryPath: string;
  approvedValueName: string;
  approvedBytes?: Buffer;
  launchFilePath?: string;
}

interface ElevatedToggleAction {
  approvedRegistryPath: string;
  approvedValueName: string;
  targetEnabled: boolean;
  currentApprovedBase64?: string;
}

interface ResolvedDropInput {
  sourcePath: string;
  displayName: string;
  targetPath: string;
  arguments: string;
  workingDirectory: string;
  iconLocation: string;
}

let startupItemsCache: InternalStartupItem[] | null = null;
const startupItemIconCache = new Map<string, string | null>();

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell(script)
    ],
    {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }
  );

  return cleanPowerShellOutput(stdout);
}

function cleanPowerShellOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return '';
  }

  const clixmlMarkerIndex = trimmed.indexOf('#< CLIXML');
  const withoutClixml =
    clixmlMarkerIndex >= 0 ? trimmed.slice(0, clixmlMarkerIndex).trim() : trimmed;

  if (!withoutClixml) {
    return '';
  }

  const firstObjectIndex = withoutClixml.indexOf('{');
  const firstArrayIndex = withoutClixml.indexOf('[');

  if (firstObjectIndex === -1 && firstArrayIndex === -1) {
    return withoutClixml;
  }

  if (firstObjectIndex === -1) {
    return withoutClixml.slice(firstArrayIndex).trim();
  }

  if (firstArrayIndex === -1) {
    return withoutClixml.slice(firstObjectIndex).trim();
  }

  return withoutClixml.slice(Math.min(firstObjectIndex, firstArrayIndex)).trim();
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim();
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as T[] | T;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function ensureArray<T>(value?: T[] | T): T[] {
  if (!value) {
    return [];
  }

  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function toApprovedMap(entries?: ApprovedValueRecord[] | ApprovedValueRecord): Map<string, Buffer> {
  return new Map(
    ensureArray(entries)
      .filter(
        (entry): entry is ApprovedValueRecord =>
          Boolean(entry && typeof entry.Name === 'string' && typeof entry.Base64 === 'string')
      )
      .map((entry) => [entry.Name, Buffer.from(entry.Base64, 'base64')])
  );
}

async function readStartupSnapshot(): Promise<StartupSnapshotJson> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Get-RegistryEntries($path) {
  $result = @()
  if (Test-Path -LiteralPath $path) {
    $key = Get-Item -LiteralPath $path
    foreach ($name in $key.GetValueNames()) {
      $result += [PSCustomObject]@{
        Name = $name
        Value = [string]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        Kind = $key.GetValueKind($name).ToString()
      }
    }
  }
  return @($result)
}

function Get-ApprovedEntries($path) {
  $result = @()
  if (Test-Path -LiteralPath $path) {
    $key = Get-Item -LiteralPath $path
    foreach ($name in $key.GetValueNames()) {
      $bytes = [byte[]]$key.GetValue($name)
      if ($bytes) {
        $result += [PSCustomObject]@{
          Name = $name
          Base64 = [Convert]::ToBase64String($bytes)
        }
      }
    }
  }
  return @($result)
}

function Get-StartupFolderEntries($folder) {
  $result = @()
  if (Test-Path -LiteralPath $folder) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
      if ($item.Name -eq 'desktop.ini') {
        continue
      }

      $targetPath = $item.FullName
      $arguments = ''
      $command = $item.FullName

      if ($item.Extension -ieq '.lnk') {
        try {
          $shortcut = $shell.CreateShortcut($item.FullName)
          if ($shortcut.TargetPath) {
            $targetPath = $shortcut.TargetPath
          }
          if ($shortcut.Arguments) {
            $arguments = $shortcut.Arguments
          }
        } catch {
        }
      }

      if ($arguments) {
        $command = ('"{0}" {1}' -f $targetPath, $arguments)
      } elseif ($targetPath) {
        $command = $targetPath
      }

      $result += [PSCustomObject]@{
        Name = $item.Name
        FullName = $item.FullName
        TargetPath = $targetPath
        Arguments = $arguments
        Command = $command
        Extension = $item.Extension
      }
    }
  }
  return @($result)
}

$result = [PSCustomObject]@{
  userRun = Get-RegistryEntries '${escapePowerShellString(USER_RUN_PS_PATH)}'
  machineRun = Get-RegistryEntries '${escapePowerShellString(MACHINE_RUN_PS_PATH)}'
  userApprovedRun = Get-ApprovedEntries '${escapePowerShellString(USER_APPROVED_RUN_PS_PATH)}'
  machineApprovedRun = Get-ApprovedEntries '${escapePowerShellString(MACHINE_APPROVED_RUN_PS_PATH)}'
  userStartupFolder = Get-StartupFolderEntries '${escapePowerShellString(USER_STARTUP_FOLDER)}'
  machineStartupFolder = Get-StartupFolderEntries '${escapePowerShellString(COMMON_STARTUP_FOLDER)}'
  userApprovedStartupFolder = Get-ApprovedEntries '${escapePowerShellString(USER_APPROVED_STARTUP_PS_PATH)}'
  machineApprovedStartupFolder = Get-ApprovedEntries '${escapePowerShellString(MACHINE_APPROVED_STARTUP_PS_PATH)}'
}

$result | ConvertTo-Json -Compress -Depth 6
`;

  const raw = await runPowerShell(script);
  return raw ? (JSON.parse(raw) as StartupSnapshotJson) : {};
}

async function readRegistryValues(registryPsPath: string): Promise<RegistryValueRecord[]> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = '${escapePowerShellString(registryPsPath)}'
$result = @()
if (Test-Path -LiteralPath $path) {
  $key = Get-Item -LiteralPath $path
  foreach ($name in $key.GetValueNames()) {
    $result += [PSCustomObject]@{
      Name = $name
      Value = [string]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      Kind = $key.GetValueKind($name).ToString()
    }
  }
}
@($result) | ConvertTo-Json -Compress
`;

  return parseJsonArray<RegistryValueRecord>(await runPowerShell(script));
}

async function readApprovedValues(registryPsPath: string): Promise<Map<string, Buffer>> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = '${escapePowerShellString(registryPsPath)}'
$result = @()
if (Test-Path -LiteralPath $path) {
  $key = Get-Item -LiteralPath $path
  foreach ($name in $key.GetValueNames()) {
    $bytes = [byte[]]$key.GetValue($name)
    if ($bytes) {
      $result += [PSCustomObject]@{
        Name = $name
        Base64 = [Convert]::ToBase64String($bytes)
      }
    }
  }
}
@($result) | ConvertTo-Json -Compress
`;

  const entries = parseJsonArray<ApprovedValueRecord>(await runPowerShell(script));
  return new Map(entries.map((entry) => [entry.Name, Buffer.from(entry.Base64, 'base64')]));
}

async function readStartupFolderEntries(folderPath: string): Promise<StartupFolderRecord[]> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$folder = '${escapePowerShellString(folderPath)}'
$result = @()
if (Test-Path -LiteralPath $folder) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
    if ($item.Name -eq 'desktop.ini') {
      continue
    }

    $targetPath = $item.FullName
    $arguments = ''
    $command = $item.FullName

    if ($item.Extension -ieq '.lnk') {
      try {
        $shortcut = $shell.CreateShortcut($item.FullName)
        if ($shortcut.TargetPath) {
          $targetPath = $shortcut.TargetPath
        }
        if ($shortcut.Arguments) {
          $arguments = $shortcut.Arguments
        }
      } catch {
      }
    }

    if ($arguments) {
      $command = ('"{0}" {1}' -f $targetPath, $arguments)
    } elseif ($targetPath) {
      $command = $targetPath
    }

    $result += [PSCustomObject]@{
      Name = $item.Name
      FullName = $item.FullName
      TargetPath = $targetPath
      Arguments = $arguments
      Command = $command
      Extension = $item.Extension
    }
  }
}
@($result) | ConvertTo-Json -Compress
`;

  return parseJsonArray<StartupFolderRecord>(await runPowerShell(script));
}

function resolveEnvSegments(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, segment) => process.env[segment] || `%${segment}%`);
}

function normalizeComparablePath(inputPath: string): string {
  return path.normalize(resolveEnvSegments(inputPath)).replace(/\//g, '\\').toLowerCase();
}

function extractExecutablePath(command: string): string {
  const trimmed = resolveEnvSegments(command.trim());
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    return endQuote > 1 ? trimmed.slice(1, endQuote) : trimmed.slice(1);
  }

  const exeMatch = trimmed.match(/^(.+?\.exe)\b/i);
  if (exeMatch) {
    return exeMatch[1];
  }

  return trimmed.split(/\s+/)[0];
}

function toTitleCase(value: string): string {
  return value.replace(/\b([a-z])([a-z]*)/gi, (_, first: string, rest: string) => {
    return `${first.toUpperCase()}${rest.toLowerCase()}`;
  });
}

function getFriendlyNameFromTarget(targetPath: string): string {
  const baseName = path.parse(targetPath).name.trim();
  if (!baseName) {
    return '';
  }

  const lowerName = baseName.toLowerCase();
  const knownNames: Record<string, string> = {
    'msedge': 'Microsoft Edge',
    'onedrive': 'OneDrive',
    'utools': 'uTools',
    'docker desktop': 'Docker Desktop',
    'dockerdesktop': 'Docker Desktop',
    'feishu': 'Feishu',
    'ollama app': 'Ollama',
    'apifoxappagent': 'Apifox',
    'securityhealthsystray': 'Windows Security',
    'rtkauduservice64': 'Realtek Audio Service',
    'everything': 'Everything'
  };

  if (knownNames[lowerName]) {
    return knownNames[lowerName];
  }

  const cleanedName = baseName
    .replace(/appagent$/i, '')
    .replace(/\s*launcher$/i, '')
    .replace(/\s*autolaunch.*$/i, '')
    .replace(/\s*app$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  return cleanedName ? toTitleCase(cleanedName) : '';
}

function looksTechnicalName(name: string): boolean {
  return (
    /autolaunch/i.test(name) ||
    /[_-][A-F0-9]{8,}/i.test(name) ||
    /[a-z]\.[a-z]/i.test(name) ||
    name.length > 28
  );
}

function getDisplayName(name: string, targetPath: string, extension?: string): string {
  const normalizedName =
    extension?.toLowerCase() === '.lnk' ? path.parse(name).name.trim() : name.trim();
  const friendlyTargetName = getFriendlyNameFromTarget(targetPath);

  if (friendlyTargetName && (looksTechnicalName(normalizedName) || !normalizedName)) {
    return friendlyTargetName;
  }

  if (/^microsoftedgeautolaunch_/i.test(normalizedName)) {
    return 'Microsoft Edge';
  }

  return normalizedName || friendlyTargetName || name;
}

async function resolveShortcutFile(filePath: string): Promise<ResolvedDropInput | null> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('${escapePowerShellString(filePath)}')
[PSCustomObject]@{
  TargetPath = [string]$shortcut.TargetPath
  Arguments = [string]$shortcut.Arguments
  WorkingDirectory = [string]$shortcut.WorkingDirectory
  IconLocation = [string]$shortcut.IconLocation
} | ConvertTo-Json -Compress
`;

  const raw = await runPowerShell(script);
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as {
    TargetPath?: string;
    Arguments?: string;
    WorkingDirectory?: string;
    IconLocation?: string;
  };

  const targetPath = parsed.TargetPath?.trim() || '';
  if (!targetPath || !targetPath.toLowerCase().endsWith('.exe')) {
    return null;
  }

  return {
    sourcePath: filePath,
    displayName: getDisplayName(path.basename(filePath), targetPath, '.lnk'),
    targetPath,
    arguments: parsed.Arguments?.trim() || '',
    workingDirectory: parsed.WorkingDirectory?.trim() || path.dirname(targetPath),
    iconLocation: parsed.IconLocation?.trim() || targetPath
  };
}

async function resolveDroppedInput(filePath: string): Promise<ResolvedDropInput | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return null;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.exe') {
    return {
      sourcePath: filePath,
      displayName: getDisplayName(path.basename(filePath), filePath, '.exe'),
      targetPath: filePath,
      arguments: '',
      workingDirectory: path.dirname(filePath),
      iconLocation: filePath
    };
  }

  if (extension === '.lnk') {
    return resolveShortcutFile(filePath);
  }

  return null;
}

function findExistingByTarget(items: InternalStartupItem[], targetPath: string): InternalStartupItem | undefined {
  const normalizedTarget = normalizeComparablePath(targetPath);
  return items.find((item) => normalizeComparablePath(item.targetPath) === normalizedTarget);
}

function makeDropResult(
  sourcePath: string,
  status: CreateStartupFromDropEntry['status'],
  displayName: string,
  message: string,
  itemId?: string
): CreateStartupFromDropEntry {
  return {
    sourcePath,
    status,
    displayName,
    message,
    itemId
  };
}

function nextAvailableShortcutPath(displayName: string): string {
  const baseName = sanitizeFileName(displayName) || 'Startup App';
  let candidate = path.join(USER_STARTUP_FOLDER, `${baseName}.lnk`);
  let index = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(USER_STARTUP_FOLDER, `${baseName} (${index}).lnk`);
    index += 1;
  }

  return candidate;
}

async function createStartupShortcut(input: ResolvedDropInput): Promise<string> {
  const shortcutPath = nextAvailableShortcutPath(input.displayName);
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('${escapePowerShellString(shortcutPath)}')
$shortcut.TargetPath = '${escapePowerShellString(input.targetPath)}'
$shortcut.Arguments = '${escapePowerShellString(input.arguments)}'
$shortcut.WorkingDirectory = '${escapePowerShellString(input.workingDirectory)}'
$shortcut.IconLocation = '${escapePowerShellString(input.iconLocation)}'
$shortcut.Save()
Write-Output '${escapePowerShellString(shortcutPath)}'
`;

  const outputPath = await runPowerShell(script);
  return outputPath || shortcutPath;
}

function getSelfAutostartShortcutPath(): string {
  return path.join(USER_STARTUP_FOLDER, SELF_AUTOSTART_SHORTCUT_NAME);
}

async function createSelfAutostartShortcut(): Promise<void> {
  const shortcutPath = getSelfAutostartShortcutPath();
  const targetPath = process.execPath;
  const workingDirectory = path.dirname(targetPath);
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('${escapePowerShellString(shortcutPath)}')
$shortcut.TargetPath = '${escapePowerShellString(targetPath)}'
$shortcut.Arguments = '--hidden'
$shortcut.WorkingDirectory = '${escapePowerShellString(workingDirectory)}'
  $shortcut.IconLocation = '${escapePowerShellString(targetPath)}'
  $shortcut.Save()
`;

  await runPowerShell(script);
}

function removeSelfAutostartShortcut(): void {
  const shortcutPath = getSelfAutostartShortcutPath();
  if (fs.existsSync(shortcutPath)) {
    fs.unlinkSync(shortcutPath);
  }
}

async function clearSelfAutostartApprovalEntry(): Promise<void> {
  const script = `
$approvalPath = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
try {
  Remove-ItemProperty -LiteralPath $approvalPath -Name '${escapePowerShellString(SELF_AUTOSTART_SHORTCUT_NAME)}' -ErrorAction SilentlyContinue
} catch {
}
`;

  await runPowerShell(script);
}

async function cleanupLegacySelfAutostartRegistry(): Promise<void> {
  const script = `
$runPath = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$names = @('com.zyz.startuptraymanager', 'Startup Tray Manager')
foreach ($name in $names) {
  try {
    Remove-ItemProperty -LiteralPath $runPath -Name $name -ErrorAction SilentlyContinue
  } catch {
  }
}
`;

  await runPowerShell(script);
}

function isStartupApprovedEnabled(bytes?: Buffer): boolean {
  if (!bytes || bytes.length === 0) {
    return true;
  }

  return bytes[0] === 0x02 || bytes[0] === 0x06;
}

function buildStartupApprovedBytes(enabled: boolean, existing?: Buffer): Buffer {
  const bytes = Buffer.alloc(12, 0);

  if (existing?.length) {
    existing.copy(bytes, 0, 0, Math.min(existing.length, 12));
  }

  if (enabled) {
    bytes[0] = 0x02;
    bytes.fill(0, 4);
    return bytes;
  }

  bytes[0] = 0x03;
  const fileTime = BigInt(Date.now()) * 10000n + 116444736000000000n;
  bytes.writeBigUInt64LE(fileTime, 4);
  return bytes;
}

function sortStartupItems<T extends StartupItem>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const byName = SORTER.compare(left.name, right.name);
    if (byName !== 0) {
      return byName;
    }

    const byScope = SORTER.compare(left.scope, right.scope);
    if (byScope !== 0) {
      return byScope;
    }

    const byType = SORTER.compare(left.sourceType, right.sourceType);
    if (byType !== 0) {
      return byType;
    }

    return SORTER.compare(left.id, right.id);
  });
}

function toItemId(parts: string[]): string {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

function toPublicItem(item: InternalStartupItem): StartupItem {
  return {
    id: item.id,
    name: item.name,
    command: item.command,
    targetPath: item.targetPath,
    sourceType: item.sourceType,
    scope: item.scope,
    enabled: item.enabled,
    requiresAdmin: item.requiresAdmin,
    sourceLocation: item.sourceLocation,
    disableStrategy: item.disableStrategy
  };
}

async function listRegistryRunItems(
  scope: 'user' | 'machine',
  runPsPath: string,
  runRegPath: string,
  approvedPsPath: string,
  approvedRegPath: string
): Promise<InternalStartupItem[]> {
  const [values, approvedMap] = await Promise.all([
    readRegistryValues(runPsPath),
    readApprovedValues(approvedPsPath)
  ]);

  return values.map((entry) => {
    const approvedBytes = approvedMap.get(entry.Name);
    const command = entry.Value || '';
    const targetPath = extractExecutablePath(command);

    return {
      id: toItemId([scope, 'registry-run', runRegPath, entry.Name]),
      name: getDisplayName(entry.Name, targetPath),
      command,
      targetPath,
      sourceType: 'registry-run',
      scope,
      enabled: isStartupApprovedEnabled(approvedBytes),
      requiresAdmin: scope === 'machine',
      sourceLocation: runRegPath,
      disableStrategy: 'startup-approved-run',
      approvedRegistryPath: approvedRegPath,
      approvedValueName: entry.Name,
      approvedBytes,
      launchFilePath: targetPath || undefined
    };
  });
}

function buildRegistryRunItems(
  scope: 'user' | 'machine',
  runRegPath: string,
  approvedRegPath: string,
  values: RegistryValueRecord[],
  approvedMap: Map<string, Buffer>
): InternalStartupItem[] {
  return values
    .filter(
      (entry): entry is RegistryValueRecord =>
        Boolean(entry && typeof entry.Name === 'string' && typeof entry.Value === 'string')
    )
    .map((entry) => {
    const approvedBytes = approvedMap.get(entry.Name);
    const command = entry.Value || '';
    const targetPath = extractExecutablePath(command);

    return {
      id: toItemId([scope, 'registry-run', runRegPath, entry.Name]),
      name: getDisplayName(entry.Name, targetPath),
      command,
      targetPath,
      sourceType: 'registry-run',
      scope,
      enabled: isStartupApprovedEnabled(approvedBytes),
      requiresAdmin: scope === 'machine',
      sourceLocation: runRegPath,
      disableStrategy: 'startup-approved-run',
      approvedRegistryPath: approvedRegPath,
      approvedValueName: entry.Name,
      approvedBytes,
      launchFilePath: targetPath || undefined
    };
    });
}

async function listStartupFolderItems(
  scope: 'user' | 'machine',
  folderPath: string,
  approvedPsPath: string,
  approvedRegPath: string
): Promise<InternalStartupItem[]> {
  const [entries, approvedMap] = await Promise.all([
    readStartupFolderEntries(folderPath),
    readApprovedValues(approvedPsPath)
  ]);

  return entries.map((entry) => {
    const approvedBytes = approvedMap.get(entry.Name);
    const targetPath = resolveEnvSegments(entry.TargetPath || '');

    return {
      id: toItemId([scope, 'startup-folder', folderPath, entry.FullName]),
      name: getDisplayName(entry.Name, targetPath, entry.Extension),
      command: entry.Command || entry.FullName,
      targetPath,
      sourceType: 'startup-folder',
      scope,
      enabled: isStartupApprovedEnabled(approvedBytes),
      requiresAdmin: scope === 'machine',
      sourceLocation: folderPath,
      disableStrategy: 'startup-approved-startup-folder',
      approvedRegistryPath: approvedRegPath,
      approvedValueName: entry.Name,
      approvedBytes,
      launchFilePath: entry.FullName
    };
  });
}

function buildStartupFolderItems(
  scope: 'user' | 'machine',
  folderPath: string,
  approvedRegPath: string,
  entries: StartupFolderRecord[],
  approvedMap: Map<string, Buffer>
): InternalStartupItem[] {
  return entries
    .filter(
      (entry): entry is StartupFolderRecord =>
        Boolean(
          entry &&
            typeof entry.Name === 'string' &&
            typeof entry.FullName === 'string' &&
            typeof entry.Extension === 'string'
        )
    )
    .map((entry) => {
    const approvedBytes = approvedMap.get(entry.Name);
    const targetPath = resolveEnvSegments(entry.TargetPath || '');

    return {
      id: toItemId([scope, 'startup-folder', folderPath, entry.FullName]),
      name: getDisplayName(entry.Name, targetPath, entry.Extension),
      command: entry.Command || entry.FullName,
      targetPath,
      sourceType: 'startup-folder',
      scope,
      enabled: isStartupApprovedEnabled(approvedBytes),
      requiresAdmin: scope === 'machine',
      sourceLocation: folderPath,
      disableStrategy: 'startup-approved-startup-folder',
      approvedRegistryPath: approvedRegPath,
      approvedValueName: entry.Name,
      approvedBytes,
      launchFilePath: entry.FullName
    };
    });
}

async function listInternalStartupItems(forceRefresh = false): Promise<InternalStartupItem[]> {
  if (!forceRefresh && startupItemsCache) {
    return startupItemsCache;
  }

  const snapshot = await readStartupSnapshot();

  const userRun = buildRegistryRunItems(
    'user',
    USER_RUN_REG_PATH,
    USER_APPROVED_RUN_REG_PATH,
    ensureArray(snapshot.userRun),
    toApprovedMap(snapshot.userApprovedRun)
  );
  const machineRun = buildRegistryRunItems(
    'machine',
    MACHINE_RUN_REG_PATH,
    MACHINE_APPROVED_RUN_REG_PATH,
    ensureArray(snapshot.machineRun),
    toApprovedMap(snapshot.machineApprovedRun)
  );
  const userFolder = buildStartupFolderItems(
    'user',
    USER_STARTUP_FOLDER,
    USER_APPROVED_STARTUP_REG_PATH,
    ensureArray(snapshot.userStartupFolder),
    toApprovedMap(snapshot.userApprovedStartupFolder)
  );
  const machineFolder = buildStartupFolderItems(
    'machine',
    COMMON_STARTUP_FOLDER,
    MACHINE_APPROVED_STARTUP_REG_PATH,
    ensureArray(snapshot.machineStartupFolder),
    toApprovedMap(snapshot.machineApprovedStartupFolder)
  );

  startupItemsCache = sortStartupItems([
    ...userRun,
    ...machineRun,
    ...userFolder,
    ...machineFolder
  ]);

  return startupItemsCache;
}

async function writeApprovedState(
  approvedRegistryPath: string,
  approvedValueName: string,
  targetEnabled: boolean,
  currentBytes?: Buffer
): Promise<void> {
  const nextBytes = buildStartupApprovedBytes(targetEnabled, currentBytes);
  await execFileAsync(
    'reg.exe',
    [
      'add',
      approvedRegistryPath,
      '/v',
      approvedValueName,
      '/t',
      'REG_BINARY',
      '/d',
      nextBytes.toString('hex'),
      '/f'
    ],
    {
      windowsHide: true
    }
  );
}

function getAppLaunchCommand(actionArg: string): { filePath: string; args: string[] } {
  if (app.isPackaged) {
    return {
      filePath: process.execPath,
      args: [actionArg]
    };
  }

  return {
    filePath: process.execPath,
    args: process.defaultApp ? [app.getAppPath(), actionArg] : [actionArg]
  };
}

async function launchElevatedToggle(item: InternalStartupItem, targetEnabled: boolean): Promise<void> {
  const action: ElevatedToggleAction = {
    approvedRegistryPath: item.approvedRegistryPath,
    approvedValueName: item.approvedValueName,
    targetEnabled,
    currentApprovedBase64: item.approvedBytes?.toString('base64')
  };

  const actionArg = `--startup-manager-elevated=${Buffer.from(
    JSON.stringify(action),
    'utf8'
  ).toString('base64url')}`;

  const { filePath, args } = getAppLaunchCommand(actionArg);
  const script = `
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath '${escapePowerShellString(filePath)}' -ArgumentList @(${args
    .map((value) => `'${escapePowerShellString(value)}'`)
    .join(', ')}) -Verb RunAs -Wait -PassThru
exit $process.ExitCode
`;

  await runPowerShell(script);
}

function accessDenied(error: unknown): boolean {
  return String(error).toLowerCase().includes('access is denied');
}

export function parseElevatedToggleAction(argv: string[]): ElevatedToggleAction | null {
  const rawArg = argv.find((arg) => arg.startsWith('--startup-manager-elevated='));
  if (!rawArg) {
    return null;
  }

  const payload = rawArg.split('=', 2)[1];
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ElevatedToggleAction;
  } catch {
    return null;
  }
}

export async function performElevatedToggleAction(action: ElevatedToggleAction): Promise<void> {
  const currentBytes = action.currentApprovedBase64
    ? Buffer.from(action.currentApprovedBase64, 'base64')
    : undefined;

  await writeApprovedState(
    action.approvedRegistryPath,
    action.approvedValueName,
    action.targetEnabled,
    currentBytes
  );
}

export async function listStartupItems(): Promise<StartupItem[]> {
  const items = await listInternalStartupItems();
  return items.map(toPublicItem);
}

export async function refreshStartupItems(): Promise<StartupItem[]> {
  const items = await listInternalStartupItems(true);
  return items.map(toPublicItem);
}

export async function toggleStartupItem(
  id: string,
  targetEnabled: boolean
): Promise<ToggleStartupResult> {
  const items = await listInternalStartupItems();
  const item = items.find((candidate) => candidate.id === id);

  if (!item) {
    return {
      success: false,
      errorMessage: 'Startup item was not found.'
    };
  }

  try {
    await writeApprovedState(
      item.approvedRegistryPath,
      item.approvedValueName,
      targetEnabled,
      item.approvedBytes
    );
  } catch (error) {
    if (!item.requiresAdmin || !accessDenied(error)) {
      return {
        success: false,
        errorMessage: 'Failed to update the startup item.'
      };
    }

    try {
      await launchElevatedToggle(item, targetEnabled);
    } catch {
      return {
        success: false,
        errorMessage: 'Elevation was canceled or failed.'
      };
    }
  }

  const refreshedItem = (await listInternalStartupItems()).find((candidate) => candidate.id === id);
  startupItemsCache = await listInternalStartupItems(true);
  const latestItem = startupItemsCache.find((candidate) => candidate.id === id);

  return {
    success: true,
    item: latestItem ? toPublicItem(latestItem) : refreshedItem ? toPublicItem(refreshedItem) : undefined,
    elevated: item.requiresAdmin
  };
}

export async function openStartupItemLocation(id: string): Promise<boolean> {
  const items = await listInternalStartupItems();
  const item = items.find((candidate) => candidate.id === id);

  if (!item) {
    return false;
  }

  const candidates = [item.launchFilePath, item.targetPath].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      shell.showItemInFolder(candidate);
      return true;
    }
  }

  if (item.sourceType === 'startup-folder' && fs.existsSync(item.sourceLocation)) {
    await shell.openPath(item.sourceLocation);
    return true;
  }

  const targetDirectory = item.targetPath ? path.dirname(item.targetPath) : '';
  if (targetDirectory && fs.existsSync(targetDirectory)) {
    await shell.openPath(targetDirectory);
    return true;
  }

  return false;
}

export async function getStartupItemIcon(id: string): Promise<string | null> {
  const items = await listInternalStartupItems();
  const item = items.find((candidate) => candidate.id === id);

  if (!item) {
    return null;
  }

  const candidates = [item.targetPath, item.launchFilePath].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    if (startupItemIconCache.has(candidate)) {
      return startupItemIconCache.get(candidate) ?? null;
    }

    try {
      const icon = await app.getFileIcon(candidate, { size: 'small' });
      const iconDataUrl = icon.isEmpty() ? null : icon.toDataURL();
      startupItemIconCache.set(candidate, iconDataUrl);
      return iconDataUrl;
    } catch {
      startupItemIconCache.set(candidate, null);
    }
  }

  return null;
}

export async function createStartupItemsFromDrop(paths: string[]): Promise<CreateStartupFromDropResult> {
  const currentItems = await listInternalStartupItems(true);
  const results: CreateStartupFromDropEntry[] = [];

  for (const originalPath of paths) {
    try {
      const resolvedInput = await resolveDroppedInput(originalPath);
      if (!resolvedInput) {
        results.push(
          makeDropResult(originalPath, 'unsupported', path.basename(originalPath), '仅支持拖入 .exe 或 .lnk 应用文件。')
        );
        continue;
      }

      const existingItem = findExistingByTarget(currentItems, resolvedInput.targetPath);
      if (existingItem?.requiresAdmin) {
        results.push(
          makeDropResult(
            originalPath,
            'blocked_system_level',
            resolvedInput.displayName,
            '该应用已存在系统级启动项，请在高级项中管理。',
            existingItem.id
          )
        );
        continue;
      }

      if (existingItem) {
        if (existingItem.enabled) {
          results.push(
            makeDropResult(
              originalPath,
              'already_enabled',
              existingItem.name,
              '该应用已在管理中。',
              existingItem.id
            )
          );
          continue;
        }

        const toggled = await toggleStartupItem(existingItem.id, true);
        if (toggled.success) {
          results.push(
            makeDropResult(
              originalPath,
              'enabled_existing',
              toggled.item?.name || existingItem.name,
              '已启用已有启动项。',
              toggled.item?.id || existingItem.id
            )
          );
        } else {
          results.push(
            makeDropResult(
              originalPath,
              'error',
              existingItem.name,
              toggled.errorMessage || '启用已有启动项失败。',
              existingItem.id
            )
          );
        }
        continue;
      }

      const shortcutPath = await createStartupShortcut(resolvedInput);
      const shortcutName = path.basename(shortcutPath);
      await writeApprovedState(USER_APPROVED_STARTUP_REG_PATH, shortcutName, true);

      const refreshedItems = await listInternalStartupItems(true);
      const createdItem = findExistingByTarget(refreshedItems, resolvedInput.targetPath);

      results.push(
        makeDropResult(
          originalPath,
          'created',
          createdItem?.name || resolvedInput.displayName,
          '已创建并启用新的开机启动项。',
          createdItem?.id
        )
      );
    } catch {
      results.push(
        makeDropResult(originalPath, 'error', path.basename(originalPath), '创建开机自启动项失败。')
      );
    }
  }

  await listInternalStartupItems(true);
  return {
    entries: results
  };
}

export function isHiddenLaunch(argv: string[]): boolean {
  return argv.includes('--hidden');
}

export function selfAutostartSupported(): boolean {
  return process.platform === 'win32' && app.isPackaged;
}

export function isSelfAutostartEnabled(): boolean {
  if (!selfAutostartSupported()) {
    return false;
  }

  return fs.existsSync(getSelfAutostartShortcutPath());
}

export async function applySelfAutostartSetting(enabled: boolean): Promise<void> {
  if (!selfAutostartSupported()) {
    return;
  }

  if (enabled) {
    await createSelfAutostartShortcut();
    await clearSelfAutostartApprovalEntry();
  } else {
    removeSelfAutostartShortcut();
    await clearSelfAutostartApprovalEntry();
  }

  // Clean up any legacy Electron login-item entry if it exists.
  app.setLoginItemSettings({
    openAtLogin: false,
    path: process.execPath,
    args: ['--hidden']
  });

  await cleanupLegacySelfAutostartRegistry();
}

export function readCurrentDisableStrategy(sourceType: StartupItem['sourceType']): StartupDisableStrategy {
  return sourceType === 'registry-run'
    ? 'startup-approved-run'
    : 'startup-approved-startup-folder';
}
