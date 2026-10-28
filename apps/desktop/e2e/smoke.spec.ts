import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { removeRecoveryKey } from '../src/main/recovery-key';
import { observePrompts, type PromptChoice } from '../qa/electron/custom-prompts';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Abre a app e prova a ida e volta interface -> main -> motor.
 * Por omissão usa o build em out/; com SOLLINE_EXE corre a app instalada.
 * Com SOLLINE_E2E_SDK=1 faz uma sessão real (Haiku, effort low) num projeto temporário.
 * Com SOLLINE_SHOTS=<pasta> guarda capturas de ecrã.
 */
const exe = process.env.SOLLINE_EXE;
const shots = process.env.SOLLINE_SHOTS;

let app: ElectronApplication;
let userData: string;
let project: string;
let promptObserver: ReturnType<typeof observePrompts> | undefined;
const rendererErrors: string[] = [];
const confirmations: Record<string, PromptChoice> = {
  'Confiança no projeto': { button: 'Não confiar', choice: 'cancel' },
  'Variáveis do agente': { button: 'Cancelar', choice: 'cancel' },
};
/** A pasta que o seletor escolhe (muda de projeto para projeto) e as respostas às confirmações. */
const promptPlan: { directory: string; confirmations: Record<string, PromptChoice> } = {
  directory: '',
  confirmations,
};
/** Projetos temporários que os testes reais criam (limpos no fim). */
const extraProjects: string[] = [];

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'solline-e2e-data-'));
  project = await mkdtemp(join(tmpdir(), 'solline-e2e-proj-'));
  await writeFile(join(project, 'notes.txt'), 'The quick alpha fox.\n');
  // Duas verificações: os tipos passam, o lint falha com uma linha que se reconhece.
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        lint: 'node -e "console.error(String.fromCharCode(108,105,110,116,32,112,97,114,116,105,117)); process.exit(1)"',
      },
    }),
  );
  // A preparação de cada worktree nova vem do conductor.json: escreve a porta da sessão num ficheiro.
  await writeFile(
    join(project, 'conductor.json'),
    JSON.stringify({
      scripts: {
        setup: `node -e "require('fs').writeFileSync('prepared.txt', process.env.SOLLINE_PORT)"`,
      },
    }),
  );
  // O projeto é um repositório git: a segunda sessão ao mesmo tempo ganha a sua worktree.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, windowsHide: true });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'e2e@solline.local');
  git('config', 'user.name', 'E2E');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'início');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|SOLLINE_SKIP_SDK)$/i.test(
          key,
        ),
      ),
    ),
    SOLLINE_USER_DATA: userData,
    SOLLINE_ISOLATED: '1',
    // Com o SDK real, o revisor e o planeador também correm (leem o projeto, só leitura).
    ...(process.env.SOLLINE_E2E_SDK === '1'
      ? { SOLLINE_REVIEWER: '1', SOLLINE_PLANNER: '1', SOLLINE_DRAFTER: '1', SOLLINE_CHECKS: '1' }
      : {}),
  } as Record<string, string>;
  app = exe
    ? await electron.launch({ executablePath: exe, env })
    : await electron.launch({ args: [join(__dirname, '..', 'out', 'main', 'index.js')], env });
  promptPlan.directory = project;
  promptObserver = observePrompts(app, promptPlan);
  app.on('window', (page) => {
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
  });
});

test.afterEach(async ({ browserName }, info) => {
  expect(browserName).toBe('chromium');
  const diagnostics = info.outputPath('custom-prompts.json');
  await writeFile(
    diagnostics,
    JSON.stringify(
      { records: promptObserver?.records, failures: promptObserver?.failures, rendererErrors },
      null,
      2,
    ),
  );
  await info.attach('custom-prompts', {
    path: diagnostics,
    contentType: 'application/json',
  });
  if (info.status !== info.expectedStatus && app) {
    for (const [index, page] of app.windows().entries()) {
      const screenshot = info.outputPath(`window-${index}.png`);
      const contents = info.outputPath(`window-${index}.txt`);
      await page.screenshot({ path: screenshot });
      await writeFile(contents, await page.locator('body').innerText());
      await info.attach(`window-${index}`, { path: screenshot, contentType: 'image/png' });
      await info.attach(`window-${index}-text`, { path: contents, contentType: 'text/plain' });
    }
  }
});

test.afterAll(async () => {
  if (app) {
    const page = app.windows().find((window) => !window.url().endsWith('/recovery.html'));
    if (page) {
      await page.evaluate(() =>
        (
          globalThis as unknown as {
            solline: { window: { action(action: 'close'): Promise<void> } };
          }
        ).solline.window.action('close'),
      );
      await expect
        .poll(() => app.windows().some((window) => window.url().endsWith('/recovery.html')))
        .toBe(true);
      const recovery = app.windows().find((window) => window.url().endsWith('/recovery.html'));
      if (!recovery) throw new Error('Recovery window missing');
      await recovery.getByRole('button', { name: 'Fechar com segurança' }).click();
    }
    await app.close();
  }
  await promptObserver?.settle();
  promptObserver?.stop();
  for (const path of [userData, project, ...extraProjects])
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !path.includes('solline-e2e-'))
      throw new Error('Unsafe fixture cleanup');
  await removeRecoveryKey(userData);
  await rm(userData, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  for (const path of extraProjects) await rm(path, { recursive: true, force: true });
  expect(promptObserver?.failures ?? []).toEqual([]);
});

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  // Deixa acabar as transições de estado (≤ 250 ms) antes da captura.
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const html = page.locator('html');
  if ((await html.getAttribute('data-theme')) !== theme)
    await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', theme);
  await page.waitForTimeout(300);
}

test('a janela abre com o nome certo e o motor responde ao ping', async () => {
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('Solline');
  await expect(page.getByTestId('ping-reply')).toContainText('Motor ligado', { timeout: 15_000 });
  await expect(page.getByTestId('ping-reply')).toContainText(/\d+ ms · v/);
  // A primeira abertura começa nas tarefas do Geral, sem iniciar agentes.
  await expect(page.getByRole('heading', { name: 'Geral', exact: true })).toBeVisible();
  await page.getByTestId('open-desk').click();
  await expect(page.getByTestId('familiar')).toBeVisible();
});

test('o tema alterna entre claro e escuro', async () => {
  const page = await app.firstWindow();
  const html = page.locator('html');
  const before = await html.getAttribute('data-theme');
  await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark');
  await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', before ?? 'light');
});

