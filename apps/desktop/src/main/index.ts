import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { APP_NAME } from '@solline/protocol/app';
import { IPC, type Theme } from '@solline/protocol/bridge';
import {
  CommandNameSchema,
  RaceStartPayload,
  SplitStartPayload,
  SessionCreatePayload,
  commandSchemas,
  isMainCommand,
  type CommandName,
  type CommandPayload,
  type CommandResult,
  type MainCommandName,
} from '@solline/protocol';
import { addedKeys, allowedLoginUrl } from './agent-policy.ts';
import { AttentionTracker, type Attention } from './attention.ts';
import { EngineHost } from './engine-host.ts';
import { ProjectStore, newCommands } from './projects.ts';
import { resolveSessionStart } from './session-policy.ts';
import { reconcilePolicy } from './recovered-policy.ts';
import { UiRecoveryStore } from './ui-recovery.ts';
import { loadRecoveryKey } from './recovery-key.ts';
import { RecoveryStartup } from './recovery-startup.ts';
import { recoveryCodec } from './recovery-codec.ts';
import { PromptWindows } from './prompt-window.ts';
import { AttentionWindow } from './attention-window.ts';
import { WindowRecovery } from './window-recovery.ts';
import { DraftUpdateSchema, WindowActionSchema } from './window-schemas.ts';
import { NavigationPreferencesStore } from './navigation-preferences.ts';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(`app.${APP_NAME.toLowerCase()}`);
// Testes e smoke usam uma pasta de dados própria para não tocar na do dia a dia.
if (process.env.SOLLINE_USER_DATA) app.setPath('userData', process.env.SOLLINE_USER_DATA);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

let mainWindow: BrowserWindow | undefined;
let recovery: WindowRecovery | undefined;
let prompts: PromptWindows | undefined;
let attentionWindow: AttentionWindow | undefined;
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
let windowRevision = 0;
const customControls = process.platform === 'win32';
let draftKey: Buffer | undefined;
const drafts = new UiRecoveryStore(
  join(app.getPath('userData'), 'recovery-ui'),
  recoveryCodec(
    () => draftKey,
    (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
  ),
);
const attention = new AttentionTracker();
/** O nome dos projetos com repartições abertas, para o título dos avisos das partes tardias. */
const projectNames = new Map<string, string>();
const engine = new EngineHost((event) => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  win?.webContents.send(IPC.event, event);
  // Uma parte que arranca depois da parte zero só aparece num race.state: passa a ser seguida
  // (só o estado dela; nunca o conteúdo).
  if (event.type === 'race.state')
    attention.trackRace(event.race, projectNames.get(event.race.projectId) ?? 'Projeto');
  const notice = attention.observe(event, win?.isFocused() ?? false);
  if (notice) notify(notice);
  if (event.type === 'engine.error' && !event.sessionId) recovery?.show('crashed', event.message);
});
const recoveryStartup = new RecoveryStartup(drafts, engine, async () => {
  const key = await loadRecoveryKey(app.getPath('userData'));
  draftKey?.fill(0);
  draftKey = Buffer.from(key);
  return key;
});

/** Na app instalada o ícone vem do executável; fora dela, da pasta build. */
const devIcon = app.isPackaged ? undefined : join(__dirname, '../../build/icon.png');

/**
 * Aviso próprio da Solline para uma sessão que precisa de ti ou acabou um turno,
 * mostrado quando a janela está sem foco. Clicar abre essa sessão.
 */
function notify(notice: Attention): void {
  // Nos testes (isolados) os avisos ficam numa lista em vez de aparecerem no ecrã.
  if (process.env.SOLLINE_ISOLATED === '1') {
    ((globalThis as { notices?: Attention[] }).notices ??= []).push(notice);
    return;
  }
  attentionWindow?.show(notice);
}
const projects = new ProjectStore(join(app.getPath('userData'), 'projects.json'));
const navigation = new NavigationPreferencesStore(join(app.getPath('userData'), 'navigation.json'));
const generalCwd = join(app.getPath('userData'), 'general-workspace');
const policyProjects = {
  get: async (id: string) =>
    id === '__general__'
      ? { id, name: 'Geral', path: generalCwd, trusted: false, addedAt: 0 }
      : projects.get(id),
};

