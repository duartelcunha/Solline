import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { longModelLabel, longModeLabel, longToolOutput, permission } from '../fixtures';

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
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await info.attach(name, {
    body: await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' }),
    contentType: 'image/png',
  });
}
test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() =>
    window.qa
      ? {
          journal: window.qa.journal,
          failures: window.qa.failures,
          subscriptions: window.qa.subscriptions(),
          focusSubscriptions: window.qa.focusSubscriptions(),
        }
      : null,
  );
  await info.attach('protocol-journal', {
    body: JSON.stringify({ ...evidence, runtimeErrors: errors.get(page) }, null, 2),
    contentType: 'application/json',
  });
  expect(evidence).not.toBeNull();
  expect(evidence?.failures).toEqual([]);
  expect(evidence?.subscriptions).toBe(1);
  expect(evidence?.focusSubscriptions).toBe(1);
  expect(errors.get(page)).toEqual([]);
});

test('confiança: um agente pronto mas incompatível fica bloqueado até confiar', async ({
  page,
}, info) => {
  await page.goto('/?scene=untrusted');
  const trust = page.getByTestId('project-trust');
  await expect(trust).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('new-session-agent').click();
  await expect(page.getByTestId('agent-codex')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('agent-codex')).toContainText('Só corre em projetos de confiança');
  await capture(page, info, 'agents-trust-menu');
  await page.keyboard.press('Escape');
  await trust.click();
  await expect(trust).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('new-session-agent').click();
  await expect(page.getByTestId('agent-codex')).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('agent-codex').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  expect(await commands(page, 'projects.setTrusted')).toEqual([
    { projectId: 'atelier', trusted: true },
  ]);
  expect(await commands(page, 'session.create')).toEqual([
    { projectId: 'atelier', agent: 'codex' },
  ]);
  await trust.click();
  await expect(trust).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('assistant-text')).toBeVisible();
});

test('capacidades: sem esforço nem orientação, Ctrl+Enter mantém a mensagem na fila', async ({
  page,
}) => {
  await open(page, 'limited-agent');
  await expect(page.getByTestId('pill-effort')).toHaveCount(0);
  await page.getByTestId('composer-input').fill('Verifica depois.');
  await expect(page.getByTestId('steer-now')).toHaveCount(0);
  await page.getByTestId('composer-input').press('Control+Enter');
  await expect(page.getByTestId('queued')).toContainText('Verifica depois.');
  expect(await commands(page, 'session.send')).toEqual([
    { sessionId: 'session-1', text: 'Verifica depois.', how: 'queue' },
  ]);
  expect(await commands(page, 'session.setEffort')).toEqual([]);
});

test('mesa: Espaço abre a sessão e coloca o foco na conversa', async ({ page }, info) => {
  await open(page);
  await page.getByTestId('composer-input').fill('Rascunho da sessão A.');
  await page.getByTestId('new-session').click();
  await page.getByTestId('open-desk').click();
  const card = page.locator('[data-testid="desk-card"][data-session="session-1"]');
  await card.focus();
  await expect(card).toBeFocused();
  await capture(page, info, 'desk-keyboard-focus');
  await card.press('Space');
  await expect(page.getByTestId('composer-input')).toHaveValue('Rascunho da sessão A.');
  await expect(page.getByTestId('composer-input')).toBeFocused();
  await expect(page.getByTestId('session-row').last()).toHaveAttribute('aria-current', 'page');
});

