import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, type RecoveryNotice, type Theme } from '@solline/protocol/bridge';
import type { EngineHost } from './engine-host.ts';
import type { UiRecoveryStore } from './ui-recovery.ts';
import { RendererHealth } from './renderer-health.ts';

/** Recovery has its own renderer, partition and least-privilege preload. */
export class WindowRecovery {
  #dialog: BrowserWindow | undefined;
  #notice: RecoveryNotice = {
    reason: 'crashed',
    message: '',
    canWait: false,
    busy: false,
    theme: 'light',
  };
  #allowedClose = false;
  #closing: Promise<void> | undefined;
  #prepared: { token: string; finish: (ok: boolean) => void } | undefined;
  #main: BrowserWindow | undefined;
  #theme: Theme = 'light';
  #unresponsive = false;
  #restoring = false;
  #health: RendererHealth | undefined;
  constructor(
    readonly engine: EngineHost,
    readonly drafts: UiRecoveryStore,
    readonly preload: string,
    readonly renderer: string,
    readonly devUrl?: string,
    readonly retryStartup?: () => Promise<void>,
    readonly onUnresponsive?: () => void,
  ) {
    ipcMain.handle(IPC.recoveryNotice, (event) => {
      this.#authorize(event);
      return this.#notice;
    });
    ipcMain.handle(IPC.recoveryAction, async (event, action: unknown) => {
      this.#authorize(event);
      if (typeof action !== 'string' || !['wait', 'restore', 'close'].includes(action))
        throw new Error('Ação inválida');
      if (this.#notice.busy) return;
      if (action === 'wait') {
        if (!this.#notice.canWait) throw new Error('A interface já terminou');
        this.#dialog?.hide();
        this.#thawRenderer();
        return;
      }
      this.#setBusy(true);
      try {
        if (action === 'close') await this.close(true);
        else await this.restore();
      } catch (error) {
        this.#thawRenderer();
        this.show(
          'save-failed',
          `Não foi possível concluir em segurança. ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.#setBusy(false);
      }
    });
  }

  get mayQuit(): boolean {
    return this.#allowedClose;
  }

  /** Called only by the authorized independent recovery action. Never reload before the barrier. */
  async restore(): Promise<void> {
    const win = this.#main;
    if (!win || win.isDestroyed()) throw new Error('A janela já terminou');
    // Repair readiness first: saveDraft itself awaits it. Renderer edits stay in memory
    // throughout this retry, then must be acknowledged before any reload/crash below.
    if (this.retryStartup) await this.retryStartup();
    else {
      await this.drafts.retry();
      if (this.engine.failedToStart) await this.engine.restartFailed();
      if (!this.engine.running) this.engine.start();
    }
    if (!win.webContents.isCrashed() && !this.#unresponsive) await this.#flushRenderer(win);
    await this.drafts.flush();
    await this.engine.request('engine.flush');
    await this.engine.request('engine.snapshot');
    if (this.#unresponsive && !win.webContents.isCrashed()) {
      this.#restoring = true;
      try {
        const contents = win.webContents;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            contents.removeListener('render-process-gone', gone);
            reject(new Error('A interface bloqueada não terminou.'));
          }, 5000);
          const gone = () => {
            clearTimeout(timeout);
            resolve();
          };
          contents.once('render-process-gone', gone);
          contents.forcefullyCrashRenderer();
        });
      } finally {
        this.#restoring = false;
      }
    }
    win.webContents.reload();
    this.#dialog?.hide();
  }

  attach(win: BrowserWindow): void {
    this.#main = win;
    this.#health?.stop();
    const health = new RendererHealth(
      (token) => win.webContents.send(IPC.healthProbe, token),
      () => this.#markUnresponsive(),
      () => {
        this.#unresponsive = false;
      },
    );
    this.#health = health;
    let loaded = false;
    const resume = () => {
      if (loaded && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) health.start();
    };
    win.on('show', resume);
    win.on('restore', resume);
    win.on('hide', () => health.stop());
    win.on('minimize', () => health.stop());
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        loaded = false;
        health.stop();
      }
    });
    win.on('close', (event) => {
      if (this.#allowedClose) return;
      event.preventDefault();
      void this.close().catch((error) => this.show('save-failed', String(error)));
    });
    win.webContents.on('unresponsive', () => this.#markUnresponsive());
    win.webContents.on('responsive', () => {
      this.#unresponsive = false;
    });
    win.webContents.on('did-finish-load', () => {
      this.#unresponsive = false;
      loaded = true;
      resume();
    });
    win.webContents.on('render-process-gone', () => {
      loaded = false;
      health.stop();
      if (!this.#restoring)
        this.show(
          'crashed',
          'A interface parou. O trabalho confirmado como guardado pode ser restaurado sem reenviar ações.',
        );
    });
    win.on('closed', () => {
      health.stop();
      this.#prepared?.finish(false);
      this.#dialog?.destroy();
      this.#dialog = undefined;
    });
  }

  healthy(token: unknown): void {
    this.#health?.acknowledge(token);
  }

  #markUnresponsive(): void {
    if (this.#unresponsive || this.#allowedClose || this.#restoring) return;
    this.#unresponsive = true;
    this.onUnresponsive?.();
    this.show(
      'unresponsive',
      'A interface deixou de responder. Podes esperar, restaurar ou fechar com o último estado confirmado como guardado. Texto ainda em trânsito pode não ser recuperável.',
    );
  }

  theme(theme: Theme): void {
    this.#theme = theme;
    this.#notice.theme = theme;
    this.#dialog?.webContents.send(IPC.recoveryNotice, this.#notice);
  }

  prepared(token: string, ok: boolean): void {
    if (this.#prepared?.token === token) this.#prepared.finish(ok);
  }

  async close(confirmed = false): Promise<void> {
    if (this.#allowedClose || this.#closing) return this.#closing;
    const win = this.#main;
    if (!win || win.isDestroyed()) return;
    // Both idle and active windows require the same deliberate, custom warning.
    // Do not freeze or flush the renderer until the user confirms this action.
    if (!confirmed) {
      if (this.#notice.busy) return;
      this.show(
        'close',
        'Fechar guarda o estado recuperável e interrompe os agentes. Nada será retomado ou reenviado automaticamente. Queres fechar a Solline?',
      );
      return;
    }
    this.#closing = (async () => {
      // A crashed renderer cannot flush edits still in flight. Do not imply those were saved.
      if (!win.webContents.isCrashed() && !(confirmed && this.#unresponsive))
        await this.#flushRenderer(win);
      await this.drafts.flush();
      if (win.isDestroyed()) throw new Error('A janela terminou antes de confirmar o fecho.');
      if (!this.engine.running) throw new Error('Restaura o motor antes de fechar com segurança.');
      await this.engine.request('engine.snapshot');
      await this.engine.request('engine.flush');
      await this.engine.request('engine.shutdown');
      this.#allowedClose = true;
      win.close();
    })()
      .catch((error) => {
        this.#thawRenderer();
        throw error;
      })
      .finally(() => {
        this.#closing = undefined;
      });
    return this.#closing;
  }

  show(reason: RecoveryNotice['reason'], message: string): void {
    if (this.#allowedClose || this.#main?.isDestroyed()) return;
    this.#notice = {
      reason,
      message,
      canWait: reason === 'unresponsive' || reason === 'close' || reason === 'save-failed',
      busy: reason === 'save-failed' ? false : this.#notice.busy || Boolean(this.#closing),
      theme: this.#theme,
    };
    if (this.#dialog && !this.#dialog.isDestroyed()) {
      this.#dialog.webContents.send(IPC.recoveryNotice, this.#notice);
      this.#dialog.show();
      return;
    }
    const win = new BrowserWindow({
      title: 'Recuperar Solline',
      width: 480,
      height: 340,
      minWidth: 400,
      minHeight: 300,
      show: false,
      frame: false,
      resizable: false,
      autoHideMenuBar: true,
      backgroundColor: this.#theme === 'dark' ? '#19191b' : '#f4f3f0',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: 'solline-recovery-isolated',
      },
    });
    this.#dialog = win;
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('close', (e) => {
      if (!this.#allowedClose) {
        e.preventDefault();
        if (this.#notice.canWait && !this.#notice.busy) {
          win.hide();
          this.#thawRenderer();
        }
      }
    });
    win.once('ready-to-show', () => win.show());
    if (this.devUrl) void win.loadURL(new URL('recovery.html', this.devUrl).href);
    else void win.loadFile(join(this.renderer, 'recovery.html'));
  }

  #setBusy(busy: boolean): void {
    this.#notice.busy = busy;
    this.#dialog?.webContents.send(IPC.recoveryNotice, this.#notice);
  }

  #authorize(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    const expected = this.devUrl
      ? new URL('recovery.html', this.devUrl).href
      : pathToFileURL(join(this.renderer, 'recovery.html')).href;
    if (
      !this.#dialog ||
      event.sender !== this.#dialog.webContents ||
      !frame ||
      frame.parent ||
      frame.url !== expected
    )
      throw new Error('Origem não autorizada');
  }

  #flushRenderer(win: BrowserWindow): Promise<void> {
    return new Promise((resolve, reject) => {
      const token = randomUUID();
      const timeout = setTimeout(() => finish(false), 5000);
      const finish = (ok: boolean) => {
        if (this.#prepared?.token !== token) return;
        clearTimeout(timeout);
        this.#prepared = undefined;
        if (ok) resolve();
        else
          reject(
            new Error(
              'Não foi possível confirmar a gravação dos rascunhos. Mantém a janela aberta e tenta novamente.',
            ),
          );
      };
      this.#prepared = { token, finish };
      try {
        win.webContents.send(IPC.prepareClose, token);
      } catch {
        finish(false);
      }
    });
  }

  #thawRenderer(): void {
    if (this.#main && !this.#main.isDestroyed() && !this.#main.webContents.isDestroyed())
      this.#main.webContents.send(IPC.closeCancelled);
  }
}
