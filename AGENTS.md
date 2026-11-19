# Solline

Personal Windows desktop app for coding agents. Read [STATUS.md](STATUS.md) first,
then [docs/visao.md](docs/visao.md) for the roadmap and [CLAUDE.md](CLAUDE.md) for
architecture and agent rules. Historical decisions remain in [DECISIONS.md](DECISIONS.md).

## Commands

Node >=22.18; pnpm 10.34.6 (`package.json`). From the repository root:
`pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm dist`. The root scripts call `corepack pnpm`, so they still run when pnpm is not on
`PATH` and only Corepack can start it. If pnpm is not installed, use
`corepack pnpm@10.34.6 install --frozen-lockfile`.

With dependencies installed, PowerShell checks without pnpm:

```powershell
cd apps/desktop
../../node_modules/.bin/vitest.cmd run src/main
../../node_modules/.bin/tsc.cmd -p tsconfig.node.json --noEmit
../../node_modules/.bin/tsc.cmd -p tsconfig.web.json --noEmit
../../node_modules/.bin/eslint.cmd .
cd ../../packages/engine
../../node_modules/.bin/vitest.cmd run test/git-resolution.test.ts test/spaces-analysis.test.ts test/memory.test.ts
../../node_modules/.bin/tsc.cmd --noEmit
../../node_modules/.bin/eslint.cmd .
```

Use `SOLLINE_SKIP_SDK=1` for offline engine tests; real-agent tests consume account quota.
Full desktop tests build and launch Electron (`apps/desktop/package.json:17`);
coordinate those separately from pure Node unit checks.

## Project rules

- Preserve the engine, protocol and renderer boundaries described in `CLAUDE.md`;
  the renderer uses only the preload API.
- Use the absolute executable from `resolveGit()` for Git commands in project folders;
  never fall back to a bare `git` when resolution fails. Test each changed call.
- Keep credentials and real user data out of source, fixtures and reports.
- As Codex, leave changes in the working tree for review; no commit, push or PR.
- Code and new technical documentation are in English; `STATUS.md` is in European Portuguese.
- Keep `STATUS.md` a one-page resume point; command output and evidence go in the PR, not in `STATUS.md`.
- Sandbox lesson (2026-10-29): desktop Vitest's default config bundler can hit a parent-directory
  access denial; `--configLoader runner` loads the same config without bundling. This does not
  fix denied Windows vault access or Git index writes; leave those checks/actions pending.
