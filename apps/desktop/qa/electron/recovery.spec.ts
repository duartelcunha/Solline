import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  _electron as electron,
  chromium,
  expect,
  test as base,
  type ElectronApplication,
  type Browser,
  type Page,
} from '@playwright/test';
import { removeRecoveryKey } from '../../src/main/recovery-key';
import { answerConfirmation, chooseDirectory, observePrompts } from './custom-prompts';

type Fixture = {
  app: () => ElectronApplication;
  page: Page;
  project: string;
  launch: () => Promise<Page>;
  recovery: () => Promise<Page>;
  shot: (page: Page, name: string) => Promise<void>;
  nativeShot: (name: string) => Promise<void>;
  saveTrace: () => Promise<void>;
};
const test = base.extend<{ qa: Fixture }>({
  qa: async ({ browserName }, use, info) => {
    expect(browserName).toBe('chromium');
    // Guard before startup: this suite must never load a real SDK/provider factory.
    expect(await readFile(resolve('out/qa-electron/main/engine.js'), 'utf8')).toContain(
      'solline-scripted-qa-agent',
    );
    const root = await mkdtemp(join(tmpdir(), 'solline-recovery-qa-'));
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('solline-recovery-qa-'))
      throw new Error('Unsafe QA root');
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'notes.txt'), 'Original.\n');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Solline QA');
    git('config', 'user.email', 'qa@solline.local');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-qm', 'Recovery fixture');
    const applications: ElectronApplication[] = [];
    const nativePids = new Map<ElectronApplication, number>();
    const prompts: ReturnType<typeof observePrompts>[] = [];
    const errors: string[] = [];
    const logs: { stream: string; text: string }[] = [];
    let app: ElectronApplication;
    let generation = 0;
    const traced = new Set<ElectronApplication>();
    const observed = new WeakSet<Page>();
    const observe = (page: Page) => {
      if (observed.has(page)) return;
      observed.add(page);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
    };
    const saveTrace = async (application = app) => {
      if (traced.has(application)) return;
      const trace = info.outputPath(`recovery-${generation++}.zip`);
      await application.context().tracing.stop({ path: trace });
      traced.add(application);
      await info.attach('recovery-trace', { path: trace, contentType: 'application/zip' });
    };
    const launch = async () => {
      app = await electron.launch({
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
          SOLLINE_ISOLATED: '1',
        } as Record<string, string>,
      });
      applications.push(app);
      nativePids.set(app, await app.evaluate(() => process.pid));
      prompts.push(
        observePrompts(app, {
          directory: project,
          confirmations: { 'Confiança no projeto': { button: 'Confiar', choice: 'accept' } },
        }),
      );
      for (const [stream, source] of [
        ['stdout', app.process().stdout],
        ['stderr', app.process().stderr],
      ] as const)
        source?.on('data', (data: Buffer) => logs.push({ stream, text: data.toString('utf8') }));
      app.on('window', observe);
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await app.firstWindow();
      observe(page);
      await expect(page.getByTestId('ping-reply')).toBeAttached({ timeout: 20_000 });
      const agents = await page.evaluate(() => window.solline.request('agents.list', {}));
      expect(agents.agents.map((agent) => agent.label)).toEqual(['Claude QA']);
      return page;
    };
    const recovery = async () => {
      await expect
        .poll(() => app.windows().some((page) => page.url().endsWith('/recovery.html')))
        .toBe(true);
      const page = app.windows().find((page) => page.url().endsWith('/recovery.html'));
      if (!page) throw new Error('Independent recovery renderer missing');
      await expect(page.getByRole('heading')).toBeVisible();
      const notice = await page.evaluate(() => window.sollineRecovery.notice());
      await expect(page.locator(notice.canWait ? '#wait' : '#restore')).toBeFocused();
      const geometry = await page.getByRole('button').evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return {
            visible: box.width > 0 && box.height > 0,
            contained:
              box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          };
        }),
      );
      expect(geometry.filter((button) => button.visible).every((button) => button.contained)).toBe(
        true,
      );
      return page;
    };
    const shot = async (page: Page, name: string) => {
      const file = info.outputPath(`${name}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      await info.attach(name, { path: file, contentType: 'image/png' });
    };
    const nativeShot = async (name: string) => {
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().endsWith('/index.html'),
        );
        if (!win) throw new Error('Main window missing');
        return (await win.webContents.capturePage()).toPNG().toString('base64');
      });
      const file = info.outputPath(`${name}.png`);
      await writeFile(file, Buffer.from(png, 'base64'));
      await info.attach(name, { path: file, contentType: 'image/png' });
    };
    try {
      const page = await launch();
      await page.getByTestId('add-project').click();
      await expect(page.getByTestId('project-trust')).toHaveAttribute('aria-pressed', 'true');
      await use({ app: () => app, page, project, launch, recovery, shot, nativeShot, saveTrace });
      for (const prompt of prompts) {
        await prompt.settle();
        expect(prompt.failures).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally {
      try {
        for (const prompt of prompts) prompt.stop();
        await info.attach('custom-prompt-evidence', {
          body: JSON.stringify(
            prompts.map((prompt) => ({ records: prompt.records, failures: prompt.failures })),
            null,
            2,
          ),
          contentType: 'application/json',
        });
        await info.attach('main-utility-output', {
          body: JSON.stringify(logs, null, 2),
          contentType: 'application/json',
        });
        for (const application of applications) {
          if (!application.windows().some((page) => !page.isClosed())) continue;
          await saveTrace(application).catch(async (error) => {
            await info.attach('trace-unavailable', {
              body: String(error),
              contentType: 'text/plain',
            });
          });
        }
      } finally {
        try {
          for (const application of applications) {
            const pid = nativePids.get(application);
            if (!pid || !alive(pid)) continue;
            // Failure cleanup only: this PID belongs to the exact application launched above.
            // A hung renderer/custom close dialog must never leak its utility/provider tree.
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'pipe',
            });
            await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
          }
        } finally {
          try {
            await removeRecoveryKey(join(root, 'data'));
          } finally {
            await rm(root, { recursive: true, force: true, maxRetries: 3 });
          }
        }
      }
    }
  },
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}`);
  return value;
}

