/// <reference types="vite/client" />
import type { SollineApi } from '@solline/protocol/bridge';

declare global {
  interface Window {
    solline: SollineApi;
  }
}
