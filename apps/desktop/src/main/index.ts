import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  Notification,
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
import { addedKeys, allowedLoginUrl } from './agent-policy.ts';
import { AttentionTracker, type Attention } from './attention.ts';
import { EngineHost } from './engine-host.ts';
import { ProjectStore, newCommands } from './projects.ts';
import { resolveSessionStart } from './session-policy.ts';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(`app.${APP_NAME.toLowerCase()}`);
// Testes e smoke usam uma pasta de dados própria para não tocar na do dia a dia.
if (process.env.SOLLINE_USER_DATA) app.setPath('userData', process.env.SOLLINE_USER_DATA);

let mainWindow: BrowserWindow | undefined;
const attention = new AttentionTracker();
const engine = new EngineHost((event) => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  win?.webContents.send(IPC.event, event);
  const notice = attention.observe(event, win?.isFocused() ?? false);
  if (notice) notify(notice);
});

/** Na app instalada o ícone vem do executável; fora dela, da pasta build. */
const devIcon = app.isPackaged ? undefined : join(__dirname, '../../build/icon.png');

/**
 * Aviso do Windows para uma sessão que precisa de ti ou acabou um turno (só chega aqui com a
 * janela sem foco). Clicar abre essa sessão; "precisa de ti" também faz piscar a barra.
 */
function notify(notice: Attention): void {
  // Nos testes (isolados) os avisos ficam numa lista em vez de aparecerem no ecrã.
  if (process.env.SOLLINE_ISOLATED === '1') {
    ((globalThis as { notices?: Attention[] }).notices ??= []).push(notice);
    return;
  }
  const win = mainWindow;
  if (notice.urgent) win?.flashFrame(true);
  if (!Notification.isSupported()) return;
  const toast = new Notification({
    title: notice.title,
    body: notice.body,
    silent: true,
    ...(devIcon ? { icon: devIcon } : {}),
  });
  toast.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(IPC.focusSession, notice.sessionId);
  });
  toast.show();
}
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

/** Diálogo nativo: um agente só recebe segredos novos depois de um clique teu fora da interface. */
async function confirmKeys(label: string, keys: readonly string[]): Promise<boolean> {
  const options = {
    type: 'question' as const,
    title: 'Variáveis do agente',
    message: `Dar ao ${label} estas variáveis do teu ambiente?`,
    detail:
      `${keys.join('\n')}\n\nO agente recebe os valores destas variáveis em cada sessão nova. ` +
      'A Solline só guarda os nomes.',
    buttons: ['Dar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

/** Diálogo nativo: um comando novo só corre no projeto depois de um clique teu fora da interface. */
async function confirmChecks(name: string, commands: readonly string[]): Promise<boolean> {
  const options = {
    type: 'question' as const,
    title: 'Verificações do projeto',
    message: `Correr estes comandos em ${name} no fim de cada turno?`,
    detail: `${commands.join('\n')}\n\nCorrem na pasta do projeto, sem os segredos do teu ambiente.`,
    buttons: ['Correr', 'Cancelar'],
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
    case 'agents.login': {
      const { agent } = payload as CommandPayload<'agents.login'>;
      // O motor pede, o main decide: só se abre o browser no sítio de login do agente.
      // Em qualquer falha (endereço recusado, resposta inválida, tempo esgotado) o login fecha.
      const cancel = () => engine.request('agents.loginCancel', { agent }).catch(() => undefined);
      let url: URL | null;
      try {
        url = allowedLoginUrl(agent, (await engine.request('agents.loginStart', { agent })).url);
      } catch (error) {
        await cancel();
        throw error;
      }
      if (!url) {
        await cancel();
        throw new Error('O endereço de login não é o esperado; não foi aberto.');
      }
      await shell.openExternal(url.href);
      return {};
    }
    case 'agents.setKeys': {
      const { agent, keys } = payload as CommandPayload<'agents.setKeys'>;
      const current = await engine.request('agents.keys', { agent });
      const added = addedKeys(current.keys, keys);
      if (added.length > 0 && !(await confirmKeys(current.label, added))) return { saved: false };
      await engine.request('agents.saveKeys', { agent, keys });
      return { saved: true };
    }
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
    case 'projects.setChecks': {
      const { projectId, checks } = payload as CommandPayload<'projects.setChecks'>;
      const project = await projects.get(projectId);
      if (!project) throw new Error('Projeto desconhecido');
      // Compara com a lista em uso: a guardada, ou a que o motor encontra no package.json.
      const before =
        project.checks ??
        (await engine.request('projects.detectChecks', { cwd: project.path })).checks;
      const after =
        checks ?? (await engine.request('projects.detectChecks', { cwd: project.path })).checks;
      const added = newCommands(before, after);
      if (added.length > 0 && !(await confirmChecks(project.name, added))) return { project };
      const updated = await projects.setChecks(projectId, checks);
      await engine.request('projects.checksChanged', { projectId, checks });
      return { project: updated };
    }
    case 'session.create': {
      // A interface pede pelo projeto; a pasta vem sempre do que está guardado aqui.
      const start = await resolveSessionStart(projects, SessionCreatePayload.parse(payload));
      const created = await engine.request('session.start', start);
      const project = await projects.get(start.projectId);
      attention.track(created.session, project?.name ?? basename(start.cwd));
      return created;
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
    ...(devIcon ? { icon: devIcon } : {}),
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
  // Voltaste à janela: a barra deixa de piscar.
  win.on('focus', () => win.flashFrame(false));
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
