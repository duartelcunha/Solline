import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { removeRecoveryKey } from '../../src/main/recovery-key';
import { answerConfirmation } from './custom-prompts';

async function customWindow(app: ElectronApplication, file: string): Promise<Page> {
  await expect
    .poll(() => app.windows().some((page) => new URL(page.url()).pathname.endsWith(`/${file}`)))
    .toBe(true);
  const page = app.windows().find((page) => new URL(page.url()).pathname.endsWith(`/${file}`));
  if (!page) throw new Error(`Missing ${file}`);
  return page;
}

for (const theme of ['light', 'dark'] as const) {
  test(`janelas próprias: pasta, teclado e confiança · ${theme}`, async ({ browserName }, info) => {
    expect(browserName).toBe('chromium');
    expect(await readFile(resolve('out/qa-electron/main/engine.js'), 'utf8')).toContain(
      'solline-scripted-qa-agent',
    );
    const root = await mkdtemp(join(tmpdir(), 'solline-prompt-qa-'));
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('solline-prompt-qa-'))
      throw new Error('Unsafe fixture path');
    const project = join(root, 'project');
    await mkdir(project);
    for (const name of ['assets', 'docs', 'src']) await mkdir(join(project, name));
    const file = join(project, 'fixture.txt');
    await writeFile(file, 'Synthetic QA content.');
    const app = await electron.launch({
      args: [resolve('out/qa-electron/main/index.js')],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(
              name,
            ),
          ),
        ),
        SOLLINE_USER_DATA: join(root, 'data'),
        // The guarded QA engine stays isolated, but exercise the real custom notice window.
        SOLLINE_ISOLATED: '0',
      } as Record<string, string>,
    });
    const main = await app.firstWindow();
    try {
      await expect(main.getByTestId('ping-reply')).toBeAttached();
      if ((await main.locator('html').getAttribute('data-theme')) !== theme)
        await main.getByTestId('theme-toggle').click();
      await expect(main.locator('html')).toHaveAttribute('data-theme', theme);
      await main.getByTestId('add-project').click();
      const picker = await customWindow(app, 'prompt.html');
      await expect(
        picker.getByRole('heading', { name: 'Escolher pasta do projeto' }),
      ).toBeVisible();
      await expect(picker.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(picker.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
      const path = picker.getByRole('textbox', { name: 'Caminho da pasta' });
      await path.fill(file);
      await picker.getByRole('button', { name: 'Escolher esta pasta' }).click();
      await expect(picker.getByRole('alert')).toHaveText(
        'Escolhe uma pasta existente e acessível.',
      );
      await path.fill(project);
      await picker.getByRole('button', { name: 'Abrir', exact: true }).click();
      await expect(picker.locator('#folders').getByRole('button')).toHaveCount(3);
      await expect(picker.locator('#folders')).not.toContainText('fixture.txt');
      await picker.locator('#folders').focus();
      await picker.keyboard.press('ArrowDown');
      await expect(
        picker.locator('#folders').getByRole('button', { name: 'assets', exact: true }),
      ).toBeFocused();
      await picker.keyboard.press('Tab');
      await expect(picker.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
      await picker.evaluate(() => document.fonts.ready);
      await info.attach(`picker-${theme}`, {
        body: await picker.screenshot({ path: info.outputPath(`picker-${theme}.png`) }),
        contentType: 'image/png',
      });
      await picker.getByRole('button', { name: 'Escolher esta pasta' }).click();
      await expect.poll(() => picker.isClosed()).toBe(true);
      const confirmation = await customWindow(app, 'prompt.html');
      await expect(
        confirmation.getByRole('heading', { name: 'Confiança no projeto' }),
      ).toBeVisible();
      await expect(confirmation.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(
        confirmation.getByRole('button', { name: 'Não confiar', exact: true }),
      ).toBeFocused();
      await confirmation.evaluate(() => document.fonts.ready);
      await info.attach(`trust-${theme}`, {
        body: await confirmation.screenshot({ path: info.outputPath(`trust-${theme}.png`) }),
        contentType: 'image/png',
      });
      await answerConfirmation(confirmation, {
        title: 'Confiança no projeto',
        button: 'Não confiar',
        choice: 'cancel',
      });
      await expect(main.getByTestId('project-trust')).toHaveAttribute('aria-pressed', 'false');
      await main.getByTestId('new-session').click();
      await expect(main.getByTestId('composer-input')).toBeEnabled();
      const sessionId = await main.evaluate(async () => {
        const snapshot = await window.solline.request('engine.snapshot', {});
        return snapshot.sessions[0]?.session.id;
      });
      if (!sessionId) throw new Error('QA session missing');
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith('/index.html'),
        );
        if (!window) throw new Error('Main window missing');
        window.hide();
      });
      await main.evaluate(
        (id) => window.solline.request('session.send', { sessionId: id, text: 'QA: aviso real' }),
        sessionId,
      );
      const notice = await customWindow(app, 'attention.html');
      await expect(notice.locator('#body')).toHaveText('Precisa de ti');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            const main = windows.find((window) =>
              window.webContents.getURL().endsWith('/index.html'),
            );
            const notice = windows.find((window) =>
              window.webContents.getURL().endsWith('/attention.html'),
            );
            return {
              mainVisible: main?.isVisible(),
              noticeVisible: notice?.isVisible(),
              noticeFocused: notice?.isFocused(),
            };
          }),
        )
        .toEqual({ mainVisible: false, noticeVisible: true, noticeFocused: false });
      await notice.screenshot({ path: info.outputPath(`notice-real-${theme}.png`) });
      // Explicit synthetic typography probe, separate from the real needs-you event above.
      const longBody =
        Array.from({ length: 6 }, (_, index) => `Verificação extensa QA ${index + 1}`).join(', ') +
        ' falharam';
      await app.evaluate(
        ({ BrowserWindow }, value) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().endsWith('/attention.html'),
          );
          if (!window) throw new Error('Notice window missing');
          window.webContents.send('solline:attention-notice', value);
        },
        { title: 'Claude · Projeto de demonstração com nome comprido', body: longBody, theme },
      );
      await expect(notice.locator('#open')).toHaveAccessibleName(
        `Claude · Projeto de demonstração com nome comprido. ${longBody}. Abrir conversa`,
      );
      const bounds = await notice.locator('.hint').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
      });
      expect(bounds.top).toBeGreaterThan(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 8);
      await notice.screenshot({ path: info.outputPath(`notice-long-synthetic-${theme}.png`) });
      await notice.locator('#open').click();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
              candidate.webContents.getURL().endsWith('/index.html'),
            );
            return window?.isVisible();
          }),
        )
        .toBe(true);
      await expect(main.getByTestId('permission-card')).toBeVisible();
    } finally {
      // Recovery owns close even if a prompt is still open after an assertion failure.
      await main.evaluate(() => window.solline.window.action('close'));
      const recovery = await customWindow(app, 'recovery.html');
      await recovery.getByRole('button', { name: 'Fechar com segurança' }).click();
      await app.close();
      await removeRecoveryKey(join(root, 'data'));
      await rm(root, { recursive: true, force: true });
    }
  });
}
