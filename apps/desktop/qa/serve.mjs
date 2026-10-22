import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const vite = resolve('../../node_modules/vite/bin/vite.js');
const build = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.qa.config.ts'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);
const server = spawn(
  process.execPath,
  [
    vite,
    'preview',
    '--config',
    'vite.qa.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    process.env.SOLLINE_QA_PORT ?? '5178',
    '--strictPort',
  ],
  { stdio: 'inherit', windowsHide: true },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.kill();
  });
server.on('exit', (code) => process.exit(code ?? 0));