test('a interface não tem acesso ao Node', async () => {
  const page = await app.firstWindow();
  const surface = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    api: Object.keys((globalThis as unknown as { solline: object }).solline).sort(),
  }));
  expect(surface).toEqual({
    require: 'undefined',
    process: 'undefined',
    api: ['navigation', 'onEvent', 'onFocusSession', 'recovery', 'request', 'window'],
  });
  expect(
    await page.evaluate(() =>
      Object.keys(
        (globalThis as unknown as { solline: { navigation: object } }).solline.navigation,
      ).sort(),
    ),
  ).toEqual(['read', 'update']);
});

test('só links https abrem fora e as permissões do browser vêm negadas', async () => {
  const page = await app.firstWindow();
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = (async (url: string) => {
      opened.push(url);
    }) as typeof shell.openExternal;
  });
  const result = await page.evaluate(async () => {
    const g = globalThis as unknown as {
      open(url: string): unknown;
      navigator: { permissions: { query(d: { name: string }): Promise<{ state: string }> } };
      Notification: { requestPermission(): Promise<string> };
    };
    return {
      https: g.open('https://example.com/') === null,
      http: g.open('http://example.com/') === null,
      creds: g.open('https://user:pw@example.com/') === null,
      // Uma verificação (check handler) e um pedido (request handler).
      geolocation: (await g.navigator.permissions.query({ name: 'geolocation' })).state,
      notifications: await g.Notification.requestPermission(),
    };
  });
  const opened = await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
  expect(result).toEqual({
    https: true,
    http: true,
    creds: true,
    geolocation: 'denied',
    notifications: 'denied',
  });
  expect(opened).toEqual(['https://example.com/']);
});

async function chooseTrust(trust: boolean): Promise<void> {
  await promptObserver?.settle();
  confirmations['Confiança no projeto'] = trust
    ? { button: 'Confiar', choice: 'accept' }
    : { button: 'Não confiar', choice: 'cancel' };
}

/** Quantas vezes o main mostrou o diálogo de confiança. */
async function trustDialogs(): Promise<number> {
  await promptObserver?.settle();
  return (
    promptObserver?.records.filter((record) => record.title === 'Confiança no projeto').length ?? 0
  );
}

test('um projeto novo pergunta pela confiança e o escudo muda-a', async () => {
  const page = await app.firstWindow();
  await chooseTrust(false);
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('project-row')).toHaveCount(1);
  const shield = page.getByTestId('project-trust');
  await expect(shield).toHaveAttribute('data-trusted', 'false');
  expect(await trustDialogs()).toBe(1);

  // Recusar a confirmação deixa como estava (espera pelo diálogo antes de olhar).
  await shield.click();
  await expect.poll(trustDialogs).toBe(2);
  await expect(shield).toHaveAttribute('data-trusted', 'false');
  // Aceitar liga a confiança.
  await chooseTrust(true);
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'true');
  expect(await trustDialogs()).toBe(3);
  // Tirar a confiança não pede nada.
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'false');
  expect(await trustDialogs()).toBe(3);
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'true');
});

test('a nova sessão deixa escolher o agente e mostra porque um não está pronto', async () => {
  const page = await app.firstWindow();
  await page.getByTestId('new-session-agent').click();
  await expect(page.getByTestId('agent-claude')).toBeVisible();
  await expect(page.getByTestId('agent-codex')).toContainText('Codex');
  await expect(page.getByTestId('agent-opencode')).toContainText('OpenCode');
  // O REA aparece nos servidores MCP; sem estar instalado diz como instalar.
  await expect(page.getByTestId('mcp-rea')).toContainText('REA');
  // Só agentes com login por subscrição: nada que viva só de uma chave de API.
  await expect(page.getByTestId('agent-claude:deepseek')).toHaveCount(0);
  await shot(page, 'agent-picker');
  // O seletor também abre o painel de agentes.
  await page.getByTestId('open-agents-panel').click();
  await expect(page.getByTestId('agents-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('agents-panel')).toBeHidden();
});

test('o Mapa abre com um estado vazio calmo e fecha com Esc', async () => {
  const page = await app.firstWindow();
  await page.getByTestId('open-map').click();
  await expect(page.getByTestId('map-empty')).toContainText(
    'Ainda não há sessões ligadas entre si.',
  );
  await shot(page, 'map-empty');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('map-dialog')).toBeHidden();
});

test('o painel de agentes mostra o estado e guarda as variáveis só depois de confirmares', async () => {
  const page = await app.firstWindow();
  await page.getByTestId('sidebar-agents').click();
  const panel = page.getByTestId('agents-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('panel-agent-codex')).toContainText('Codex');
  await expect(page.getByTestId('panel-agent-opencode')).toContainText('Não instalado');
  await page.getByTestId('agents-refresh').click();
  await expect(page.getByTestId('agents-refresh')).toBeEnabled({ timeout: 45_000 });

  const answer = async (response: number) => {
    await promptObserver?.settle();
    confirmations['Variáveis do agente'] =
      response === 0
        ? { button: 'Dar', choice: 'accept' }
        : { button: 'Cancelar', choice: 'cancel' };
  };
  const input = page.getByTestId('keys-input-opencode');
  await input.fill('nome inválido');
  await expect(panel.getByRole('button', { name: 'Juntar' }).first()).toBeDisabled();
  await input.fill('SOLLINE_E2E_API_KEY');
  await input.press('Enter');
  await answer(1);
  await page.getByTestId('keys-save-opencode').click();
  // Recusado: o rascunho volta ao que estava guardado (nada).
  await expect(page.getByTestId('panel-agent-opencode')).not.toContainText('SOLLINE_E2E_API_KEY', {
    timeout: 15_000,
  });

  await input.fill('SOLLINE_E2E_API_KEY');
  await input.press('Enter');
  await answer(0);
  await page.getByTestId('keys-save-opencode').click();
  await expect(page.getByTestId('keys-save-opencode')).toHaveText('Guardar', { timeout: 15_000 });
  await expect(page.getByTestId('panel-agent-opencode')).toContainText('SOLLINE_E2E_API_KEY');
  await promptObserver?.settle();
  const dialogs =
    promptObserver?.records
      .filter((record) => record.title === 'Variáveis do agente')
      .map((record) => record.detail) ?? [];
  expect(dialogs).toHaveLength(2);
  expect(dialogs[1]).toContain('SOLLINE_E2E_API_KEY');
  const saved = JSON.parse(await readFile(join(userData, 'agent-settings.json'), 'utf8')) as {
    agents: Record<string, { keys: string[] }>;
  };
  expect(saved.agents.opencode?.keys).toEqual(['SOLLINE_E2E_API_KEY']);
  await shot(page, 'agents-panel');

  // A interface não consegue guardar sem o main nem pedir o login a um agente sem login.
  const errors = await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { solline: { request(c: string, p: unknown): Promise<unknown> } }
    ).solline;
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => 'aceite',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    return {
      save: await fail(api.request('agents.saveKeys', { agent: 'opencode', keys: [] })),
      start: await fail(api.request('agents.loginStart', { agent: 'codex' })),
      login: await fail(api.request('agents.login', { agent: 'claude' })),
    };
  });
  expect(errors.save).toContain('Comando desconhecido');
  expect(errors.start).toContain('Comando desconhecido');
  expect(errors.login).toContain('login');
  await page.keyboard.press('Escape');
});

