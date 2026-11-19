import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses a strict X.Y.Z[-prerelease] string into comparable numeric/tag parts.
 * Returns null when the input is not a valid semver version.
 */
export function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
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
 * Compares two semver strings. Returns > 0 if `a > b`, < 0 if `a < b`, 0 if equal.
 */
export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }
  for (const field of ['major', 'minor', 'patch']) {
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readCatalogReviewedVersion(source, entryId) {
  const escaped = entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = new RegExp(`\\bid:\\s*['"]${escaped}['"]`).exec(source);
  if (!startMatch) return null;
  const after = source.slice(startMatch.index + startMatch[0].length);
  const nextEntry = /\bid:\s*['"][^'"]+['"]/.exec(after);
  const slice = nextEntry ? after.slice(0, nextEntry.index) : after;
  const versionMatch = /\breviewedVersion:\s*['"]([^'"]+)['"]/.exec(slice);
  return versionMatch ? versionMatch[1] : null;
}

function readConstantVersion(source, constantName) {
  const match = new RegExp(`\\b${constantName}\\s*=\\s*['"]([^'"]+)['"]`).exec(source);
  return match ? match[1] : null;
}

/**
 * Reads all pinned agent SDK, CLI binary, and MCP versions directly from repository sources.
 */
export function readPinnedVersions(root = defaultRoot) {
  const enginePkg = readJson(path.join(root, 'packages/engine/package.json'));
  const desktopPkg = readJson(path.join(root, 'apps/desktop/package.json'));
  const codexExecSrc = readFileSync(
    path.join(root, 'packages/engine/src/adapters/codex/executable.ts'),
    'utf8',
  );
  const codexGenSrc = readFileSync(
    path.join(root, 'packages/engine/src/adapters/codex/protocol/GENERATED_FROM.ts'),
    'utf8',
  );
  const agentCatalogSrc = readFileSync(
    path.join(root, 'packages/engine/src/agents/catalog.ts'),
    'utf8',
  );
  const mcpCatalogSrc = readFileSync(
    path.join(root, 'packages/engine/src/mcp/catalog.ts'),
    'utf8',
  );

  const claudeEngine = enginePkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? null;
  const claudeDesktop = desktopPkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? null;
  const claudeDrift = [];
  if (claudeEngine !== claudeDesktop) {
    claudeDrift.push(
      `Version mismatch between packages/engine (${claudeEngine ?? 'missing'}) and apps/desktop (${claudeDesktop ?? 'missing'})`,
    );
  }

  const codexPkg = enginePkg.dependencies?.['@openai/codex'] ?? null;
  const codexReviewed = readConstantVersion(codexExecSrc, 'REVIEWED_CODEX_VERSION');
  const codexGenerated = readConstantVersion(codexGenSrc, 'GENERATED_FROM');
  const codexDrift = [];
  if (codexPkg !== codexReviewed || codexPkg !== codexGenerated) {
    codexDrift.push(
      `Codex pin mismatch: package.json=${codexPkg ?? 'missing'}, REVIEWED_CODEX_VERSION=${codexReviewed ?? 'missing'}, GENERATED_FROM=${codexGenerated ?? 'missing'}`,
    );
  }

  const opencodeVersion = readCatalogReviewedVersion(agentCatalogSrc, 'opencode');
  const ompVersion = readCatalogReviewedVersion(agentCatalogSrc, 'omp');
  const reaVersion = readCatalogReviewedVersion(mcpCatalogSrc, 'rea');

  return [
    {
      id: 'claude',
      label: 'Claude Agent SDK',
      kind: 'npm',
      packageName: '@anthropic-ai/claude-agent-sdk',
      sourceFile: 'packages/engine/package.json',
      pinnedVersion: claudeEngine,
      drift: claudeDrift,
      checklist: [
        'Review @anthropic-ai/claude-agent-sdk release notes for permissionMode / canUseTool / hooks changes.',
        'Update version in packages/engine/package.json and apps/desktop/package.json + pnpm install.',
        'Verify claudeMdExcludes behavior and run SDK/desktop Vitest suites.',
      ],
    },
    {
      id: 'codex',
      label: 'OpenAI Codex',
      kind: 'npm',
      packageName: '@openai/codex',
      sourceFile: 'packages/engine/package.json',
      pinnedVersion: codexPkg,
      drift: codexDrift,
      checklist: [
        'Bump @openai/codex in packages/engine/package.json and REVIEWED_CODEX_VERSION in packages/engine/src/adapters/codex/executable.ts.',
        'Run `pnpm --filter @solline/engine codex:gen` on Windows to regenerate protocol TS types.',
        'Run @solline/engine typecheck and Vitest (`test/codex*.test.ts`).',
      ],
    },
    {
      id: 'opencode',
      label: 'OpenCode ACP',
      kind: 'npm',
      packageName: 'opencode-ai',
      sourceFile: 'packages/engine/src/agents/catalog.ts',
      pinnedVersion: opencodeVersion,
      drift: opencodeVersion ? [] : ['Missing reviewedVersion for opencode in catalog.ts'],
      checklist: [
        'Audit opencode-ai package manifest, postinstall script, and `opencode acp` permission prompt handling.',
        'Update `reviewedVersion` and `install` in packages/engine/src/agents/catalog.ts.',
      ],
    },
    {
      id: 'omp',
      label: 'OMP (Oh My Pi)',
      kind: 'github-release',
      repo: 'can1357/oh-my-pi',
      sourceFile: 'packages/engine/src/agents/catalog.ts',
      pinnedVersion: ompVersion,
      drift: ompVersion ? [] : ['Missing reviewedVersion for omp in catalog.ts'],
      checklist: [
        'Run `omp --config <overlay> config list --json` and verify `tools.approvalMode: always-ask` plus overlapping subsystems remain disabled.',
        'Run `SOLLINE_AGENTS=omp vitest run test/omp-acp.integration.test.ts` for live ACP handshake + `_session/steering`.',
        'Update `reviewedVersion` / `install` in packages/engine/src/agents/catalog.ts and matrix.ts.',
      ],
    },
    {
      id: 'rea',
      label: 'REA MCP Server',
      kind: 'npm',
      packageName: 'rea-agents',
      sourceFile: 'packages/engine/src/mcp/catalog.ts',
      pinnedVersion: reaVersion,
      drift: reaVersion ? [] : ['Missing reviewedVersion for rea in mcp/catalog.ts'],
      checklist: [
        'Inspect rea-agents tarball and verify install remains safe with `--ignore-scripts`.',
        'Update `reviewedVersion` and `install` in packages/engine/src/mcp/catalog.ts.',
      ],
    },
  ];
}

async function fetchNpmLatest(packageName, fetchImpl) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Solline-Update-Watch' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`npm HTTP ${res.status} for ${packageName}`);
  }
  const data = await res.json();
  return {
    latestVersion: typeof data.version === 'string' ? data.version : null,
    releaseUrl: `https://www.npmjs.com/package/${packageName}/v/${data.version ?? ''}`,
    publishedAt: null,
  };
}