async function begin(page: Page, text: string) {
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('permission-card')).toBeVisible();
  const snapshot = await page.evaluate(() => window.solline.request('engine.snapshot', {}));
  const id = snapshot.sessions[0]?.session.id;
  if (!id) throw new Error('Missing real engine session');
  return id;
}
async function savedDraft(page: Page, sessionId: string, text: string) {
  await page.getByTestId('composer-input').fill(text);
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.solline.recovery.ui().then((state) => state.drafts[id]?.text),
        sessionId,
      ),
    )
    .toBe(text);
}
async function restore(qa: Fixture) {
  const recovery = await qa.recovery();
  await recovery.getByRole('button', { name: 'Restaurar interface', exact: true }).click();
  // Playwright permanently marks its Page/CDP session crashed, even after native
  // reload succeeds. Read the actual restored renderer through public Electron
  // APIs; never reset private Playwright state or inject a replacement store.
  await expect
    .poll(() =>
      qa.app().evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().endsWith('/index.html'),
        );
        if (!win || win.webContents.isCrashed() || win.webContents.isLoading()) return false;
        return win.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-testid="composer-input"]'))`,
        );
      }),
    )
    .toBe(true);
  return qa.app().evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('/index.html'),
    );
    if (!win) throw new Error('Main window missing');
    return win.webContents.executeJavaScript(`(async () => ({
      text: document.querySelector('[data-testid="composer-input"]').value,
      pending: document.querySelectorAll('[data-testid="permission-card"]').length,
      ping: await window.solline.request('engine.ping', {}),
      snapshot: await window.solline.request('engine.snapshot', {})
    }))()`);
  }) as Promise<{ text: string; pending: number; ping: { pid: number } }>;
}

