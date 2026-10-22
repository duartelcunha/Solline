import { expect, type ElectronApplication, type Page } from '@playwright/test';

export type PromptChoice = { button: string; choice: 'accept' | 'cancel' };
export type PromptRecord = {
  title: string;
  message: string;
  detail: string;
  button: string;
  choice: string;
  directory?: string;
};

/** Real isolated prompt UI only. Every accepted confirmation has an explicit title and label. */
export async function answerConfirmation(
  page: Page,
  expected: PromptChoice & { title: string },
): Promise<PromptRecord> {
  await expect(page.getByRole('heading', { name: expected.title, exact: true })).toBeVisible();
  const record = {
    title: expected.title,
    message: await page.locator('#message').innerText(),
    detail: await page.locator('#detail').innerText(),
    button: expected.button,
    choice: expected.choice,
  };
  const target = page.locator(expected.choice === 'accept' ? '#accept' : '#cancel');
  await expect(target).toHaveText(expected.button);
  await expect(page.locator('#cancel')).toBeFocused();
  await target.click();
  return record;
}

export async function chooseDirectory(page: Page, path: string): Promise<PromptRecord> {
  const title = 'Escolher pasta do projeto';
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Escolher esta pasta', exact: true }),
  ).toBeEnabled();
  await page.getByRole('textbox', { name: 'Caminho da pasta' }).fill(path);
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await expect(page.locator('#folder-status')).not.toHaveText('A abrir pasta…');
  await expect(page.locator('#error')).toHaveText('');
  await page.getByRole('button', { name: 'Escolher esta pasta', exact: true }).click();
  return {
    title,
    message: '',
    detail: '',
    button: 'Escolher esta pasta',
    choice: 'choose',
    directory: path,
  };
}

export function observePrompts(
  app: ElectronApplication,
  plan: { directory?: string; confirmations: Record<string, PromptChoice> },
) {
  const records: PromptRecord[] = [];
  const failures: string[] = [];
  const pending = new Set<Promise<void>>();
  const observe = (page: Page) => {
    const task = (async () => {
      await page.waitForURL((url) => url.protocol === 'file:' || url.protocol === 'http:', {
        timeout: 15_000,
      });
      if (!new URL(page.url()).pathname.endsWith('/prompt.html')) return;
      await expect(page.locator('#title')).not.toHaveText('Um momento…');
      const title = await page.locator('#title').innerText();
      if (title === 'Escolher pasta do projeto') {
        if (!plan.directory)
          throw new Error('Unexpected folder picker without a fixture directory');
        records.push(await chooseDirectory(page, plan.directory));
      } else {
        const choice = plan.confirmations[title];
        if (!choice) throw new Error(`Unexpected custom confirmation: ${title}`);
        records.push(await answerConfirmation(page, { title, ...choice }));
      }
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  app.on('window', observe);
  return {
    records,
    failures,
    stop: () => app.off('window', observe),
    settle: async () => {
      await Promise.all([...pending]);
    },
  };
}