async function fetchGithubLatest(repo, fetchImpl, token) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Solline-Update-Watch',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub HTTP ${res.status} for ${repo}`);
  }
  const data = await res.json();
  const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
  return {
    latestVersion: tag.replace(/^v/i, '') || null,
    releaseUrl: typeof data.html_url === 'string' ? data.html_url : `https://github.com/${repo}/releases`,
    publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
  };
}

/**
 * Checks pinned agent/MCP versions against upstream registries/releases.
 */
export async function checkUpdates({
  root = defaultRoot,
  fetchImpl = globalThis.fetch,
  githubToken = process.env.GITHUB_TOKEN,
} = {}) {
  const pinned = readPinnedVersions(root);
  const items = await Promise.all(
    pinned.map(async (entry) => {
      try {
        const upstream =
          entry.kind === 'npm'
            ? await fetchNpmLatest(entry.packageName, fetchImpl)
            : await fetchGithubLatest(entry.repo, fetchImpl, githubToken);
        const updateAvailable =
          Boolean(entry.pinnedVersion && upstream.latestVersion) &&
          compareVersions(upstream.latestVersion, entry.pinnedVersion) > 0;
        return {
          ...entry,
          latestVersion: upstream.latestVersion,
          releaseUrl: upstream.releaseUrl,
          publishedAt: upstream.publishedAt,
          updateAvailable,
          error: null,
        };
      } catch (error) {
        return {
          ...entry,
          latestVersion: null,
          releaseUrl: null,
          publishedAt: null,
          updateAvailable: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return {
    checkedAt: new Date().toISOString(),
    updatesAvailable: items.some((item) => item.updateAvailable),
    driftDetected: items.some((item) => item.drift.length > 0),
    fetchErrors: items.filter((item) => item.error !== null).length,
    items,
  };
}

/**
 * Renders a Markdown summary report + per-agent audit checklist.
 */
export function formatMarkdown(report) {
  const lines = [
    '# Agent & MCP Version Watch',
    '',
    `Checked at: \`${report.checkedAt}\``,
    '',
    '| Component | Pinned | Latest | Status | Upstream |',
    '|---|---|---|---|---|',
  ];

  for (const item of report.items) {
    const status = item.error
      ? `Error (${item.error})`
      : item.drift.length > 0
        ? 'Drift detected'
        : item.updateAvailable
          ? 'Update available'
          : 'Up to date';
    const link = item.releaseUrl ? `[release](${item.releaseUrl})` : '—';
    lines.push(
      `| ${item.label} | \`${item.pinnedVersion ?? '?'}\` | \`${item.latestVersion ?? '?'}\` | ${status} | ${link} |`,
    );
  }

  const actionable = report.items.filter((item) => item.updateAvailable || item.drift.length > 0);
  if (actionable.length > 0) {
    lines.push('', '## Audit Checklist', '');
    for (const item of actionable) {
      lines.push(
        `### ${item.label} (\`${item.pinnedVersion ?? '?'}\` → \`${item.latestVersion ?? item.pinnedVersion ?? '?'}\`)`,
      );
      lines.push(`- Source: \`${item.sourceFile}\``);
      for (const note of item.drift) {
        lines.push(`- **Drift:** ${note}`);
      }
      for (const step of item.checklist) {
        lines.push(`- [ ] ${step}`);
      }
      lines.push('');
    }
  } else {
    lines.push('', 'All pinned agent SDKs, native binaries, and MCP servers match upstream.');
  }

  return lines.join('\n') + '\n';
}

const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const report = await checkUpdates();
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatMarkdown(report));
  }
}