test('eventos e permissão em segundo plano não roubam seleção, texto ou foco', async ({ page }) => {
  await open(page);
  await page.getByTestId('new-session').click();
  const input = page.getByTestId('composer-input');
  await input.fill('Estou a escrever na sessão B.');
  await page.evaluate((block) => {
    window.qa.emit({
      kind: 'event',
      type: 'session.event',
      sessionId: 'session-1',
      delta: { type: 'block.upsert', turnId: 'answer-1', block },
    });
    window.qa.state('session-1', 'needs-you');
    for (const [sessionId, text] of [
      ['session-1', 'Atualização exclusiva de A.'],
      ['session-2', 'Atualização exclusiva de B.'],
    ]) {
      window.qa.emit({
        kind: 'event',
        type: 'session.event',
        sessionId,
        delta: {
          type: 'block.upsert',
          turnId: 'answer-1',
          block: { kind: 'text', id: 'background-update', text, parentToolId: null },
        },
      });
    }
  }, permission);
  await expect(page.getByTestId('session-row').last()).toHaveAttribute('data-state', 'needs-you');
  await expect(page.getByTestId('session-row').first()).toHaveAttribute('aria-current', 'page');
  await expect(input).toHaveValue('Estou a escrever na sessão B.');
  await expect(input).toBeFocused();
  await expect(page.getByText('Atualização exclusiva de B.', { exact: true })).toBeVisible();
  await expect(page.getByText('Atualização exclusiva de A.', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('permission-card')).toHaveCount(0);
  await page.getByTestId('session-row').last().click();
  await expect(page.getByTestId('permission-card')).toBeVisible();
  await expect(page.getByText('Atualização exclusiva de A.', { exact: true })).toBeVisible();
  await expect(page.getByText('Atualização exclusiva de B.', { exact: true })).toHaveCount(0);
  await page.getByTestId('session-row').first().click();
  await expect(input).toHaveValue('Estou a escrever na sessão B.');
});

test('ferramenta com erro mostra entrada, saída completa e devolve foco', async ({
  page,
}, info) => {
  await open(page, 'tool-error');
  const tool = page.getByTestId('tool-block');
  await expect(tool).toHaveAttribute('data-state', 'error');
  await expect(tool).toHaveAccessibleName(/falhou/);
  await tool.click();
  await expect(page.getByTestId('tool-detail')).toContainText('pnpm test:keyboard');
  await expect(page.getByTestId('tool-output')).toHaveText(
    'Falhou: foco perdido em navigation.ts:18\nCódigo de saída: 1',
  );
  await capture(page, info, 'tool-error-detail');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-detail')).toBeHidden();
  await expect(tool).toBeFocused();
});

test('várias perguntas exigem todas as respostas e preservam a seleção múltipla', async ({
  page,
}, info) => {
  await open(page, 'multi-question');
  const send = page.getByRole('button', { name: 'Responder', exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole('radio', { name: 'Por projeto', exact: true }).click();
  await expect(send).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Teclado', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Contraste', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Movimento', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Movimento', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Movimento', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await capture(page, info, 'multiple-questions');
  await send.click();
  await expect(page.getByTestId('ask-resolved')).toContainText('Por projeto · Teclado, Contraste');
  expect(await commands(page, 'permission.answer')).toEqual([
    {
      sessionId: 'session-1',
      requestId: 'ask-1',
      answer: {
        decision: 'answer',
        answers: { 'Como agrupar?': 'Por projeto', 'O que verificar?': 'Teclado, Contraste' },
      },
    },
  ]);
});

test('orientação agora usa o protocolo exato e não altera a fila existente', async ({ page }) => {
  await open(page, 'queue');
  await page.getByTestId('composer-input').fill('Prioriza a acessibilidade agora.');
  await page.getByTestId('steer-now').click();
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await expect(page.getByTestId('queued')).toHaveCount(2);
  expect(await commands(page, 'session.send')).toEqual([
    { sessionId: 'session-1', text: 'Prioriza a acessibilidade agora.', how: 'now' },
  ]);
});

test('editar a fila com resposta tardia devolve o texto uma só vez à sessão original', async ({
  page,
}) => {
  await open(page, 'queue');
  await page.getByTestId('composer-input').fill('Texto já escrito.');
  await page.evaluate(() => window.qa.hold('session.unqueue'));
  await page.getByTestId('queued-edit').first().click();
  await expect
    .poll(() => commands(page, 'session.unqueue'))
    .toEqual([{ sessionId: 'session-1', id: 'queued-1' }]);
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('Texto da outra sessão.');
  await page.evaluate(() => window.qa.release('session.unqueue'));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.qa.journal.filter(
            (entry) =>
              entry.name === 'session.queue' &&
              (entry.data as { sessionId: string }).sessionId === 'session-1',
          ).length,
      ),
    )
    .toBe(2);
  await expect(page.getByTestId('composer-input')).toHaveValue('Texto da outra sessão.');
  await expect(page.getByTestId('queued')).toHaveCount(2);
  await page.getByTestId('session-row').last().click();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'Texto já escrito.\nDepois verifica o tema escuro.',
  );
  await expect(page.getByTestId('queued')).toHaveCount(1);
  await page.getByTestId('open-desk').click();
  await page.locator('[data-testid="desk-card"][data-session="session-1"]').press('Enter');
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'Texto já escrito.\nDepois verifica o tema escuro.',
  );
});