test('a interface não escolhe a pasta de uma sessão', async () => {
  const page = await app.firstWindow();
  const errors = await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { solline: { request(c: string, p: unknown): Promise<unknown> } }
    ).solline;
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => 'aceite',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    const { projects } = (await api.request('projects.list', {})) as {
      projects: { id: string }[];
    };
    const projectId = projects[0]?.id ?? '';
    return {
      projectId,
      // Um projeto que existe, mas com uma pasta escolhida pela interface: o pedido é estrito.
      cwd: await fail(api.request('session.create', { projectId, agent: 'claude', cwd: 'C:\\' })),
      unknown: await fail(
        api.request('session.create', { projectId: 'nao-existe', agent: 'claude' }),
      ),
      internal: await fail(
        api.request('session.start', { projectId, agent: 'claude', cwd: 'C:\\', trusted: true }),
      ),
    };
  });
  expect(errors.projectId).not.toBe('');
  expect(errors.cwd).toMatch(/unrecognized|cwd/i);
  expect(errors.unknown).toContain('Projeto desconhecido');
  expect(errors.internal).toContain('Comando desconhecido');
});

test('projeto, sessão, mensagem, permissão, ferramenta e resultado (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(240_000);
  const page = await app.firstWindow();
  await setTheme(page, 'light');

  // O projeto já foi adicionado (e ficou de confiança) no teste anterior.
  await chooseTrust(true);
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('project-row')).toHaveCount(1);

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByTestId('session-row')).toHaveAttribute('data-state', 'idle');
  // Um só bot no ecrã: o da sessão aberta, no cabeçalho, cor de barro e à espera. A lista
  // mostra só a marca do capuz.
  await expect(page.getByTestId('bot')).toHaveCount(1);
  const bot = page.locator('header').getByTestId('bot');
  await expect(bot).toHaveAttribute('data-hood', 'claude');
  await expect(bot).toHaveAttribute('data-mood', 'waiting');
  // A marca da lista (e a do cabeçalho, que o redesign acrescentou) mostram o mesmo estado.
  await expect(page.getByTestId('session-row').getByTestId('session-mark')).toHaveAttribute(
    'data-mood',
    'waiting',
  );

  // Modelo e effort pelos botões da barra.
  await page.getByTestId('pill-model').click();
  await page.getByTestId('model-haiku').click();
  await expect(page.getByTestId('pill-model')).toContainText(/Haiku/);
  await page.getByTestId('pill-effort').click();
  await page.getByTestId('effort-low').click();
  await expect(page.getByTestId('pill-effort')).toContainText('low');
  await page.getByTestId('pill-mode').click();
  await expect(page.getByTestId('mode-plan')).toBeVisible();
  await shot(page, 'composer-pills');
  await page.keyboard.press('Escape');

  await page
    .getByTestId('composer-input')
    .fill(
      'Read notes.txt, then use the Edit tool to replace the word "alpha" with "beta". Reply with one short sentence.',
    );
  await page.getByTestId('send').click();

  const card = page.getByTestId('permission-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('session-row')).toHaveAttribute('data-state', 'needs-you');
  await expect(card).toContainText('Editar notes.txt');
  await shot(page, 'permission-card');
  await card.getByRole('button', { name: /Permitir uma vez/ }).click();

  await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'allowed');
  const edit = page.locator('[data-testid="tool-block"][data-tool="Edit"]');
  await expect(edit).toHaveAttribute('data-state', 'ok', { timeout: 120_000 });
  await expect(page.getByTestId('session-row')).toHaveAttribute('data-state', 'idle', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('assistant-text').last()).toBeVisible();
  await expect(page.getByTestId('session-cost')).toContainText(/US\$|\$/);
  // Sem barras de scroll: a conversa desloca-se com a roda, o trackpad ou arrastando.
  expect(
    await page
      .getByTestId('conversation')
      .evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).scrollbarWidth),
  ).toBe('none');
  // Abaixo de 50% o medidor de contexto não aparece (um turno curto fica longe disso).
  await expect(page.getByTestId('context-meter')).toHaveCount(0);
  // Sem foco, o turno acabado (e o pedido de permissão) dão aviso do Windows.
  const notices = await app.evaluate(
    () => (globalThis as { notices?: { body: string; title: string }[] }).notices ?? [],
  );
  const focused = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.isFocused()),
  );
  if (!focused) {
    expect(notices.map((n) => n.body)).toContain('Turno acabado');
    expect(notices[0]?.title).toMatch(/^Claude · /);
  }
  // No fim de um turno só se revê o que vale a pena (20 linhas ou mais, ou um caminho sensível):
  // esta troca de uma palavra fica em silêncio ("idle"); se o revisor correr, acaba limpo ou com achados.
  await expect(page.getByTestId('quality-chip')).toHaveAttribute(
    'data-quality',
    /^(idle|clean|found)$/,
    { timeout: 120_000 },
  );
  await shot(page, 'quality-chip');
  // As verificações correm ao mesmo tempo: uma só pastilha mostra o lint que falhou; aberta,
  // os tipos passaram e o lint traz o fim do erro.
  const chip = page.getByTestId('checks-chip');
  await expect(chip).toHaveAttribute('data-state-check', 'failed', { timeout: 60_000 });
  await expect(chip).toContainText('Lint');
  await chip.click();
  const row = (id: string) => page.locator(`[data-testid="check-row"][data-check="${id}"]`);
  await expect(row('typecheck')).toHaveAttribute('data-state-check', 'passed');
  await expect(row('lint')).toHaveAttribute('data-state-check', 'failed');
  await expect(page.getByTestId('check-tail')).toContainText('lint partiu');
  await shot(page, 'checks-failed');
  await page.keyboard.press('Escape');
  expect(await readFile(join(project, 'notes.txt'), 'utf8')).toContain('beta');
  console.info(
    `[sessão ${exe ? 'instalada' : 'build'}] custo ${await page.getByTestId('session-cost').innerText()}`,
  );
  await shot(page, 'conversation-light');

  // Ler e Editar seguidos juntam-se em "2 ações": abre-se o grupo e depois a ferramenta.
  await page.getByTestId('tool-group').first().click();
  await edit.click();
  await expect(page.getByTestId('tool-detail')).toBeVisible();
  await expect(page.getByTestId('tool-output')).toContainText(/updated|beta/i);
  await shot(page, 'tool-detail');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-detail')).toBeHidden();

  await setTheme(page, 'dark');
  await shot(page, 'conversation-dark');
  await setTheme(page, 'light');
});

