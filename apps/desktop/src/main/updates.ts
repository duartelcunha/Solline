import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type {
  UpdateCheckResult,
  UpdateInstaller,
  UpdateInstallResult,
} from '@solline/protocol';
import type { Confirmation } from './prompt-window.ts';

export const RELEASE_REPO = 'duartelcunha/Solline';
const MAX_SUMS_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Compares two semver strings (`X.Y.Z[-prerelease]`). Returns > 0 if `a > b`, < 0 if `a < b`,
 * and 0 if equal or if either string is not a valid semver version.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (pa[field] !== pb[field]) return pa[field] - pb[field];
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const left = pa.prerelease[i];
    const right = pb.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) return Number(left) - Number(right);
    if (leftNum !== rightNum) return leftNum ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Parses `SHA256SUMS.txt` (`<64-hex>  <filename>`) ignoring entries with path separators or `..`.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Fa-f0-9]{64})[ \t]+\*?([^\s]+)$/.exec(line);
    if (!match) continue;
    const hash = (match[1] ?? '').toLowerCase();
    const filename = match[2] ?? '';
    if (
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('..') ||
      !/^[A-Za-z0-9._-]+$/.test(filename)
    ) {
      continue;
    }
    map.set(filename, hash);
  }
  return map;
}

function hasCredentialsOrDots(url: URL): boolean {
  if (url.protocol !== 'https:') return true;
  if (url.username || url.password) return true;
  const segments = url.pathname.split('/');
  return segments.some((s) => s === '..');
}

export function isAllowedReleaseUrl(raw: string, repo: string = RELEASE_REPO): boolean {
  try {
    const url = new URL(raw);
    if (hasCredentialsOrDots(url)) return false;
    if (url.hostname.toLowerCase() !== 'github.com') return false;
    return url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`);
  } catch {
    return false;
  }
}

export function isAllowedAssetUrl(raw: string, repo: string = RELEASE_REPO): boolean {
  try {
    const url = new URL(raw);
    if (hasCredentialsOrDots(url)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'github.com') {
      return url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/download/`);
    }
    if (host === 'api.github.com') {
      return url.pathname.toLowerCase().startsWith(`/repos/${repo.toLowerCase()}/releases/assets/`);
    }
    return ALLOWED_DOWNLOAD_HOSTS.has(host);
  } catch {
    return false;
  }
}

function sanitizeNotes(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= 3800) return normalized;
  return `${normalized.slice(0, 3797).trimEnd()}...`;
}

function isSafeInstallerName(name: string): boolean {
  return !name.includes('..') && /^[A-Za-z0-9._-]+\.exe$/.test(name);
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
  draft?: unknown;
  assets?: unknown;
}

export interface UpdaterOptions {
  repo?: string;
  currentVersion: () => string;
  userDataDir: () => string;
  fetch?: typeof globalThis.fetch;
  confirm: (options: Confirmation) => Promise<boolean>;
  openExternal: (url: string) => void | Promise<void>;
  openPath: (filePath: string) => Promise<string> | string;
  now?: () => number;
  maxSumsBytes?: number;
  maxInstallerBytes?: number;
}

/**
 * Read-only GitHub Release checker and SHA-256-verified downloader owned by `main`.
 */
export class AppUpdater {
  readonly #repo: string;
  readonly #currentVersion: () => string;
  readonly #userDataDir: () => string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #confirm: (options: Confirmation) => Promise<boolean>;
  readonly #openExternal: (url: string) => void | Promise<void>;
  readonly #openPath: (filePath: string) => Promise<string> | string;
  readonly #now: () => number;
  readonly #maxSumsBytes: number;
  readonly #maxInstallerBytes: number;
  #lastVerified: UpdateCheckResult | undefined;

  constructor(options: UpdaterOptions) {
    this.#repo = options.repo ?? RELEASE_REPO;
    this.#currentVersion = options.currentVersion;
    this.#userDataDir = options.userDataDir;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#confirm = options.confirm;
    this.#openExternal = options.openExternal;
    this.#openPath = options.openPath;
    this.#now = options.now ?? Date.now;
    this.#maxSumsBytes = options.maxSumsBytes ?? MAX_SUMS_BYTES;
    this.#maxInstallerBytes = options.maxInstallerBytes ?? MAX_INSTALLER_BYTES;
  }