const TRUST_DETAIL =
  'Num projeto de confiança, os agentes leem as definições, hooks, servidores MCP e instruções ' +
  'da pasta (no Claude, o .claude/ e o CLAUDE.md). Sem confiança, só as tuas definições de ' +
  'utilizador, e "Permitir sempre" vale só na sessão. Vale para as sessões novas.';

/** Confirmation lives in an independent, main-owned Solline window. */
function confirm(options: Parameters<PromptWindows['confirm']>[0]): Promise<boolean> {
  if (!prompts) throw new Error('A confirmação ainda não está pronta.');
  return prompts.confirm(options);
}
async function confirmTrust(name: string): Promise<boolean> {
  return confirm({
    title: 'Confiança no projeto',
    message: `Confias no projeto ${name}?`,
    detail: TRUST_DETAIL,
    acceptLabel: 'Confiar',
    cancelLabel: 'Não confiar',
  });
}
async function confirmKeys(label: string, keys: readonly string[]): Promise<boolean> {
  return confirm({
    title: 'Variáveis do agente',
    message: `Dar ao ${label} estas variáveis do teu ambiente?`,
    detail: `${keys.join('\n')}\n\nO agente recebe os valores destas variáveis em cada sessão nova. A Solline só guarda os nomes.`,
    acceptLabel: 'Dar',
    cancelLabel: 'Cancelar',
  });
}
async function confirmChecks(name: string, commands: readonly string[]): Promise<boolean> {
  return confirm({
    title: 'Verificações do projeto',
    message: `Correr estes comandos em ${name} no fim de cada turno?`,
    detail: `${commands.join('\n')}\n\nCorrem na pasta do projeto, sem os segredos do teu ambiente.`,
    acceptLabel: 'Correr',
  });
}
async function confirmSetup(name: string, command: string, copyEnv: boolean): Promise<boolean> {
  return confirm({
    title: 'Preparação das worktrees',
    message: `Preparar cada worktree nova de ${name} com este comando?`,
    detail: `${command}\n\nCorre uma vez em cada worktree nova${copyEnv ? ', depois de copiar os .env ignorados da raiz do projeto' : ''}, sem os segredos do teu ambiente.`,
    acceptLabel: 'Preparar',
  });
}
async function confirmExportRules(folder: string): Promise<boolean> {
  return confirm({
    title: 'Exportar as regras',
    message: `Escrever AGENTS.md e CLAUDE.md em ${folder}?`,
    detail:
      'Ficam na pasta do projeto, para os agentes e para quem usar o repositório. A Solline só reescreve ' +
      'ficheiros que ela própria escreveu e que não editaste; se algum for teu, nada é escrito.',
    acceptLabel: 'Escrever',
    cancelLabel: 'Cancelar',
  });
}
async function confirmDiscard(): Promise<boolean> {
  return confirm({
    title: 'Deitar fora',
    message: 'Deitar fora o trabalho desta worktree?',
    detail: 'Apaga a pasta da worktree e o branch, com tudo o que não foi trazido. Não se desfaz.',
    acceptLabel: 'Deitar fora',
  });
}
async function confirmCloseRace(options: {
  unbrought: boolean;
  kept: string | null;
}): Promise<boolean> {
  return confirm({
    title: 'Fechar a corrida',
    message: 'Deitar fora as pistas desta corrida?',
    detail:
      'Apaga as worktrees e os branches das pistas, com tudo o que não foi trazido' +
      (options.kept ? `, menos o branch de ${options.kept}, que fica guardado` : '') +
      '.' +
      (options.unbrought ? ' A montagem ainda não foi trazida e também se apaga.' : '') +
      ' Não se desfaz.',
    acceptLabel: 'Deitar fora',
  });
}

