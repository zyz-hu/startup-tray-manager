import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const binDir = path.join(projectRoot, 'node_modules', '.bin');
const tempDir =
  process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'Temp')
    : os.tmpdir();

const env = {
  ...process.env,
  TEMP: tempDir,
  TMP: tempDir,
  ELECTRON_MIRROR:
    process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/'
};

function resolveBin(name) {
  if (process.platform === 'win32') {
    return path.join(binDir, `${name}.cmd`);
  }

  return path.join(binDir, name);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32'
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

await run(resolveBin('electron-vite'), ['build']);
await run(resolveBin('electron-builder'), ['--win', 'nsis', '--x64']);
