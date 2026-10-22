import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import type { Theme } from '@solline/protocol/bridge';
import type { Attention } from './attention.ts';

/** A Solline surface, shown without taking focus. No native notification chrome. */
export class AttentionWindow {
  #window: BrowserWindow | undefined;
  #notice: Attention | undefined;
  #theme: Theme = 'light';
  #timer: ReturnType<typeof setTimeout> | undefined;
  #visible = false;
  #ready = false;
  constructor(
    readonly main: () => BrowserWindow | undefined,
    readonly preload: string,
    readonly renderer: string,
    readonly open: (sessionId: string) => void,
    readonly devUrl?: string,
  ) {
    ipcMain.handle('solline:attention-notice', (event) => {
      this.#authorize(event);
      return { ...this.#notice, theme: this.#theme };
    });
    ipcMain.handle('solline:attention-action', (event, action: unknown) => {
      this.#authorize(event);
      if (action !== 'open' && action !== 'dismiss') throw new Error('Ação inválida');
      if (action === 'open' && this.#notice) this.open(this.#notice.sessionId);
      this.hide();
    });
  }
  theme(theme: Theme): void {
    this.#theme = theme;
    this.#window?.webContents.send('solline:attention-notice', { ...this.#notice, theme });
  }
  show(notice: Attention): void {
    this.#visible = true;
    this.#notice = notice;
    clearTimeout(this.#timer);
    if (!this.#window || this.#window.isDestroyed()) {
      this.#ready = false;
      const main = this.main();
      const area = (main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay())
        .workArea;
      const win = new BrowserWindow({
        width: 340,
        height: 144,
        x: area.x + area.width - 356,
        y: area.y + area.height - 160,
        frame: false,
        show: false,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: this.#theme === 'dark' ? '#19191b' : '#f4f3f0',
        webPreferences: {
          preload: this.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: 'solline-attention-isolated',
        },
      });
      this.#window = win;
      win.webContents.session.setPermissionRequestHandler((_c, _p, callback) => callback(false));
      win.webContents.session.setPermissionCheckHandler(() => false);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      win.once('ready-to-show', () => {
        if (this.#window === win) this.#ready = true;
        if (this.#window === win && this.#visible && !win.isDestroyed()) win.showInactive();
      });
      win.on('closed', () => {
        clearTimeout(this.#timer);
        this.#window = undefined;
      });
      if (this.devUrl) void win.loadURL(new URL('attention.html', this.devUrl).href);
      else void win.loadFile(join(this.renderer, 'attention.html'));
    } else {
      this.#window.webContents.send('solline:attention-notice', { ...notice, theme: this.#theme });
      if (this.#ready) this.#window.showInactive();
    }
    this.#timer = setTimeout(() => this.hide(), 10000);
  }
  hide(): void {
    this.#visible = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#window?.hide();
  }
  dispose(): void {
    this.hide();
    this.#window?.destroy();
    this.#window = undefined;
  }
  #authorize(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    const expected = this.devUrl
      ? new URL('attention.html', this.devUrl).href
      : pathToFileURL(join(this.renderer, 'attention.html')).href;
    if (
      !this.#window ||
      event.sender !== this.#window.webContents ||
      !frame ||
      frame.parent ||
      frame.url !== expected
    )
      throw new Error('Origem não autorizada');
  }
}
