import type { StartupManagerApi } from '../../shared/types';

declare global {
  interface Window {
    startupManager: StartupManagerApi;
  }
}

export {};