test('renderer crash preserves acknowledged draft and pending permission without restarting engine', async ({
  qa,
}) => {
  const id = await begin(qa.page, 'Pedido antes da falha');
  await savedDraft(qa.page, id, 'Rascunho confirmado antes da falha');
  const before = await qa.page.evaluate(() => window.solline.request('engine.ping', {}));
  await qa.app().evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (win) => !win.webContents.getURL().endsWith('/recovery.html'),
    );
    if (!window) throw new Error('Main window missing');
    window.webContents.forcefullyCrashRenderer();
  });
  const recovery = await qa.recovery();
  expect(await recovery.evaluate(() => typeof window.solline)).toBe('undefined');
  await qa.shot(recovery, 'independent-renderer-crash-warning');
  const restored = await restore(qa);
  expect(restored.text).toBe('Rascunho confirmado antes da falha');
  expect(restored.pending).toBe(1);
  expect(restored.ping.pid).toBe(before.pid);
  expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe('Original.\n');
  await qa.nativeShot('renderer-restored-pending-request');
});

base(
  'independent recovery renderer stays responsive during a real bounded UI hang',
  async ({ browserName }, info) => {
    expect(browserName).toBe('chromium');
    expect(await readFile(resolve('out/qa-electron/main/engine.js'), 'utf8')).toContain(
      'solline-scripted-qa-agent',
    );
    const root = await mkdtemp(join(tmpdir(), 'solline-native-hang-qa-'));
    if (
      dirname(root) !== resolve(tmpdir()) ||
      !basename(root).startsWith('solline-native-hang-qa-')
    )
      throw new Error('Unsafe QA root');
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'notes.txt'), 'Original.\n');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, windowsHide: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Solline QA');
    git('config', 'user.email', 'qa@solline.local');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-qm', 'Native recovery fixture');
    // The Playwright Electron loader forces --disable-hang-monitor. Launch the same
    // QA entry directly, without that loader, and attach only via the public CDP API.
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
    let browser: Browser | undefined;
    const output: string[] = [];
    let endpoint = '';
    let inspectorEndpoint = '';
    let inspector: WebSocket | undefined;
    let inspectorId = 0;
    for (const source of [child.stdout, child.stderr])
      source.on('data', (chunk: Buffer) => {
        const value = chunk.toString();
        output.push(value);
        endpoint ||= value.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? '';
        inspectorEndpoint ||= value.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] ?? '';
      });
    const errors: string[] = [];
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
    const connect = async () => {
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      const context = required(browser.contexts()[0], 'native browser context');
      context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
      return context;
    };
    try {
      await expect.poll(() => endpoint).not.toBe('');
      await expect.poll(() => inspectorEndpoint).not.toBe('');
      inspector = new WebSocket(inspectorEndpoint);
      await expect
        .poll(() => required(inspector, 'main inspector').readyState)
        .toBe(WebSocket.OPEN);
      const context = await connect();
      await expect
        .poll(() => context.pages().some((page) => page.url().endsWith('/index.html')))
        .toBe(true);
      const page = required(
        context.pages().find((page) => page.url().endsWith('/index.html')),
        'main renderer',
      );
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByTestId('ping-reply')).toBeAttached({ timeout: 20_000 });
      await page.getByTestId('add-project').click();
      const promptPage = async () => {
        await expect
          .poll(() =>
            required(browser, 'native browser')
              .contexts()
              .flatMap((context) => context.pages())
              .some((page) => new URL(page.url()).pathname.endsWith('/prompt.html')),
          )
          .toBe(true);
        return required(
          required(browser, 'native browser')
            .contexts()
            .flatMap((context) => context.pages())
            .find((page) => new URL(page.url()).pathname.endsWith('/prompt.html')),
          'custom prompt',
        );
      };
      const picker = await promptPage();
      await chooseDirectory(picker, project);
      await expect.poll(() => picker.isClosed()).toBe(true);
      await answerConfirmation(await promptPage(), {
        title: 'Confiança no projeto',
        button: 'Confiar',
        choice: 'accept',
      });
      await expect(page.getByTestId('project-trust')).toHaveAttribute('aria-pressed', 'true');
      const id = await begin(page, 'Pedido antes do bloqueio');
      await savedDraft(page, id, 'Rascunho guardado antes do bloqueio');
      const before = await page.evaluate(() => window.solline.request('engine.ping', {}));
      await page.bringToFront();
      await expect
        .poll(() =>
          page.evaluate(() => ({
            visible: document.visibilityState,
            focused: document.hasFocus(),
          })),
        )
        .toEqual({ visible: 'visible', focused: true });
      const started = Date.now();
      // An attached renderer debugger can suppress Chromium's hung-renderer
      // detection. Observe target discovery over HTTP while fully detached.
      await required(browser, 'native browser').close();
      await mainEvaluate(`(async () => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'));
        win.webContents.on('console-message', event => { if (event.message === 'QA native hang entered') console.log(event.message); });
        await win.webContents.executeJavaScript("document.addEventListener('keydown', event => { event.preventDefault(); event.stopImmediatePropagation(); console.log('QA native hang entered'); const until = Date.now() + 30000; while(Date.now() < until) {} }, { once: true, capture: true });");
      })()`);
      // The main-process inspector does not attach a renderer debugger. Send real
      // native input only after renderer CDP has detached, retaining the watchdog.
      expect(
        await mainEvaluate(`(() => {
        const { BrowserWindow, app } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'));
        win.show();
        win.focus();
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F8' });
        return { disabled: app.commandLine.hasSwitch('disable-hang-monitor'), visible: win.isVisible(), focused: win.isFocused() };
      })()`),
      ).toEqual({ disabled: false, visible: true, focused: true });
      await expect.poll(() => output.join('').includes('QA native hang entered')).toBe(true);
      const discovery = new URL(endpoint);
      discovery.protocol = 'http:';
      discovery.pathname = '/json/list';
      await expect
        .poll(async () => {
          const targets = (await (await fetch(discovery)).json()) as { url: string }[];
          return targets.some((target) => target.url.endsWith('/recovery.html'));
        })
        .toBe(true);
      const recoveryScript = (script: string) =>
        mainEvaluate(`(async () => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/recovery.html'));
        return win.webContents.executeJavaScript(${JSON.stringify(script)});
      })()`);
      await expect
        .poll(() =>
          recoveryScript(
            `(async () => ({ reason: (await window.sollineRecovery.notice()).reason, focused: document.activeElement.id }))()`,
          ),
        )
        .toEqual({ reason: 'unresponsive', focused: 'wait' });
      const identities = await mainEvaluate(`(() => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        return BrowserWindow.getAllWindows().filter(win => ['/index.html', '/recovery.html'].some(file => win.webContents.getURL().endsWith(file))).map(win => win.webContents.getOSProcessId());
      })()`);
      if (!Array.isArray(identities)) throw new Error('Native renderer identities missing');
      expect(identities).toHaveLength(2);
      expect(new Set(identities).size).toBe(2);
      expect(
        await recoveryScript(
          `Array.from(document.querySelectorAll('button')).filter(button => !button.hidden).every(button => { const box = button.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; })`,
        ),
      ).toBe(true);
      expect(Date.now() - started).toBeLessThan(30_000);
      const png = await mainEvaluate(`(async () => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/recovery.html'));
        return (await win.webContents.capturePage()).toPNG().toString('base64');
      })()`);
      if (typeof png !== 'string') throw new Error('Recovery capture missing');
      const pngPath = info.outputPath('native-unresponsive-warning.png');
      await writeFile(pngPath, Buffer.from(png, 'base64'));
      await info.attach('native-unresponsive-warning', {
        path: pngPath,
        contentType: 'image/png',
      });
      await recoveryScript(`document.getElementById('restore').click()`);
      await expect
        .poll(() =>
          mainEvaluate(`(async () => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'));
        const recovery = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/recovery.html'));
        if (recovery?.isVisible()) return false;
        if (win.webContents.isCrashed() || win.webContents.isLoading()) return false;
        return win.webContents.executeJavaScript("Boolean(document.querySelector('[data-testid=composer-input]'))");
      })()`),
        )
        .toBe(true);
      // Reattach only after the explicit restore completes. Connecting while the
      // main renderer is blocked waits for it and would invalidate independence.
      const restoredContext = await connect();
      await expect
        .poll(() => restoredContext.pages().some((page) => page.url().endsWith('/index.html')))
        .toBe(true);
      const restored = required(
        restoredContext.pages().find((page) => page.url().endsWith('/index.html')),
        'restored renderer',
      );
      await expect(restored.getByTestId('composer-input')).toHaveValue(
        'Rascunho guardado antes do bloqueio',
      );
      await expect(restored.getByTestId('permission-card')).toBeVisible();
      expect((await restored.evaluate(() => window.solline.request('engine.ping', {}))).pid).toBe(
        before.pid,
      );
      expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Original.\n');
      expect(errors).toEqual([]);
    } finally {
      try {
        if (browser?.isConnected()) {
          const session = await browser.newBrowserCDPSession();
          await info.attach('native-target-inventory', {
            body: JSON.stringify({
              contexts: browser
                .contexts()
                .map((context) => context.pages().map((page) => page.url())),
              targets: await session.send('Target.getTargets'),
            }),
            contentType: 'application/json',
          });
          await session.detach();
        }
        await info.attach('native-launch-output', {
          body: output.join(''),
          contentType: 'text/plain',
        });
        await browser?.close();
        inspector?.close();
      } finally {
        try {
          const pid = child.pid;
          if (pid && alive(pid)) {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'pipe',
            });
            await expect.poll(() => alive(pid)).toBe(false);
          }
        } finally {
          try {
            await removeRecoveryKey(join(root, 'data'));
          } finally {
            await rm(root, { recursive: true, force: true, maxRetries: 3 });
          }
        }
      }
    }
  },
);