async function handleMain(command: MainCommandName, payload: unknown): Promise<unknown> {
  switch (command) {
    case 'spaces.delegate': {
      const input = payload as CommandPayload<'spaces.delegate'>;
      const task = (await engine.request('spaces.snapshot', {})).tasks.find(
        (t) => t.id === input.id,
      );
      if (!task) throw new Error('Tarefa desconhecida.');
      if (input.target.kind === 'existing') {
        await reconcilePolicy(engine, policyProjects, 'session.send', {
          sessionId: input.target.sessionId,
          text: input.text,
        });
        return engine.request('spaces.dispatch', input);
      }
      const start = await resolveSessionStart(policyProjects, {
        projectId: task.projectId ?? '__general__',
        agent: input.target.agent,
        ...(input.target.model ? { model: input.target.model } : {}),
      });
      const result = await engine.request('spaces.dispatch', { ...input, start });
      const id = result.attempts.at(-1)?.sessionId;
      const session =
        id &&
        (await engine.request('engine.snapshot', {})).sessions.find((s) => s.session.id === id)
          ?.session;
      if (session)
        attention.track(
          session,
          task.projectId ? ((await projects.get(task.projectId))?.name ?? 'Projeto') : 'Geral',
        );
      return result;
    }
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
      const folder = await prompts?.pickDirectory();
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
    case 'projects.setSetup': {
      const { projectId, setup } = payload as CommandPayload<'projects.setSetup'>;
      const project = await projects.get(projectId);
      if (!project) throw new Error('Projeto desconhecido');
      // Como nas verificações: só um comando novo (face ao que está em uso) pede confirmação.
      const suggested = async () =>
        (await engine.request('projects.detectSetup', { cwd: project.path })).setup;
      const before = project.setup ?? (await suggested());
      const after = setup ?? (await suggested());
      const isNew = Boolean(after.command.trim()) && after.command !== before.command;
      if (isNew && !(await confirmSetup(project.name, after.command, after.copyEnv)))
        return { project };
      const updated = await projects.setSetup(projectId, setup);
      await engine.request('projects.setupChanged', { projectId, setup });
      return { project: updated };
    }
    case 'rules.import': {
      // A pasta vem do projeto guardado: a interface só diz de que projeto.
      const request = payload as CommandPayload<'rules.import'>;
      const project = await projects.get(request.projectId);
      if (!project) throw new Error('Projeto desconhecido');
      return engine.request('rules.importNow', { ...request, cwd: project.path });
    }
    case 'rules.export': {
      // Escrever na pasta do projeto é para fora da Solline: confirma-se fora da interface.
      const { projectId } = payload as CommandPayload<'rules.export'>;
      const project = await projects.get(projectId);
      if (!project) throw new Error('Projeto desconhecido');
      if (!(await confirmExportRules(project.name))) return { written: [] };
      return engine.request('rules.exportNow', { projectId, cwd: project.path });
    }
    case 'session.close': {
      const request = payload as CommandPayload<'session.close'>;
      // Deitar fora não se desfaz: confirma-se fora da interface.
      if (request.worktree === 'discard' && !(await confirmDiscard())) return { closed: false };
      return engine.request('session.closeNow', request);
    }
    case 'worktrees.discard': {
      const { id } = payload as CommandPayload<'worktrees.discard'>;
      if (!(await confirmDiscard())) return {};
      await engine.request('worktrees.discardNow', { id });
      return {};
    }
    case 'race.close': {
      const request = payload as CommandPayload<'race.close'>;
      const race = await engine.request('race.get', { raceId: request.raceId });
      // Deitar fora não se desfaz: confirma-se fora da interface.
      const kept = race.lanes.find((l) => l.sessionId === request.keep);
      const confirmed = await confirmCloseRace({
        unbrought: Boolean(
          (race.assembly && !race.assembly.brought) ||
          (race.integration && !race.integration.brought),
        ),
        kept: kept ? kept.agent : null,
      });
      if (!confirmed) return { closed: false };
      return engine.request('race.closeNow', request);
    }
    case 'race.start': {
      // Como numa sessão: a pasta, a confiança e as definições vêm do projeto guardado.
      const request = RaceStartPayload.parse(payload);
      const project = await projects.get(request.projectId);
      if (!project) throw new Error('Projeto desconhecido');
      const started = await engine.request('race.begin', {
        ...request,
        cwd: project.path,
        trusted: project.trusted,
        checks: project.checks ?? null,
        setup: project.setup ?? null,
      });
      for (const created of started.sessions) attention.track(created.session, project.name);
      return started;
    }
    case 'split.start': {
      // Como numa corrida: a pasta, a confiança e as definições vêm do projeto guardado.
      const request = SplitStartPayload.parse(payload);
      const project = await projects.get(request.projectId);
      if (!project) throw new Error('Projeto desconhecido');
      projectNames.set(project.id, project.name);
      const started = await engine.request('split.begin', {
        ...request,
        cwd: project.path,
        trusted: project.trusted,
        checks: project.checks ?? null,
        setup: project.setup ?? null,
      });
      for (const created of started.sessions) attention.track(created.session, project.name);
      return started;
    }
    case 'split.resolve': {
      // A pasta e a confiança vêm do projeto guardado: a interface só diz de que repartição.
      const request = payload as CommandPayload<'split.resolve'>;
      const race = await engine.request('race.get', { raceId: request.raceId });
      const project = await projects.get(race.projectId);
      if (!project) throw new Error('Projeto desconhecido');
      const resolved = await engine.request('split.resolveNow', {
        raceId: request.raceId,
        cwd: project.path,
        trusted: project.trusted,
        checks: project.checks ?? null,
        setup: project.setup ?? null,
      });
      attention.track(resolved.session.session, project.name);
      return resolved;
    }
    case 'split.plan': {
      // A pasta e as verificações vêm do projeto guardado; o planeador só lê.
      const request = payload as CommandPayload<'split.plan'>;
      const project = await projects.get(request.projectId);
      if (!project) throw new Error('Projeto desconhecido');
      // Num projeto sem confiança nada se corre: o planeador não conta com verificações.
      const specs = project.trusted
        ? (project.checks ??
          (await engine.request('projects.detectChecks', { cwd: project.path })).checks)
        : [];
      return engine.request('split.planNow', {
        text: request.text,
        cwd: project.path,
        checks: specs.filter((c) => c.enabled).map((c) => ({ id: c.id, label: c.label })),
      });
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
function isTrustedSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): boolean {
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
    titleBarOverlay: customControls
      ? false
      : { ...titleBarColors[theme], height: TITLE_BAR_HEIGHT },
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
  recovery?.attach(win);
  const publishState = () => {
    windowRevision += 1;
    win.webContents.send(IPC.windowState, {
      maximized: win.isMaximized(),
      customControls,
      revision: windowRevision,
    });
  };
  win.on('maximize', publishState);
  win.on('unmaximize', publishState);
  // Voltaste à janela: a barra deixa de piscar.
  win.on('close', () => prompts?.cancelAll());
  win.on('closed', () => attentionWindow?.dispose());
  win.webContents.on('render-process-gone', () => prompts?.cancelAll());
  win.webContents.on('unresponsive', () => prompts?.cancelAll());
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererFile);
}

ipcMain.handle(IPC.request, async (event, raw: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  const parsed = CommandNameSchema.safeParse((raw as { command?: unknown } | null)?.command);
  if (!parsed.success) return { ok: false, error: { message: 'Comando desconhecido' } };
  const command: CommandName = parsed.data;
  if (command === 'engine.shutdown')
    return { ok: false, error: { message: 'O fecho é coordenado pela janela' } };
  const payload = (raw as { payload?: unknown }).payload ?? {};
  try {
    // A memória precisa de saber as pastas dos projetos (a prova das memórias está lá).
    if (command.startsWith('spaces.') || command.startsWith('memory.')) {
      await mkdir(generalCwd, { recursive: true });
      await engine.request('spaces.syncProjects', { projects: await projects.list(), generalCwd });
    }
    if (isMainCommand(command)) {
      const input = commandSchemas[command].payload.parse(payload);
      if (
        command === 'session.close' ||
        command === 'worktrees.discard' ||
        command === 'race.close' ||
        command === 'split.resolve' ||
        command === 'rules.import' ||
        command === 'rules.export'
      )
        await reconcilePolicy(engine, policyProjects, command, input);
      const result = commandSchemas[command].result.parse(await handleMain(command, input));
      return { ok: true, result };
    }
    await reconcilePolicy(engine, policyProjects, command, payload);
    const result = await engine.request(command, payload);
    // A sessão que recebe o testemunho, ou que nasce de uma bifurcação, passa a ser seguida,
    // como qualquer sessão nova.
    if (command === 'handoff.start' || command === 'session.fork') {
      const { session } = result as CommandResult<'handoff.start' | 'session.fork'>;
      const project = await projects.get(session.projectId);
      attention.track(session, project?.name ?? basename(session.cwd));
    }
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
  if (!customControls)
    mainWindow?.setTitleBarOverlay({ ...titleBarColors[theme], height: TITLE_BAR_HEIGHT });
  recovery?.theme(theme);
  prompts?.theme(theme);
  attentionWindow?.theme(theme);
});

ipcMain.handle(IPC.navigationRead, (event) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  return navigation.read();
});
ipcMain.handle(IPC.navigationUpdate, (event, raw) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  return navigation.update(raw);
});

