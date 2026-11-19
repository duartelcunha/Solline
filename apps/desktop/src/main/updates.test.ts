import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppUpdater,
  RELEASE_REPO,
  compareSemver,
  isAllowedAssetUrl,
  isAllowedReleaseUrl,
  parseSha256Sums,
} from './updates.ts';

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('updates helpers', () => {
  it('compares semver versions safely and ignores malformed tags', () => {
    expect(compareSemver('0.0.2', '0.0.1')).toBeGreaterThan(0);
    expect(compareSemver('v1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('v0.0.1', '0.0.1')).toBe(0);
    expect(compareSemver('not-semver', '0.0.1')).toBe(0);
  });

  it('parses SHA256SUMS.txt and rejects path traversal or unsafe names', () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'B'.repeat(64);
    const hashC = 'c'.repeat(64);
    const sums = parseSha256Sums(
      [
        '# comment',
        `${hashA}  Solline-Setup-0.0.2.exe`,
        `${hashB} *Solline-Setup-0.0.3.exe`,
        `${hashC}  ../evil.exe`,
        `${hashC}  sub/dir.exe`,
        'not-a-hash  Solline.exe',
      ].join('\n'),
    );
    expect(sums.get('Solline-Setup-0.0.2.exe')).toBe(hashA);
    expect(sums.get('Solline-Setup-0.0.3.exe')).toBe(hashB.toLowerCase());
    expect(sums.has('../evil.exe')).toBe(false);
    expect(sums.has('sub/dir.exe')).toBe(false);
  });

  it('enforces strict GitHub HTTPS release and asset allowlists', () => {
    expect(isAllowedReleaseUrl(`https://github.com/${RELEASE_REPO}/releases/tag/v0.0.2`)).toBe(true);
    expect(isAllowedReleaseUrl('https://github.com/other/repo/releases/tag/v0.0.2')).toBe(false);
    expect(isAllowedReleaseUrl('https://user:pass@github.com/duartelcunha/Solline/releases/latest')).toBe(false);
    expect(isAllowedReleaseUrl('http://github.com/duartelcunha/Solline/releases/latest')).toBe(false);

    expect(
      isAllowedAssetUrl(
        `https://github.com/${RELEASE_REPO}/releases/download/v0.0.2/Solline-Setup-0.0.2.exe`,
      ),
    ).toBe(true);
    expect(isAllowedAssetUrl('https://objects.githubusercontent.com/github-production-release-asset/1')).toBe(true);
    expect(isAllowedAssetUrl('https://release-assets.githubusercontent.com/abc')).toBe(true);
    expect(isAllowedAssetUrl('https://evil.example.com/Solline-Setup.exe')).toBe(false);
    expect(isAllowedAssetUrl('https://raw.githubusercontent.com/duartelcunha/Solline/main/x.exe')).toBe(false);
  });
});

describe('AppUpdater', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeUpdater(overrides: Partial<ConstructorParameters<typeof AppUpdater>[0]> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'solline-updates-test-'));
    dirs.push(dir);
    const confirm = vi.fn(async () => true);
    const openExternal = vi.fn();
    const openPath = vi.fn(async () => '');
    const updater = new AppUpdater({
      currentVersion: () => '0.0.1',
      userDataDir: () => dir,
      confirm,
      openExternal,
      openPath,
      now: () => 1_700_000_000_000,
      ...overrides,
    });
    return { dir, updater, confirm, openExternal, openPath };
  }

  it('handles 404 (no published releases) as up-to-date and network failures as unavailable', async () => {
    const { updater: noRel } = await makeUpdater({
      fetch: async () => new Response('Not Found', { status: 404 }),
    });
    expect(await noRel.check()).toMatchObject({
      status: 'up-to-date',
      currentVersion: '0.0.1',
      latestVersion: null,
      installer: null,
    });

    const { updater: offline } = await makeUpdater({
      fetch: async () => {
        throw new Error('ENETUNREACH');
      },
    });
    expect(await offline.check()).toMatchObject({
      status: 'unavailable',
      currentVersion: '0.0.1',
      detail: expect.stringContaining('ENETUNREACH'),
    });
  });

  it('returns up-to-date when upstream release matches current version', async () => {
    const { updater } = await makeUpdater({
      fetch: async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v0.0.1',
            html_url: `https://github.com/${RELEASE_REPO}/releases/tag/v0.0.1`,
            published_at: '2026-11-19T12:00:00Z',
            body: 'Initial build',
            assets: [],
          }),
          { status: 200 },
        ),
    });
    expect(await updater.check()).toMatchObject({
      status: 'up-to-date',
      currentVersion: '0.0.1',
      latestVersion: '0.0.1',
      installer: null,
    });
  });

  it('downloads and verifies SHA-256 before opening the installer after confirmation', async () => {
    const exeBytes = Buffer.from('MZ-simulated-solline-installer-0.0.2');
    const exeHash = sha256Hex(exeBytes);
    const assetName = 'Solline-Setup-0.0.2.exe';
    const releaseUrl = `https://github.com/${RELEASE_REPO}/releases/tag/v0.0.2`;
    const exeUrl = `https://github.com/${RELEASE_REPO}/releases/download/v0.0.2/${assetName}`;
    const sumsUrl = `https://github.com/${RELEASE_REPO}/releases/download/v0.0.2/SHA256SUMS.txt`;
    const cdnUrl = 'https://objects.githubusercontent.com/github-production-release-asset/002';

    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.0.2',
            html_url: releaseUrl,
            published_at: '2026-11-19T14:00:00Z',
            body: 'Novidades da versão 0.0.2',
            assets: [
              { name: assetName, browser_download_url: exeUrl },
              { name: 'SHA256SUMS.txt', browser_download_url: sumsUrl },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === sumsUrl) {
        return new Response(`${exeHash}  ${assetName}\n`, { status: 200 });
      }
      if (url === exeUrl) {
        return new Response(null, { status: 302, headers: { Location: cdnUrl } });
      }
      if (url === cdnUrl) {
        return new Response(exeBytes, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { dir, updater, confirm, openPath } = await makeUpdater({ fetch: fakeFetch });
    await expect(updater.install('0.0.2')).rejects.toThrow('Verifica primeiro');

    const check = await updater.check();
    expect(check).toMatchObject({
      status: 'available',
      latestVersion: '0.0.2',
      installer: { name: assetName, url: exeUrl, sha256: exeHash },
    });

    confirm.mockResolvedValueOnce(false);
    expect(await updater.install('0.0.2')).toEqual({ started: false });
    expect(openPath).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    const installed = await updater.install('0.0.2');
    const expectedPath = path.join(dir, 'updates', assetName);
    expect(installed).toEqual({ started: true, installerPath: expectedPath });
    expect(openPath).toHaveBeenCalledWith(expectedPath);
    expect(await readFile(expectedPath)).toEqual(exeBytes);
  });

  it('discards temp file on SHA-256 mismatch and rejects disallowed redirects', async () => {
    const assetName = 'Solline-Setup-0.0.2.exe';
    const exeUrl = `https://github.com/${RELEASE_REPO}/releases/download/v0.0.2/${assetName}`;
    const sumsUrl = `https://github.com/${RELEASE_REPO}/releases/download/v0.0.2/SHA256SUMS.txt`;
    let exeResponse = Buffer.from('corrupted-payload');

    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.0.2',
            html_url: `https://github.com/${RELEASE_REPO}/releases/tag/v0.0.2`,
            assets: [
              { name: assetName, browser_download_url: exeUrl },
              { name: 'SHA256SUMS.txt', browser_download_url: sumsUrl },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === sumsUrl) {
        return new Response(`${sha256Hex('expected-authentic-bytes')}  ${assetName}\n`, {
          status: 200,
        });
      }
      if (url === exeUrl) {
        return new Response(exeResponse, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { dir, updater, openPath } = await makeUpdater({ fetch: fakeFetch });
    await updater.check();
    await expect(updater.install('0.0.2')).rejects.toThrow('SHA-256');
    expect(openPath).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, 'updates', assetName))).toBe(false);
    expect(await readdir(path.join(dir, 'updates'))).toEqual([]);

    // Disallowed redirect target
    exeResponse = Buffer.from('expected-authentic-bytes');
    const redirectUpdater = new AppUpdater({
      currentVersion: () => '0.0.1',
      userDataDir: () => dir,
      confirm: async () => true,
      openExternal: vi.fn(),
      openPath: vi.fn(async () => ''),
      fetch: async (input) => {
        const url = String(input);
        if (url === exeUrl) {
          return new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/a.exe' } });
        }
        return fakeFetch(input);
      },
    });
    await redirectUpdater.check();
    await expect(redirectUpdater.install('0.0.2')).rejects.toThrow('não autorizado');
  });

  it('falls back to opening the verified release page when SHA256SUMS.txt is absent', async () => {
    const assetName = 'Solline-Setup-0.0.2.exe';
    const releaseUrl = `https://github.com/${RELEASE_REPO}/releases/tag/v0.0.2`;
    const exeUrl = `https://github.com/${RELEASE_REPO}/releases/download/v0.0.2/${assetName}`;

    const { updater, openExternal, openPath } = await makeUpdater({
      fetch: async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v0.0.2',
            html_url: releaseUrl,
            assets: [{ name: assetName, browser_download_url: exeUrl }],
          }),
          { status: 200 },
        ),
    });

    const check = await updater.check();
    expect(check.status).toBe('available');
    expect(check.installer).toBeNull();
    expect(await updater.install('0.0.2')).toEqual({ started: true, openedReleasePage: true });
    expect(openExternal).toHaveBeenCalledWith(releaseUrl);
    expect(openPath).not.toHaveBeenCalled();
  });
});
