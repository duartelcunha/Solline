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
  const env = { ...process.env, SOLLINE_USER_DATA: userData, SOLLINE_ISOLATED: '1' } as Record<
    string,
    string
  >;
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
  await expect(page.getByTestId('ping-reply')).toContainText(/pong em \d+ ms/);
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
    return {
      cwd: await fail(
        api.request('session.create', { agent: 'claude', cwd: 'C:\\', mode: 'default' }),
      ),
      unknown: await fail(
        api.request('session.create', { projectId: 'nao-existe', agent: 'claude' }),
      ),
      internal: await fail(
        api.request('session.start', { projectId: 'x', agent: 'claude', cwd: 'C:\\' }),
      ),
    };
  });
  expect(errors.cwd).not.toBe('aceite');
  expect(errors.unknown).toContain('Projeto desconhecido');
  expect(errors.internal).toContain('Comando desconhecido');
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
    };
    return {
      https: g.open('https://example.com/') === null,
      http: g.open('http://example.com/') === null,
      creds: g.open('https://user:pw@example.com/') === null,
      geolocation: (await g.navigator.permissions.query({ name: 'geolocation' })).state,
    };
  });
  const opened = await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
  expect(result).toEqual({ https: true, http: true, creds: true, geolocation: 'denied' });
  expect(opened).toEqual(['https://example.com/']);
});

/**
 * Os diálogos nativos não se conduzem por Playwright: trocam-se no main. trust é o botão
 * do diálogo de confiança (0 = Confiar, 1 = Não confiar).
 */
async function stubDialogs(folder: string, trust: number): Promise<void> {
  await app.evaluate(
    ({ dialog }, { folder, trust }) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({
        response: trust,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    },
    { folder, trust },
  );
}

test('um projeto novo pergunta pela confiança e o escudo muda-a', async () => {
  const page = await app.firstWindow();
  await stubDialogs(project, 1);
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('project-row')).toHaveCount(1);
  const shield = page.getByTestId('project-trust');
  await expect(shield).toHaveAttribute('data-trusted', 'false');

  // Recusar a confirmação deixa como estava; aceitar liga a confiança.
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'false');
  await stubDialogs(project, 0);
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'true');
  // Tirar a confiança não pede nada.
  await stubDialogs(project, 1);
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'false');
  await stubDialogs(project, 0);
  await shield.click();
  await expect(shield).toHaveAttribute('data-trusted', 'true');
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
