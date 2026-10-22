// Isolated, serial comparison. Never changes either production checkout.
// Run from apps/desktop: SOLLINE_PERF_EXCLUSIVE=1 node qa/performance.mjs
/* global window, document, requestAnimationFrame, HTMLElement */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  rm,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir, platform, cpus } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '../..');
const output = join(desktop, 'qa-evidence/performance');
const baseline = '9fb1cb047e06e0d613cc2ec5f1edf32b65971425';
const browserPath =
  process.env.SOLLINE_QA_BROWSER ??
  join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1247/chrome-win64/chrome.exe');
const warmups = 1;
const samples = Number(process.env.SOLLINE_PERF_SAMPLES ?? 5);
// These thresholds are written before building or measuring. Noise does not count as a win.
const policy = {
  interaction: { relative: 0.25, absoluteMs: 16.7 },
  frameP95: { relative: 0.25, absoluteMs: 8.4 },
  heap: { relative: 0.25, absoluteBytes: 2 * 1024 * 1024 },
  dom: { relative: 0.35, absoluteNodes: 300 },
  teardown: {
    extraListeners: 8,
    afterUnmount: {
      subscriptions: 0,
      focusSubscriptions: 0,
      animations: 0,
      intervals: 0,
      timeouts: 0,
      frames: 0,
    },
  },
  interpretation:
    'Flag only when median increase exceeds both relative/absolute allowance AND twice the combined median absolute deviations. A noisy result is inconclusive, never proof of improvement.',
};
if (process.env.SOLLINE_PERF_EXCLUSIVE !== '1')
  throw new Error('Run only after other test/build jobs stop; set SOLLINE_PERF_EXCLUSIVE=1.');
assert(samples >= 3 && samples <= 15, 'Use 3–15 measured samples per version');
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'policy.json'),
  JSON.stringify(
    { baseline, browserPath, warmups, samples, policy, createdAt: new Date().toISOString() },
    null,
    2,
  ),
);
const scratch = await mkdtemp(join(tmpdir(), 'solline-performance-'));
const scratchRelative = relative(resolve(tmpdir()), scratch);
assert(
  !scratchRelative.startsWith('..') &&
    !scratchRelative.includes(sep) &&
    scratchRelative.startsWith('solline-performance-'),
);
const harnessSnapshot = join(scratch, 'harness');
await cp(join(desktop, 'qa'), harnessSnapshot, { recursive: true });
const junctions = [];
const servers = [];
const snapshotDigests = {};
let browser;

