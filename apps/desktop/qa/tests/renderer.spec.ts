import { test, expect, type Page } from '@playwright/test';
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(m.text());
  });
});

async function open(page: Page, scene = 'conversation') {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
  await page.goto(`/?scene=${scene}`);
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-title')).toContainText(
    'Melhora a navegação entre sessões',
  );
}

test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => {
    const qa = window.qa;
    return qa
      ? {
          journal: qa.journal,
          failures: qa.failures,
          subscriptions: qa.subscriptions(),
          focusSubscriptions: qa.focusSubscriptions(),
        }
      : null;
  });
  await info.attach('protocol-journal', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  if (evidence) {
    expect(evidence.failures).toEqual([]);
    expect(evidence.subscriptions).toBe(1);
    expect(evidence.focusSubscriptions).toBe(1);
  }
  expect(errors.get(page)).toEqual([]);
});

test('rascunhos sobrevivem à navegação e ao cancelamento do fecho', async ({ page }) => {
  await open(page);
  await page.getByTestId('composer-input').fill('Ainda não enviar.');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await page.getByTestId('session-row').last().click();
  await expect(page.getByTestId('composer-input')).toHaveValue('Ainda não enviar.');
  await page.getByTestId('session-close').last().click();
  await expect(page.getByRole('dialog')).toContainText('mensagem por enviar');
  await page.getByRole('button', { name: 'Manter aberta' }).click();
  await expect(page.getByTestId('composer-input')).toHaveValue('Ainda não enviar.');
  await expect(page.getByTestId('session-row')).toHaveCount(2);
});

test('falha tardia preserva também o texto escrito entretanto', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.qa.hold('session.send');
    window.qa.fail('session.send');
  });
  await page.getByTestId('composer-input').fill('Primeira mensagem.');
  await page.getByTestId('composer-input').press('Enter');
  await page.getByTestId('session-close').click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('app-notice')).toContainText('ainda está a ser enviada');
  await page.getByTestId('composer-input').fill('Segunda mensagem.');
  await page.evaluate(() => window.qa.release('session.send'));
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'Primeira mensagem.\nSegunda mensagem.',
  );
});

