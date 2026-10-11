// O nome vem da mesma constante que a janela usa (Node 22+ lê o .ts diretamente).
import { APP_NAME } from '../../packages/protocol/src/app.ts';

/** @type {import('electron-builder').Configuration} */
export default {
  appId: `app.${APP_NAME.toLowerCase()}`,
  productName: APP_NAME,
  executableName: APP_NAME,
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: ['out/**', 'package.json'],
  // O claude.exe não corre de dentro do asar; fica ao lado, em app.asar.unpacked.
  asarUnpack: ['**/node_modules/@anthropic-ai/**'],
  extraMetadata: {
    name: APP_NAME.toLowerCase(),
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: '${productName}-Setup-${version}.${ext}',
  },
  // Sem auto-update enquanto é pessoal.
  publish: null,
};
