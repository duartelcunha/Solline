import { test, expect, type Page } from '@playwright/test';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const current: string[] = [];
  errors.set(page, current);
  page.on('pageerror', (error) => current.push(error.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') current.push(entry.text());
  });
});

async function open(page: Page, scene: string) {
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
  await page.goto(`/?scene=${scene}`);
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
}

test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => ({
    journal: window.qa.journal,
    failures: window.qa.failures,
    subscriptions: window.qa.subscriptions(),
    focusSubscriptions: window.qa.focusSubscriptions(),
  }));
  await info.attach('protocol-journal', {
    body: JSON.stringify({ ...evidence, runtimeErrors: errors.get(page) }, null, 2),
    contentType: 'application/json',
  });
  expect(evidence.failures).toEqual([]);
  expect(evidence.subscriptions).toBe(1);
  expect(evidence.focusSubscriptions).toBe(1);
  expect(errors.get(page)).toEqual([]);
});

test('permissão: falha permite repetir e limpa o erro após sucesso', async ({ page }) => {
  await open(page, 'permission');
  await page.evaluate(() => window.qa.fail('permission.answer'));
  const deny = page.getByRole('button', { name: /^Negar/ });
  await deny.click();
  await expect(page.getByText('Falha simulada: tenta de novo.')).toBeVisible();
  await expect(deny).toBeEnabled();
  await deny.click();
  await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'denied');
  await expect(page.getByText('Falha simulada: tenta de novo.')).toBeHidden();
  expect(
    await page.evaluate(() =>
      window.qa.journal
        .filter((entry) => entry.name === 'permission.answer')
        .map((entry) => entry.data),
    ),
  ).toEqual([
    { sessionId: 'session-1', requestId: 'ask-1', answer: { decision: 'deny' } },
    { sessionId: 'session-1', requestId: 'ask-1', answer: { decision: 'deny' } },
  ]);
});

test('permissão: duplo clique durante resposta atrasada envia uma decisão', async ({ page }) => {
  await open(page, 'permission');
  await page.evaluate(() => window.qa.hold('permission.answer'));
  const allow = page.getByRole('button', { name: /^Permitir uma vez/ });
  await allow.dblclick();
  await expect(allow).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Negar/ })).toBeDisabled();
  expect(
    await page.evaluate(() =>
      window.qa.journal
        .filter((entry) => entry.name === 'permission.answer')
        .map((entry) => entry.data),
    ),
  ).toEqual([{ sessionId: 'session-1', requestId: 'ask-1', answer: { decision: 'allow-once' } }]);
  await page.evaluate(() => window.qa.release('permission.answer'));
  await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'allowed');
});

for (const decision of ['approve', 'reject'] as const) {
  test(`plano: ${decision} confirma o resultado e a decisão exata`, async ({ page }) => {
    await open(page, 'plan');
    await expect(page.getByTestId('plan-card')).toContainText('Preservar a seleção.');
    await page
      .getByRole('button', {
        name: decision === 'approve' ? 'Aprovar plano' : 'Rejeitar',
        exact: true,
      })
      .click();
    await expect(page.getByTestId('ask-resolved')).toHaveAttribute(
      'data-status',
      decision === 'approve' ? 'allowed' : 'denied',
    );
    expect(
      await page.evaluate(() =>
        window.qa.journal
          .filter((entry) => entry.name === 'permission.answer')
          .map((entry) => entry.data),
      ),
    ).toEqual([
      {
        sessionId: 'session-1',
        requestId: 'ask-1',
        answer: { decision: decision === 'approve' ? 'allow-once' : 'deny' },
      },
    ]);
  });
}

for (const worktree of ['keep', 'discard', 'bring'] as const) {
  test(`fecho com rascunho, fila e worktree preserva a escolha ${worktree}`, async ({ page }) => {
    await open(page, 'worktree-queue');
    await page.getByTestId('composer-input').fill('Rascunho ainda por enviar.');
    await page.getByTestId('session-close').click();
    await expect(page.getByTestId('close-queue-dialog')).toContainText('mensagem por enviar');
    await expect(page.getByTestId('close-queue-dialog')).toContainText('2 mensagens na fila');
    await page.getByTestId('close-drop-queue').click();
    await expect(page.getByTestId('close-dialog')).toContainText('Trabalho por trazer');
    await page.getByTestId(`close-${worktree}`).click();
    await expect(page.getByTestId('session-row')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(
      await page.evaluate(() =>
        window.qa.journal
          .filter((entry) => entry.name === 'session.close')
          .map((entry) => entry.data),
      ),
    ).toEqual([
      { sessionId: 'session-1', dropQueue: true },
      { sessionId: 'session-1', worktree, dropQueue: true },
    ]);
  });
}

test('cancelar a segunda etapa do fecho conserva rascunho e fila', async ({ page }) => {
  await open(page, 'worktree-queue');
  await page.getByTestId('composer-input').fill('Rascunho ainda por enviar.');
  await page.getByTestId('session-close').click();
  await page.getByTestId('close-drop-queue').click();
  await expect(page.getByTestId('close-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toHaveValue('Rascunho ainda por enviar.');
  await expect(page.getByTestId('queued')).toHaveCount(2);
  await page.getByTestId('session-close').click();
  await expect(page.getByTestId('close-queue-dialog')).toContainText('mensagem por enviar');
  await expect(page.getByTestId('close-queue-dialog')).toContainText('2 mensagens na fila');
});
