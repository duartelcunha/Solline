import { test, expect } from '@playwright/test';

test('pesquisar uma tarefa abre o projeto certo e retoma o detalhe sem delegar', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?scene=conversation');
  await expect(page.getByTestId('spaces-view')).toBeVisible();
  await page.getByTestId('project-row').click();
  await page.getByLabel('Nova tarefa', { exact: true }).fill('Rever autenticação');
  await page.getByLabel('Nova tarefa', { exact: true }).press('Enter');
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await page.getByTestId('open-general').click();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Pesquisar projetos, tarefas e conversas' });
  await search.fill('autenticacao atelier');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Atelier');
  await page.screenshot({ path: info.outputPath('search-task.png') });
  await search.press('Enter');
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await expect(page.getByTestId('task-row')).toHaveText('Rever autenticação');
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('solline-qa-navigation') ?? '{}').lastTarget?.taskId,
      ),
    )
    .toBeTruthy();
  await page.reload();
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await expect(page.getByTestId('task-row')).toHaveText('Rever autenticação');
  expect(
    await page.evaluate(() =>
      (window as unknown as { qa: { journal: { name: string }[] } }).qa.journal.filter((x) =>
        ['session.send', 'session.resume', 'session.create', 'spaces.delegate'].includes(x.name),
      ),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('pesquisa por teclado devolve o foco e conserva o rascunho', async ({ page }) => {
  await page.goto('/?scene=conversation');
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('Não perder este rascunho');
  await composer.press('Control+k');
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('sem-resultado-123');
  await expect(page.getByRole('option')).toHaveCount(0);
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.press('Escape');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('Não perder este rascunho');
});

for (const startup of ['Tarefas do Geral', 'Mesa', 'Retomar onde estava'])
  test(`arranque ${startup} é guardado e não muda a vista atual`, async ({ page }) => {
    await page.goto('/?scene=conversation');
    await page.getByTestId('project-row').click();
    await page.getByTestId('navigation-settings').click();
    await page.getByRole('radio', { name: new RegExp(`^${startup}`) }).check();
    await expect(page.getByText('A escolha aplica-se na próxima abertura.')).toBeVisible();
    await page.getByRole('button', { name: 'Fechar definições' }).click();
    await expect(page.getByRole('heading', { name: 'Atelier', exact: true })).toBeVisible();
    await page.reload();
    if (startup === 'Mesa')
      await expect(page.getByTestId('open-desk')).toHaveAttribute('aria-current', 'page');
    else
      await expect(
        page.getByRole('heading', {
          name: startup === 'Tarefas do Geral' ? 'Geral' : 'Atelier',
          exact: true,
        }),
      ).toBeVisible();
  });

test('um destino removido cai no Geral', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'solline-qa-navigation',
      JSON.stringify({
        version: 1,
        startupView: 'resume',
        lastTarget: { view: 'spaces', projectId: 'removed' },
      }),
    ),
  );
  await page.goto('/?scene=conversation');
  await expect(page.getByRole('heading', { name: 'Geral', exact: true })).toBeVisible();
});

test('retomar conserva o painel de memória e pesquisar uma tarefa volta às tarefas', async ({
  page,
}) => {
  await page.goto('/?scene=conversation');
  await page.getByTestId('project-row').click();
  await page.getByLabel('Nova tarefa', { exact: true }).fill('Retomar contexto');
  await page.getByLabel('Nova tarefa', { exact: true }).press('Enter');
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('solline-qa-navigation') ?? '{}').lastTarget?.panel,
      ),
    )
    .toBe('memory');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Memória', exact: true })).toHaveCount(2);
  await page.getByTestId('navigation-search').click();
  await page.getByRole('combobox').fill('Retomar contexto');
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
});

test('preferências inválidas são preservadas e mostram uma explicação', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('solline-qa-navigation', 'corrupt'));
  await page.goto('/?scene=conversation');
  await page.getByTestId('navigation-settings').click();
  await expect(page.getByRole('alert')).toContainText('O ficheiro foi preservado');
  expect(await page.evaluate(() => localStorage.getItem('solline-qa-navigation'))).toBe('corrupt');
});

for (const theme of ['light', 'dark'])
  test(`pesquisa e definições em ${theme}, janela estreita`, async ({ page }, info) => {
    await page.addInitScript((value) => localStorage.setItem('solline.theme', value), theme);
    await page.setViewportSize({ width: 760, height: 520 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?scene=conversation');
    await page.getByTestId('navigation-search').click();
    await expect(page.getByRole('combobox')).toBeFocused();
    await page.screenshot({ path: info.outputPath(`search-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.getByTestId('navigation-settings').click();
    await expect(page.getByRole('radio', { name: /^Retomar onde estava/ })).toBeChecked();
    await page.screenshot({ path: info.outputPath(`settings-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