test('achados: detalhe, escolha explícita e recuperação de uma correção falhada', async ({
  page,
}, info) => {
  await open(page, 'quality-findings');
  await expect(page.getByTestId('quality-chip')).toHaveAttribute('data-quality', 'found');
  await page.getByTestId('quality-chip').click();
  await page.getByTestId('quality-open').click();
  await expect(page.getByTestId('finding')).toHaveCount(2);
  await page.getByRole('button', { name: /Erro: Preservar a sessão anterior/ }).click();
  await expect(
    page.getByText('A seleção deve sobreviver a uma atualização em segundo plano.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId('fix-findings')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Escolher: Preservar a sessão anterior' }).check();
  await capture(page, info, 'quality-findings');
  await page.evaluate(() => window.qa.fail('quality.fix'));
  await page.getByTestId('fix-findings').click();
  await expect(page.getByTestId('action-error')).toContainText('Falha simulada');
  await expect(
    page.getByRole('checkbox', { name: 'Escolher: Preservar a sessão anterior' }),
  ).toBeChecked();
  await page.getByTestId('fix-findings').click();
  await expect(page.getByTestId('fix-findings')).toHaveCount(0);
  expect(await commands(page, 'quality.fix')).toEqual([
    { sessionId: 'session-1', ids: ['finding-1'] },
    { sessionId: 'session-1', ids: ['finding-1'] },
  ]);
});

test('erro do revisor é legível e repetir recupera o estado', async ({ page }, info) => {
  await open(page, 'quality-error');
  await expect(page.getByTestId('quality-chip')).toHaveAccessibleName(
    'Falhou: O revisor perdeu a ligação.',
  );
  await capture(page, info, 'quality-error');
  await page.getByTestId('quality-chip').click();
  await page.getByTestId('quality-again').click();
  await expect(page.getByTestId('quality-chip')).toHaveAttribute('data-quality', 'clean');
  expect(await commands(page, 'quality.review')).toEqual([{ sessionId: 'session-1' }]);
});

test('MCP indisponível não pode ser escolhido e desmarcar remove o servidor do pedido', async ({
  page,
}, info) => {
  await page.goto('/?scene=unavailable-mcp');
  await page.getByTestId('new-session-agent').click();
  await expect(page.getByTestId('mcp-offline')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('mcp-offline')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('mcp-offline')).toContainText('Não instalado');
  await page.getByTestId('mcp-docs').click();
  await expect(page.getByTestId('mcp-docs')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('mcp-docs').click();
  await expect(page.getByTestId('mcp-docs')).toHaveAttribute('aria-checked', 'false');
  await capture(page, info, 'mcp-unavailable');
  await page.getByTestId('agent-claude').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  expect(await commands(page, 'session.create')).toEqual([
    { projectId: 'atelier', agent: 'claude' },
  ]);
});

test('saída extensa da ferramenta mantém todo o texto e scroll local', async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 520 });
  await open(page, 'long-tool');
  await page.getByTestId('tool-block').click();
  const output = page.getByTestId('tool-output');
  await expect(output).toHaveText(longToolOutput);
  const scrollArea = output.locator('..');
  expect(await scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await output.hover();
  await page.mouse.wheel(0, 16000);
  await expect.poll(() => scrollArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const bounds = await page.getByTestId('tool-detail').boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(760);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(520);
  await capture(page, info, 'long-tool-output');
  await page.getByRole('button', { name: 'Fechar detalhe', exact: true }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('rótulos longos mantêm os controlos acessíveis numa janela estreita', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 760, height: 520 });
  await open(page, 'long-controls');
  for (const control of ['model', 'effort', 'mode']) {
    const pill = page.getByTestId(`pill-${control}`);
    await expect(pill).toBeVisible();
    const bounds = await pill.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(760);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(520);
  }
  await expect(page.getByTestId('pill-model')).toHaveAccessibleName(
    `Modelo: ${longModelLabel}. Mudar`,
  );
  await expect(page.getByTestId('pill-mode')).toHaveAccessibleName(`Modo: ${longModeLabel}. Mudar`);
  await page.getByTestId('pill-model').click();
  await expect(page.getByTestId('model-opus')).toContainText(longModelLabel);
  await capture(page, info, 'long-model-label');
  await page.getByTestId('model-opus').click();
  await page.getByTestId('pill-mode').click();
  await page.getByTestId('mode-plan').click();
  expect(await commands(page, 'session.setModel')).toEqual([
    { sessionId: 'session-1', model: 'opus' },
  ]);
  expect(await commands(page, 'session.setMode')).toEqual([
    { sessionId: 'session-1', mode: 'plan' },
  ]);
});