test('actual window close warns and restart restores exact text, paused queue and checkpoints without replay', async ({
  qa,
}) => {
  const id = await begin(qa.page, 'Alteração confirmada antes de fechar');
  await qa.page.getByRole('button', { name: /^Permitir uma vez/ }).click();
  await expect(qa.page.getByTestId('session-row').first()).toHaveAttribute('data-state', 'idle');
  await expect
    .poll(() => readFile(join(qa.project, 'notes.txt'), 'utf8'))
    .toBe('Alteração revista.\n');
  await qa.page.getByTestId('composer-input').fill('Pedido ainda por autorizar');
  await qa.page.getByTestId('composer-input').press('Enter');
  await expect(qa.page.getByTestId('permission-card')).toBeVisible();
  await qa.page.getByTestId('composer-input').fill('Texto em fila, sem envio automático');
  await qa.page.getByTestId('composer-input').press('Enter');
  await savedDraft(qa.page, id, 'Rascunho exato\ncom duas linhas.');
  await qa.page.evaluate(() => window.solline.request('engine.flush', {}));
  const before = await qa.page.evaluate(() => window.solline.request('engine.snapshot', {}));
  await qa.page.getByRole('button', { name: 'Controlos da janela', exact: true }).focus();
  await qa.page.getByRole('button', { name: 'Fechar janela', exact: true }).click();
  const recovery = await qa.recovery();
  await qa.shot(recovery, 'close-warning-before-preservation');
  await qa.saveTrace();
  const exited = new Promise<void>((resolve) =>
    qa
      .app()
      .process()
      .once('exit', () => resolve()),
  );
  await recovery.getByRole('button', { name: 'Fechar com segurança', exact: true }).click();
  await exited;
  const page = await qa.launch();
  await expect(page.getByTestId('composer-input')).toHaveValue('Rascunho exato\ncom duas linhas.');
  const after = await page.evaluate(() => window.solline.request('engine.snapshot', {}));
  expect(after.sessions).toHaveLength(1);
  expect(after.sessions[0]?.interrupted).toBe(true);
  expect(after.sessions[0]?.queue).toEqual({ ...before.sessions[0]?.queue, paused: true });
  expect(after.sessions[0]?.turns.filter((turn) => turn.role === 'user')).toEqual(
    before.sessions[0]?.turns.filter((turn) => turn.role === 'user'),
  );
  expect(after.sessions[0]?.timeline?.checkpoints.map((point) => point.turnId)).toEqual(
    before.sessions[0]?.timeline?.checkpoints.map((point) => point.turnId),
  );
  await expect(page.getByTestId('permission-card')).toHaveCount(0);
  expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
  await qa.shot(page, 'whole-app-restored-without-replay');
});

