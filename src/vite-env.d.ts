/// <reference types="vite/client" />

import type { TinyHermesBridge } from './types';

declare global {
  interface Window {
    tinyHermes?: TinyHermesBridge;
  }
}

export {};
