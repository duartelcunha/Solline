import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
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

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'solline-e2e-data-'));
  project = await mkdtemp(join(tmpdir(), 'solline-e2e-proj-'));
  await writeFile(join(project, 'notes.txt'), 'The quick alpha fox.\n');
  const env = {
    ...process.env,
    SOLLINE_USER_DATA: userData,
    SOLLINE_ISOLATED: '1',
    // Com o SDK real, o revisor também corre (lê o turno e deixa achados).
    ...(process.env.SOLLINE_E2E_SDK === '1' ? { SOLLINE_REVIEWER: '1' } : {}),
  } as Record<string, string>;
  app = exe
    ? await electron.launch({ executablePath: exe, env })
    : await electron.launch({ args: [join(__dirname, '..', 'out', 'main', 'index.js')], env });
});

test.afterAll(async () => {
  await app?.close();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  await rm(project, { recursive: true, force: true }).catch(() => undefined);
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
  // Sem projetos, o familiar recebe-te ao portátil.
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
    api: ['onEvent', 'request', 'window'],
  });
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

/**
 * Os diálogos nativos não se conduzem por Playwright: trocam-se no main. trust é o botão
 * do diálogo de confiança (0 = Confiar, 1 = Não confiar).
 */
async function stubDialogs(folder: string, trust: number): Promise<void> {
  await app.evaluate(
    ({ dialog }, { folder, trust }) => {
      const g = globalThis as { trustDialogs?: number };
      g.trustDialogs ??= 0;
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => {
        g.trustDialogs = (g.trustDialogs ?? 0) + 1;
        return { response: trust, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    },
    { folder, trust },
  );
}

/** Quantas vezes o main mostrou o diálogo de confiança. */
function trustDialogs(): Promise<number> {
  return app.evaluate(() => (globalThis as { trustDialogs?: number }).trustDialogs ?? 0);
}

test('um projeto novo pergunta pela confiança e o escudo muda-a', async () => {
  const page = await app.firstWindow();
  await stubDialogs(project, 1);
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
  await stubDialogs(project, 0);
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

test('o painel de agentes mostra o estado e guarda as variáveis só depois de confirmares', async () => {
  const page = await app.firstWindow();
  await page.getByTestId('sidebar-agents').click();
  const panel = page.getByTestId('agents-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('panel-agent-codex')).toContainText('Codex');
  await expect(page.getByTestId('panel-agent-opencode')).toContainText('Não instalado');
  await page.getByTestId('agents-refresh').click();
  await expect(page.getByTestId('agents-refresh')).toBeEnabled({ timeout: 45_000 });

  // O diálogo nativo de confirmação troca-se no main: primeiro recusas, depois aceitas.
  const answer = (response: number) =>
    app.evaluate(({ dialog }, response) => {
      const g = globalThis as { keyDialogs?: string[] };
      g.keyDialogs ??= [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string };
        g.keyDialogs!.push(options.detail ?? '');
        return { response, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, response);
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
  const dialogs = await app.evaluate(
    () => (globalThis as { keyDialogs?: string[] }).keyDialogs ?? [],
  );
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
  await stubDialogs(project, 0);
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('project-row')).toHaveCount(1);

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByTestId('session-row')).toHaveAttribute('data-state', 'idle');
  // A sessão do Claude tem o bot cor de barro, à espera.
  const bot = page.getByTestId('session-row').getByTestId('bot');
  await expect(bot).toHaveAttribute('data-hood', 'claude');
  await expect(bot).toHaveAttribute('data-mood', 'waiting');

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
  await expect(page.getByTestId('context-meter')).toBeVisible({ timeout: 15_000 });
  // A segunda opinião lê o turno que mudou o notes.txt e acaba limpa ou com achados.
  await expect(page.getByTestId('quality-chip')).toHaveAttribute('data-quality', /clean|found/, {
    timeout: 120_000,
  });
  await shot(page, 'quality-chip');
  expect(await readFile(join(project, 'notes.txt'), 'utf8')).toContain('beta');
  console.info(
    `[sessão ${exe ? 'instalada' : 'build'}] custo ${await page.getByTestId('session-cost').innerText()}`,
  );
  await shot(page, 'conversation-light');

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
