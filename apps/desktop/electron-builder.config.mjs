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
  // Fecha as portas para correr código dentro do executável da app. O motor é um
  // utilityProcess e os agentes são executáveis à parte, por isso nada precisa do runAsNode.
  // O grantFileProtocolExtraPrivileges fica: a interface carrega módulos de file://.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: true,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: '${productName}-Setup-${version}.${ext}',
  },
  // Sem auto-update enquanto é pessoal.
  publish: null,
};