  async check(): Promise<UpdateCheckResult> {
    const currentVersion = this.#currentVersion();
    const checkedAt = this.#now();
    this.#lastVerified = undefined;

    const apiUrl = `https://api.github.com/repos/${this.#repo}/releases/latest`;
    let res: Response;
    try {
      res = await this.#fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Solline/${currentVersion}`,
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        releaseUrl: null,
        notes: '',
        installer: null,
        checkedAt,
        detail: `Não foi possível contactar o GitHub (${error instanceof Error ? error.message : String(error)}).`,
      };
    }

    if (res.status === 404) {
      return {
        status: 'up-to-date',
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        releaseUrl: null,
        notes: '',
        installer: null,
        checkedAt,
        detail: 'Ainda não há lançamentos publicados no GitHub.',
      };
    }

    if (!res.ok) {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        releaseUrl: null,
        notes: '',
        installer: null,
        checkedAt,
        detail:
          res.status === 403 || res.status === 429
            ? 'O GitHub limitou temporariamente os pedidos. Tenta mais tarde.'
            : `O GitHub devolveu o estado HTTP ${res.status}.`,
      };
    }

    let payload: GithubReleasePayload;
    try {
      payload = (await res.json()) as GithubReleasePayload;
    } catch {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        releaseUrl: null,
        notes: '',
        installer: null,
        checkedAt,
        detail: 'A resposta do GitHub não é JSON válido.',
      };
    }

    if (payload.draft === true || typeof payload.tag_name !== 'string') {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        releaseUrl: null,
        notes: '',
        installer: null,
        checkedAt,
        detail: 'Os dados do lançamento no GitHub estão incompletos.',
      };
    }

    const latestVersion = payload.tag_name.trim().replace(/^v/i, '');
    if (!parseSemver(latestVersion)) {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        releaseUrl: null,
        notes: '',
        installer: null,
        checkedAt,
        detail: 'A versão do lançamento não segue o formato semver esperado.',
      };
    }

    const releaseUrl =
      typeof payload.html_url === 'string' && isAllowedReleaseUrl(payload.html_url, this.#repo)
        ? payload.html_url
        : null;
    const publishedAt = typeof payload.published_at === 'string' ? payload.published_at : null;

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      return {
        status: 'up-to-date',
        currentVersion,
        latestVersion,
        publishedAt,
        releaseUrl,
        notes: '',
        installer: null,
        checkedAt,
      };
    }

    const installer = await this.#resolveInstaller(payload.assets, currentVersion);
    const result: UpdateCheckResult = {
      status: 'available',
      currentVersion,
      latestVersion,
      publishedAt,
      releaseUrl,
      notes: sanitizeNotes(payload.body),
      installer,
      checkedAt,
    };
    this.#lastVerified = result;
    return result;
  }

  async install(version: string): Promise<UpdateInstallResult> {
    const target = this.#lastVerified;
    if (!target || target.status !== 'available' || target.latestVersion !== version) {
      throw new Error('Verifica primeiro as atualizações disponíveis antes de instalar.');
    }

    if (target.installer) {
      const confirmed = await this.#confirm({
        title: 'Atualizar o Solline',
        message: `Transferir e abrir o instalador v${target.latestVersion}?`,
        detail: `Ficheiro: ${target.installer.name}\nSHA-256 esperado: ${target.installer.sha256}\n\nA assinatura SHA-256 é verificada antes de abrir o instalador.`,
        acceptLabel: 'Transferir e instalar',
        cancelLabel: 'Cancelar',
      });
      if (!confirmed) return { started: false };

      const dest = await this.#downloadVerified(target.installer, target.currentVersion);
      const openErr = await this.#openPath(dest);
      if (openErr) {
        throw new Error(`Não foi possível abrir o instalador: ${openErr}`);
      }
      return { started: true, installerPath: dest };
    }

    if (target.releaseUrl) {
      const confirmed = await this.#confirm({
        title: 'Abrir lançamento no GitHub',
        message: `Abrir a página da versão v${target.latestVersion}?`,
        detail: `${target.releaseUrl}\n\nEste lançamento não inclui verificação SHA-256 automática para o instalador.`,
        acceptLabel: 'Abrir no browser',
        cancelLabel: 'Cancelar',
      });
      if (!confirmed) return { started: false };

      await this.#openExternal(target.releaseUrl);
      return { started: true, openedReleasePage: true };
    }

    throw new Error('Este lançamento não tem instalador nem página de transferência válida.');
  }

  async #resolveInstaller(
    rawAssets: unknown,
    currentVersion: string,
  ): Promise<UpdateInstaller | null> {
    if (!Array.isArray(rawAssets)) return null;
    const assets = rawAssets as GithubAsset[];

    const validExe = assets.filter(
      (a): a is { name: string; browser_download_url: string } =>
        typeof a?.name === 'string' &&
        isSafeInstallerName(a.name) &&
        typeof a.browser_download_url === 'string' &&
        isAllowedAssetUrl(a.browser_download_url, this.#repo),
    );
    const exeAsset = validExe.find((a) => /^Solline-Setup-.*\.exe$/i.test(a.name)) ?? validExe[0];
    const sumsAsset = assets.find(
      (a): a is { name: string; browser_download_url: string } =>
        a?.name === 'SHA256SUMS.txt' &&
        typeof a.browser_download_url === 'string' &&
        isAllowedAssetUrl(a.browser_download_url, this.#repo),
    );
    if (!exeAsset || !sumsAsset) return null;

    try {
      const res = await this.#fetchWithValidatedRedirects(sumsAsset.browser_download_url, {
        headers: { 'User-Agent': `Solline/${currentVersion}` },
        timeoutMs: CHECK_TIMEOUT_MS,
        maxBytes: this.#maxSumsBytes,
      });
      if (!res.ok) return null;
      const text = await this.#readTextLimited(res, this.#maxSumsBytes);
      const sums = parseSha256Sums(text);
      const sha256 = sums.get(exeAsset.name);
      if (!sha256) return null;
      return {
        name: exeAsset.name,
        url: exeAsset.browser_download_url,
        sha256,
      };
    } catch {
      return null;
    }
  }

  async #fetchWithValidatedRedirects(
    initialUrl: string,
    options: { headers: Record<string, string>; timeoutMs: number; maxBytes: number },
  ): Promise<Response> {
    let currentUrl = initialUrl;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      if (!isAllowedAssetUrl(currentUrl, this.#repo)) {
        throw new Error('URL de transferência fora dos domínios autorizados do GitHub.');
      }
      const res = await this.#fetch(currentUrl, {
        headers: options.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new Error('Redirecionamento sem destino.');
        const nextUrl = new URL(location, currentUrl).href;
        if (!isAllowedAssetUrl(nextUrl, this.#repo)) {
          throw new Error('Redirecionamento de atualização não autorizado.');
        }
        currentUrl = nextUrl;
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error('O ficheiro de atualização excede o tamanho máximo permitido.');
      }
      return res;
    }
    throw new Error('Demasiados redirecionamentos ao transferir a atualização.');
  }

  async #readTextLimited(res: Response, maxBytes: number): Promise<string> {
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new Error('O ficheiro SHA256SUMS.txt excede o tamanho máximo.');
      }
      return buf.toString('utf8');
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel('size limit exceeded').catch(() => undefined);
          throw new Error('O ficheiro SHA256SUMS.txt excede o tamanho máximo.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  async #downloadVerified(installer: UpdateInstaller, currentVersion: string): Promise<string> {
    if (!isSafeInstallerName(installer.name)) {
      throw new Error('Nome do instalador inválido.');
    }
    const dir = path.join(this.#userDataDir(), 'updates');
    await mkdir(dir, { recursive: true });
    const destPath = path.join(dir, installer.name);
    const tmpPath = path.join(dir, `${installer.name}.tmp-${randomUUID()}`);

    const res = await this.#fetchWithValidatedRedirects(installer.url, {
      headers: { 'User-Agent': `Solline/${currentVersion}` },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: this.#maxInstallerBytes,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Falha ao transferir o instalador (HTTP ${res.status}).`);
    }

    const hash = createHash('sha256');
    const stream = createWriteStream(tmpPath, { flags: 'wx' });
    let total = 0;
    let renamed = false;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > this.#maxInstallerBytes) {
              await reader.cancel('size limit exceeded').catch(() => undefined);
              throw new Error('O instalador excede o tamanho máximo permitido.');
            }
            const chunk = Buffer.from(value);
            hash.update(chunk);
            if (!stream.write(chunk)) {
              await once(stream, 'drain');
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > this.#maxInstallerBytes) {
          throw new Error('O instalador excede o tamanho máximo permitido.');
        }
        hash.update(buf);
        if (!stream.write(buf)) {
          await once(stream, 'drain');
        }
      }

      stream.end();
      await finished(stream);

      const actual = hash.digest();
      const expected = Buffer.from(installer.sha256, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('A verificação SHA-256 do instalador falhou; o ficheiro foi descartado.');
      }

      await rename(tmpPath, destPath);
      renamed = true;
      return destPath;
    } finally {
      if (!stream.destroyed) stream.destroy();
      if (!renamed) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
      }
    }
  }
}
