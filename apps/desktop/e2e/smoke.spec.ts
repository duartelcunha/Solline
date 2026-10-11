import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

/**
 * Abre a app e prova a ida e volta interface -> main -> motor.
 * Por omissão usa o build em out/; com SOLLINE_EXE corre a app instalada.
 * Com SOLLINE_E2E_SDK=1 também carrega em "Testar motor" (chama Haiku a sério).
 */
const exe = process.env.SOLLINE_EXE;

let app: ElectronApplication;

test.beforeAll(async () => {
  app = exe
    ? await electron.launch({ executablePath: exe })
    : await electron.launch({ args: [join(__dirname, '..', 'out', 'main', 'index.js')] });
});

test.afterAll(async () => {
  await app?.close();
});

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
    api: ['engine', 'window'],
  });
});

test('Testar motor devolve modelo, credencial, resposta e custo', async () => {
  test.skip(process.env.SOLLINE_E2E_SDK !== '1', 'chamada real ao SDK só com SOLLINE_E2E_SDK=1');
  test.setTimeout(180_000);
  const page = await app.firstWindow();
  await page.getByTestId('sdk-check').click();
  const result = page.getByTestId('sdk-check-result').or(page.getByTestId('sdk-check-error'));
  await expect(result).toBeVisible({ timeout: 170_000 });
  const text = await result.innerText();
  console.info(`[sdkCheck ${exe ? 'instalada' : 'build'}]\n${text}`);
  await expect(page.getByTestId('sdk-check-result')).toContainText(/Modelo\s*claude-haiku/i);
  await expect(page.getByTestId('sdk-check-result')).toContainText(/Resposta\s*ok\.?\s*Custo/i);
});
