import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { removeRecoveryKey } from '../../src/main/recovery-key';
import { WorktreeManager } from '../../../../packages/engine/src/worktrees/worktrees';
import { observePrompts, type PromptRecord } from './custom-prompts';
import { _electron as electron, test as base, expect, type Page } from '@playwright/test';

type Qa = {
  page: Page;
  project: string;
  worktreeRoot: string;
  git: (...args: string[]) => string;
  restart: () => Promise<Page>;
  restoreEngine: () => Promise<Page>;
  shot: (name: string) => Promise<void>;
  trustChoice: (trusted: boolean) => void;
  prompts: () => PromptRecord[];
};
async function removeFixture(root: string) {
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('solline-redesign-qa-')) {
    throw new Error('Unsafe fixture cleanup');
  }
  await rm(root, { recursive: true, force: true });
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
// Playwright's Windows loader ChildProcess is not the native Electron PID.
// Bind forced cleanup to the OS process start identity to reject PID reuse.
function nativeIdentity(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned native PID');
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop | ForEach-Object { $_.CreationDate.ToUniversalTime().Ticks.ToString() }`,
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
  ).trim();
}

const test = base.extend<{ qa: Qa }>({
  qa: async ({ browserName }, use, info) => {
    expect(browserName).toBe('chromium');
    // Fail closed BEFORE startup: never accidentally launch the real-agent build.
    expect(await readFile(resolve('out/qa-electron/main/engine.js'), 'utf8')).toContain(
      'solline-scripted-qa-agent',
    );
    const root = await mkdtemp(join(tmpdir(), 'solline-redesign-qa-'));
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'notes.txt'), 'Original.\n');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Solline QA');
    git('config', 'user.email', 'qa@solline.local');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-qm', 'Fixture');
    const launch = () =>
      electron.launch({
        args: [resolve('out/qa-electron/main/index.js')],
        env: {
          // Keep launch traces free of inherited credentials. The fixture needs only OS paths.
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
    let app = await launch();
    let nativePid = await app.evaluate(() => process.pid);
    const ownedProcesses = [{ pid: nativePid, identity: nativeIdentity(nativePid) }];
    const promptRecords: PromptRecord[] = [];
    const promptFailures: string[] = [];
    const promptPlan = {
      directory: project,
      confirmations: {
        'Confiança no projeto': { button: 'Confiar', choice: 'accept' as 'accept' | 'cancel' },
        'Preparação das worktrees': { button: 'Preparar', choice: 'accept' as const },
        'Deitar fora': { button: 'Deitar fora', choice: 'accept' as const },
      },
    };
    let prompts = observePrompts(app, promptPlan);
    const collectPrompts = async () => {
      await prompts.settle();
      prompts.stop();
      promptRecords.push(...prompts.records);
      promptFailures.push(...prompts.failures);
    };
    const safeClose = async () => {
      const main = app
        .windows()
        .find((page) => new URL(page.url()).pathname.endsWith('/index.html'));
      if (!main || main.isClosed()) return;
      await main.evaluate(() => window.solline.window.action('close'));
      await expect
        .poll(() => app.windows().some((page) => page.url().endsWith('/recovery.html')))
        .toBe(true);
      const recovery = app.windows().find((page) => page.url().endsWith('/recovery.html'));
      if (!recovery) throw new Error('Recovery window missing');
      await recovery.getByRole('button', { name: 'Fechar com segurança' }).click();
      // A rejected safe close must fail, never leave app.close waiting indefinitely.
      await expect
        .poll(() => alive(nativePid), {
          timeout: 10_000,
          message: 'Confirmed safe close must exit the owned native process',
        })
        .toBe(false);
      await app.close();
    };
    const errors: string[] = [];
    const processLog: { at: string; stream: string; text: string }[] = [];
    const eventJournal: { generation: number; events: unknown[] }[] = [];
    let generation = 0;
    let flushEvents = () => Promise.resolve();
    const connect = async () => {
      const child = app.process();
      for (const [stream, source] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ] as const)
        source?.on('data', (data: Buffer) =>
          processLog.push({ at: new Date().toISOString(), stream, text: data.toString('utf8') }),
        );
      const page = await app.firstWindow();
      const journal = await page.evaluateHandle(() => {
        const events: { at: number; event: unknown }[] = [];
        const stop = window.solline.onEvent((event) =>
          events.push({ at: performance.now(), event }),
        );
        return { events, stop };
      });
      const currentGeneration = generation++;
      flushEvents = async () => {
        flushEvents = () => Promise.resolve();
        const events = await journal.evaluate((value) => {
          value.stop();
          return value.events;
        });
        eventJournal.push({ generation: currentGeneration, events });
        await journal.dispose();
      };
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (entry) => {
        if (entry.type() === 'error') errors.push(entry.text());
      });
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      await expect(page.getByTestId('ping-reply')).toBeAttached();
      const descriptors = await page.evaluate(() => window.solline.request('agents.list', {}));
      expect(descriptors.agents.map((a) => a.label)).toEqual(['Claude QA']);
      return page;
    };
    try {
      let page = await connect();
      await page.getByTestId('add-project').click();
      const restart = async () => {
        await flushEvents();
        await app.context().tracing.stop({ path: info.outputPath('before-restart.zip') });
        await info.attach('before-restart', {
          path: info.outputPath('before-restart.zip'),
          contentType: 'application/zip',
        });
        await safeClose();
        await collectPrompts();
        app = await launch();
        nativePid = await app.evaluate(() => process.pid);
        ownedProcesses.push({ pid: nativePid, identity: nativeIdentity(nativePid) });
        prompts = observePrompts(app, promptPlan);
        page = await connect();
        return page;
      };
      const restoreEngine = async () => {
        await flushEvents();
        const trace = info.outputPath('before-engine-restore.zip');
        await app.context().tracing.stop({ path: trace });
        await info.attach('before-engine-restore', { path: trace, contentType: 'application/zip' });
        const recovery = app.windows().find((window) => window.url().endsWith('/recovery.html'));
        if (!recovery) throw new Error('Independent engine recovery window missing');
        const loaded = page.waitForEvent('domcontentloaded');
        await recovery.getByRole('button', { name: 'Restaurar interface', exact: true }).click();
        await loaded;
        page = await connect();
        return page;
      };
      const shot = async (name: string) => {
        const path = info.outputPath(`${name}.png`);
        await page.screenshot({ path, animations: 'disabled' });
        await info.attach(name, { path, contentType: 'image/png' });
      };
      const trustChoice = (trusted: boolean) => {
        promptPlan.confirmations['Confiança no projeto'] = {
          button: trusted ? 'Confiar' : 'Não confiar',
          choice: trusted ? 'accept' : 'cancel',
        };
      };
      await use({
        page,
        project,
        worktreeRoot: join(root, 'data', 'worktrees'),
        git,
        restart,
        restoreEngine,
        shot,
        trustChoice,
        prompts: () => [...promptRecords, ...prompts.records],
      });
      expect(
        await page.evaluate(() => ({
          node: typeof (globalThis as { require?: unknown }).require,
          qa: 'qa' in window,
        })),
      ).toEqual({ node: 'undefined', qa: false });
      expect(errors).toEqual([]);
    } finally {
      const evidenceErrors: string[] = [];
      const capture = async (name: string, collect: () => Promise<void>) => {
        try {
          await collect();
        } catch (error) {
          evidenceErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      try {
        await capture('engine-events', async () => {
          await flushEvents();
          await info.attach('engine-events', {
            body: JSON.stringify(
              {
                limitation:
                  'Passive engine events after connection. Invoke requests/responses are not observable through public Electron listeners.',
                connections: eventJournal,
              },
              null,
              2,
            ),
            contentType: 'application/json',
          });
        });
        await capture('custom-prompts', async () => {
          await collectPrompts();
          await info.attach('custom-prompts', {
            body: JSON.stringify({ records: promptRecords, failures: promptFailures }, null, 2),
            contentType: 'application/json',
          });
          expect(promptFailures).toEqual([]);
        });
        await capture('main-utility-output', async () => {
          await info.attach('main-utility-output', {
            body: JSON.stringify(processLog, null, 2),
            contentType: 'application/json',
          });
        });
        await capture('git-before-teardown', async () => {
          const snapshot = await gitSnapshot(root, project);
          await info.attach('git-before-teardown', {
            body: JSON.stringify(snapshot, null, 2),
            contentType: 'application/json',
          });
        });
        await capture('electron', async () => {
          const page = app.windows()[0];
          if (page && !page.isClosed())
            await info.attach('electron', {
              body: await page.screenshot(),
              contentType: 'image/png',
            });
        });
        await capture('electron-trace', async () => {
          await app.context().tracing.stop({ path: info.outputPath('electron-trace.zip') });
          await info.attach('electron-trace', {
            path: info.outputPath('electron-trace.zip'),
            contentType: 'application/zip',
          });
        });
        if (evidenceErrors.length)
          await info.attach('evidence-failures', {
            body: JSON.stringify(evidenceErrors),
            contentType: 'application/json',
          });
        expect(evidenceErrors, 'Required QA evidence collection').toEqual([]);
      } finally {
        try {
          await safeClose();
        } finally {
          // Failure cleanup owns only PIDs captured at this fixture's launches.
          // Verify exit BEFORE removing the key or files. Keep safeClose failures visible.
          for (const { pid, identity } of ownedProcesses)
            if (identity && alive(pid) && nativeIdentity(pid) === identity) {
              execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'pipe',
              });
              await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
            }
          try {
            await removeRecoveryKey(join(root, 'data'));
          } finally {
            await removeFixture(root);
          }
        }
      }
    }
  },
});

async function gitSnapshot(root: string, project: string) {
  const read = (cwd: string, args: string[]) => {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    });
  };
  const worktrees = read(project, ['worktree', 'list', '--porcelain']);
  const paths = worktrees
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9));
  const files = await Promise.all(
    paths.map(async (path) => {
      if (!resolve(path).startsWith(resolve(root) + sep))
        throw new Error('Snapshot path escaped fixture');
      return {
        path,
        status: read(path, ['status', '--porcelain']),
        notes: await readFile(join(path, 'notes.txt'), 'utf8').catch(() => null),
        prepared: await readFile(join(path, 'prepared.txt'), 'utf8').catch(() => null),
      };
    }),
  );
  return {
    worktrees,
    branches: read(project, [
      'for-each-ref',
      '--format=%(refname:short) %(objectname)',
      'refs/heads',
    ]),
    log: read(project, ['log', '--all', '--oneline', '--stat', '-8']),
    files,
  };
}

// An idle provider event precedes asynchronous checkpoint settlement. Capture the
// completed durable history as the restart oracle, never that transient projection.
async function settledSnapshot(page: Page) {
  let snapshot = await page.evaluate(() => window.solline.request('engine.snapshot', {}));
  await expect
    .poll(
      async () => {
        snapshot = await page.evaluate(() => window.solline.request('engine.snapshot', {}));
        const checkpoints = snapshot.sessions.flatMap(
          (session) => session.timeline?.checkpoints ?? [],
        );
        return (
          checkpoints.length > 0 && checkpoints.every((checkpoint) => checkpoint.state === 'done')
        );
      },
      { message: 'Completed real checkpoints before recording the recovery baseline' },
    )
    .toBe(true);
  // `done` is published before the final pending-diff calculation. This public
  // serialized read waits behind endTurn and refreshes the entire timeline.
  for (const session of snapshot.sessions) {
    if (session.timeline?.checkpoints.length)
      await page.evaluate(
        (sessionId) => window.solline.request('review.timeline', { sessionId }),
        session.session.id,
      );
  }
  return page.evaluate(() => window.solline.request('engine.snapshot', {}));
}

async function newSession(page: Page) {
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
}
for (const trusted of [false, true])
  test(`confiança real persiste depois de reiniciar: ${trusted}`, async ({ qa }) => {
    const trust = qa.page.getByTestId('project-trust');
    await expect(trust).toHaveAttribute('aria-pressed', 'true');
    await trust.click();
    await expect(trust).toHaveAttribute('aria-pressed', 'false');
    if (trusted) {
      await trust.click();
      await expect(trust).toHaveAttribute('aria-pressed', 'true');
    }
    const before = await qa.page.evaluate(() => window.solline.request('projects.list', {}));
    expect(before.projects).toHaveLength(1);
    expect(before.projects[0]).toMatchObject({ path: qa.project, trusted });
    const page = await qa.restart();
    await expect(page.getByTestId('project-trust')).toHaveAttribute(
      'aria-pressed',
      String(trusted),
    );
    const after = await page.evaluate(() => window.solline.request('projects.list', {}));
    expect(after.projects).toEqual(before.projects);
    expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe('Original.\n');
    await qa.shot(`trust-persisted-${trusted}`);
  });
async function send(page: Page, text = 'Atualiza as notas.') {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-input').press('Enter');
}

test('navegação: pesquisa e arranque persistem no main sem iniciar agentes', async ({ qa }) => {
  let page = qa.page;
  await page.getByTestId('project-row').click();
  await page.getByLabel('Nova tarefa', { exact: true }).fill('Rever autenticação');
  await page.getByLabel('Nova tarefa', { exact: true }).press('Enter');
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await page.getByTestId('open-general').click();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('autenticacao');
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await expect
    .poll(() => page.evaluate(async () => (await window.solline.navigation.read()).lastTarget))
    .toMatchObject({ view: 'spaces' });
  page = await qa.restart();
  await expect(page.getByLabel('Detalhes da tarefa')).toBeVisible();
  await expect(page.getByTestId('task-row')).toHaveText('Rever autenticação');
  expect(
    (await page.evaluate(() => window.solline.request('engine.snapshot', {}))).sessions,
  ).toHaveLength(0);
  await page.getByTestId('navigation-settings').click();
  await page.getByRole('radio', { name: /^Mesa/ }).check();
  await expect(page.getByText('A escolha aplica-se na próxima abertura.')).toBeVisible();
  await page.getByRole('button', { name: 'Fechar definições' }).click();
  page = await qa.restart();
  await expect(page.getByTestId('open-desk')).toHaveAttribute('aria-current', 'page');
  expect(
    (await page.evaluate(() => window.solline.request('engine.snapshot', {}))).sessions,
  ).toHaveLength(0);
  await qa.shot('navigation-durable-startup');
});

test('espaços: delegar, rever, analisar e recuperar sem repetir a execução', async ({ qa }) => {
  let page = qa.page;
  await page.getByTestId('project-row').click();
  await page.getByLabel('Nova tarefa', { exact: true }).fill('Melhorar os estados vazios');
  await page.getByLabel('Nova tarefa', { exact: true }).press('Enter');
  await expect(page.getByTestId('session-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Delegar', exact: true }).click();
  await page.getByLabel('Agente', { exact: true }).click();
  await page.getByTestId('choice-task-agent-claude').click();
  await page.getByRole('button', { name: 'Enviar tarefa' }).click();
  await page.getByRole('button', { name: 'Abrir conversa' }).click();
  await page.getByRole('button', { name: /^Permitir uma vez/ }).click();
  await expect
    .poll(() => readFile(join(qa.project, 'notes.txt'), 'utf8'))
    .toBe('Alteração revista.\n');
  await page.getByTestId('project-row').click();
  await expect(page.getByRole('heading', { name: 'Para rever' })).toBeVisible();
  await page.getByTestId('task-row').click();
  await expect(page.getByRole('button', { name: 'Ver alterações' })).toBeVisible();
  await qa.shot('space-real-project');
  page = await qa.restart();
  await page.getByTestId('project-row').click();
  await expect(page.getByTestId('task-row')).toHaveText('Melhorar os estados vazios');
  await page.getByTestId('task-row').click();
  await expect(page.getByText('Para rever', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await page.getByTestId('open-general').click();
  await page.getByLabel('Definições de análise e aprendizagem').click();
  await page.getByLabel('Agente de análise', { exact: true }).click();
  await page.getByTestId('choice-analysis-agent-claude').click();
  await page.getByRole('checkbox', { name: 'project', exact: true }).check();
  await page.getByRole('button', { name: 'Guardar preferências' }).click();
  await page.getByRole('button', { name: 'Analisar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rever os estados do projeto' })).toBeVisible();
  await page.getByTestId('project-row').click();
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await expect(
    page.getByText('Preferir estados claros e respostas curtas.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Desativar', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Abrir origem: Melhorar os estados vazios', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Abrir origem: Melhorar os estados vazios', exact: true })
    .click();
  await expect(page.getByLabel('Título da tarefa', { exact: true })).toHaveValue(
    'Melhorar os estados vazios',
  );
  await page.getByRole('button', { name: 'Memória', exact: true }).click();
  await qa.shot('space-real-memory');
});

test('confirmação própria permite recusar confiança sem a ativar', async ({ qa }) => {
  const trust = qa.page.getByTestId('project-trust');
  await expect(trust).toHaveAttribute('aria-pressed', 'true');
  await trust.click();
  await expect(trust).toHaveAttribute('aria-pressed', 'false');
  qa.trustChoice(false);
  await trust.click();
  await expect.poll(() => qa.prompts().at(-1)?.button).toBe('Não confiar');
  await expect(trust).toHaveAttribute('aria-pressed', 'false');
  expect(
    (await qa.page.evaluate(() => window.solline.request('projects.list', {}))).projects[0]
      ?.trusted,
  ).toBe(false);
});
async function answer(page: Page, decision: 'allow' | 'deny') {
  await expect(page.getByTestId('permission-card')).toBeVisible();
  await page
    .getByRole('button', { name: decision === 'deny' ? /^Negar/ : /^Permitir uma vez/ })
    .click();
  await expect(page.getByTestId('ask-resolved').last()).toHaveAttribute(
    'data-status',
    decision === 'deny' ? 'denied' : 'allowed',
  );
  await expect(page.getByTestId('session-row').first()).toHaveAttribute('data-state', 'idle');
}
async function openWorktree(qa: Qa, failFirst = false) {
  const { page, project, git } = qa;
  await writeFile(
    join(project, 'setup.cjs'),
    failFirst
      ? "const fs = require('node:fs'); if (!fs.existsSync('setup-attempted')) { fs.writeFileSync('setup-attempted', '1'); console.error('QA setup failed once'); process.exit(1); } fs.writeFileSync('prepared.txt', process.env.SOLLINE_PORT);\n"
      : "require('node:fs').writeFileSync('prepared.txt', process.env.SOLLINE_PORT);\n",
  );
  await writeFile(
    join(project, 'conductor.json'),
    JSON.stringify({ scripts: { setup: 'node setup.cjs' } }),
  );
  git('add', '.');
  git('commit', '-qm', 'Setup fixture');
  await newSession(page);
  await newSession(page);
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await expect(page.getByTestId('workspace-label')).toHaveText('Por preparar');
  const paths = git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9));
  expect(paths).toHaveLength(2);
  const path = paths.find((path) => resolve(path) !== resolve(project));
  if (!path) throw new Error('Missing real worktree');
  expect(existsSync(join(path, 'prepared.txt'))).toBe(false);
  await page.getByTestId('workspace-chip').click();
  await page.getByTestId('setup-approve').click();
  if (failFirst) {
    await expect.poll(() => existsSync(join(path, 'setup-attempted'))).toBe(true);
    await page.getByTestId('workspace-chip').click();
    await expect(page.getByTestId('setup-tail')).toContainText('QA setup failed once');
    await qa.shot('setup-failure');
    expect(existsSync(join(path, 'prepared.txt'))).toBe(false);
    await page.getByTestId('setup-retry').click();
  }
  await expect
    .poll(() => readFile(join(path, 'prepared.txt'), 'utf8').catch(() => ''))
    .toMatch(/^4\d{4}$/);
  await expect(page.getByTestId('workspace-label')).not.toHaveText(/A preparar|Por preparar/);
  if (failFirst) await qa.shot('setup-recovered');
  return path;
}
async function closeWorktree(page: Page) {
  await page.getByTestId('workspace-chip').click();
  await page.getByTestId('workspace-close').click();
}

function branchesForWorktree(qa: Qa, path: string) {
  // The title-based branch name changes asynchronously; the worktree suffix never does.
  const suffix = basename(path);
  expect(suffix).toMatch(/^[a-z0-9]{4}$/);
  return qa
    .git('branch', '--format=%(refname:short)')
    .split('\n')
    .filter((branch) => branch.startsWith('solline/') && branch.endsWith(`-${suffix}`));
}

function branchFile(qa: Qa, branch: string, file: string) {
  return execFileSync('git', ['show', `${branch}:${file}`], {
    cwd: qa.project,
    windowsHide: true,
    encoding: 'utf8',
  });
}

function expectKeptWorktree(qa: Qa, path: string, prepared: string) {
  const branches = branchesForWorktree(qa, path);
  expect(branches).toHaveLength(1);
  const branch = branches[0];
  if (!branch) throw new Error('Missing retained worktree branch');
  expect(branchFile(qa, branch, 'notes.txt')).toBe('Alteração revista.\n');
  expect(branchFile(qa, branch, 'prepared.txt')).toBe(prepared);
}

for (const decision of ['deny', 'allow'] as const) {
  test(`Electron → preload → motor → Git: ${decision}`, async ({ qa }) => {
    const { page, project } = qa;
    await newSession(page);
    await send(page);
    await answer(page, decision);
    await expect
      .poll(() => readFile(join(project, 'notes.txt'), 'utf8'))
      .toBe(decision === 'deny' ? 'Original.\n' : 'Alteração revista.\n');
  });
}

test('review: comentário enviado e rejeitar/desfazer muda os ficheiros reais', async ({ qa }) => {
  const { page, project } = qa;
  const notes = () => readFile(join(project, 'notes.txt'), 'utf8');
  await newSession(page);
  await send(page);
  await answer(page, 'allow');
  await expect(page.getByTestId('review-pending')).toBeVisible();
  await page.getByTestId('review-toggle').click();
  const file = page.locator('[data-testid="diff-file"][data-path="notes.txt"]');
  await expect(file.getByTestId('diff-hunk')).toBeVisible();
  await file.locator('[data-kind="add"]').hover();
  await file.locator('[data-kind="add"] [data-testid="comment-line"]').click();
  await page.getByTestId('comment-input').fill('Mantém a frase original por favor.');
  await page.getByTestId('comment-save').click();
  await expect(page.getByTestId('comment-chip')).toContainText('Mantém a frase original');
  await page.getByTestId('send-comments').click();
  await expect(page.getByTestId('user-turn').last()).toContainText('notes.txt, linha 1');
  await expect(page.getByTestId('user-turn').last()).toContainText(
    'Mantém a frase original por favor.',
  );
  await answer(page, 'deny');
  // Comment delivery is a genuine second engine turn, not just a local chip.
  await expect(page.getByTestId('user-turn')).toHaveCount(2);
  if (!(await page.getByTestId('review-panel').isVisible()))
    await page.getByTestId('review-toggle').click();
  await page.getByTestId('reject-all').click();
  await expect.poll(notes).toBe('Original.\n');
  await page.getByTestId('review-undo').click();
  await expect.poll(notes).toBe('Alteração revista.\n');
});

test('rebobinar ficheiros, voltar ao presente e rebobinar conversa', async ({ qa }) => {
  const { page, project } = qa;
  const notes = () => readFile(join(project, 'notes.txt'), 'utf8');
  await newSession(page);
  await send(page);
  await answer(page, 'allow');
  await expect(page.getByTestId('review-pending')).toBeVisible();
  await page.getByTestId('timeline-stop').first().click();
  await page.getByTestId('rewind-files').click();
  await expect.poll(notes).toBe('Original.\n');
  await expect(page.getByTestId('user-turn')).toHaveCount(1);
  await page.getByTestId('timeline-present').click();
  await expect.poll(notes).toBe('Alteração revista.\n');
  await page.getByTestId('timeline-stop').first().click();
  await page.getByTestId('rewind-both').click();
  await expect.poll(notes).toBe('Original.\n');
  await expect(page.getByTestId('user-turn')).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toHaveValue('Atualiza as notas.');
  await expect(page.getByTestId('composer-input')).toBeEnabled();
  // The replacement adapter remains usable after the rewind.
  await page.getByTestId('composer-input').press('Enter');
  await answer(page, 'allow');
  await expect(page.getByTestId('user-turn')).toHaveCount(1);
  await expect.poll(notes).toBe('Alteração revista.\n');
});

for (const choice of ['keep', 'discard', 'bring'] as const) {
  test(`setup real + fechar worktree: ${choice}`, async ({ qa }, info) => {
    const { page, project, git } = qa;
    const path = await openWorktree(qa);
    const prepared = await readFile(join(path, 'prepared.txt'), 'utf8');
    await send(page);
    await answer(page, 'allow');
    await expect.poll(() => readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Original.\n');
    const branch = await page.getByTestId('workspace-chip').getAttribute('data-branch');
    if (!branch) throw new Error('Missing worktree branch');
    const before = {
      branch,
      worktreeSuffix: basename(path),
      project: await readFile(join(project, 'notes.txt'), 'utf8'),
      worktree: await readFile(join(path, 'notes.txt'), 'utf8'),
      status: git('-C', path, 'status', '--porcelain'),
    };
    await closeWorktree(page);
    await expect(page.getByTestId('close-dialog')).toBeVisible();
    await qa.shot(`worktree-close-${choice}`);
    await page.getByTestId(`close-${choice}`).click();
    await expect(page.getByTestId('session-row')).toHaveCount(1);
    await expect.poll(() => existsSync(path)).toBe(false);
    const branches = git('branch', '--format=%(refname:short)').split('\n');
    await info.attach('git-close-evidence', {
      body: JSON.stringify(
        {
          choice,
          before,
          after: {
            branches,
            retained: branchesForWorktree(qa, path).map((ref) => ({
              branch: ref,
              notes: branchFile(qa, ref, 'notes.txt'),
              prepared: branchFile(qa, ref, 'prepared.txt'),
            })),
            project: await readFile(join(project, 'notes.txt'), 'utf8'),
            head: git('show', 'HEAD:notes.txt'),
            log: git('log', '--all', '--oneline', '--stat', '-5'),
            status: git('status', '--porcelain'),
          },
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    if (choice === 'keep') expectKeptWorktree(qa, path, prepared);
    else expect(branchesForWorktree(qa, path)).toEqual([]);
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe(
      choice === 'bring' ? 'Alteração revista.\n' : 'Original.\n',
    );
    if (choice === 'bring')
      expect(await readFile(join(project, 'prepared.txt'), 'utf8')).toBe(prepared);
    else expect(existsSync(join(project, 'prepared.txt'))).toBe(false);
  });
}

test('fechar com fila preserva autorização através do diálogo da worktree', async ({ qa }) => {
  const { page } = qa;
  const path = await openWorktree(qa);
  const prepared = await readFile(join(path, 'prepared.txt'), 'utf8');
  await send(page);
  await answer(page, 'allow');
  await send(page, 'Segundo turno, espera pela permissão.');
  await expect(page.getByTestId('permission-card')).toBeVisible();
  await send(page, 'Mensagem que fica na fila.');
  await expect(page.getByTestId('queued')).toHaveCount(1);
  await page.getByTestId('interrupt').click();
  await expect(page.getByTestId('queue-resume')).toBeVisible();
  await closeWorktree(page);
  await expect(page.getByTestId('close-queue-dialog')).toBeVisible();
  await page.getByTestId('close-drop-queue').click();
  await expect(page.getByTestId('close-dialog')).toBeVisible();
  await page.getByTestId('close-keep').click();
  await expect(page.getByTestId('close-queue-dialog')).toBeHidden();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect.poll(() => existsSync(path)).toBe(false);
  expectKeptWorktree(qa, path, prepared);
});

for (const scenario of ['empate', 'falha'] as const) {
  test(`corrida: classificação real com ${scenario}`, async ({ qa }) => {
    const { page, project, git } = qa;
    if (scenario === 'falha') {
      await writeFile(
        join(project, 'check.cjs'),
        "process.exit(require('node:fs').readFileSync('notes.txt','utf8').includes('BROKEN') ? 1 : 0);\n",
      );
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({ private: true, scripts: { typecheck: 'node check.cjs' } }),
      );
      git('add', '.');
      git('commit', '-qm', 'Check fixture');
    }
    await newSession(page);
    await page.getByTestId('pill-race').click();
    await page.getByTestId('race-lane-claude-opus').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pill-race')).toContainText('2×');
    await send(page, `QA: corrida com ${scenario}`);
    await expect(page.getByTestId('race-lane')).toHaveCount(2);
    await expect(page.getByTestId('race-allow-all')).toBeVisible();
    await page.getByTestId('race-allow-all').click();
    await expect(page.getByTestId('race-phase')).toHaveAttribute('data-phase', 'ranked', {
      timeout: 45_000,
    });
    await expect(page.getByTestId('race-rank')).toHaveCount(2);
    if (scenario === 'falha') {
      const contrast = await page
        .locator('[data-rank="1"] [data-testid="race-rank"]')
        .evaluate((badge) => {
          const style = getComputedStyle(badge);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Missing colour conversion context');
          const luminance = (colour: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            const rgba = context.getImageData(0, 0, 1, 1).data;
            if (rgba[3] !== 255) throw new Error('Badge contrast requires opaque colours');
            const linear = Array.from(rgba)
              .slice(0, 3)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
            const [red = 0, green = 0, blue = 0] = linear;
            return red * 0.2126 + green * 0.7152 + blue * 0.0722;
          };
          const fg = luminance(style.color);
          const bg = luminance(style.backgroundColor);
          return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    for (const lane of await page.getByTestId('race-lane').all())
      await expect(lane).not.toContainText('A pensar…');
    await qa.shot(`race-ranked-${scenario}`);
    if (scenario === 'empate') {
      await expect(page.getByTestId('race-tie')).toContainText('Empate: escolhe tu');
      await expect(page.getByTestId('race-rank')).toHaveText(['Empate', 'Empate']);
      for (const lane of await page.getByTestId('race-lane').all())
        await expect(lane).toHaveAttribute('data-winner', 'false');
    } else {
      await expect(page.getByTestId('race-tie')).toBeHidden();
      await expect(page.locator('[data-testid="race-lane"][data-rank="1"]')).toContainText(
        'sonnet',
      );
      await expect(page.locator('[data-testid="race-lane"][data-rank="2"]')).toContainText('opus');
      await expect(page.locator('[data-testid="race-lane"][data-rank="2"]')).toContainText('Tipos');
    }
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Original.\n');
    await page.getByTestId('open-desk').click();
    await expect(page.getByTestId('race-card')).toHaveCount(1);
  });
}

test('preparação falha uma vez e repetir corre o comando real', async ({ qa }) => {
  const path = await openWorktree(qa, true);
  expect(await readFile(join(path, 'setup-attempted'), 'utf8')).toBe('1');
  expect(await readFile(join(path, 'prepared.txt'), 'utf8')).toMatch(/^4\d{4}$/);
  await send(qa.page);
  await answer(qa.page, 'allow');
  await expect.poll(() => readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
});

test('conflito ao trazer preserva projeto e branch recuperável', async ({ qa }) => {
  const { page, project, git } = qa;
  const path = await openWorktree(qa);
  const prepared = await readFile(join(path, 'prepared.txt'), 'utf8');
  await send(page);
  await answer(page, 'allow');
  await expect.poll(() => readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
  await writeFile(join(project, 'notes.txt'), 'Edição local.\n');
  git('add', 'notes.txt');
  git('commit', '-qm', 'Independent local edit');
  const before = git('rev-parse', 'HEAD');
  await page.getByTestId('workspace-chip').click();
  await expect(page.getByTestId('workspace-bring')).toBeEnabled();
  await page.getByTestId('workspace-bring').click();
  await expect(page.getByTestId('workspace-chip')).toHaveAttribute('data-state', 'closed');
  await expect(page.getByTestId('workspace-bring')).toBeHidden();
  await page.getByTestId('workspace-chip').click();
  await expect(page.getByTestId('workspace-resolve')).toBeVisible();
  await qa.shot('merge-conflict');
  expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Edição local.\n');
  expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(git('status', '--porcelain')).toBe('');
  await page.keyboard.press('Escape');
  await closeWorktree(page);
  await page.getByTestId('close-keep').click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  expectKeptWorktree(qa, path, prepared);
});

for (const choice of ['bring', 'discard'] as const) {
  test(`reiniciar restaura sessão e preserva worktree: ${choice}`, async ({ qa }) => {
    const path = await openWorktree(qa);
    const prepared = await readFile(join(path, 'prepared.txt'), 'utf8');
    await send(qa.page);
    await answer(qa.page, 'allow');
    await expect.poll(() => readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
    const before = await settledSnapshot(qa.page);
    const saved = before.sessions.find((item) => resolve(item.session.cwd) === resolve(path));
    if (!saved) throw new Error('Worktree session missing from canonical snapshot');
    const refs = branchesForWorktree(qa, path).map((ref) => qa.git('rev-parse', ref));
    expect(refs).toHaveLength(1);
    const page = await qa.restart();
    const after = await page.evaluate(() => window.solline.request('engine.snapshot', {}));
    const restored = after.sessions.find((item) => item.session.id === saved.session.id);
    expect(restored).toMatchObject({
      session: {
        id: saved.session.id,
        cwd: saved.session.cwd,
        state: 'error',
        workspace: { kind: 'worktree' },
      },
      interrupted: true,
      turns: saved.turns,
      queue: { ...saved.queue, paused: true },
      timeline: saved.timeline ? { ...saved.timeline, conversationRewind: 'summary' } : null,
    });
    expect(branchesForWorktree(qa, path).map((ref) => qa.git('rev-parse', ref))).toEqual(refs);
    expect(qa.git('worktree', 'list', '--porcelain')).toContain(path.replaceAll('\\', '/'));
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
    expect(await readFile(join(path, 'prepared.txt'), 'utf8')).toBe(prepared);
    expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe('Original.\n');
    await page.getByTestId('open-desk').click();
    await expect(page.getByTestId('orphan-card')).toHaveCount(0);
    await expect(page.getByTestId('session-row')).toHaveCount(2);
    await qa.shot(`restored-worktree-${choice}`);
    await page.locator(`[data-testid="desk-card"][data-session="${saved.session.id}"]`).click();
    await expect(page.getByTestId('user-turn')).toHaveCount(1);
    await closeWorktree(page);
    await page.getByTestId(`close-${choice}`).click();
    try {
      await expect(page.getByTestId('session-row')).toHaveCount(1);
    } catch (error) {
      await test.info().attach('close-diagnostic', {
        body: JSON.stringify(
          {
            snapshot: await page.evaluate(() => window.solline.request('engine.snapshot', {})),
            ui: await page.locator('body').innerText(),
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      throw error;
    }
    await expect.poll(() => existsSync(path)).toBe(false);
    expect(branchesForWorktree(qa, path)).toEqual([]);
    expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe(
      choice === 'bring' ? 'Alteração revista.\n' : 'Original.\n',
    );
    if (choice === 'bring')
      expect(await readFile(join(qa.project, 'prepared.txt'), 'utf8')).toBe(prepared);
    else expect(existsSync(join(qa.project, 'prepared.txt'))).toBe(false);
  });

  test(`worktree legada realmente órfã: ${choice}`, async ({ qa }) => {
    await expect(qa.page.getByTestId('project-trust')).toHaveAttribute('aria-pressed', 'true');
    const { projects } = await qa.page.evaluate(() => window.solline.request('projects.list', {}));
    const project = projects[0];
    if (!project) throw new Error('Real project missing');
    // Production Git/metadata creation without a session: no recovery journal is modified.
    const manager = new WorktreeManager({ root: qa.worktreeRoot });
    const worktree = await manager.create(qa.project, project.id);
    if (!worktree) throw new Error('Real legacy worktree creation failed');
    const path = worktree.path;
    await writeFile(join(path, 'notes.txt'), 'Alteração revista.\n');
    await writeFile(join(path, 'prepared.txt'), 'Preparação legada.\n');
    const page = await qa.restart();
    await page.getByTestId('open-desk').click();
    await expect(page.getByTestId('orphan-card')).toHaveCount(1);
    await expect(page.getByTestId('session-row')).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.solline.request('engine.snapshot', {}))).sessions,
    ).toEqual([]);
    expect(branchesForWorktree(qa, path)).toEqual([worktree.branch]);
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('Alteração revista.\n');
    await qa.shot(`legacy-orphan-${choice}`);
    await page.getByTestId(`orphan-${choice}`).click();
    if (choice === 'discard') {
      await expect(page.getByTestId('orphan-discard')).toHaveText('Confirmar');
      expect(existsSync(path)).toBe(true);
      await page.getByTestId('orphan-discard').click();
    }
    await expect(page.getByTestId('orphan-card')).toHaveCount(0);
    await expect.poll(() => existsSync(path)).toBe(false);
    expect(branchesForWorktree(qa, path)).toEqual([]);
    expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe(
      choice === 'bring' ? 'Alteração revista.\n' : 'Original.\n',
    );
    if (choice === 'bring')
      expect(await readFile(join(qa.project, 'prepared.txt'), 'utf8')).toBe('Preparação legada.\n');
    else expect(existsSync(join(qa.project, 'prepared.txt'))).toBe(false);
  });
}

test('fechar app com corrida por trazer conserva ambas as worktrees', async ({ qa }) => {
  const { page, project, git } = qa;
  await newSession(page);
  await page.getByTestId('pill-race').click();
  await page.getByTestId('race-lane-claude-opus').click();
  await page.keyboard.press('Escape');
  await send(page, 'QA: corrida com empate');
  await expect(page.getByTestId('race-allow-all')).toBeVisible();
  await page.getByTestId('race-allow-all').click();
  await expect(page.getByTestId('race-phase')).toHaveAttribute('data-phase', 'ranked');
  const worktrees = git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9))
    .filter((path) => resolve(path) !== resolve(project));
  expect(worktrees).toHaveLength(2);
  const before = await settledSnapshot(page);
  const race = before.races[0];
  if (!race) throw new Error('Ranked race missing from canonical snapshot');
  const refs = worktrees.map((path) => ({
    path,
    refs: branchesForWorktree(qa, path).map((ref) => git('rev-parse', ref)),
  }));
  for (const item of refs) expect(item.refs).toHaveLength(1);
  const next = await qa.restart();
  const after = await next.evaluate(() => window.solline.request('engine.snapshot', {}));
  expect(after.races[0]).toMatchObject({ id: race.id, phase: 'ranked', verdict: race.verdict });
  expect(after.races[0]?.lanes.map((lane) => lane.sessionId)).toEqual(
    race.lanes.map((lane) => lane.sessionId),
  );
  for (const lane of race.lanes) {
    const saved = before.sessions.find((item) => item.session.id === lane.sessionId);
    if (!saved) throw new Error('Race lane snapshot missing');
    expect(after.sessions.find((item) => item.session.id === lane.sessionId)).toMatchObject({
      session: {
        id: lane.sessionId,
        cwd: saved.session.cwd,
        workspace: { kind: 'worktree' },
        state: 'error',
      },
      interrupted: true,
      turns: saved.turns,
      queue: { ...saved.queue, paused: true },
      timeline: saved.timeline ? { ...saved.timeline, conversationRewind: 'summary' } : null,
    });
  }
  for (const item of refs) {
    expect(branchesForWorktree(qa, item.path).map((ref) => git('rev-parse', ref))).toEqual(
      item.refs,
    );
    expect(git('worktree', 'list', '--porcelain')).toContain(item.path.replaceAll('\\', '/'));
  }
  await next.getByTestId('open-desk').click();
  await expect(next.getByTestId('orphan-card')).toHaveCount(0);
  await expect(next.getByTestId('race-card')).toHaveCount(1);
  await next.getByTestId('race-card').click();
  await expect(next.getByTestId('race-phase')).toHaveAttribute('data-phase', 'ranked');
  await expect(next.getByTestId('race-lane')).toHaveCount(2);
  await qa.shot('race-recovered-worktrees');
  expect(
    (await Promise.all(worktrees.map((path) => readFile(join(path, 'notes.txt'), 'utf8')))).sort(),
  ).toEqual(['Solução opus.\n', 'Solução sonnet.\n']);
  expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Original.\n');
});

test('morte real do utility process preserva conversa e bloqueia envio', async ({ qa }) => {
  const { page } = qa;
  await newSession(page);
  await send(page);
  await answer(page, 'deny');
  const before = await settledSnapshot(page);
  const ping = await page.evaluate(() => window.solline.request('engine.ping', {}));
  // This PID came from the guarded fixture's engine, never a machine-wide process search.
  expect(ping.pid).toBeGreaterThan(0);
  expect(ping.pid).not.toBe(process.pid);
  process.kill(ping.pid);
  await expect(page.getByTestId('session-error')).toContainText('O motor parou');
  await qa.shot('engine-process-failed');
  await expect(page.getByTestId('user-turn')).toContainText('Atualiza as notas.');
  await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'denied');
  await expect(page.getByTestId('composer-input')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retomar', exact: true })).toBeHidden();
  const restoredPage = await qa.restoreEngine();
  const nextPing = await restoredPage.evaluate(() => window.solline.request('engine.ping', {}));
  expect(nextPing.pid).not.toBe(ping.pid);
  const after = await restoredPage.evaluate(() => window.solline.request('engine.snapshot', {}));
  expect(after.sessions).toHaveLength(before.sessions.length);
  for (const saved of before.sessions)
    expect(after.sessions.find((item) => item.session.id === saved.session.id)).toMatchObject({
      interrupted: true,
      turns: saved.turns,
      queue: { ...saved.queue, paused: true },
      timeline: saved.timeline ? { ...saved.timeline, conversationRewind: 'summary' } : null,
    });
  await expect(restoredPage.getByTestId('user-turn')).toContainText('Atualiza as notas.');
  await expect(restoredPage.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'denied');
  expect(await readFile(join(qa.project, 'notes.txt'), 'utf8')).toBe('Original.\n');
  await qa.shot('engine-process-restored');
});

for (const failure of ['crash', 'interrupt'] as const) {
  test(`corrida: pista ${failure} não impede a outra de terminar`, async ({ qa }) => {
    const { page, project, git } = qa;
    await newSession(page);
    await page.getByTestId('pill-race').click();
    await page.getByTestId('race-lane-claude-opus').click();
    await page.keyboard.press('Escape');
    await send(page, failure === 'crash' ? 'QA: falha numa pista' : 'QA: interromper uma pista');
    const failedLane = page.getByTestId('race-lane').filter({ hasText: 'opus' });
    await expect(failedLane).toHaveAttribute(
      'data-state',
      failure === 'crash' ? 'error' : 'needs-you',
    );
    await failedLane.getByRole('button', { name: 'Abrir a conversa desta pista' }).click();
    if (failure === 'crash') {
      await expect(page.getByTestId('session-error')).toContainText('QA: falha determinística');
    } else {
      await expect(page.getByTestId('permission-card')).toBeVisible();
      await page.getByTestId('interrupt').click();
      await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'denied');
    }
    await qa.shot(`race-lane-${failure}`);
    await page.getByTestId('open-desk').click();
    await page.getByTestId('race-card').click();
    await expect(page.getByTestId('race-allow')).toBeVisible();
    await page.getByTestId('race-allow').click();
    await expect(page.getByTestId('race-phase')).toHaveAttribute('data-phase', 'ranked');
    await expect(page.getByTestId('race-lane').filter({ hasText: 'sonnet' })).toHaveAttribute(
      'data-state',
      'idle',
    );
    await expect(page.getByTestId('race-lane').filter({ hasText: 'opus' })).toHaveAttribute(
      'data-state',
      failure === 'crash' ? 'error' : 'idle',
    );
    await qa.shot(`race-finished-${failure}`);
    const paths = git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice(9))
      .filter((path) => resolve(path) !== resolve(project));
    expect(paths).toHaveLength(2);
    expect(
      (await Promise.all(paths.map((path) => readFile(join(path, 'notes.txt'), 'utf8')))).sort(),
    ).toEqual(['Alteração revista.\n', 'Original.\n']);
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('Original.\n');
  });
}
