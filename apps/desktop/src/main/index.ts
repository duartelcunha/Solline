import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { APP_NAME } from '@solline/protocol/app';
import { IPC, type Theme } from '@solline/protocol/bridge';
import {
  CommandNameSchema,
  SessionCreatePayload,
  commandSchemas,
  isMainCommand,
  type CommandName,
  type CommandPayload,
  type MainCommandName,
} from '@solline/protocol';
import { EngineHost } from './engine-host.ts';
import { ProjectStore } from './projects.ts';
import { resolveSessionStart } from './session-policy.ts';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(`app.${APP_NAME.toLowerCase()}`);
// Testes e smoke usam uma pasta de dados própria para não tocar na do dia a dia.
if (process.env.SOLLINE_USER_DATA) app.setPath('userData', process.env.SOLLINE_USER_DATA);

let mainWindow: BrowserWindow | undefined;
const engine = new EngineHost((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.event, event);
});
const projects = new ProjectStore(join(app.getPath('userData'), 'projects.json'));

const TRUST_DETAIL =
  'Num projeto de confiança, os agentes leem as definições, hooks, servidores MCP e instruções ' +
  'da pasta (no Claude, o .claude/ e o CLAUDE.md). Sem confiança, só as tuas definições de ' +
  'utilizador, e "Permitir sempre" vale só na sessão. Vale para as sessões novas.';

/** Diálogo nativo: a confiança nunca se liga sem um clique teu fora da interface. */
async function confirmTrust(name: string): Promise<boolean> {
  const options = {
    type: 'question' as const,
    title: 'Confiança no projeto',
    message: `Confias no projeto ${name}?`,
    detail: TRUST_DETAIL,
    buttons: ['Confiar', 'Não confiar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

async function handleMain(command: MainCommandName, payload: unknown): Promise<unknown> {
  switch (command) {
    case 'projects.list':
      return { projects: await projects.list() };
    case 'projects.add': {
      const options = { title: 'Adicionar projeto', properties: ['openDirectory' as const] };
      const picked = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      const folder = picked.canceled ? undefined : picked.filePaths[0];
      if (!folder) return { project: null };
      const existing = await projects.find(folder);
      if (existing) return { project: existing };
      const trusted = await confirmTrust(basename(folder) || folder);
      return { project: await projects.add(folder, trusted) };
    }
    case 'projects.setTrusted': {
      const { projectId, trusted } = payload as CommandPayload<'projects.setTrusted'>;
      const project = await projects.get(projectId);
      if (!project) throw new Error('Projeto desconhecido');
      if (trusted && !project.trusted && !(await confirmTrust(project.name))) return { project };
      const updated = await projects.setTrusted(projectId, trusted);
      // As sessões abertas guardam a confiança com que arrancaram; a retoma passa a usar esta.
      await engine.request('projects.trustChanged', { projectId, trusted });
      return { project: updated };
    }
    case 'session.create': {
      // A interface pede pelo projeto; a pasta vem sempre do que está guardado aqui.
      const start = await resolveSessionStart(projects, SessionCreatePayload.parse(payload));
      return engine.request('session.start', start);
    }
  }
}

const TITLE_BAR_HEIGHT = 44;
const titleBarColors: Record<Theme, { color: string; symbolColor: string }> = {
  light: { color: '#00000000', symbolColor: '#3b3833' },
  dark: { color: '#00000000', symbolColor: '#e8e5e0' },
};

const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = join(__dirname, '../renderer/index.html');

/** Sem hash nem query; no Windows o disco e as pastas não distinguem maiúsculas. */
function samePage(a: string, b: string): boolean {
  const clean = (value: string) => {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return process.platform === 'win32' ? url.href.toLowerCase() : url.href;
  };
  return clean(a) === clean(b);
}

/**
 * Só a janela principal, no frame de topo e na página que a app carregou, fala com o main.
 * A condição é a mesma do loadURL/loadFile em createWindow.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!mainWindow || event.sender !== mainWindow.webContents || !frame || frame.parent) {
    return false;
  }
  try {
    if (devUrl) return new URL(frame.url).origin === new URL(devUrl).origin;
    return samePage(frame.url, pathToFileURL(rendererFile).href);
  } catch {
    return false;
  }
}

/** Links externos: só https, sem utilizador nem password no URL. */
function openExternalSafely(raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      void shell.openExternal(url.href);
    }
  } catch {
    // URL inválido: não abre nada.
  }
}

function createWindow(): void {
  const theme: Theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: theme === 'dark' ? '#1c1a18' : '#fbfaf8',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors[theme], height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  // Nada de navegar para fora nem abrir janelas: links externos vão para o browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow = win;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererFile);
}

ipcMain.handle(IPC.request, async (event, raw: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  const parsed = CommandNameSchema.safeParse((raw as { command?: unknown } | null)?.command);
  if (!parsed.success) return { ok: false, error: { message: 'Comando desconhecido' } };
  const command: CommandName = parsed.data;
  const payload = (raw as { payload?: unknown }).payload ?? {};
  try {
    if (isMainCommand(command)) {
      const input = commandSchemas[command].payload.parse(payload);
      const result = commandSchemas[command].result.parse(await handleMain(command, input));
      return { ok: true, result };
    }
    return { ok: true, result: await engine.request(command, payload) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
});

ipcMain.handle(IPC.setTheme, (event, theme: unknown) => {
  if (!isTrustedSender(event) || (theme !== 'light' && theme !== 'dark')) return;
  nativeTheme.themeSource = theme;
  mainWindow?.setTitleBarOverlay({ ...titleBarColors[theme], height: TITLE_BAR_HEIGHT });
});

// Qualquer webContents novo nasce sem webviews, sem janelas e sem navegar.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

void app.whenReady().then(() => {
  // A interface não usa câmara, microfone, notificações nem nada do género: tudo negado.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  engine.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => engine.stop());