ipcMain.handle(IPC.windowState, (event) => {
  if (!isTrustedSender(event) || !mainWindow || mainWindow.isDestroyed())
    throw new Error('Origem não autorizada');
  return { maximized: mainWindow.isMaximized(), customControls, revision: windowRevision };
});
ipcMain.handle(IPC.windowAction, async (event, raw: unknown) => {
  if (!isTrustedSender(event) || !mainWindow || mainWindow.isDestroyed())
    throw new Error('Origem não autorizada');
  const action = WindowActionSchema.parse(raw);
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'toggle-maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else await recovery?.close().catch((error) => recovery?.show('save-failed', String(error)));
});
ipcMain.handle(IPC.recoveryUi, async (event) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  await recoveryStartup.ready();
  return drafts.load();
});
ipcMain.handle(IPC.recoveryOpen, (event) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  recovery?.show(
    'save-failed',
    'A interface não conseguiu confirmar o estado guardado. Podes tentar restaurar; nenhuma ação será reenviada automaticamente.',
  );
});
ipcMain.handle(IPC.recoveryDraft, async (event, raw: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  await recoveryStartup.ready();
  return drafts.save(DraftUpdateSchema.parse(raw));
});
ipcMain.handle(IPC.preparedClose, (event, raw: unknown) => {
  if (!isTrustedSender(event)) throw new Error('Origem não autorizada');
  const data = raw as { token?: unknown; ok?: unknown } | null;
  if (!data || typeof data.token !== 'string' || typeof data.ok !== 'boolean')
    throw new Error('Resposta inválida');
  recovery?.prepared(data.token, data.ok);
});
ipcMain.on(IPC.healthReply, (event, token: unknown) => {
  if (isTrustedSender(event)) recovery?.healthy(token);
});