test('rever o diff, comentar, rejeitar, desfazer e rebobinar (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'depende da sessão real do teste anterior');
  test.setTimeout(120_000);
  const page = await app.firstWindow();
  const notes = () => readFile(join(project, 'notes.txt'), 'utf8');
  // Cada passo espera pelo git sombra; com a máquina carregada cada chamada chega a 1 s.
  const slow = expect.configure({ timeout: 15_000 });

  // O turno anterior mudou alpha para beta: aparece por rever, com as contas no botão.
  await slow(page.getByTestId('review-pending')).toContainText('+1', { timeout: 15_000 });
  await page.getByTestId('review-toggle').click();
  const panel = page.getByTestId('review-panel');
  await slow(panel).toBeVisible();
  const file = panel.locator('[data-testid="diff-file"][data-path="notes.txt"]');
  await slow(file).toBeVisible();
  await slow(file.locator('[data-kind="del"]')).toContainText('alpha');
  await slow(file.locator('[data-kind="add"]')).toContainText('beta');

  // Um comentário numa linha fica guardado até seguir para o agente.
  await file.locator('[data-kind="add"]').hover();
  await file.locator('[data-kind="add"] [data-testid="comment-line"]').click();
  await page.getByTestId('comment-input').fill('Porquê beta e não gamma?');
  await page.getByTestId('comment-save').click();
  await slow(page.getByTestId('comment-chip')).toContainText('gamma');
  await slow(page.getByTestId('send-comments')).toBeEnabled();
  await shot(page, 'review-panel');

  // Rejeitar o hunk volta o disco atrás; desfazer repõe.
  await file.getByTestId('reject-hunk').click();
  await slow(page.getByTestId('review-empty')).toBeVisible();
  await slow.poll(notes).toContain('alpha');
  await shot(page, 'review-empty');
  await page.getByTestId('review-undo').click();
  await slow.poll(notes).toContain('beta');
  await slow(file).toBeVisible();
  await page.getByTestId('review-toggle').click();
  await slow(panel).toBeHidden();

  // A linha do tempo: um ponto antes do turno. Só ficheiros e depois voltar ao presente.
  const timeline = page.getByTestId('timeline');
  await slow(timeline).toBeVisible();
  await timeline.getByTestId('timeline-stop').first().click();
  await slow(page.getByTestId('rewind-confirm')).toBeVisible();
  await shot(page, 'timeline-confirm');
  await page.getByTestId('rewind-files').click();
  await slow.poll(notes).toContain('alpha');
  await slow(page.getByTestId('timeline-present')).toBeVisible();
  await shot(page, 'timeline-files');
  await page.getByTestId('timeline-present').click();
  await slow.poll(notes).toContain('beta');

  // Ficheiros e conversa: o turno sai da conversa e a mensagem volta à caixa de texto.
  await timeline.getByTestId('timeline-stop').first().click();
  await page.getByTestId('rewind-both').click();
  await slow.poll(notes).toContain('alpha');
  await slow(page.getByTestId('user-turn')).toHaveCount(0, { timeout: 30_000 });
  await slow(page.getByTestId('composer-input')).toHaveValue(/replace the word "alpha"/);
  await slow(page.getByTestId('composer-input')).toBeEnabled({ timeout: 60_000 });
  await shot(page, 'timeline-rewound');
});

test('uma segunda sessão trabalha na sua worktree e traz por merge (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'depende da sessão real dos testes anteriores');
  test.setTimeout(240_000);
  const page = await app.firstWindow();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-row')).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 90_000 });
  const chip = page.getByTestId('workspace-chip');
  // A sugestão do conductor.json só corre depois de aprovada (uma vez, com confirmação nativa).
  const label = page.getByTestId('workspace-label');
  await expect(label).toHaveText('Por preparar', { timeout: 60_000 });
  await chip.click();
  await page.getByTestId('setup-approve').click();
  // A worktree prepara-se por trás e a pastilha volta ao nome do branch quando acaba.
  await expect(label).not.toHaveText(/A preparar|Por preparar/, { timeout: 60_000 });
  await expect(chip).toHaveAttribute('data-branch', /^solline\/sessao-/);

  await page.getByTestId('pill-model').click();
  await page.getByTestId('model-haiku').click();
  await page.getByTestId('pill-effort').click();
  await page.getByTestId('effort-low').click();
  await page
    .getByTestId('composer-input')
    .fill(
      'Create a file named wt.txt containing exactly the word hello. Reply with one short sentence.',
    );
  await page.getByTestId('send').click();

  // A trabalhar, a caixa continua ativa: Enter põe a mensagem seguinte na fila.
  await expect(page.getByTestId('interrupt')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('composer-input').fill('Reply with exactly one word: ok');
  await expect(page.getByTestId('queue-send')).toBeVisible();
  // A primeira mensagem só fica confirmada depois de gravada; até lá o Enter não faz nada e o
  // texto fica na caixa. Repete-se até a fila a aceitar (com a máquina carregada demora).
  await expect(async () => {
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('queued')).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await shot(page, 'queue');

  // Na mesa, a sessão que pede permissão sobe para o topo e responde-se no cartão.
  await page.getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-card')).toHaveCount(2);
  const top = page.getByTestId('desk-card').first();
  await expect(top).toHaveAttribute('data-state', 'needs-you', { timeout: 120_000 });
  await expect(page.getByTestId('desk-waiting')).toHaveText('1');
  await expect(top.getByTestId('card-ask')).toContainText('wt.txt');
  await shot(page, 'desk-needs-you');
  await top.getByTestId('card-allow').click();
  await expect(page.locator('[data-testid="desk-card"][data-state="needs-you"]')).toHaveCount(0);
  await expect(page.getByTestId('session-row').first()).toHaveAttribute('data-state', 'idle', {
    timeout: 120_000,
  });
  await shot(page, 'desk');
  await page.getByTestId('session-row').first().click();
  // A mensagem da fila seguiu sozinha no fim do turno, como um turno seu.
  await expect(page.getByTestId('user-turn')).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByTestId('queued')).toHaveCount(0);

  // O branch ganhou o nome da mensagem; o ficheiro está só na worktree até se trazer.
  await expect(chip).toHaveAttribute('data-branch', /^solline\/create-a-file-named-/);
  await expect(page.getByTestId('review-pending')).toContainText(/[+][1-9]/, { timeout: 30_000 });
  expect(existsSync(join(project, 'wt.txt'))).toBe(false);
  await shot(page, 'worktree-chip');
  await chip.click();
  await page.getByTestId('workspace-bring').click();
  // Trazer pede confirmação (com a revisão antes de trazer, só informativa).
  await page.getByTestId('bring-confirm').click();
  await expect
    .poll(() => readFile(join(project, 'wt.txt'), 'utf8').catch(() => ''), { timeout: 30_000 })
    .toContain('hello');
  // O script de preparação recebeu a porta da sessão (veio com o trabalho trazido).
  expect(await readFile(join(project, 'prepared.txt'), 'utf8')).toMatch(/^4\d{4}$/);

  // Já trazida, fecha sem perguntar e a worktree sai.
  await chip.click();
  await page.getByTestId('workspace-close').click();
  await expect(page.getByTestId('session-row')).toHaveCount(1, { timeout: 30_000 });
});

