import { test, expect, type Page, type TestInfo } from '@playwright/test';

/**
 * M5 na interface, sem SDK: segunda opinião (achados, revisor, corrigir e dispensar), passar a…,
 * bifurcar daqui, o aviso de trazer e o Mapa, tudo contra a ponte de QA.
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
async function commands(page: Page, name: string) {
  return page.evaluate(
    (name) =>
      window.qa.journal
        .filter((entry) => entry.kind === 'command' && entry.name === name)
        .map((entry) => entry.data),
    name,
  );
}
/** Capturas para rever o aspeto: só vão para a pasta de evidência quando a há. */
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await info.attach(name, {
    body: await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' }),
    contentType: 'image/png',
  });
}

test.describe('achados', () => {
  test('revisor de outro fabricante, achados à vista e os menos certos dobrados', async ({
    page,
  }, info) => {
    await open(page, 'quality-folded');
    await page.getByTestId('review-toggle').click();
    const strip = page.getByTestId('quality-strip');
    await expect(strip.getByTestId('quality-headline')).toHaveText(/3 achados/);
    await expect(strip.getByTestId('quality-byline')).toContainText('Revisto por Codex · gpt-5.5');
    await expect(strip.getByTestId('quality-byline')).toContainText('depois do turno');
    await expect(strip.getByTestId('quality-byline')).not.toContainText('mesmo fabricante');
    await expect(page.getByTestId('quality-stats')).toHaveText('· 3 corrigidos · 1 dispensado');

    // À vista: os 3 certos, cada um com prioridade e confiança em letra calada.
    await expect(page.getByTestId('finding')).toHaveCount(3);
    const first = page.getByTestId('finding-meta').filter({ hasText: 'P0' });
    await expect(first).toHaveCount(1);
    await expect(first).toContainText('92 %');
    // Os 3 que o revisor tem por menos certos ficam dobrados.
    const fold = page.getByTestId('findings-fold-toggle');
    await expect(fold).toHaveText('3 achados menos certos');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await capture(page, info, 'findings-folded');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('finding')).toHaveCount(6);
    await capture(page, info, 'findings-unfolded');
  });

  test('dispensar tira o achado e conta; corrigir todos leva só os que estão à vista', async ({
    page,
  }) => {
    await open(page, 'quality-folded');
    await page.getByTestId('review-toggle').click();
    await page.getByRole('button', { name: /Dispensar: .*Escape fecha duas camadas/ }).click();
    await expect(page.getByTestId('finding')).toHaveCount(2);
    await expect(page.getByTestId('quality-stats')).toHaveText('· 3 corrigidos · 2 dispensados');
    expect(await commands(page, 'quality.dismiss')).toEqual([
      { sessionId: 'session-1', ids: ['finding-3'] },
    ]);
    await expect(page.getByTestId('fix-shown')).toContainText('Corrigir todos');
    await page.getByTestId('fix-shown').click();
    expect(await commands(page, 'quality.fix')).toEqual([
      { sessionId: 'session-1', ids: ['finding-1', 'finding-2'] },
    ]);
  });

  test('corrigir um achado manda só esse', async ({ page }) => {
    await open(page, 'quality-folded');
    await page.getByTestId('review-toggle').click();
    await page.getByRole('button', { name: 'Corrigir: Validar a lista vazia' }).click();
    expect(await commands(page, 'quality.fix')).toEqual([
      { sessionId: 'session-1', ids: ['finding-2'] },
    ]);
  });

  test('sem achados é um bom resultado, com o revisor e o aviso de mesmo fabricante', async ({
    page,
  }, info) => {
    await open(page, 'quality-clean');
    await page.getByTestId('review-toggle').click();
    const strip = page.getByTestId('quality-strip');
    await expect(strip.getByTestId('quality-headline')).toHaveText('Sem achados');
    await expect(strip).toHaveAttribute('data-phase', 'clean');
    await expect(strip.getByTestId('quality-byline')).toContainText('Revisto por Claude · sonnet');
    await expect(strip.getByTestId('quality-byline')).toContainText('mesmo fabricante');
    await capture(page, info, 'findings-clean');
  });

  test('um erro do revisor lê-se como erro, nunca como limpo', async ({ page }, info) => {
    await open(page, 'quality-error');
    await page.getByTestId('review-toggle').click();
    const strip = page.getByTestId('quality-strip');
    await expect(strip).toHaveAttribute('data-phase', 'error');
    await expect(strip.getByTestId('quality-headline')).toHaveText(
      'A revisão falhou: O revisor perdeu a ligação.',
    );
    await expect(strip.getByTestId('quality-headline')).toHaveClass(/text-danger/);
    await capture(page, info, 'findings-error');
    await page.getByTestId('quality-retry').click();
    await expect(strip).toHaveAttribute('data-phase', 'clean');
  });

  test('segunda opinião: escolhe o âmbito, mostra progresso e fica desligada enquanto revê', async ({
    page,
  }) => {
    await open(page, 'quality-clean');
    await page.getByTestId('review-toggle').click();
    const button = page.getByTestId('second-opinion');
    await expect(button).toBeEnabled();
    await button.click();
    await page.getByTestId('second-opinion-session').click();
    expect(await commands(page, 'quality.review')).toEqual([
      { sessionId: 'session-1', trigger: 'manual', scope: 'session' },
    ]);
    await expect(page.getByTestId('quality-headline')).toHaveText('A rever…');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Já há uma revisão a decorrer');
    await page.clock.runFor(400);
    await expect(page.getByTestId('quality-headline')).toHaveText('Sem achados');
    await expect(button).toBeEnabled();
    // O relógio de teste está parado: deixa o Radix acabar a saída do menu antes do seguinte.
    await page.waitForTimeout(300);
    await page.clock.runFor(100);
    await button.click();
    await page.getByTestId('second-opinion-turn').click();
    expect((await commands(page, 'quality.review')).at(-1)).toEqual({
      sessionId: 'session-1',
      trigger: 'manual',
      scope: 'turn',
    });
  });

  test('a segunda opinião também está no chip do cabeçalho', async ({ page }) => {
    await open(page, 'quality-clean');
    await page.getByTestId('quality-chip').click();
    await page.getByTestId('second-opinion-turn').click();
    expect(await commands(page, 'quality.review')).toEqual([
      { sessionId: 'session-1', trigger: 'manual', scope: 'turn' },
    ]);
  });
});

