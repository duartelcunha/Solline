import { test, expect, type Page, type TestInfo } from '@playwright/test';

/**
 * O Mapa das sessões ligadas, sem SDK, contra a ponte de QA.
 */
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const current: string[] = [];
  errors.set(page, current);
  page.on('pageerror', (error) => current.push(error.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') current.push(entry.text());
  });
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
});
test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() =>
    window.qa ? { failures: window.qa.failures, subscriptions: window.qa.subscriptions() } : null,
  );
  await info.attach('runtime', {
    body: JSON.stringify({ ...evidence, runtimeErrors: errors.get(page) }, null, 2),
    contentType: 'application/json',
  });
  expect(evidence?.failures).toEqual([]);
  expect(evidence?.subscriptions).toBe(1);
  expect(errors.get(page)).toEqual([]);
});

async function open(page: Page, scene = 'conversation') {
  await page.goto(`/?scene=${scene}`);
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
}
/** Capturas para rever o aspeto: só vão para a pasta de evidência quando a há. */
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await info.attach(name, {
    body: await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' }),
    contentType: 'image/png',
  });
}

test.describe('mapa', () => {
  test('sem ligações, um estado vazio calmo', async ({ page }) => {
    await open(page);
    await page.getByTestId('open-map').click();
    await expect(page.getByTestId('map-empty')).toContainText(
      'Ainda não há sessões ligadas entre si.',
    );
    await page.getByTestId('map-close').click();
    await expect(page.getByTestId('map-dialog')).toBeHidden();
  });

  test('desenha cadeia, centro, bifurcação, corrida e uma sessão sem origem', async ({
    page,
  }, info) => {
    await page.goto('/?scene=lineage');
    await page.getByTestId('open-map').click();
    await expect(page.getByTestId('map-dialog')).toBeVisible();
    await expect(page.getByTestId('map-node')).toHaveCount(8);
    // Passagens e bifurcação, com o rótulo do tipo.
    await expect(page.locator('[data-testid="map-edge"][data-kind="handoff"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="map-edge"][data-kind="fork"]')).toHaveCount(1);
    await expect(page.getByTestId('map-stub')).toHaveCount(1);
    await expect(page.getByTestId('map-cluster')).toHaveText('Corrida');
    await expect(page.getByTestId('map-loose')).toHaveText(
      'Mais 1 sessão sem ligações não aparece aqui.',
    );
    // O centro fica por cima dos filhos.
    const depth = (id: string) =>
      page.locator(`[data-testid="map-node"][data-session="${id}"]`).getAttribute('data-depth');
    expect(await depth('lin-plan')).toBe('0');
    expect(await depth('lin-fase1')).toBe('1');
    expect(await depth('lin-final')).toBe('2');
    // Passar o rato por uma passagem mostra o que foi passado.
    await page.locator('[data-testid="map-edge"][data-kind="handoff"]').first().hover();
    await expect(page.locator('[data-testid="map-edge-preview"]:visible')).toContainText(
      'Passagem de testemunho de Claude',
    );
    await page.clock.runFor(500);
    await capture(page, info, 'map');
    // Abrir uma sessão a partir do mapa.
    await page.locator('[data-testid="map-node"][data-session="lin-fase1"]').click();
    await expect(page.getByTestId('map-dialog')).toBeHidden();
    await expect(page.getByTestId('session-title')).toHaveText('Fase 1 no Codex');
    await expect(page.getByTestId('session-origin')).toContainText(/veio de\s*Plano da navegação/);
  });

  test('uma bifurcação diz de que turno partiu', async ({ page }) => {
    await page.goto('/?scene=lineage');
    await page.getByTestId('open-map').click();
    await page.locator('[data-testid="map-node"][data-session="lin-alt"]').click();
    await expect(page.getByTestId('session-origin')).toContainText(
      /bifurcada do turno 1 de\s*Plano da navegação/,
    );
  });

  test('uma passagem aparece com o aviso na sessão de origem', async ({ page }) => {
    await page.goto('/?scene=handed-off');
    await page.getByRole('button', { name: /^Plano da navegação, parada$/ }).click();
    await expect(page.getByTestId('handed-banner')).toContainText(
      'Passou o testemunho a Executar a fase 1',
    );
    await expect(page.getByTestId('composer-input')).toBeDisabled();
  });
});