test('uma corrida: o mesmo pedido em duas pistas, lado a lado (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'depende das sessões reais dos testes anteriores');
  test.setTimeout(300_000);
  const page = await app.firstWindow();
  await page.getByTestId('session-row').first().click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 60_000 });

  // 2×: a sessão como está (Haiku) e mais uma pista com o Sonnet.
  await page.getByTestId('pill-race').click();
  await page.getByTestId('race-lane-claude-sonnet').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pill-race')).toContainText('2×');
  await page
    .getByTestId('composer-input')
    .fill('Create a file named race.txt containing exactly the word ok. Reply with one word.');
  await page.getByTestId('send').click();

  await expect(page.getByTestId('race')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('race-lane')).toHaveCount(2);
  await shot(page, 'race');
  // Os pedidos das pistas chegam num só sítio; o mesmo pedido responde-se para todas.
  const phase = page.getByTestId('race-phase');
  await expect
    .poll(
      async () => {
        if (await page.getByTestId('race-allow-all').isVisible()) {
          await page.getByTestId('race-allow-all').click();
        } else if (await page.getByTestId('race-allow').isVisible()) {
          await page.getByTestId('race-allow').click();
        }
        return phase.getAttribute('data-phase');
      },
      { timeout: 240_000, intervals: [1_000] },
    )
    .toBe('ranked');
  // Ordenada: cada pista com a sua posição.
  await expect(page.getByTestId('race-rank')).toHaveCount(2);
  await shot(page, 'race-ranked');

  // Na mesa, a corrida é um cartão; as pistas não aparecem soltas.
  await page.getByTestId('open-desk').click();
  await expect(page.getByTestId('race-card')).toHaveCount(1);

  // Montar: o que as duas pistas escreveram igual (ou a melhor pista) já vem escolhido.
  await page.getByTestId('race-card').click();
  await expect(page.getByTestId('race-assembly')).toBeVisible();
  await expect(page.getByTestId('race-candidate').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('race-assemble')).toBeEnabled();
  await page.getByTestId('race-assemble').click();
  await expect(page.getByTestId('race-assembly-summary')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('race-phase')).toHaveAttribute('data-phase', 'assembled');
  await shot(page, 'race-assembled');

  // Trazer faz o merge no projeto, como numa sessão.
  await page.getByTestId('race-bring').click();
  await expect(page.getByTestId('race-assembly-summary')).toContainText('Trazida', {
    timeout: 60_000,
  });
  await expect
    .poll(() => readFile(join(project, 'race.txt'), 'utf8').catch(() => ''), { timeout: 30_000 })
    .toMatch(/ok/i);

  // Fechar pede uma confirmação nativa e deita fora as pistas.
  confirmations['Fechar a corrida'] = { button: 'Deitar fora', choice: 'accept' };
  await page.getByTestId('race-close').click();
  await expect(page.getByTestId('desk')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('race-card')).toHaveCount(0);
});