// Qualquer webContents novo nasce sem webviews, sem janelas e sem navegar.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  Menu.setApplicationMenu(null);
  // A interface não usa câmara, microfone, notificações nem nada do género: tudo negado.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  recovery = new WindowRecovery(
    engine,
    drafts,
    join(__dirname, '../preload/recovery.js'),
    join(__dirname, '../renderer'),
    devUrl,
    () => recoveryStartup.retry(),
    () => prompts?.cancelAll(),
  );
  prompts = new PromptWindows({
    parent: () => mainWindow,
    preload: join(__dirname, '../preload/prompt.js'),
    renderer: join(__dirname, '../renderer'),
    devUrl,
    initialDirectory: app.getPath('home'),
  });
  attentionWindow = new AttentionWindow(
    () => mainWindow,
    join(__dirname, '../preload/attention.js'),
    join(__dirname, '../renderer'),
    (sessionId) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send(IPC.focusSession, sessionId);
    },
    devUrl,
  );
  let startupError: unknown;
  try {
    await recoveryStartup.ready();
  } catch (error) {
    startupError = error;
  }
  createWindow();
  if (startupError)
    recovery.show(
      'save-failed',
      `A recuperação não está disponível. Os dados existentes foram preservados. ${String(startupError)}`,
    );
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (recovery && !recovery.mayQuit && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    void recovery.close().catch((error) => recovery?.show('save-failed', String(error)));
    return;
  }
  engine.stop();
});
