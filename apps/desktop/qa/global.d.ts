import type { installBridge } from './bridge';
declare global {
  interface Window {
    qa: ReturnType<typeof installBridge>;
  }
}