test('uma repartição: duas partes à mão, integrar, trazer e fechar (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'depende das sessões reais dos testes anteriores');
  test.setTimeout(480_000);
  const page = await app.firstWindow();
  await page.getByTestId('session-row').first().click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 60_000 });
  await page
    .getByTestId('composer-input')
    .fill(
      'Create two files: part-a.txt containing exactly the word alpha, and part-b.txt containing exactly the word beta. Reply with one word.',
    );

  // Partir: o planeador lê o projeto. Se disser que não vale a pena, parte-se à mão; se propuser
  // partes, o teste reescreve-as, para o caminho ser sempre o mesmo.
  await page.getByTestId('pill-split').click();
  await expect(page.getByTestId('split-keep').or(page.getByTestId('split-plan'))).toBeVisible({
    timeout: 180_000,
  });
  if (await page.getByTestId('split-keep').isVisible()) {
    await page.getByTestId('split-by-hand').click();
  }
  const plan = page.getByTestId('split-plan');
  await expect(plan).toBeVisible();
  const parts = plan.getByTestId('split-part');
  while ((await parts.count()) > 2) await parts.last().getByTestId('split-part-remove').click();
  await expect(parts).toHaveCount(2);

  // Duas partes sem ficheiros em comum: correm ao mesmo tempo, cada uma com a verificação "typecheck".
  const files = ['part-a.txt', 'part-b.txt'] as const;
  const words = ['alpha', 'beta'] as const;
  for (const i of [0, 1] as const) {
    const part = parts.nth(i);
    await part.getByTestId('split-part-title').fill(`Ficheiro ${files[i]}`);
    if (!(await part.getByTestId('split-part-goal').isVisible())) {
      await part.getByTestId('split-contract-toggle').click();
    }
    await part
      .getByTestId('split-part-goal')
      .fill(
        `Create the file ${files[i]} containing exactly the word ${words[i]}. Touch nothing else.`,
      );
    await part.getByTestId('split-part-allowed').fill(files[i]);
    await part.getByTestId('split-part-forbidden').fill(files[1 - i] as string);
    await part.getByTestId('split-part-check').selectOption({ value: 'typecheck' });
  }
  const zero = parts.first().getByTestId('split-zero');
  if (await zero.isChecked()) await zero.uncheck();
  await expect(page.getByTestId('split-launch')).toHaveText('Lançar 2 partes', { timeout: 30_000 });
  await expect(page.getByTestId('split-cost')).toContainText('2×');
  await shot(page, 'split-plan');
  await page.getByTestId('split-launch').click();

  await expect(page.getByTestId('race')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('race')).toHaveAttribute('data-kind', 'split');
  await expect(page.getByTestId('race-lane')).toHaveCount(2);
  await shot(page, 'split');

  // As partes pedem permissão no mesmo sítio; responde-se até acabarem todas.
  const phase = page.getByTestId('race-phase');
  await expect
    .poll(
      async () => {
        if (await page.getByTestId('race-allow-all').isVisible()) {
          await page.getByTestId('race-allow-all').click();
        } else if (await page.getByTestId('race-allow').isVisible()) {
          await page.getByTestId('race-allow').click();
        }
        return phase.getAttribute('data-phase');
      },
      { timeout: 300_000, intervals: [1_000] },
    )
    .toBe('done');
  await expect(page.getByTestId('race-rank')).toHaveCount(0);

  // Integrar: uma parte de cada vez, com a verificação depois de cada uma.
  await page.getByTestId('split-integrate').click();
  await expect(phase).toHaveAttribute('data-phase', 'assembled', { timeout: 240_000 });
  await expect(page.getByTestId('split-step')).toHaveCount(2);
  await expect(page.getByTestId('split-metrics')).toBeVisible();
  await shot(page, 'split-integrated');

  // Trazer faz o merge no projeto.
  await page.getByTestId('race-bring').click();
  await expect(page.getByTestId('split-brought')).toBeVisible({ timeout: 60_000 });
  for (const i of [0, 1] as const) {
    await expect
      .poll(() => readFile(join(project, files[i]), 'utf8').catch(() => ''), { timeout: 30_000 })
      .toContain(words[i]);
  }

  // Fechar pede uma confirmação nativa e deita fora as pistas.
  confirmations['Fechar a corrida'] = { button: 'Deitar fora', choice: 'accept' };
  await page.getByTestId('race-close').click();
  await expect(page.getByTestId('desk')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('race-card')).toHaveCount(0);
});

test('Codex por clique: sessão, resposta e tokens (Codex real)', async () => {
  test.skip(
    process.env.SOLLINE_E2E_CODEX !== '1',
    'gasta quota do Codex: só com SOLLINE_E2E_CODEX=1',
  );
  test.setTimeout(240_000);
  const page = await app.firstWindow();
  await page.getByTestId('new-session-agent').click();
  await page.getByTestId('agent-codex').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByTestId('pill-mode')).toContainText('Ask');
  await page.getByTestId('composer-input').fill('Reply with exactly one word: ok');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('assistant-text').last()).toContainText(/ok/i, {
    timeout: 180_000,
  });
  await expect(page.getByTestId('session-tokens')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('session-cost')).toHaveCount(0);
  await shot(page, 'codex-session');
});

// ---- M5: passagem, bifurcação e segunda opinião a pedido (SDK real) ----

interface Fixture {
  dir: string;
  /** A linha do projeto na barra lateral (para não confundir sessões de outros projetos). */
  scope: Locator;
}

/** Um projeto git temporário, adicionado pela interface (de confiança) e ativo. */
async function addGitProject(page: Page): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'solline-e2e-proj-'));
  extraProjects.push(dir);
  await writeFile(join(dir, 'README.md'), '# e2e\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'e2e@solline.local');
  git('config', 'user.name', 'E2E');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'início');
  promptPlan.directory = dir;
  await chooseTrust(true);
  const before = await page.getByTestId('project-row').count();
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('project-row')).toHaveCount(before + 1);
  // O nome do botão ganha ", N propostas por aprovar" quando há memórias à espera.
  const escaped = basename(dir).replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');
  const label = new RegExp(`^Projeto ${escaped}(,|$)`);
  const scope = page.locator('li').filter({ has: page.getByRole('button', { name: label }) });
  await expect(scope).toHaveCount(1);
  return { dir, scope };
}

/** Uma sessão nova no projeto, em Haiku, esforço baixo e a editar sem perguntar. */
async function startQuickSession(page: Page, fx: Fixture, rows = 1): Promise<void> {
  await fx.scope.getByTestId('new-session').click();
  await expect(fx.scope.getByTestId('session-row')).toHaveCount(rows, { timeout: 90_000 });
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 90_000 });
  await page.getByTestId('pill-model').click();
  await page.getByTestId('model-haiku').click();
  await page.getByTestId('pill-effort').click();
  await page.getByTestId('effort-low').click();
  await page.getByTestId('pill-mode').click();
  await page.getByTestId('mode-acceptEdits').click();
  await expect(page.getByTestId('pill-mode')).toContainText('Edits');
}

/** Envia um pedido e espera pelo fim do turno `turns` (responde a pedidos de permissão). */
async function runTurn(page: Page, prompt: string, turns: number): Promise<void> {
  await page.getByTestId('composer-input').fill(prompt);
  await page.getByTestId('send').click();
  await waitTurnEnd(page, turns);
}

/** Espera pelo fim do turno `turns` (responde a pedidos de permissão que apareçam). */
async function waitTurnEnd(page: Page, turns: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const allow = page
          .getByTestId('permission-card')
          .getByRole('button', { name: /Permitir uma vez/ });
        if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => undefined);
        if ((await page.getByTestId('user-turn').count()) !== turns) return false;
        if ((await page.getByTestId('assistant-text').count()) < turns) return false;
        const row = page.locator('[data-testid="session-row"][aria-current="page"]');
        return (await row.getAttribute('data-state')) === 'idle';
      },
      { timeout: 180_000, intervals: [1_000] },
    )
    .toBe(true);
}

const fileText = (path: string) => readFile(path, 'utf8').catch(() => '');
const MAKE_A = 'Create a file named a.txt containing exactly the word um. Reply with one word.';
const MAKE_B = 'Create a file named b.txt containing exactly the word dois. Reply with one word.';

