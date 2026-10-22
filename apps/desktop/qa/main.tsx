import { installBridge } from './bridge';
import { scenes } from './fixtures';

const params = new URLSearchParams(location.search);
const scene = scenes.find((s) => s === params.get('scene')) ?? 'conversation';
if (params.get('scene') === 'figures') await import('./gallery');
else {
  installBridge(scene);
  await import('../src/renderer/src/main');
}
