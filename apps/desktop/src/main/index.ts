import { join } from 'node:path';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { APP_NAME } from '@solline/protocol/app';
import { IPC, type Theme } from '@solline/protocol/bridge';
import {
  CommandNameSchema,
  commandSchemas,
  isMainCommand,
  type CommandName,
  type MainCommandName,
} from '@solline/protocol';
import { EngineHost } from './engine-host.ts';
import { ProjectStore } from './projects.ts';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(`app.${APP_NAME.toLowerCase()}`);
// Testes e smoke usam uma pasta de dados própria para não tocar na do dia a dia.
if (process.env.SOLLINE_USER_DATA) app.setPath('userData', process.env.SOLLINE_USER_DATA);

let mainWindow: BrowserWindow | undefined;
const engine = new EngineHost((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.event, event);
});
const projects = new ProjectStore(join(app.getPath('userData'), 'projects.json'));

async function handleMain(command: MainCommandName): Promise<unknown> {
  switch (command) {
    case 'projects.list':
      return { projects: await projects.list() };
    case 'projects.add': {
      const options = { title: 'Adicionar projeto', properties: ['openDirectory' as const] };
      const picked = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      const folder = picked.canceled ? undefined : picked.filePaths[0];
      return { project: folder ? await projects.add(folder) : null };
    }
  }
}

const TITLE_BAR_HEIGHT = 44;
const titleBarColors: Record<Theme, { color: string; symbolColor: string }> = {
  light: { color: '#00000000', symbolColor: '#3b3833' },
  dark: { color: '#00000000', symbolColor: '#e8e5e0' },
};

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return url.startsWith('file://') || (devUrl !== undefined && url.startsWith(devUrl));
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
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow = win;
}

ipcMain.handle(IPC.request, async (event, raw: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  const parsed = CommandNameSchema.safeParse((raw as { command?: unknown } | null)?.command);
  if (!parsed.success) return { ok: false, error: { message: 'Comando desconhecido' } };
  const command: CommandName = parsed.data;
  const payload = (raw as { payload?: unknown }).payload ?? {};
  try {
    if (isMainCommand(command)) {
      commandSchemas[command].payload.parse(payload);
      const result = commandSchemas[command].result.parse(await handleMain(command));
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

void app.whenReady().then(() => {
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