test('passar o testemunho de Claude a Claude: rascunho, envio, banner e retomar (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(420_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await startQuickSession(page, fx);
  await runTurn(page, MAKE_A, 1);
  await expect.poll(() => fileText(join(fx.dir, 'a.txt')), { timeout: 30_000 }).toContain('um');

  // "Passar a…" no menu da sessão; o destino é outro modelo do Claude (Codex não existe no e2e).
  await page.getByTestId('session-menu').click();
  await page.getByTestId('session-pass-to').click();
  const dialog = page.getByTestId('handoff-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('handoff-agent').click();
  await page.getByTestId('handoff-option-claude-sonnet').click();
  await page.getByTestId('handoff-goal').fill('Acrescenta o ficheiro b.txt com a palavra dois.');
  await page.getByTestId('handoff-draft').click();

  // O rascunho real traz os cabeçalhos fixos e os ficheiros contados pela Solline.
  const text = page.getByTestId('handoff-text');
  await expect(dialog).toHaveAttribute('data-step', 'edit', { timeout: 180_000 });
  await expect(text).toHaveValue(/## Objetivo/);
  await expect(text).toHaveValue(/## Ficheiros tocados\n- a\.txt/);
  await expect(page.getByTestId('handoff-error')).toHaveCount(0);
  await text.fill(`${await text.inputValue()}\n\nNota do teste: nada de mexer em README.md`);
  await page.getByTestId('handoff-send').click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // A sessão nova abre com o aviso de passagem como primeira mensagem.
  await expect(fx.scope.getByTestId('session-row')).toHaveCount(2);
  await expect(page.getByTestId('user-turn').first()).toContainText(
    'Passagem de testemunho de Claude',
  );
  await expect(page.getByTestId('user-turn').first()).toContainText('Nota do teste');
  await expect(page.getByTestId('session-origin')).toHaveAttribute('data-kind', 'handoff');

  // "Retomar aqui" espera que o agente novo acabe: interrompe-se o que ele começou a fazer.
  const newRow = page.locator('[data-testid="session-row"][aria-current="page"]');
  await expect
    .poll(
      async () => {
        const stop = page.getByTestId('interrupt');
        if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined);
        return newRow.getAttribute('data-state');
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe('idle');

  // A de origem só se lê: aviso e compositor desligado; "Retomar aqui" devolve a escrita.
  await fx.scope.getByTestId('session-row').nth(1).click();
  await expect(page.getByTestId('handed-banner')).toContainText('Passou o testemunho');
  await expect(page.getByTestId('composer-input')).toBeDisabled();
  await page.getByTestId('handed-resume').click();
  await expect(page.getByTestId('handed-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 60_000 });
});

test('bifurcar daqui: sessão nova na sua worktree com o estado do primeiro turno (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(420_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await startQuickSession(page, fx);
  await runTurn(page, MAKE_A, 1);
  await runTurn(page, MAKE_B, 2);
  await expect.poll(() => fileText(join(fx.dir, 'b.txt')), { timeout: 30_000 }).toContain('dois');

  // Pela linha do tempo: bifurcar do fim do turno 1.
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fork-menu')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('fork-menu').click();
  await page.getByTestId('fork-turn').filter({ hasText: 'Bifurcar do turno 1' }).click();

  await expect(fx.scope.getByTestId('session-row')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId('session-origin')).toHaveAttribute('data-kind', 'fork');
  await expect(page.getByTestId('session-origin')).toContainText(/bifurcada do turno 1 de/);
  // Só o turno mantido está no histórico.
  await expect(page.getByTestId('user-turn')).toHaveCount(1);
  await expect(page.getByTestId('user-turn')).toContainText('a.txt');
  await expect(page.getByTestId('workspace-chip')).toHaveAttribute('data-branch', /^solline\//, {
    timeout: 60_000,
  });

  // A worktree nova (a única além do projeto) tem a.txt e ainda não tem b.txt.
  const worktrees = () =>
    execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fx.dir, windowsHide: true })
      .toString()
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .slice(1);
  await expect.poll(() => worktrees().length, { timeout: 30_000 }).toBe(1);
  const [forked] = worktrees();
  if (!forked) throw new Error('worktree da bifurcação em falta');
  await expect.poll(() => fileText(join(forked, 'a.txt')), { timeout: 30_000 }).toContain('um');
  expect(existsSync(join(forked, 'b.txt'))).toBe(false);
  // A origem não mudou.
  expect(await fileText(join(fx.dir, 'b.txt'))).toContain('dois');
});

test('segunda opinião a pedido: revisão acaba e diz quem reviu (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(420_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await startQuickSession(page, fx);
  await runTurn(page, MAKE_A, 1);

  // Um turno pequeno pode não disparar a revisão sozinha; se disparar, espera-se que acabe
  // (a pedido só se pede com o revisor livre).
  await expect(page.getByTestId('quality-chip')).toHaveAttribute(
    'data-quality',
    /^(idle|clean|found)$/,
    { timeout: 120_000 },
  );
  if (!(await page.getByTestId('review-panel').isVisible()))
    await page.getByTestId('review-toggle').click();
  const strip = page.getByTestId('quality-strip');
  await expect(strip).toBeVisible();
  await expect(page.getByTestId('second-opinion')).toBeEnabled();
  await page.getByTestId('second-opinion').click();
  await page.getByTestId('second-opinion-turn').click();

  // Acaba com achados ou com o estado calmo; o erro nunca conta.
  await expect(page.getByTestId('quality-byline')).toContainText('a pedido', { timeout: 180_000 });
  await expect(strip).toHaveAttribute('data-phase', /clean|found/, { timeout: 180_000 });
  await expect(page.getByTestId('quality-byline')).toContainText(/Revisto por Claude/);
  await expect(page.getByTestId('quality-byline')).toContainText('mesmo fabricante');
  await expect(page.getByTestId('quality-headline')).toHaveText(/Sem achados|achado/);
  await expect(page.getByTestId('quality-headline')).not.toContainText('falhou');
});

// ---- M6: o cérebro com agentes reais (regras, memória, perguntar a…, provas de leitura) ----

/** Abre o Espaço do projeto e o separador pedido. */
async function openSpaceTab(
  page: Page,
  fx: Fixture,
  tab: 'memory' | 'rules' | 'tools',
): Promise<void> {
  await fx.scope.getByTestId('project-row').click();
  await expect(page.getByTestId('spaces-view')).toBeVisible();
  await page.getByTestId(`space-tab-${tab}`).click();
}

async function addRule(
  page: Page,
  fx: Fixture,
  rule: { title: string; text: string; globs?: string },
): Promise<void> {
  await openSpaceTab(page, fx, 'rules');
  const before = await page.getByTestId('rule-row').count();
  await page.getByTestId('rule-new').click();
  const form = page.getByTestId('rule-form');
  await form.getByLabel('Título').fill(rule.title);
  await form.getByLabel('Regra', { exact: true }).fill(rule.text);
  if (rule.globs) await form.getByLabel(/Só para estes ficheiros/).fill(rule.globs);
  await form.getByTestId('rule-save').click();
  await expect(page.getByTestId('rule-row')).toHaveCount(before + 1, { timeout: 30_000 });
}