test.describe('trazer', () => {
  test('pede a revisão antes de trazer e mostra o resultado sem bloquear', async ({
    page,
  }, info) => {
    await open(page, 'worktree-queue');
    await page.getByTestId('workspace-chip').click();
    await page.getByTestId('workspace-bring').click();
    const dialog = page.getByTestId('bring-dialog');
    await expect(dialog).toBeVisible();
    expect(await commands(page, 'quality.review')).toEqual([
      { sessionId: 'session-1', trigger: 'bring', scope: 'session' },
    ]);
    // A rever, e mesmo assim trazer está à mão.
    await expect(page.getByTestId('bring-review')).toHaveAttribute('data-phase', 'running');
    await expect(page.getByTestId('bring-confirm')).toBeEnabled();
    await page.clock.runFor(400);
    await expect(page.getByTestId('bring-review')).toHaveAttribute('data-phase', 'clean');
    await capture(page, info, 'bring-review');
    await page.getByTestId('bring-confirm').click();
    await expect(dialog).toBeHidden();
    expect(await commands(page, 'session.bring')).toEqual([{ sessionId: 'session-1' }]);
  });
});

test.describe('passar a…', () => {
  test('objetivo, rascunho editável, enviar, e a origem fica só de leitura com retomar', async ({
    page,
  }, info) => {
    await open(page);
    await page.getByTestId('session-menu').click();
    await page.getByTestId('session-pass-to').click();
    const dialog = page.getByTestId('handoff-dialog');
    await expect(dialog).toHaveAttribute('data-step', 'form');
    await expect(page.getByTestId('handoff-draft')).toBeDisabled();
    await page.getByTestId('handoff-goal').fill('executa a fase 1 do plano');
    await page.getByTestId('handoff-draft').click();
    await expect(dialog).toHaveAttribute('data-step', 'edit');
    await expect(page.getByTestId('handoff-note')).toContainText('QA: rascunho mecânico.');
    const text = page.getByTestId('handoff-text');
    await expect(text).toHaveValue(/## Objetivo\nexecuta a fase 1 do plano/);
    await text.fill('## Objetivo\nexecuta a fase 1 do plano\n\nSó a navegação.');
    await capture(page, info, 'handoff-draft');
    await page.getByTestId('handoff-send').click();

    // A sessão nova abre, com a origem à vista.
    await expect(page.getByTestId('session-title')).toHaveText('Continuação');
    await expect(page.getByTestId('session-origin')).toContainText('veio de');
    await expect(page.getByTestId('session-origin')).toContainText('Melhora a navegação');
    expect(await commands(page, 'handoff.start')).toEqual([
      {
        sessionId: 'session-1',
        agent: 'claude',
        model: 'opus',
        text: '## Objetivo\nexecuta a fase 1 do plano\n\nSó a navegação.',
      },
    ]);

    // Na origem: aviso calmo, compositor desligado com o motivo, e retomar aqui.
    await page.getByTestId('session-origin-open').click();
    await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
    const banner = page.getByTestId('handed-banner');
    await expect(banner).toContainText('Passou o testemunho a Continuação');
    await expect(page.getByTestId('composer-input')).toBeDisabled();
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      /Passou o testemunho a Continuação.*Retomar aqui/,
    );
    await expect(page.getByTestId('session-pass-to')).toHaveCount(0);
    await capture(page, info, 'handoff-banner');
    await page.getByTestId('handed-open').click();
    await expect(page.getByTestId('session-title')).toHaveText('Continuação');
    await page.getByTestId('session-origin-open').click();
    await page.getByTestId('handed-resume').click();
    await expect(page.getByTestId('handed-banner')).toBeHidden();
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    expect(await commands(page, 'handoff.resume')).toEqual([{ sessionId: 'session-1' }]);
  });

  test('cancelar o rascunho a meio volta ao formulário, e Esc fecha sem passar nada', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('session-menu').click();
    await page.getByTestId('session-pass-to').click();
    await page.evaluate(() => window.qa.hold('handoff.draft'));
    await page.getByTestId('handoff-goal').fill('executa a fase 1 do plano');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('handoff-progress')).toBeVisible();
    await page.getByTestId('handoff-cancel-draft').click();
    expect(await commands(page, 'handoff.cancelDraft')).toEqual([{ sessionId: 'session-1' }]);
    await expect(page.getByTestId('handoff-dialog')).toHaveAttribute('data-step', 'form');
    await expect(page.getByTestId('handoff-goal')).toHaveValue('executa a fase 1 do plano');
    await expect(page.getByTestId('action-error')).toHaveCount(0);
    // Um rascunho que chega depois de cancelar não muda nada.
    await page.evaluate(() => window.qa.release('handoff.draft'));
    await expect(page.getByTestId('handoff-dialog')).toHaveAttribute('data-step', 'form');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('handoff-dialog')).toBeHidden();
    expect(await commands(page, 'handoff.start')).toEqual([]);
  });

  test('o painel de rever também passa o testemunho', async ({ page }) => {
    await open(page);
    await page.getByTestId('review-toggle').click();
    await page.getByTestId('pass-to-icon').click();
    await expect(page.getByTestId('handoff-dialog')).toBeVisible();
  });
});

test.describe('bifurcar daqui', () => {
  test('abre a sessão bifurcada, com a origem à vista', async ({ page }) => {
    await open(page);
    await page.getByTestId('fork-menu').click();
    await page.getByTestId('fork-turn').click();
    await expect(page.getByTestId('session-title')).toContainText('(bifurcação)');
    await expect(page.getByTestId('session-origin')).toContainText('bifurcada');
    await expect(page.getByTestId('session-origin')).toHaveAttribute('data-kind', 'fork');
    expect(await commands(page, 'session.fork')).toEqual([
      { sessionId: 'session-1', turnId: 'user-1' },
    ]);
    await page.getByTestId('session-origin-open').click();
    await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
  });

  test('desligado com o motivo enquanto o agente trabalha', async ({ page }) => {
    await open(page, 'queue');
    await expect(page.getByTestId('fork-menu')).toBeDisabled();
    await expect(page.getByTestId('fork-menu')).toHaveAttribute(
      'title',
      'O agente ainda está a trabalhar',
    );
  });
});
