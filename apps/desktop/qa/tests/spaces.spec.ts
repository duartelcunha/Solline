import { test, expect } from '@playwright/test';

test('capturar não arranca um agente; delegar mostra o contexto e abre a conversa', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?scene=conversation');
  await page.getByTestId('project-row').click();
  await page.getByLabel('Nova tarefa', { exact: true }).fill('Melhorar os estados vazios');
  await page.getByLabel('Nova tarefa', { exact: true }).press('Enter');
  await expect(page.getByTestId('task-row')).toHaveText('Melhorar os estados vazios');
  await expect(page.getByTestId('session-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Delegar', exact: true }).click();
  await expect(page.getByLabel('O que o agente recebe')).toHaveValue('Melhorar os estados vazios');
  await page.getByLabel('Agente', { exact: true }).click();
  await page.getByTestId('choice-task-agent-claude').click();
  await page.getByRole('button', { name: 'Enviar tarefa', exact: true }).click();
  await expect(page.getByText('Em curso', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Abrir conversa' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('back-to-task').click();
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await expect(page.getByTestId('task-row')).toHaveText('Melhorar os estados vazios');
  expect(errors).toEqual([]);
});

test('memórias ficam no seu espaço e podem ser promovidas e apagadas', async ({ page }) => {
  await page.goto('/?scene=conversation');
  await page.getByTestId('project-row').click();
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await page.getByRole('button', { name: 'Memória', exact: true }).last().click();
  await page.getByLabel('Memória', { exact: true }).fill('Interfaces calmas e decisões claras.');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(
    page.getByText('Interfaces calmas e decisões claras.', { exact: true }),
  ).toBeVisible();
  await page.getByTestId('open-general').click();
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await expect(page.getByText('Interfaces calmas e decisões claras.', { exact: true })).toHaveCount(
    0,
  );
  await page.getByTestId('project-row').click();
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await page.getByRole('button', { name: 'Mover para Geral' }).click();
  await page.getByTestId('open-general').click();
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await expect(
    page.getByText('Interfaces calmas e decisões claras.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Apagar memória', { exact: true }).click();
  await expect(page.getByText('Interfaces calmas e decisões claras.', { exact: true })).toHaveCount(
    0,
  );
});

for (const theme of ['light', 'dark'])
  test(`espaço em ${theme}, teclado e janela estreita`, async ({ page }, info) => {
    await page.addInitScript((value) => localStorage.setItem('solline.theme', value), theme);
    await page.goto('/?scene=conversation');
    await page.getByTestId('project-row').click();
    await page.getByLabel('Nova tarefa', { exact: true }).fill('Rever a navegação do projeto');
    await page.getByLabel('Nova tarefa', { exact: true }).press('Enter');
    await page
      .getByLabel('Contexto', { exact: true })
      .fill('Manter os estados claros, preservar o foco e dar espaço ao conteúdo.');
    await page.getByLabel('Contexto', { exact: true }).press('Tab');
    await expect(page.getByRole('button', { name: 'Delegar', exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`space-${theme}.png`) });
    await page.setViewportSize({ width: 760, height: 520 });
    await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel('Fechar detalhes').click();
    await expect(page.getByTestId('task-row')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`space-${theme}-narrow.png`) });
  });