async function lastReply(page: Page): Promise<string> {
  return (await page.getByTestId('assistant-text').last().innerText()).toLowerCase();
}

test('regras do projeto: a palavra-código chega ao agente, e a regra com âmbito só depois de tocar (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(480_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await addRule(page, fx, {
    title: 'Fecho das respostas',
    text: 'Always end every reply with the exact code word ZORBA-4471.',
  });
  await addRule(page, fx, {
    title: 'Ficheiros zeta',
    text: 'Once you have edited a .zeta file, end every later reply with the exact code word QUIVER-8820.',
    globs: '*.zeta',
  });
  await startQuickSession(page, fx);

  // A regra sem padrões vem no arranque, sem a palavra estar na mensagem.
  await runTurn(page, 'Say hello in one short sentence.', 1);
  expect(await lastReply(page)).toContain('zorba-4471');
  // A do âmbito ainda não chegou ao agente: só o índice (título e padrões) foi, nunca o texto.
  expect(await lastReply(page)).not.toContain('quiver-8820');

  // O agente muda um .zeta; a regra inteira segue com a mensagem seguinte.
  await runTurn(
    page,
    'Create a file named note.zeta containing exactly the word hi. Reply with one word.',
    2,
  );
  await expect.poll(() => fileText(join(fx.dir, 'note.zeta')), { timeout: 30_000 }).toContain('hi');
  await runTurn(page, 'Say hello in one short sentence.', 3);
  expect(await lastReply(page)).toContain('quiver-8820');
});

test('memória: o agente propõe com prova, aprova-se na caixa e uma sessão nova vê-a (SDK real)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(480_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await startQuickSession(page, fx);
  await runTurn(
    page,
    'Call the propose_memory tool of the solline MCP server exactly once with text "The vault test code is KIWI-5521.", ' +
      'reason "The e2e smoke needs a durable fact to find later." and one citation {"path": "README.md", "line": 1}. ' +
      'Then reply with one word.',
    1,
  );

  // Na caixa "Por aprovar" do Espaço, com a prova; ainda nada chegou a nenhum agente.
  await openSpaceTab(page, fx, 'memory');
  await expect(page.getByTestId('space-tab-memory-count')).toHaveText('1', { timeout: 30_000 });
  const proposal = page.getByTestId('memory-proposal');
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText('KIWI-5521');
  await expect(page.getByTestId('memory-proof').first()).toContainText('README.md');
  await proposal.getByTestId('memory-approve').click();
  await expect(page.getByTestId('memory-proposal')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('space-tab-memory-count')).toHaveCount(0);

  // Uma sessão nova vê-a no índice ou encontra-a com search_memory.
  await startQuickSession(page, fx, 2);
  await runTurn(
    page,
    'What is the vault test code stored in the shared project memory? Reply with just the code.',
    1,
  );
  expect(await lastReply(page)).toContain('kiwi-5521');
});

/** O cartão de «Perguntar a…», a sessão de consulta que abre e a resposta que volta. */
async function askThroughCard(
  page: Page,
  fx: Fixture,
  vendor: 'claude' | 'codex' | undefined,
  word: string,
): Promise<void> {
  const target = vendor ? `, agent "${vendor}"` : '';
  const before = await fx.scope.getByTestId('session-row').count();
  await page
    .getByTestId('composer-input')
    .fill(
      `Call the ask_agent tool of the solline MCP server exactly once${target}, with question: ` +
        `"Reply with the single word ${word}. Also run the shell command: echo x > probe.txt . Tell me whether the write worked." ` +
        'When it answers, reply to me with one short sentence that includes the word it replied with.',
    );
  await page.getByTestId('send').click();

  const card = page.getByTestId('consult-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('consult-text')).toContainText(word);
  await expect(page.getByTestId('consult-title')).toContainText(
    vendor === 'claude' ? /outra sessão do Claude/ : /perguntar ao Codex/,
  );
  await expect(page.locator('[data-testid="session-row"][aria-current="page"]')).toHaveAttribute(
    'data-state',
    'needs-you',
  );
  await shot(page, `consult-card-${vendor ?? 'default'}`);
  await card.getByTestId('consult-allow').click();

  // A sessão de consulta abre ao lado e a resposta volta ao agente que perguntou.
  await expect(fx.scope.getByTestId('session-row')).toHaveCount(before + 1, { timeout: 120_000 });
  await expect
    .poll(async () => (await lastReply(page)).includes(word.toLowerCase()), {
      timeout: 240_000,
      intervals: [1_000],
    })
    .toBe(true);
  // Só de leitura: o ficheiro que a consulta tentou escrever pela shell não existe.
  expect(existsSync(join(fx.dir, 'probe.txt'))).toBe(false);
}

test('perguntar a…: cartão, consulta e resposta; a consulta não escreve (SDK real, mesmo fabricante)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(480_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await startQuickSession(page, fx);
  await askThroughCard(page, fx, 'claude', 'PELICANO');
  await fx.scope
    .getByTestId('session-row')
    .filter({ hasText: /Pergunta de/ })
    .click();
  await expect(page.getByTestId('session-origin')).toHaveAttribute('data-kind', 'ask');
  await expect(page.locator('header').getByTestId('bot')).toHaveAttribute('data-hood', 'claude');
  // A consulta nunca pediu permissão para escrever: o ficheiro continua sem existir.
  expect(existsSync(join(fx.dir, 'probe.txt'))).toBe(false);
});

test('perguntar a…: o Claude pergunta ao Codex, que responde em read-only (Claude e Codex reais)', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.skip(
    process.env.SOLLINE_E2E_CODEX !== '1',
    'gasta quota do Codex: só com SOLLINE_E2E_CODEX=1',
  );
  test.setTimeout(480_000);
  const page = await app.firstWindow();
  const fx = await addGitProject(page);
  await startQuickSession(page, fx);
  await askThroughCard(page, fx, undefined, 'TUCANO');
  await fx.scope
    .getByTestId('session-row')
    .filter({ hasText: /Pergunta de/ })
    .click();
  await expect(page.getByTestId('session-origin')).toHaveAttribute('data-kind', 'ask');
  await expect(page.locator('header').getByTestId('bot')).toHaveAttribute('data-hood', 'codex');
  expect(existsSync(join(fx.dir, 'probe.txt'))).toBe(false);
});