test('ícones conservam identidade e ajuda ao teclado sem animar a escolha do modo', async ({
  page,
}) => {
  await open(page, 'review');
  await page.getByTestId('review-toggle').click();
  const quality = page.getByTestId('quality-chip');
  await expect(quality).toHaveAccessibleName('Revisor sem achados');
  await expect(quality.locator('.lucide-badge-check')).toBeVisible();
  const effort = page.getByTestId('pill-effort');
  await effort.focus();
  await expect(page.getByTestId('effort-help')).toHaveText('Esforço: high');
  await expect(page.getByTestId('effort-help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('effort-help')).toBeHidden();
  await expect(effort).toBeFocused();
  const mode = page.getByTestId('pill-mode');
  await mode.focus();
  await page.keyboard.press('Enter');
  const plan = page.getByTestId('mode-plan');
  await expect(plan).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  await plan.focus();
  await page.keyboard.press('Enter');
  await expect(mode).toHaveAccessibleName('Modo: Planear. Mudar');
  await expect(mode.locator('.sl-swap-out')).toHaveCount(0);
  await expect(mode.locator('.sl-swap-in')).toHaveCount(0);
});

test('marcas de estado mantêm formas distintas sem cor nem movimento', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await open(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const sidebar = page.getByTestId('session-row').getByTestId('session-mark');
  const header = page.locator('.session-state-chip').getByTestId('session-mark');
  const shapes = new Map<string, string>();
  const record = async (mood: string) => {
    await expect(sidebar).toHaveAttribute('data-mood', mood);
    await expect(header).toHaveAttribute('data-mood', mood);
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    await expect(sidebar).toHaveCSS('opacity', '1');
    const shape = await sidebar.innerHTML();
    expect(await header.innerHTML()).toBe(shape);
    expect(await sidebar.evaluate((element) => element.getAnimations().length)).toBe(0);
    shapes.set(mood, shape);
  };
  const state = async (value: 'running' | 'needs-you' | 'error' | 'idle') => {
    await page.evaluate(
      (state) =>
        window.qa.emit({
          kind: 'event',
          type: 'session.state',
          sessionId: 'session-1',
          state,
        }),
      value,
    );
  };
  await record('waiting');
  await state('running');
  await record('working');
  await state('needs-you');
  await record('needs-you');
  await state('error');
  await record('crashed');
  await state('running');
  await state('idle');
  await record('done');
  await page.clock.fastForward(600_001);
  await record('sleeping');
  expect(new Set(shapes.values()).size).toBe(6);
});

test('modelo, esforço e modo respeitam as capacidades e o protocolo', async ({ page }) => {
  await open(page);
  for (const [control, option, label] of [
    ['model', 'opus', 'Opus'],
    ['effort', 'low', 'low'],
    ['mode', 'plan', 'Planear'],
  ] as const) {
    await page.getByTestId(`pill-${control}`).click();
    await page.getByTestId(`${control}-${option}`).click();
    await expect(page.getByTestId(`pill-${control}`)).toHaveAccessibleName(new RegExp(label));
  }
  expect(
    await page.evaluate(() =>
      window.qa.journal.filter((e) => /session.set/.test(e.name)).map((e) => e.data),
    ),
  ).toEqual([
    { sessionId: 'session-1', model: 'opus' },
    { sessionId: 'session-1', effort: 'low' },
    { sessionId: 'session-1', mode: 'plan' },
  ]);
});

test('login pode ser cancelado sem declarar o agente pronto', async ({ page }) => {
  await open(page);
  await page.getByTestId('sidebar-agents').click();
  await page.getByTestId('login-codex').click();
  await expect(page.getByTestId('login-cancel-codex')).toBeVisible();
  await page.getByTestId('login-cancel-codex').click();
  await expect(page.getByTestId('login-codex')).toBeVisible();
  await expect(page.getByTestId('agents-readiness')).toContainText('1 de 3');
});

test('rever, desfazer e manter outra sessão independente', async ({ page }) => {
  await open(page, 'review');
  await page.getByTestId('review-toggle').click();
  await expect(page.getByTestId('diff-hunk')).toBeVisible();
  await page.getByTestId('accept-all').click();
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await page.getByTestId('review-undo').click();
  await expect(page.getByTestId('diff-hunk')).toBeVisible();
  await page.getByTestId('accept-all').click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('diff-hunk')).toBeVisible();
  await page.getByTestId('session-row').last().click();
  await expect(page.getByTestId('review-empty')).toBeVisible();
});

test('marcadores do diff permanecem visíveis durante comentários', async ({ page }) => {
  await open(page, 'review');
  await page.getByTestId('review-toggle').click();
  for (const [kind, sign] of [
    ['add', '+'],
    ['del', '−'],
  ] as const) {
    const row = page.getByTestId('diff-hunk').locator(`[data-kind="${kind}"]`).first();
    const marker = row.locator('.diff-direction');
    const assertMarker = async () => {
      await expect(marker).toHaveText(sign);
      await expect(marker).toBeVisible();
      await expect(marker).toHaveCSS('opacity', '1');
      // Direction and comment action must occupy different columns, without overlay.
      const boxes = await row.evaluate((element) => {
        const marker = element.querySelector('.diff-direction')?.getBoundingClientRect();
        const action = element
          .querySelector('[data-testid="comment-line"]')
          ?.getBoundingClientRect();
        if (!marker || !action) throw new Error('Missing diff marker or action');
        return { markerRight: marker.right, actionLeft: action.left };
      });
      expect(boxes.markerRight).toBeLessThanOrEqual(boxes.actionLeft);
    };
    await assertMarker();
    await row.hover();
    await assertMarker();
    const comment = row.getByTestId('comment-line');
    await comment.focus();
    await assertMarker();
    await comment.press('Enter');
    await expect(page.getByTestId('comment-input')).toBeVisible();
    await assertMarker();
    await page.getByTestId('comment-input').press('Escape');
    await expect(page.getByTestId('review-panel')).toBeVisible();
  }
});

test('revisão estreita mantém foco e saída por Escape', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 520 });
  await open(page, 'review');
  const trigger = page.getByTestId('review-toggle');
  await trigger.click();
  await expect(page.getByTestId('review-panel')).toBeFocused();
  await expect(page.getByTestId('composer-input')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('review-panel')).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('fila: ordenar por teclado, editar, interromper e continuar', async ({ page }) => {
  await open(page, 'queue');
  await expect(page.getByTestId('queued')).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Mudar a ordem (arrastar ou setas)' })
    .last()
    .press('ArrowUp');
  await expect(page.getByTestId('queued').first()).toContainText('E confirma o teclado.');
  await page.getByTestId('queued-edit').first().click();
  await expect(page.getByTestId('composer-input')).toHaveValue('E confirma o teclado.');
  await expect(page.getByTestId('queued')).toHaveCount(1);
  await page.getByTestId('composer-input').fill('');
  await page.getByTestId('interrupt').click();
  await expect(page.getByTestId('queue-resume')).toBeVisible();
  await page.getByTestId('queue-resume').click();
  await expect(page.getByTestId('interrupt')).toBeVisible();
});

test('fechar uma fila exige escolha explícita', async ({ page }) => {
  await open(page, 'queue');
  await page.getByTestId('session-close').click();
  await expect(page.getByTestId('close-queue-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Manter aberta' }).click();
  await expect(page.getByTestId('queued')).toHaveCount(2);
  await page.getByTestId('session-close').click();
  await page.getByTestId('close-drop-queue').click();
  await expect(page.getByTestId('session-row')).toHaveCount(0);
});

