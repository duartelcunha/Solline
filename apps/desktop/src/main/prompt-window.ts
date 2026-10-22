import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Theme } from '@solline/protocol/bridge';

const channels = {
  state: 'solline:prompt-state',
  list: 'solline:prompt-list',
  answer: 'solline:prompt-answer',
  theme: 'solline:prompt-theme',
};
const identity = z.object({ nonce: z.string().uuid() }).strict();
const listing = identity.extend({ path: z.string().min(1).max(32768) }).strict();
const answer = identity
  .extend({
    choice: z.enum(['cancel', 'accept', 'choose']),
    path: z.string().min(1).max(32768).optional(),
  })
  .strict();

export type Confirmation = {
  title: string;
  message: string;
  detail?: string;
  acceptLabel: string;
  cancelLabel?: string;
};
type Job =
  | { kind: 'confirm'; data: Confirmation; resolve: (value: boolean | string | null) => void }
  | { kind: 'directory'; resolve: (value: boolean | string | null) => void };
type Options = {
  parent: () => BrowserWindow | undefined;
  preload: string;
  renderer: string;
  devUrl?: string;
  initialDirectory?: string;
};

/** Dedicated, isolated renderer: the application renderer receives no filesystem API. */
export class PromptWindows {
  #queue: Job[] = [];
  #active:
    { job: Job; win: BrowserWindow; nonce: string; url: string; detach: () => void } | undefined;
  #theme: Theme = 'light';
  #directory: string;
  constructor(readonly options: Options) {
    this.#directory = options.initialDirectory ?? homedir();
    ipcMain.handle(channels.state, (event, raw: unknown) => {
      const input = identity.parse(raw);
      const active = this.#authorize(event, input.nonce);
      return {
        kind: active.job.kind,
        theme: this.#theme,
        ...(active.job.kind === 'confirm'
          ? active.job.data
          : { title: 'Escolher pasta do projeto', path: this.#directory, home: homedir() }),
      };
    });
    ipcMain.handle(channels.list, async (event, raw: unknown) => {
      const input = listing.parse(raw);
      const active = this.#authorize(event, input.nonce);
      if (active.job.kind !== 'directory')
        throw new Error('Este pedido não permite explorar pastas.');
      const path = await this.#directoryPath(input.path);
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        throw new Error('Não foi possível abrir esta pasta. Confirma o caminho e as permissões.');
      }
      this.#authorize(event, input.nonce);
      const folders = entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true }));
      const root = parse(path).root;
      const crumbs = [{ name: root, path: root }];
      let cursor = root;
      for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, part);
        crumbs.push({ name: part, path: cursor });
      }
      return {
        path,
        parent: dirname(path) === path ? null : dirname(path),
        crumbs,
        folders: folders
          .slice(0, 1000)
          .map((entry) => ({ name: entry.name, path: join(path, entry.name) })),
        truncated: folders.length > 1000,
      };
    });
    ipcMain.handle(channels.answer, async (event, raw: unknown) => {
      const input = answer.parse(raw);
      const active = this.#authorize(event, input.nonce);
      if (input.choice === 'cancel') {
        this.#finish(null);
        return;
      }
      if (active.job.kind === 'confirm' && input.choice === 'accept' && input.path === undefined) {
        this.#finish(true);
        return;
      }
      if (active.job.kind !== 'directory' || input.choice !== 'choose' || !input.path)
        throw new Error('Resposta inválida para este pedido.');
      const path = await this.#directoryPath(input.path);
      this.#authorize(event, input.nonce);
      this.#directory = path;
      this.#finish(path);
    });
  }

  confirm(data: Confirmation): Promise<boolean> {
    return this.#enqueue({ kind: 'confirm', data }).then((value) => value === true);
  }
  pickDirectory(): Promise<string | null> {
    return this.#enqueue({ kind: 'directory' }).then((value) =>
      typeof value === 'string' ? value : null,
    );
  }
  theme(theme: Theme): void {
    this.#theme = theme;
    this.#active?.win.webContents.send(channels.theme, theme);
  }
  cancelAll(): void {
    const queued = this.#queue.splice(0);
    for (const job of queued) job.resolve(null);
    this.#finish(null);
  }

  #enqueue(
    input: { kind: 'confirm'; data: Confirmation } | { kind: 'directory' },
  ): Promise<boolean | string | null> {
    return new Promise((resolve) => {
      this.#queue.push({ ...input, resolve });
      this.#pump();
    });
  }
  #pump(): void {
    if (this.#active) return;
    const job = this.#queue.shift();
    if (!job) return;
    const parent = this.options.parent();
    if (!parent || parent.isDestroyed()) {
      job.resolve(null);
      this.#pump();
      return;
    }
    const nonce = randomUUID();
    const url = this.options.devUrl
      ? new URL('prompt.html', this.options.devUrl)
      : pathToFileURL(join(this.options.renderer, 'prompt.html'));
    url.searchParams.set('nonce', nonce);
    const win = new BrowserWindow({
      parent,
      modal: true,
      title: job.kind === 'confirm' ? job.data.title : 'Escolher pasta do projeto',
      width: job.kind === 'directory' ? 680 : 520,
      height: job.kind === 'directory' ? 560 : 370,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: this.#theme === 'dark' ? '#19191b' : '#f5f4f1',
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: 'solline-prompt-isolated',
      },
    });
    const closed = () => this.cancelAll();
    parent.once('closed', closed);
    this.#active = {
      job,
      win,
      nonce,
      url: url.href,
      detach: () => parent.removeListener('closed', closed),
    };
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', () => {
      if (this.#active?.win === win) this.#finish(null);
    });
    win.on('closed', () => {
      if (this.#active?.win === win) this.#finish(null);
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    void win.loadURL(url.href).catch(() => {
      if (this.#active?.win === win) this.#finish(null);
    });
  }
  #finish(value: boolean | string | null): void {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    active.detach();
    if (!active.win.isDestroyed()) active.win.destroy();
    active.job.resolve(value);
    this.#pump();
  }
  #authorize(event: IpcMainInvokeEvent, nonce: string) {
    const active = this.#active;
    const frame = event.senderFrame;
    if (
      !active ||
      nonce !== active.nonce ||
      event.sender !== active.win.webContents ||
      !frame ||
      frame.parent ||
      frame.url !== active.url
    )
      throw new Error('Origem não autorizada.');
    return active;
  }
  async #directoryPath(input: string): Promise<string> {
    try {
      const path = await realpath(input);
      if (!(await stat(path)).isDirectory()) throw new Error('Not a directory');
      return path;
    } catch {
      throw new Error('Escolhe uma pasta existente e acessível.');
    }
  }
}
