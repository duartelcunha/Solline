import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkUpdates,
  compareVersions,
  formatMarkdown,
  readPinnedVersions,
} from './check-updates.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('compareVersions', () => {
  it('orders major, minor, patch and prereleases', () => {
    assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.equal(compareVersions('v19.0.0', '19.0.0'), 0);
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
    assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0);
  });
});

describe('readPinnedVersions', () => {
  it('reads all 5 pinned agent/MCP versions from the repository without drift', () => {
    const pinned = readPinnedVersions(repoRoot);
    assert.equal(pinned.length, 5);
    assert.deepEqual(
      pinned.map((entry) => entry.id),
      ['claude', 'codex', 'opencode', 'omp', 'rea'],
    );
    for (const entry of pinned) {
      assert.match(entry.pinnedVersion ?? '', /^\d+\.\d+\.\d+/);
      assert.deepEqual(entry.drift, []);
    }
  });

  it('detects version drift between package.json and reviewed/generated constants', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'solline-updates-drift-'));
    try {
      for (const rel of [
        'packages/engine/package.json',
        'apps/desktop/package.json',
        'packages/engine/src/adapters/codex/executable.ts',
        'packages/engine/src/adapters/codex/protocol/GENERATED_FROM.ts',
        'packages/engine/src/agents/catalog.ts',
        'packages/engine/src/mcp/catalog.ts',
      ]) {
        cpSync(path.join(repoRoot, rel), path.join(tempRoot, rel));
      }
      const genPath = path.join(tempRoot, 'packages/engine/src/adapters/codex/protocol/GENERATED_FROM.ts');
      writeFileSync(genPath, readFileSync(genPath, 'utf8').replace(/'[^']+'/, "'0.0.0'"), 'utf8');

      const desktopPkgPath = path.join(tempRoot, 'apps/desktop/package.json');
      const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
      desktopPkg.dependencies['@anthropic-ai/claude-agent-sdk'] = '0.0.1';
      writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2), 'utf8');

      const pinned = readPinnedVersions(tempRoot);
      const codex = pinned.find((entry) => entry.id === 'codex');
      const claude = pinned.find((entry) => entry.id === 'claude');
      assert.equal(codex.drift.length, 1);
      assert.match(codex.drift[0], /GENERATED_FROM=0\.0\.0/);
      assert.equal(claude.drift.length, 1);
      assert.match(claude.drift[0], /Version mismatch/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('checkUpdates', () => {
  it('reports updates, up-to-date items, and upstream HTTP errors', async () => {
    const pinned = readPinnedVersions(repoRoot);
    const bumpMinor = (version) => {
      const [maj, min] = version.split('.').map(Number);
      return `${maj}.${min + 1}.0`;
    };
    const codexPinned = pinned.find((item) => item.id === 'codex').pinnedVersion;
    const ompPinned = pinned.find((item) => item.id === 'omp').pinnedVersion;

    const fakeFetch = async (url) => {
      if (url.includes('@openai%2Fcodex')) {
        return new Response(JSON.stringify({ version: bumpMinor(codexPinned) }), { status: 200 });
      }
      if (url.includes('can1357/oh-my-pi')) {
        return new Response(
          JSON.stringify({
            tag_name: `v${ompPinned}`,
            html_url: `https://github.com/can1357/oh-my-pi/releases/tag/v${ompPinned}`,
            published_at: '2026-11-19T00:00:00Z',
          }),
          { status: 200 },
        );
      }
      if (url.includes('opencode-ai')) {
        return new Response('rate limited', { status: 503 });
      }
      const id = url.includes('claude-agent-sdk') ? 'claude' : 'rea';
      const current = pinned.find((item) => item.id === id).pinnedVersion;
      return new Response(JSON.stringify({ version: current }), { status: 200 });
    };

    const report = await checkUpdates({ root: repoRoot, fetchImpl: fakeFetch });
    assert.equal(report.updatesAvailable, true);
    assert.equal(report.driftDetected, false);
    assert.equal(report.fetchErrors, 1);

    const codex = report.items.find((item) => item.id === 'codex');
    assert.equal(codex.updateAvailable, true);

    const omp = report.items.find((item) => item.id === 'omp');
    assert.equal(omp.updateAvailable, false);
    assert.equal(omp.latestVersion, ompPinned);

    const opencode = report.items.find((item) => item.id === 'opencode');
    assert.match(opencode.error ?? '', /503/);

    const md = formatMarkdown(report);
    assert.match(md, /## Audit Checklist/);
    assert.match(md, /codex:gen/);
  });
});