function command(args, cwd = repo) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    env: { ...process.env, SOLLINE_SKIP_SDK: '1' },
  });
  if (result.status !== 0)
    throw new Error(`${args[0]} failed: ${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout;
}

async function digestTree(root, prefix = '') {
  const entries = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) entries.push(...(await digestTree(root, path)));
    else if (entry.isFile())
      entries.push({
        path: path.replaceAll('\\', '/'),
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
  }
  return entries;
}

async function prepare(label) {
  const root = join(scratch, label);
  await mkdir(root, { recursive: true });
  if (label === 'before') {
    const archive = join(scratch, 'baseline.tar');
    command([
      'git',
      'archive',
      '--format=tar',
      `--output=${archive}`,
      baseline,
      'apps/desktop/src',
      'apps/desktop/package.json',
      'packages/ui/src',
      'packages/ui/package.json',
      'packages/protocol/src',
      'packages/protocol/package.json',
    ]);
    command(['tar', '-xf', archive, '-C', root]);
  } else {
    for (const part of [
      'apps/desktop/src',
      'apps/desktop/package.json',
      'packages/ui/src',
      'packages/ui/package.json',
      'packages/protocol/src',
      'packages/protocol/package.json',
    ]) {
      await cp(join(repo, part), join(root, part), { recursive: true });
    }
  }
  const deps = join(root, 'node_modules');
  await symlink(join(repo, 'node_modules'), deps, 'junction');
  junctions.push(deps);
  const target = join(root, 'apps/desktop');
  await cp(harnessSnapshot, join(target, 'qa'), { recursive: true });
  // Alias workspace exports to this snapshot: shared node_modules must not resolve current UI into baseline.
  const aliases = [];
  for (const pkg of ['ui', 'protocol']) {
    const manifest = JSON.parse(await readFile(join(root, `packages/${pkg}/package.json`), 'utf8'));
    for (const [key, value] of Object.entries(manifest.exports))
      aliases.push({
        find: `@solline/${pkg}${key === '.' ? '' : key.slice(1)}`,
        replacement: join(root, `packages/${pkg}`, value).replaceAll('\\', '/'),
      });
  }
  aliases.sort((a, b) => b.find.length - a.find.length);
  await writeFile(
    join(target, 'vite.performance.config.mjs'),
    `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nexport default defineConfig({ root: ${JSON.stringify(join(target, 'qa'))}, plugins: [react(), tailwindcss()], resolve: { alias: ${JSON.stringify(aliases)} }, build: { outDir: ${JSON.stringify(join(target, 'out/performance'))}, emptyOutDir: true } });\n`,
  );
  // Fixture expansion and a teardown handle exist only in these disposable benchmark copies.
  await writeFile(
    join(target, 'qa/main.tsx'),
    `import { installBridge } from './bridge';
import { diff, timeline } from './fixtures';
diff.additions = 240; diff.deletions = 240;
diff.hunks = Array.from({ length: 12 }, (_, h) => ({ id: 'hunk-' + (h + 1), header: '@@ -' + (h * 20 + 1) + ',20 +' + (h * 20 + 1) + ',20 @@', oldStart: h * 20 + 1, oldLines: 20, newStart: h * 20 + 1, newLines: 20, lines: Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? 'add' : 'del', text: 'export const navigation' + (h * 20 + Math.floor(i / 2)) + ' = ' + (i % 2 ? 'previous;' : 'null;'), oldNo: i % 2 ? null : h * 20 + Math.floor(i / 2) + 1, newNo: i % 2 ? h * 20 + Math.floor(i / 2) + 1 : null })) }));
timeline.pending = { files: 1, additions: 240, deletions: 240 };
installBridge('long');
await import('../src/renderer/src/main');
`,
  );
  const harnessFiles = await Promise.all(
    ['bridge.ts', 'fixtures.ts', 'main.tsx'].map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(join(target, 'qa', path)))
        .digest('hex'),
    })),
  );
  await writeFile(join(output, `${label}-harness.json`), JSON.stringify(harnessFiles, null, 2));
  const main = join(target, 'src/renderer/src/main.tsx');
  const source = await readFile(main, 'utf8');
  assert(source.includes('createRoot(root).render('), 'Missing root instrumentation anchor');
  await writeFile(
    main,
    source.replace(
      'createRoot(root).render(',
      'const benchmarkRoot = createRoot(root);\nObject.assign(window, { benchmarkUnmount: () => benchmarkRoot.unmount() });\nbenchmarkRoot.render(',
    ),
  );
  const log = command(
    [
      process.execPath,
      join(repo, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'vite.performance.config.mjs',
    ],
    target,
  );
  await writeFile(join(output, `${label}-build.log`), log);
  const directory = join(target, 'out/performance');
  const bundleFiles = await digestTree(directory);
  snapshotDigests[label] = createHash('sha256').update(JSON.stringify(bundleFiles)).digest('hex');
  await writeFile(
    join(output, `${label}-bundle.json`),
    JSON.stringify({ digest: snapshotDigests[label], files: bundleFiles }, null, 2),
  );
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (relative(directory, file).startsWith('..')) {
        res.writeHead(403);
        res.end();
        return;
      }
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.woff2')
            ? 'font/woff2'
            : file.endsWith('.svg')
              ? 'image/svg+xml'
              : 'text/html';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function instrumentation() {
  const activeTimeouts = new Set(),
    activeIntervals = new Set(),
    activeFrames = new Set();
  const timeout = window.setTimeout.bind(window),
    clearTimeout = window.clearTimeout.bind(window);
  const interval = window.setInterval.bind(window),
    clearInterval = window.clearInterval.bind(window);
  const raf = window.requestAnimationFrame.bind(window),
    cancel = window.cancelAnimationFrame.bind(window);
  window.setTimeout = (fn, ms, ...args) => {
    const id = timeout(() => {
      activeTimeouts.delete(id);
      if (typeof fn === 'function') fn(...args);
    }, ms);
    activeTimeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => {
    activeTimeouts.delete(id);
    clearTimeout(id);
  };
  window.setInterval = (...args) => {
    const id = interval(...args);
    activeIntervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    activeIntervals.delete(id);
    clearInterval(id);
  };
  window.requestAnimationFrame = (fn) => {
    const id = raf((time) => {
      activeFrames.delete(id);
      fn(time);
    });
    activeFrames.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    activeFrames.delete(id);
    cancel(id);
  };
  const longTasks = [];
  new PerformanceObserver((list) =>
    longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration }))),
  ).observe({ type: 'longtask', buffered: true });
  window.benchmarkResources = () => ({
    timeouts: activeTimeouts.size,
    intervals: activeIntervals.size,
    frames: activeFrames.size,
    animations: document.getAnimations().filter((a) => a.playState === 'running').length,
    subscriptions: window.qa?.subscriptions(),
    focusSubscriptions: window.qa?.focusSubscriptions(),
  });
  window.benchmarkLongTasks = longTasks;
}

async function settled(page) {
  await page.evaluate(
    () =>
      new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      ),
  );
}
async function clickPaint(page, testid, index = 0) {
  return page.evaluate(
    async ({ testid, index }) => {
      const target = document.querySelectorAll(`[data-testid="${testid}"]`)[index];
      if (!(target instanceof HTMLElement)) throw new Error(`Missing ${testid}[${index}]`);
      const start = performance.now();
      target.click();
      await new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      );
      return performance.now() - start;
    },
    { testid, index },
  );
}
async function resources(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const counters = await cdp.send('Memory.getDOMCounters');
  const metrics = await cdp.send('Runtime.getHeapUsage');
  return {
    ...counters,
    heapBytes: metrics.usedSize,
    ...(await page.evaluate(() => window.benchmarkResources())),
  };
}
async function runSample(label, url, index, warmup) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 780 },
    deviceScaleFactor: 1,
    locale: 'pt-PT',
    timezoneId: 'Europe/Lisbon',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  try {
    await page.clock.setFixedTime(new Date('2026-10-22T10:00:00Z')); // Date only; real performance/timers/frames.
    await page.addInitScript(instrumentation);
    await page.goto(url);
    await page.getByTestId('new-session').waitFor();
    for (let i = 0; i < 8; i++) {
      await page.getByTestId('new-session').click();
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-testid="session-row"]').length === count,
        i + 1,
      );
    }
    await page.evaluate(() => document.fonts.ready);
    await settled(page);
    // Warm all code paths once before measuring the retained state.
    await clickPaint(page, 'review-toggle');
    await page.getByTestId('diff-hunk').first().waitFor();
    await clickPaint(page, 'review-toggle');
    await page.getByTestId('review-panel').waitFor({ state: 'hidden' });
    await clickPaint(page, 'session-row', 1);
    await clickPaint(page, 'session-row', 0);
    const beforeCycles = await resources(page, cdp);
    const switchMs = [],
      reviewMs = [];
    for (let i = 0; i < 8; i++) {
      switchMs.push(await clickPaint(page, 'session-row', i % 2 ? 0 : 1));
      reviewMs.push(await clickPaint(page, 'review-toggle'));
      await page.getByTestId('diff-hunk').first().waitFor();
      await clickPaint(page, 'review-toggle');
      await page.getByTestId('review-panel').waitFor({ state: 'hidden' });
    }
    await clickPaint(page, 'session-row', 0);
    const frames = await page.evaluate(async () => {
      window.qa.state('session-8', 'running');
      const values = [];
      let previous;
      for (let i = 0; i < 90; i++) {
        const time = await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
        if (previous !== undefined) values.push(time - previous);
        previous = time;
        window.qa.emit({
          kind: 'event',
          type: 'session.event',
          sessionId: 'session-8',
          delta: {
            type: 'block.upsert',
            turnId: 'answer-1',
            block: {
              kind: 'text',
              id: 'stream-benchmark',
              parentToolId: null,
              text: 'Atualização determinística. '.repeat(i + 1),
            },
          },
        });
      }
      window.qa.state('session-8', 'idle');
      return values;
    });
    await settled(page);
    const afterCycles = await resources(page, cdp);
    const protocolFailures = await page.evaluate(() => window.qa.failures);
    const longTasks = await page.evaluate(() => window.benchmarkLongTasks);
    for (let remaining = 8; remaining > 0; remaining--) {
      await clickPaint(page, 'session-close');
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-testid="session-row"]').length === count,
        remaining - 1,
      );
    }
    await settled(page);
    const afterSessionsClosed = await resources(page, cdp);
    await page.evaluate(() => window.benchmarkUnmount());
    // 300 ms allows the longest 260 ms exit to settle; this is resource observation, not UI synchronization.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const afterUnmount = await resources(page, cdp);
    assert.deepEqual(errors, [], 'Renderer errors');
    assert.deepEqual(protocolFailures, [], 'Protocol failures');
    return {
      label,
      index,
      warmup,
      switchMs,
      reviewMs,
      frames,
      longTasks,
      beforeCycles,
      afterCycles,
      afterSessionsClosed,
      afterUnmount,
    };
  } finally {
    await context.close();
  }
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
function summarize(values) {
  const mid = median(values);
  return {
    median: mid,
    mad: median(values.map((v) => Math.abs(v - mid))),
    min: Math.min(...values),
    max: Math.max(...values),
    values,
  };
}
function compare(before, after, relativeLimit, absoluteLimit) {
  const delta = after.median - before.median;
  const allowance = Math.max(before.median * relativeLimit, absoluteLimit);
  const noise = 2 * (before.mad + after.mad);
  return {
    before,
    after,
    delta,
    allowance,
    noise,
    verdict:
      delta > allowance && delta > noise
        ? 'regression'
        : Math.abs(delta) <= noise
          ? 'inconclusive-within-noise'
          : delta > allowance
            ? 'inconclusive-noisy-over-budget'
            : 'within-budget',
  };
}
try {
  await stat(browserPath);
  const urls = { before: await prepare('before'), after: await prepare('after') };
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const results = [];
  for (let i = -warmups; i < samples; i++) {
    // AB/BA pairs compensate for gradual machine warming; no overlapping pages or runs.
    for (const label of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
      console.log(
        `${i < 0 ? 'warmup' : 'sample'} ${i < 0 ? i + warmups + 1 : i + 1}/${i < 0 ? warmups : samples}: ${label}`,
      );
      results.push(await runSample(label, urls[label], i, i < 0));
      await writeFile(join(output, 'raw.json'), JSON.stringify(results, null, 2));
    }
  }
  const select = (label, fn) =>
    summarize(results.filter((r) => r.label === label && !r.warmup).map(fn));
  const metric = (fn, rel, abs) => compare(select('before', fn), select('after', fn), rel, abs);
  const comparisons = {
    switchToPaintMs: metric(
      (r) => median(r.switchMs),
      policy.interaction.relative,
      policy.interaction.absoluteMs,
    ),
    reviewToPaintMs: metric(
      (r) => median(r.reviewMs),
      policy.interaction.relative,
      policy.interaction.absoluteMs,
    ),
    streamingFrameP95Ms: metric(
      (r) => percentile(r.frames, 0.95),
      policy.frameP95.relative,
      policy.frameP95.absoluteMs,
    ),
    loadedHeapBytes: metric(
      (r) => r.beforeCycles.heapBytes,
      policy.heap.relative,
      policy.heap.absoluteBytes,
    ),
    loadedDomNodes: metric(
      (r) => r.beforeCycles.nodes,
      policy.dom.relative,
      policy.dom.absoluteNodes,
    ),
  };
  const teardown = results
    .filter((r) => !r.warmup)
    .map((r) => ({
      label: r.label,
      index: r.index,
      listenerGrowth: r.afterCycles.jsEventListeners - r.beforeCycles.jsEventListeners,
      nodeGrowth: r.afterCycles.nodes - r.beforeCycles.nodes,
      heapGrowth: r.afterCycles.heapBytes - r.beforeCycles.heapBytes,
      afterSessionsClosed: r.afterSessionsClosed,
      afterUnmount: r.afterUnmount,
      passed:
        r.afterCycles.jsEventListeners - r.beforeCycles.jsEventListeners <=
          policy.teardown.extraListeners &&
        r.afterUnmount.subscriptions === 0 &&
        r.afterUnmount.focusSubscriptions === 0 &&
        r.afterUnmount.animations === 0 &&
        r.afterUnmount.intervals === 0 &&
        r.afterUnmount.timeouts === 0 &&
        r.afterUnmount.frames === 0,
    }));
  const report = {
    baseline,
    snapshotDigests,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      cpu: cpus()[0]?.model,
      browser: browser.version(),
      browserPath,
      viewport: '1200x780@1',
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
    },
    fixture: {
      sessions: 8,
      markdownSectionsPerSession: 160,
      diffHunks: 12,
      diffLines: 480,
      streamUpdates: 90,
    },
    policy,
    comparisons,
    teardown,
    limitations: [
      'Synthetic renderer comparison, not native Electron or SDK throughput.',
      'Input/state are deterministic; real elapsed time and browser scheduling are inherently noisy.',
      'Two-frame click-to-paint proxy is not field INP.',
      'Clicks are DOM-dispatched in both versions: pointer hit-target coverage is outside this benchmark.',
      'DOM listener counts include React root delegates; document-global modality/ambient listeners persist until document closes.',
      'Heap includes the QA event journal and the added stream block; growth is descriptive, not an isolated leak proof.',
    ],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const lines = Object.entries(comparisons).map(
    ([name, result]) =>
      `- ${name}: ${result.before.median.toFixed(2)} → ${result.after.median.toFixed(2)}; ${result.verdict} (noise ±${result.noise.toFixed(2)}).`,
  );
  await writeFile(
    join(output, 'README.md'),
    `# Performance before/after\n\nBaseline: ${baseline}. Browser: ${browser.version()}. ${samples} serial AB/BA measured pairs after ${warmups} warmup pair; same compiled harness and fixed fixtures. Thresholds were saved before measuring in policy.json.\n\n${lines.join('\n')}\n\nTeardown: ${teardown.filter((r) => r.passed).length}/${teardown.length} samples meet cleanup assertions. See report.json for retained counters and raw.json for every sample.\n\n${report.limitations.map((v) => `- ${v}`).join('\n')}\n`,
  );
  console.log(
    JSON.stringify(
      {
        comparisons,
        teardownPassed: teardown.filter((r) => r.passed).length,
        teardownTotal: teardown.length,
      },
      null,
      2,
    ),
  );
  if (
    Object.values(comparisons).some((r) => r.verdict === 'regression') ||
    teardown.some((r) => !r.passed && r.label === 'after')
  )
    process.exitCode = 1;
} catch (error) {
  await writeFile(join(output, 'failure.log'), error.stack ?? String(error));
  throw error;
} finally {
  await browser?.close();
  for (const server of servers) await new Promise((resolveClose) => server.close(resolveClose));
  // Unlink each verified junction before deleting only our resolved temporary directory.
  for (const junction of junctions) {
    assert(relative(scratch, junction).endsWith('node_modules'));
    await rm(junction, { force: true });
  }
  assert(resolve(scratch).startsWith(resolve(tmpdir()) + sep));
  await rm(scratch, { recursive: true, force: true });
}
