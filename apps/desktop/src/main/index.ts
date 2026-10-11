import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron';
import { APP_NAME } from '@solline/protocol/app';
import { IPC, type Theme } from '@solline/protocol/bridge';
import { CommandNameSchema } from '@solline/protocol';
import { EngineHost } from './engine-host.ts';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(`app.${APP_NAME.toLowerCase()}`);

const engine = new EngineHost();
let mainWindow: BrowserWindow | undefined;

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

ipcMain.handle(IPC.engineRequest, async (event, raw: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  const parsed = CommandNameSchema.safeParse((raw as { command?: unknown } | null)?.command);
  if (!parsed.success) return { ok: false, error: { message: 'Comando desconhecido' } };
  try {
    const result = await engine.request(parsed.data, (raw as { payload?: unknown }).payload ?? {});
    return { ok: true, result };
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
