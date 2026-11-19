import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { removeRecoveryKey } from '../../src/main/recovery-key';
import { answerConfirmation, chooseDirectory } from './custom-prompts';
import {
  OwnedProcessTree,
  cleanupOwnedFixture,
  stopOwnedProcesses,
  type CleanupReport,
} from './owned-process';

const tempBase = () => realpathSync.native(tmpdir());

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}`);
  return value;
}
async function removeOwnedFixture(
  owner: OwnedProcessTree | undefined,
  root: string,
  record: (report: CleanupReport) => Promise<void>,
) {
  if (
    dirname(root) !== resolve(tempBase()) ||
    !basename(root).startsWith('solline-native-motion-qa-')
  )
    throw new Error('Unsafe fixture cleanup');
  await cleanupOwnedFixture(
    () => stopOwnedProcesses([required(owner, 'owned native process')], record),
    () => removeRecoveryKey(join(root, 'data')),
    () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
  );
}

test('janela nativa oculta cancela animações e recupera o olhar ao voltar', async ({
  browserName,
}, info) => {
  expect(browserName).toBe('chromium');
  expect(await readFile(resolve('out/qa-electron/main/engine.js'), 'utf8')).toContain(
    'solline-scripted-qa-agent',
  );
  const root = await mkdtemp(join(tempBase(), 'solline-native-motion-qa-'));
  if (
    dirname(root) !== resolve(tempBase()) ||
    !basename(root).startsWith('solline-native-motion-qa-')
  )
    throw new Error('Unsafe QA root');
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'notes.txt'), 'Original.\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Solline QA');
  git('config', 'user.email', 'qa@solline.local');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-qm', 'Native motion fixture');
  // electron.launch installs focus emulation on its original CDP session.
  // A second session cannot reliably undo it. Start native Electron directly and
  // skip overrides from the FIRST public connection, as in the native hang test.
  const executable = createRequire(resolve('package.json'))('electron') as string;
  const child = spawn(
    executable,
    ['--inspect=0', '--remote-debugging-port=0', resolve('out/qa-electron/main/index.js')],
    {
      windowsHide: true,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(
              name,
            ),
          ),
        ),
        SOLLINE_USER_DATA: join(root, 'data'),
        SOLLINE_ISOLATED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let owner: OwnedProcessTree | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let inspector: WebSocket | undefined;
  let endpoint = '',
    inspectorEndpoint = '',
    inspectorId = 0;
  const output: string[] = [];
  const errors: string[] = [];
  for (const source of [child.stdout, child.stderr])
    source.on('data', (chunk: Buffer) => {
      const value = chunk.toString();
      output.push(value);
      endpoint ||= value.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? '';
      inspectorEndpoint ||= value.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] ?? '';
    });
  const mainEvaluate = (expression: string) =>
    new Promise<unknown>((resolve, reject) => {
      const client = required(inspector, 'main inspector');
      const id = ++inspectorId;
      const timeout = setTimeout(() => {
        client.removeEventListener('message', receive);
        reject(new Error('Main inspector did not respond'));
      }, 5000);
      const receive = (event: MessageEvent) => {
        const response = JSON.parse(String(event.data)) as {
          id?: number;
          error?: unknown;
          result?: { exceptionDetails?: unknown; result?: { value?: unknown } };
        };
        if (response.id !== id) return;
        clearTimeout(timeout);
        client.removeEventListener('message', receive);
        if (response.error || response.result?.exceptionDetails)
          reject(new Error(JSON.stringify(response.error ?? response.result?.exceptionDetails)));
        else resolve(response.result?.result?.value);
      };
      client.addEventListener('message', receive);
      client.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  let windowId: number | undefined;
  const nativeVisibility = async (show: boolean | null) =>
    mainEvaluate(`(() => {
    const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
    const win = BrowserWindow.fromId(${required(windowId, 'bound main window')});
    if (!win || win.isDestroyed()) throw new Error('Bound main window disappeared');
    ${show === null ? '' : show ? 'win.show(); win.focus();' : 'win.hide();'}
    return { visible: win.isVisible(), focused: win.isFocused() };
  })()`);
  try {
    const nativePid = required(child.pid, 'native child PID');
    await expect.poll(() => endpoint).not.toBe('');
    await expect.poll(() => inspectorEndpoint).not.toBe('');
    inspector = new WebSocket(inspectorEndpoint);
    await expect.poll(() => required(inspector, 'main inspector').readyState).toBe(WebSocket.OPEN);
    // Direct native child PID, not Playwright's Windows loader PID.
    expect(await mainEvaluate('process.pid')).toBe(child.pid);
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = required(browser.contexts()[0], 'native default context');
    context.on('page', (target) => target.on('pageerror', (error) => errors.push(error.message)));
    await expect
      .poll(() => context.pages().some((target) => target.url().endsWith('/index.html')), {
        timeout: 35_000,
      })
      .toBe(true);
    page = required(
      context.pages().find((target) => target.url().endsWith('/index.html')),
      'main renderer',
    );
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (entry) => {
      if (entry.type() === 'error') errors.push(entry.text());
    });
    await expect(page.getByTestId('ping-reply')).toBeAttached({ timeout: 30_000 });
    owner = await OwnedProcessTree.create(nativePid, () => {
      if (child.pid !== nativePid || child.exitCode !== null || child.signalCode !== null)
        throw new Error('Original native child exited during capture');
    });
    const nativeId = await mainEvaluate(`(() => {
      const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
      return BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'))?.id;
    })()`);
    if (typeof nativeId !== 'number') throw new Error('Main BrowserWindow missing');
    windowId = nativeId;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByTestId('add-project').click();
    const prompt = async () => {
      // App-owned prompts use a separate partition and therefore a separate CDP context.
      const pages = () =>
        required(browser, 'native browser')
          .contexts()
          .flatMap((entry) => entry.pages());
      await expect
        .poll(() =>
          pages().some((target) => new URL(target.url()).pathname.endsWith('/prompt.html')),
        )
        .toBe(true);
      return required(
        pages().find((target) => new URL(target.url()).pathname.endsWith('/prompt.html')),
        'custom prompt',
      );
    };
    const picker = await prompt();
    await chooseDirectory(picker, project);
    await expect.poll(() => picker.isClosed()).toBe(true);
    await answerConfirmation(await prompt(), {
      title: 'Confiança no projeto',
      button: 'Confiar',
      choice: 'accept',
    });
    await expect(page.getByTestId('project-trust')).toHaveAttribute('aria-pressed', 'true');
    await nativeVisibility(true);
    await expect.poll(() => nativeVisibility(null)).toEqual({ visible: true, focused: true });
    await page.getByTestId('new-session').click();
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    await page.getByTestId('composer-input').fill('QA: trabalho contínuo');
    await page.getByTestId('composer-input').press('Enter');
    const bot = page.getByRole('img', { name: 'Claude: a trabalhar', exact: true });
    const pupils = bot.getByTestId('bot-pupils');
    const displacement = () =>
      pupils.evaluate((el) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return Math.hypot(matrix.m41, matrix.m42);
      });
    const browserState = () =>
      required(page, 'main renderer').evaluate(() => ({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      }));
    const observed = async () => ({
      browser: await browserState(),
      bot: await bot.evaluate((el) => ({
        live: el.getAttribute('data-live'),
        gaze: el.getAttribute('data-gaze-active'),
        animations: el
          .getAnimations({ subtree: true })
          .map((animation) => ({ state: animation.playState, time: animation.currentTime })),
      })),
      pupils: await pupils.evaluate((el) => ({
        inline: el.getAttribute('style'),
        transform: getComputedStyle(el).transform,
        transition: getComputedStyle(el).transitionDuration,
      })),
    });
    await expect.poll(browserState).toEqual({ visibility: 'visible', focused: true });
    await expect.poll(() => nativeVisibility(null)).toEqual({ visible: true, focused: true });
    await expect(bot).toHaveAttribute('data-live', 'true');
    await expect(bot).toHaveAttribute('data-gaze-active', 'true');
    await expect
      .poll(() =>
        bot.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === 'running').length,
        ),
      )
      .toBeGreaterThan(0);
    await page.mouse.move(1000, 500);
    await expect.poll(displacement).toBeGreaterThan(0);
    await info.attach('native-active-state', {
      body: JSON.stringify(await observed()),
      contentType: 'application/json',
    });
    try {
      const native = await nativeVisibility(false);
      await info.attach('native-hide-diagnostic', {
        body: JSON.stringify({
          native,
          ...(await observed()),
          method:
            'Direct native Electron; public connectOverCDP noDefaults from first attachment; real BrowserWindow.hide.',
        }),
        contentType: 'application/json',
      });
      expect(native).toEqual({ visible: false, focused: false });
      // Production keeps normal background throttling. No document/focus patching.
      await expect.poll(browserState).toEqual({ visibility: 'hidden', focused: false });
      await expect(bot).toHaveAttribute('data-live', 'false');
      await expect(bot).toHaveAttribute('data-gaze-active', 'false');
      await expect(pupils).toHaveCSS('transition-duration', '0s');
      await expect.poll(displacement).toBe(0);
      await expect
        .poll(() => bot.evaluate((el) => el.getAnimations({ subtree: true }).length))
        .toBe(0);
    } finally {
      try {
        await info.attach('native-final-hidden-state', {
          body: JSON.stringify(await observed()),
          contentType: 'application/json',
        });
      } finally {
        await nativeVisibility(true);
      }
    }
    await expect.poll(() => nativeVisibility(null)).toEqual({ visible: true, focused: true });
    await expect.poll(browserState).toEqual({ visibility: 'visible', focused: true });
    await expect(bot).toHaveAttribute('data-live', 'true');
    await expect(bot).toHaveAttribute('data-gaze-active', 'true');
    await expect
      .poll(() =>
        bot.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === 'running').length,
        ),
      )
      .toBeGreaterThan(0);
    await page.mouse.move(200, 500);
    await expect.poll(displacement).toBeGreaterThan(0);
    await info.attach('native-shown-state', {
      body: JSON.stringify(await observed()),
      contentType: 'application/json',
    });
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Original.\n');
    const screenshot = info.outputPath('native-focus-resumed.png');
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    await info.attach('native-focus-resumed', { path: screenshot, contentType: 'image/png' });
    expect(errors).toEqual([]);
  } finally {
    try {
      await owner?.refresh();
      await info.attach('native-launch-output', {
        body: output.join(''),
        contentType: 'text/plain',
      });
    } finally {
      try {
        try {
          await browser?.close();
        } finally {
          inspector?.close();
        }
      } finally {
        if (owner) {
          await removeOwnedFixture(owner, root, async (report) => {
            await info.attach('owned-process-cleanup', {
              body: JSON.stringify(report),
              contentType: 'application/json',
            });
          });
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
    }
  }
  if (!owner) throw new Error('Missing owned native process');
});