test('planos e perguntas respondem com os valores escolhidos', async ({ page }) => {
  await open(page, 'question');
  await page.getByRole('radio', { name: /Por projeto/ }).click();
  await page.getByRole('button', { name: 'Responder', exact: true }).click();
  await expect(page.getByTestId('ask-resolved')).toBeVisible();
  expect(
    await page.evaluate(() => window.qa.journal.find((e) => e.name === 'permission.answer')?.data),
  ).toEqual({
    sessionId: 'session-1',
    requestId: 'ask-1',
    answer: { decision: 'answer', answers: { 'Como queres organizar as sessões?': 'Por projeto' } },
  });
});

test('tema persiste e falha do motor mantém a conversa legível', async ({ page }) => {
  await open(page);
  await page.getByTestId('theme-toggle').click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.reload();
  if (!theme) throw new Error('Theme missing');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.getByTestId('new-session').click();
  await page.evaluate(() =>
    window.qa.emit({
      kind: 'event',
      type: 'engine.error',
      message: 'O motor parou. Fecha e volta a abrir a Solline.',
    }),
  );
  await expect(page.getByTestId('composer-input')).toBeDisabled();
  await expect(page.getByTestId('assistant-text')).toBeVisible();
});

test('a sessão reproduz eventos anteriores à resposta e mantém a informação', async ({
  page,
}, info) => {
  await open(page);
  await expect(
    page.getByText('A navegação já mantém o contexto entre sessões.', { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await info.attach('session', {
    body: await page.screenshot({ path: info.outputPath('session.png'), animations: 'disabled' }),
    contentType: 'image/png',
  });
});

test('a decisão de negar chega ao protocolo e resolve o pedido', async ({ page }) => {
  await open(page, 'permission');
  await page.getByRole('button', { name: /^Negar/ }).click();
  await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'denied');
  const decisions = await page.evaluate(() =>
    (window as unknown as { qa: { journal: { name: string; data: unknown }[] } }).qa.journal
      .filter((e) => e.name === 'permission.answer')
      .map((e) => e.data),
  );
  expect(decisions).toEqual([
    { sessionId: 'session-1', requestId: 'ask-1', answer: { decision: 'deny' } },
  ]);
});

test('falha de envio preserva o texto', async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    (window as unknown as { qa: { fail(c: string): void } }).qa.fail('session.send'),
  );
  const input = page.locator('textarea').first();
  await input.fill('Não perder esta mensagem.');
  await input.press('Enter');
  await expect(input).toHaveValue('Não perder esta mensagem.');
  await expect(page.getByText('Falha simulada: tenta de novo.')).toBeVisible();
});

test('o diálogo devolve o foco ao fechar por Escape', async ({ page }) => {
  await open(page);
  const trigger = page.getByTestId('sidebar-agents');
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('agente indisponível e seleção MCP respeitam o comando de criação', async ({ page }) => {
  await page.goto('/?scene=conversation');
  await page.getByTestId('new-session-agent').click();
  await expect(page.getByTestId('agent-opencode')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('mcp-docs').click();
  await expect(page.getByTestId('mcp-docs')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('agent-claude').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  expect(
    await page.evaluate(
      () => window.qa.journal.find((entry) => entry.name === 'session.create')?.data,
    ),
  ).toEqual({ projectId: 'atelier', agent: 'claude', mcpServerIds: ['docs'] });
});

test('controlos de qualidade recuperam erro e mantêm preferências por sessão', async ({ page }) => {
  await open(page);
  await page.getByTestId('quality-chip').click();
  await page.getByTestId('quality-toggle').click();
  await expect(page.getByTestId('quality-chip')).toHaveAttribute('data-quality', 'off');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('quality-chip')).toHaveAttribute('data-quality', 'clean');
  await page.evaluate(() =>
    window.qa.emit({
      kind: 'event',
      type: 'session.checks',
      sessionId: 'session-2',
      checks: {
        trusted: true,
        detected: true,
        specs: [{ id: 'types', label: 'Tipos', command: 'pnpm typecheck', enabled: true }],
        turnId: 'user-1',
        results: [{ id: 'types', state: 'failed', tail: 'Erro fixo de cenário', durationMs: 100 }],
      },
    }),
  );
  await page.getByTestId('checks-chip').click();
  await expect(page.getByTestId('check-tail')).toContainText('Erro fixo de cenário');
  await page.getByTestId('check-again').click();
  await expect(page.getByTestId('checks-chip')).toHaveAttribute('data-state-check', 'passed');
  expect(
    await page.evaluate(() =>
      window.qa.journal.filter((entry) => entry.name === 'checks.run').map((entry) => entry.data),
    ),
  ).toEqual([{ sessionId: 'session-2' }]);
});