test('window IPC rejects unknown actions and observes native maximize without optimistic state', async ({
  qa,
}) => {
  await expect(
    qa.page.evaluate(() => window.solline.window.action('destroy' as 'close')),
  ).rejects.toThrow();
  const initial = await qa.page.evaluate(() => window.solline.window.state());
  await qa.app().evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith('/index.html'))
      ?.maximize(),
  );
  await expect
    .poll(() => qa.page.evaluate(() => window.solline.window.state()))
    .toMatchObject({ maximized: true });
  await qa.page.getByRole('button', { name: 'Controlos da janela', exact: true }).focus();
  await expect(
    qa.page.getByRole('button', { name: 'Restaurar tamanho da janela', exact: true }),
  ).toBeVisible();
  const maximized = await qa.page.evaluate(() => window.solline.window.state());
  expect(maximized.revision).toBeGreaterThan(initial.revision);
  await qa.page.keyboard.press('Escape');
  await expect(
    qa.page.getByRole('button', { name: 'Controlos da janela', exact: true }),
  ).toBeFocused();
  await expect(qa.page.getByTestId('window-controls')).toHaveAttribute('data-open', 'false');
  await expect(
    qa.page.getByRole('button', { name: 'Restaurar tamanho da janela', exact: true }),
  ).toBeHidden();
  expect(
    await qa.app().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().endsWith('/index.html'))
        ?.isMaximized(),
    ),
  ).toBe(true);
});

