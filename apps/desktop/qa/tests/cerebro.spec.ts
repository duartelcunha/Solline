import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * M6, fase 6: a interface do «um só cérebro» (regras, memórias, consultas e o catálogo MCP).
 * Cenários sintéticos em qa/cerebro.ts; nada aqui toca num agente nem num segredo reais.
 */

const errors = new WeakMap<Page, string[]>();
const shotsDir = process.env.SOLLINE_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(m.text());
  });
});

test.afterEach(async ({ page }) => {
  const failures = await page.evaluate(() => window.qa?.failures ?? []);
  expect(failures).toEqual([]);
  expect(errors.get(page)).toEqual([]);
});

type Theme = 'light' | 'dark';

async function go(page: Page, scene: string, theme: Theme = 'light') {
  await page.addInitScript((value) => localStorage.setItem('solline.theme', value), theme);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`/?scene=${scene}`);
}

async function shot(page: Page, name: string, theme: Theme) {
  if (!shotsDir) return;
  // Deixa as entradas assentarem (200 a 260 ms) antes de olhar.
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shotsDir, `${name}-${theme}.png`) });
}

const openProject = async (page: Page, tab?: string) => {
  await page.getByTestId('project-row').click();
  if (tab) await page.getByTestId(tab).click();
};

test.describe('regras do projeto', () => {
  test('criar, validar padrões, ligar, editar e apagar', async ({ page }) => {
    await go(page, 'cerebro');
    await openProject(page, 'space-tab-rules');
    await expect(page.getByTestId('rule-row')).toHaveCount(4);
    await expect(page.getByTestId('rules-size')).toContainText('linhas');

    await page.getByTestId('rule-new').click();
    await page.getByLabel('Título', { exact: true }).fill('Nomes de variáveis');
    await page.getByLabel('Regra', { exact: true }).fill('Usa camelCase nas variáveis.');
    await page.getByLabel('Só para estes ficheiros (opcional)').fill('../segredo');
    await expect(page.getByTestId('rule-save')).toBeDisabled();
    await expect(page.getByText('sem .. nem caminhos absolutos')).toBeVisible();
    await page.getByLabel('Só para estes ficheiros (opcional)').fill('*.ts, src/app/**');
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rule-row')).toHaveCount(5);
    await expect(page.getByTestId('rule-row').last()).toContainText('src/app/**');

    // Ligar e desligar vale logo.
    const first = page.getByTestId('rule-row').first();
    await first.getByTestId('rule-switch').click();
    await expect(first).toHaveAttribute('data-enabled', 'false');
    await expect(first.getByTestId('rule-switch')).toHaveAttribute('aria-checked', 'false');

    // Editar e apagar (apagar pede confirmação no próprio botão).
    await page.getByTestId('rule-row').last().getByRole('button').first().click();
    await expect(page.getByTestId('rule-form')).toBeVisible();
    await page.getByLabel('Título', { exact: true }).fill('Nomes das variáveis');
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rule-row').last()).toContainText('Nomes das variáveis');
    await page
      .getByTestId('rule-row')
      .last()
      .getByRole('button', { name: /Editar/ })
      .last()
      .click();
    await page.getByTestId('rule-delete').click();
    await expect(page.getByTestId('rule-delete')).toHaveText('Confirmar');
    await page.getByTestId('rule-delete').click();
    await expect(page.getByTestId('rule-row')).toHaveCount(4);
  });

  test('desfazer e ver o texto que o agente recebe', async ({ page }) => {
    await go(page, 'cerebro');
    await openProject(page, 'space-tab-rules');
    await expect(page.getByRole('button', { name: /gerar/i })).toHaveCount(0);
    await expect(page.getByTestId('rules-import')).toHaveCount(0);
    await page.getByTestId('rules-preview').click();
    await expect(page.getByTestId('rules-preview-text')).toContainText('Claude');
    await page.getByTestId('rule-new').click();
    await page.getByLabel('Título', { exact: true }).fill('Nova');
    await page.getByLabel('Regra', { exact: true }).fill('Uma regra curta.');
    await page.getByTestId('rule-save').click();
    await page.getByTestId('rules-undo').click();
  });

  test('o separador Regras existe no Geral', async ({ page }) => {
    await go(page, 'cerebro');
    await page.getByTestId('open-general').click();
    await expect(page.getByTestId('space-tab-rules')).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const)
    test(`regras em ${theme}`, async ({ page }) => {
      await go(page, 'cerebro', theme);
      await openProject(page, 'space-tab-rules');
      await expect(page.getByTestId('rule-row')).toHaveCount(4);
      await shot(page, 'regras', theme);
      await page.getByTestId('rule-new').click();
      await page.getByLabel('Título', { exact: true }).fill('Respostas curtas');
      await page.getByLabel('Regra', { exact: true }).fill('Responde primeiro e explica depois.');
      await page.getByLabel('Só para estes ficheiros (opcional)').fill('docs/**');
      await shot(page, 'regras-editar', theme);
      await page.setViewportSize({ width: 760, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
});

test.describe('caixa de memórias', () => {
  test('propostas com prova, origem e aviso externo; aprovar e recusar em lote', async ({
    page,
  }) => {
    await go(page, 'cerebro');
    await expect(page.getByTestId('project-pending')).toHaveText('3');
    await expect(page.getByTestId('general-pending')).toHaveText('3');
    await openProject(page, 'space-tab-memory');
    await expect(page.getByTestId('space-tab-memory-count')).toHaveText('3');
    await expect(page.getByTestId('memory-proposal')).toHaveCount(3);

    const utc = page.getByTestId('memory-proposal').filter({ hasText: 'em UTC' });
    await expect(utc.getByTestId('memory-proof').first()).toContainText(
      'packages/db/test/setup.ts:12-20',
    );
    await expect(utc.getByTestId('memory-proof').nth(1)).toContainText('commit a1b2c3d4e5');
    await expect(utc).toContainText('Proposta do Claude');
    await expect(utc.getByTestId('memory-origin-open')).toBeVisible();

    const external = page.getByTestId('memory-proposal').filter({ hasText: 'pnpm dlx' });
    await expect(external.getByTestId('memory-external')).toContainText('Origem externa');
    await expect(external.getByTestId('memory-select')).toBeDisabled();
    const closed = page.getByTestId('memory-proposal').filter({ hasText: 'processo principal' });
    await expect(closed).toContainText('já não está aberta');

    // «Escolher todas» não apanha a de origem externa.
    await page.getByTestId('memory-select-all').check();
    await expect(page.getByTestId('memory-approve-selected')).toHaveText('Aprovar 2');
    await page.getByTestId('memory-reject-selected').click();
    await expect(page.getByTestId('memory-proposal')).toHaveCount(1);
    await expect(page.getByTestId('project-pending')).toHaveText('1');

    // A externa aprova-se uma a uma, com o texto editado e no âmbito Geral.
    await external.getByTestId('memory-edit-toggle').click();
    await external.getByTestId('memory-edit').fill('Usa pnpm dlx em vez de npx.');
    await external.getByRole('button', { name: 'Geral', exact: true }).click();
    await external.getByTestId('memory-approve').click();
    await expect(page.getByTestId('memory-proposal')).toHaveCount(0);
    await expect(page.getByTestId('project-pending')).toHaveCount(0);
    const approve = await page.evaluate(() =>
      window.qa.journal.filter((e) => e.name === 'memory.approve').map((e) => e.data),
    );
    expect(approve).toEqual([
      {
        ids: ['mem-dlx'],
        scope: 'global',
        edits: { 'mem-dlx': { text: 'Usa pnpm dlx em vez de npx.' } },
      },
    ]);
    await page.getByTestId('open-general').click();
    await page.getByTestId('space-tab-memory').click();
    await expect(page.getByText('Usa pnpm dlx em vez de npx.')).toBeVisible();
  });

  test('transformar em regra aprova a memória e cria a regra', async ({ page }) => {
    await go(page, 'cerebro');
    await openProject(page, 'space-tab-memory');
    await page
      .getByTestId('memory-proposal')
      .filter({ hasText: 'processo principal' })
      .getByTestId('memory-to-rule')
      .click();
    await expect(page.getByTestId('memory-proposal')).toHaveCount(2);
    await page.getByTestId('space-tab-rules').click();
    await expect(page.getByTestId('rule-row')).toHaveCount(5);
    await expect(page.getByTestId('rules-list')).toContainText('processo principal');
  });

  test('«A confirmar» confirma-se com um clique', async ({ page }) => {
    await go(page, 'cerebro');
    await openProject(page, 'space-tab-memory');
    const card = page.getByTestId('memory-confirm-card');
    await expect(card).toContainText('O que a prova citava mudou');
    await expect(card.getByTestId('memory-proof')).toContainText('CONTRIBUTING.md:8-12');
    await card.getByTestId('memory-confirm').click();
    await expect(page.getByTestId('memory-confirm-card')).toHaveCount(0);
    await expect(page.getByText('feat/<issue>-<tema>')).toBeVisible();
  });

  test('em Geral veem-se as propostas de todos os projetos', async ({ page }) => {
    await go(page, 'cerebro');
    await page.getByTestId('open-general').click();
    await page.getByTestId('space-tab-memory').click();
    await expect(page.getByTestId('memory-proposal')).toHaveCount(3);
    await expect(page.getByTestId('memory-proposal').first()).toContainText('Atelier');
  });

  for (const theme of ['light', 'dark'] as const)
    test(`caixa de memórias em ${theme}`, async ({ page }) => {
      await go(page, 'cerebro', theme);
      await openProject(page, 'space-tab-memory');
      await expect(page.getByTestId('memory-proposal')).toHaveCount(3);
      await shot(page, 'memorias', theme);
      await page.setViewportSize({ width: 760, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
});

test.describe('perguntar a… e delegar', () => {
  test('o cartão decide-se na sessão, a sessão conta como «precisa de ti»', async ({ page }) => {
    await go(page, 'consult-ask');
    await page.getByTestId('new-session').click();
    const card = page.getByTestId('consult-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('consult-title')).toHaveText('O Claude quer perguntar ao Codex');
    await expect(card.getByTestId('consult-text')).toContainText('parser de configuração');
    await expect(card.getByText('Contexto que o agente juntou')).toBeVisible();
    await expect(page.getByTestId('consult-note')).toHaveCount(0);
    // O motor ainda diz «a trabalhar», mas quem decide és tu.
    await expect(page.locator('.session-state-chip')).toHaveAttribute('data-state', 'needs-you');
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-state', 'needs-you');
    await expect(page.getByTestId('desk-waiting')).toHaveText('1');
    await shot(page, 'consulta-pergunta', 'light');

    await page.getByTestId('consult-allow').click();
    await expect(page.getByTestId('consult-card')).toHaveCount(0);
    await expect(page.locator('.session-state-chip')).toHaveAttribute('data-state', 'running');
    // A consulta abre uma sessão visível e há um caminho para lá.
    const child = page.getByTestId('consult-child');
    await expect(child).toContainText('Pergunta ao Codex');
    await expect(page.getByTestId('desk-waiting')).toHaveCount(0);
    await child.getByRole('button', { name: /Abrir/ }).click();
    await expect(page.getByTestId('session-title')).toContainText('Pergunta de Claude');
    await expect(page.getByTestId('session-origin')).toContainText('consulta');
    const answered = await page.evaluate(
      () => window.qa.journal.find((e) => e.name === 'consult.answer')?.data,
    );
    expect(answered).toMatchObject({ requestId: 'consult-1', decision: 'allow' });
  });

  test('«Permitir nesta sessão», recusar e o teclado', async ({ page }) => {
    await go(page, 'consult-ask');
    await page.getByTestId('new-session').click();
    await expect(page.getByTestId('consult-card')).toBeVisible();
    await page.getByTestId('consult-allow-session').click();
    await expect(page.getByTestId('consult-card')).toHaveCount(0);
    const decisions = await page.evaluate(() =>
      window.qa.journal.filter((e) => e.name === 'consult.answer').map((e) => e.data),
    );
    expect(decisions).toEqual([
      { sessionId: expect.any(String), requestId: 'consult-1', decision: 'allowSession' },
    ]);
  });

  test('Esc recusa e o cartão desaparece', async ({ page }) => {
    await go(page, 'consult-ask');
    await page.getByTestId('new-session').click();
    await expect(page.getByTestId('consult-allow')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('consult-card')).toHaveCount(0);
    await expect(page.getByTestId('consult-child')).toHaveCount(0);
    await expect(page.locator('.session-state-chip')).toHaveAttribute('data-state', 'running');
  });

  test('do mesmo fabricante, o cartão avisa', async ({ page }) => {
    await go(page, 'consult-same-vendor');
    await page.getByTestId('new-session').click();
    await expect(page.getByTestId('consult-note')).toContainText('do mesmo fabricante');
    await shot(page, 'consulta-mesmo-fabricante', 'light');
  });

  test('delegar mostra o agente e o modo; na mesa só se abre ou recusa', async ({ page }) => {
    await go(page, 'consult-delegate');
    await page.getByTestId('new-session').click();
    const card = page.getByTestId('consult-card');
    await expect(card.getByTestId('consult-title')).toHaveText(
      'O Claude quer delegar uma tarefa no Codex',
    );
    await expect(card.getByTestId('consult-facts')).toContainText('Codex');
    await expect(card.getByTestId('consult-facts')).toContainText('Editar ficheiros');
    await expect(card.getByTestId('consult-facts')).toContainText('Testes do parser');
    await page.getByTestId('open-desk').click();
    const desk = page.getByTestId('desk-card').first();
    await expect(desk).toHaveAttribute('data-state', 'needs-you');
    await expect(desk.getByTestId('card-consult')).toContainText('quer delegar');
    // Delegar não se permite às cegas na mesa: abre a sessão.
    await expect(desk.getByTestId('card-consult-allow')).toHaveCount(0);
    await expect(page.getByTestId('desk-summary')).toContainText('1 precisa de ti');
    await shot(page, 'consulta-mesa', 'light');
    await desk.getByTestId('card-consult-deny').click();
    await expect(page.getByTestId('desk-summary')).toHaveCount(0);
  });

  test('perguntar permite-se direto no cartão da mesa', async ({ page }) => {
    await go(page, 'consult-ask');
    await page.getByTestId('new-session').click();
    await page.getByTestId('open-desk').click();
    await page.getByTestId('card-consult-allow').click();
    await expect(page.getByTestId('card-consult')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const)
    test(`cartões de consulta em ${theme}`, async ({ page }) => {
      for (const scene of ['consult-ask', 'consult-delegate']) {
        await go(page, scene, theme);
        await page.getByTestId('new-session').click();
        await expect(page.getByTestId('consult-card')).toBeVisible();
        await shot(page, scene === 'consult-ask' ? 'consulta-pergunta' : 'consulta-delegar', theme);
        if (scene === 'consult-delegate') {
          await page.setViewportSize({ width: 760, height: 700 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.getByTestId('open-desk').click();
          await shot(page, 'consulta-mesa', theme);
        }
      }
    });
});

test.describe('catálogo MCP', () => {
  const secret = 'valor-de-teste-que-nunca-aparece';

  test('estados, ferramentas, aprovar e segredos que nunca se mostram', async ({ page }) => {
    await go(page, 'cerebro');
    await page.getByTestId('open-general').click();
    await page.getByTestId('space-tab-tools').click();
    await expect(page.getByTestId('mcp-server')).toHaveCount(4);

    const docs = page.getByTestId('mcp-server').filter({ hasText: 'Documentação' });
    await expect(docs.getByTestId('mcp-status')).toHaveText('Pronto');
    await expect(docs).toContainText('io.github.acme/docs-mcp');
    await expect(docs).toContainText('versão fixada 1.4.2');
    await expect(docs.getByTestId('mcp-verified')).toContainText('Dono verificado pelo GitHub');
    await docs.getByTestId('mcp-tools-toggle').click();
    await expect(docs.getByTestId('mcp-tools')).toContainText('search_docs');

    const ledger = page.getByTestId('mcp-server').filter({ hasText: 'Livro de contas' });
    await expect(ledger.getByTestId('mcp-status')).toHaveText('Precisa de nova aprovação');
    await expect(ledger.getByTestId('mcp-changed')).toContainText('export_csv');
    await expect(ledger.getByTestId('mcp-changed')).toContainText('query');

    const broken = page.getByTestId('mcp-server').filter({ hasText: 'Servidor de teste' });
    await expect(broken.getByTestId('mcp-hint')).toContainText('fechou antes de responder');

    const notas = page.getByTestId('mcp-server').filter({ hasText: 'Notas locais' });
    await expect(notas.getByTestId('mcp-status')).toHaveText('Por aprovar');
    await expect(notas).toContainText('NOTAS_REGIAO=eu');
    await notas.getByTestId('mcp-approve').click();
    await expect(notas.getByTestId('mcp-status')).toHaveText('Pronto');

    const field = notas.getByLabel('NOTAS_TOKEN', { exact: false });
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(secret);
    await notas.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(notas.getByText('Guardado no Gestor de Credenciais')).toBeVisible();
    await expect(field).toHaveValue('');
    expect(await page.content()).not.toContain(secret);
    const saved = await page.evaluate(() =>
      window.qa.journal.filter((e) => e.name === 'mcp.setSecret').map((e) => e.data),
    );
    expect(saved).toEqual([{ id: 'notas', name: 'NOTAS_TOKEN', value: secret }]);

    // Tirar do catálogo pede confirmação no próprio botão.
    await broken.getByTestId('mcp-remove').click();
    await expect(broken.getByTestId('mcp-remove')).toHaveText('Confirmar');
    await broken.getByTestId('mcp-remove').click();
    await expect(page.getByTestId('mcp-server')).toHaveCount(3);
  });

  test('pesquisar no registo e acrescentar com segredos', async ({ page }) => {
    await go(page, 'cerebro');
    await page.getByTestId('open-general').click();
    await page.getByTestId('space-tab-tools').click();
    await page.getByTestId('mcp-search-input').fill('relat');
    await page.getByTestId('mcp-search').click();
    const result = page.getByTestId('mcp-result');
    await expect(result).toHaveCount(1);
    await expect(result.getByTestId('mcp-namespace')).toHaveText('com.exemplo');
    await expect(result.getByTestId('mcp-verified')).toContainText('Dono verificado por DNS');
    await expect(result).toContainText('versão fixada 2.0.0');
    await expect(result).toContainText('REL_API_KEY (segredo)');
    await expect(page.getByTestId('mcp-skipped-results')).toContainText('4 entradas');
    await result.getByTestId('mcp-add-open').click();
    await expect(result.getByTestId('mcp-add')).toBeDisabled();
    const key = result.getByLabel('REL_API_KEY');
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill(secret);
    await result.getByTestId('mcp-add').click();
    await expect(page.getByTestId('mcp-server')).toHaveCount(5);
    const added = page.getByTestId('mcp-server').filter({ hasText: 'Relatórios' });
    await expect(added.getByTestId('mcp-status')).toHaveText('Por aprovar');
    await expect(result.getByTestId('mcp-already')).toBeVisible();
    expect(await page.content()).not.toContain(secret);

    // Um servidor sem dono verificado diz-o.
    await page.getByTestId('mcp-search-input').fill('utilit');
    await page.getByTestId('mcp-search').click();
    await expect(page.getByTestId('mcp-result').getByTestId('mcp-verified')).toContainText(
      'Dono não verificado',
    );
  });

  test('acrescentar à mão valida o formulário', async ({ page }) => {
    await go(page, 'cerebro');
    await page.getByTestId('open-general').click();
    await page.getByTestId('space-tab-tools').click();
    await page.getByTestId('mcp-add-manual').click();
    await expect(page.getByTestId('mcp-manual-add')).toBeDisabled();
    await page.getByLabel('Nome', { exact: true }).fill('Servidor local');
    await page.getByLabel('Comando', { exact: true }).fill('node');
    await page.getByLabel('Argumentos, um por linha').fill('servidor.js\n--porta=4000');
    await page.getByTestId('mcp-env-add').click();
    await page.getByLabel('Nome da variável 1').fill('PATH');
    await expect(page.getByRole('alert')).toContainText('não se declara');
    await expect(page.getByTestId('mcp-manual-add')).toBeDisabled();
    await page.getByLabel('Nome da variável 1').fill('LOCAL_TOKEN');
    await expect(page.getByLabel('Valor da variável 1')).toHaveAttribute('type', 'password');
    await page.getByLabel('Valor da variável 1').fill(secret);
    await page.getByTestId('mcp-manual-add').click();
    await expect(page.getByTestId('mcp-server')).toHaveCount(5);
    await expect(
      page.getByTestId('mcp-server').filter({ hasText: 'Servidor local' }),
    ).toContainText('Acrescentado à mão');
    expect(await page.content()).not.toContain(secret);
    const sent = await page.evaluate(
      () => window.qa.journal.find((e) => e.name === 'mcp.add')?.data,
    );
    expect(sent).toMatchObject({
      source: { kind: 'manual', spec: { command: 'node', args: ['servidor.js', '--porta=4000'] } },
      values: { LOCAL_TOKEN: secret },
    });
  });

  test('cada projeto escolhe os seus servidores, até 8', async ({ page }) => {
    await go(page, 'cerebro');
    await openProject(page, 'space-tab-tools');
    await expect(page.getByTestId('mcp-project-row')).toHaveCount(4);
    await expect(page.getByTestId('mcp-project-count')).toHaveText('2 de 8');
    const ledger = page.getByTestId('mcp-project-row').filter({ hasText: 'Livro de contas' });
    await ledger.getByRole('checkbox').check();
    await expect(page.getByTestId('mcp-project-count')).toHaveText('3 de 8');
    await expect(ledger).toContainText('Ainda não entra nas sessões');
    const set = await page.evaluate(() =>
      window.qa.journal.filter((e) => e.name === 'mcp.setProject').map((e) => e.data),
    );
    expect(set).toEqual([{ projectId: 'atelier', serverIds: ['docs', 'notas', 'ledger'] }]);
    await page.getByTestId('mcp-open-catalog').click();
    await expect(page.getByTestId('mcp-servers')).toBeVisible();
    // O catálogo é o separador MCP do Geral. O Geral tem Regras; o que sai é a lista do projeto.
    await expect(page.getByTestId('mcp-project-row')).toHaveCount(0);
    await expect(page.getByTestId('space-tab-rules')).toHaveCount(1);
    await expect(page.getByTestId('space-tab-rules')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('space-tab-tools')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a sessão diz, em silêncio, que servidores ficaram de fora', async ({ page }) => {
    await go(page, 'mcp-skipped');
    await page.getByTestId('new-session').click();
    const note = page.getByTestId('mcp-skipped');
    await expect(note).toContainText('2 servidores MCP do projeto ficaram de fora');
    await expect(note).toContainText('Notas locais (precisa de aprovação)');
    await expect(note).toContainText('Livro de contas (as ferramentas mudaram');
    await shot(page, 'mcp-sessao', 'light');
    await page.getByTestId('mcp-skipped-open').click();
    await expect(page.getByTestId('mcp-servers')).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const)
    test(`catálogo MCP em ${theme}`, async ({ page }) => {
      await go(page, 'cerebro', theme);
      await page.getByTestId('open-general').click();
      await page.getByTestId('space-tab-tools').click();
      await page
        .getByTestId('mcp-server')
        .filter({ hasText: 'Documentação' })
        .getByTestId('mcp-tools-toggle')
        .click();
      await expect(page.getByTestId('mcp-server')).toHaveCount(4);
      await shot(page, 'mcp-catalogo', theme);
      await page.getByTestId('mcp-search-input').fill('relat');
      await page.getByTestId('mcp-search').click();
      await page.getByTestId('mcp-add-open').click();
      await page.getByTestId('mcp-search-input').scrollIntoViewIfNeeded();
      await page.getByTestId('mcp-result').scrollIntoViewIfNeeded();
      await shot(page, 'mcp-registo', theme);
      await page.getByTestId('project-row').click();
      await page.getByTestId('space-tab-tools').click();
      await shot(page, 'mcp-projeto', theme);
      await page.setViewportSize({ width: 760, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
});
