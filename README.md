# Solline

**Solline is a personal Windows desktop app for working with coding agents in one place.**

It brings Claude Code, Codex and reviewed ACP agents into a shared workspace, so you can
keep project rules, review work and continue with another agent. `main` includes M6 (the
shared brain) and M7 (GitHub issue, commit, pull request, read-only CI, and archive when
the pull request merges). M8 has started with a measurement baseline. The decisions and
the slice plan are in [docs/M8-plano.md](docs/M8-plano.md). The resume point is
[STATUS.md](STATUS.md) and the roadmap is [the vision](docs/visao.md).

## Try it

Run the development app using the commands below. Use a disposable project for your first
session, choose an available agent and follow its sign-in instructions. Agent availability
depends on the tools and accounts installed on your machine. See [the agent catalogue](packages/engine/src/agents/catalog.ts)
and [the desktop smoke scenarios](apps/desktop/e2e/smoke.spec.ts).

## Technical

### Stack and structure

- `apps/desktop`: Electron 44, React 19 and TypeScript, built with electron-vite.
- `packages/engine`: Node engine and agent adapters, independent of Electron.
- `packages/protocol`: shared contracts validated with Zod.
- `packages/ui`: shared design tokens and local fonts.

Architecture rules live in [CLAUDE.md](CLAUDE.md); contributor commands are in [AGENTS.md](AGENTS.md).

### Run locally

Node >=22.18 and pnpm 10.34.6 are declared in `package.json:5`.
With that package manager available, run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The root scripts also provide `pnpm build` and `pnpm dist`; the Windows installer output is
`apps/desktop/release` (`package.json:9`, `apps/desktop/electron-builder.config.mjs:9`).
Installation, launch and packaging were not run for this update.

### Test

Workspace commands (`package.json:12`, `packages/engine/package.json:9`,
`apps/desktop/package.json:11`):

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Engine integration tests can use real agent accounts. Set `SOLLINE_SKIP_SDK=1` for an offline
run; `SOLLINE_AGENTS` selects real agents (`packages/engine/test/real-agents.ts:3`).
The paired-trial baseline is `packages/engine/src/pilot`. Two arms, the same model:
the native client and Solline. Ten real tasks. Without a model client, every
model-dependent cell stays not measured. A missing number is not stored as zero.
The capability matrix is `packages/engine/src/pilot/matrix.ts`. No model client was
available for the first baseline run, so acceptance and focused minutes are not measured.
Tokens are recorded only when a client reports them.
The desktop smoke enables real sessions with `SOLLINE_E2E_SDK=1`, accepts an installed app
through `SOLLINE_EXE`, and captures screenshots with `SOLLINE_SHOTS`
(`apps/desktop/e2e/smoke.spec.ts:19`).

For an existing Windows checkout without pnpm, use the installed binaries in PowerShell:

```powershell
cd apps/desktop
../../node_modules/.bin/vitest.cmd run src/main
../../node_modules/.bin/tsc.cmd -p tsconfig.node.json --noEmit
../../node_modules/.bin/tsc.cmd -p tsconfig.web.json --noEmit
../../node_modules/.bin/eslint.cmd .
```

The current sandbox needs `--configLoader runner` for desktop Vitest; the default config
bundler encounters an access denial. The resulting run still fails its Windows vault test.
See [STATUS.md](STATUS.md) for the verification results and pending checks.