test('abrupt whole-process loss restores acknowledged draft and paused work without replay', async ({
  qa,
}) => {
  const id = await begin(qa.page, 'Pedido pendente antes de terminar o processo');
  await qa.page.getByTestId('composer-input').fill('Fila confirmada antes da falha');
  await qa.page.getByTestId('composer-input').press('Enter');
  await savedDraft(qa.page, id, 'Rascunho confirmado sem fecho normal');
  const before = await qa.page.evaluate(() => window.solline.request('engine.snapshot', {}));
  expect(before.sessions[0]?.queue.items.map((item) => item.text)).toEqual([
    'Fila confirmada antes da falha',
  ]);
  await qa.saveTrace();
  const pid = await qa.app().evaluate(() => process.pid);
  // Deliberately bypass every close handler: exercise the acknowledged append journal.
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'pipe',
  });
  await expect.poll(() => alive(pid)).toBe(false);
  const page = await qa.launch();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'Rascunho confirmado sem fecho normal',
  );
  const after = await page.evaluate(() => window.solline.request('engine.snapshot', {}));
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.sessions[0]?.queue).toEqual({ ...before.sessions[0]?.queue, paused: true });
  expect(after.sessions[0]?.interrupted).toBe(true);
  expect(after.sessions[0]?.turns.filter((turn) => turn.role === 'user')).toEqual(
    before.sessions[0]?.turns.filter((turn) => turn.role === 'user'),
  );
  await expect(page.getByTestId('permission-card')).toHaveCount(0);
  expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe('Original.\n');
  await qa.shot(page, 'abrupt-process-loss-restored');
});
