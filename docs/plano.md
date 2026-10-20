# Solline: todos os agentes num só cliente

## Resumo

**Onde ficámos.** M0 e M1 fechados a 11/10: o Claude Code corre pelo Agent SDK atrás de um
`AgentAdapter` neutro. Faltava o segundo agente (o antigo "M1b por ACP"). O repo está limpo e igual
ao origin. O plano de onde o `CLAUDE.md:4` aponta já não existe: este passa a viver no repo.

**REA (morluto/rea).** É um servidor MCP de engenharia reversa (binários, Electron, APKs…). **Não o
usamos para copiar harnesses**:

- todos têm interface pública (Agent SDK, `codex app-server`, ACP, endpoint Anthropic da DeepSeek);
- os termos da Anthropic (Consumer §3(3), Commercial D.4(b)) e do Cursor proíbem descompilar, e a
  exceção da UE (art. 6 da Diretiva 2009/24) não se aplica quando a interface é pública;
- o `claude.exe` é um executável Bun compilado, que o REA não abre.

Fica com dois usos legítimos e opcionais: servidor MCP por sessão (M1h) e auditoria estática do
`app.asar` do próprio Solline. Nunca `rea setup` (reescreve as configs globais de ~25 clientes).

**Como cada harness entra:**

| Harness                                                                                 | Caminho                                                                                                  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude Code                                                                             | Adaptador nativo do SDK (fica), sobe para 0.3.304                                                        |
| Codex                                                                                   | Adaptador nativo sobre `codex app-server` (JSON-RPC stdio, tipos gerados e fixados)                      |
| Modelos DeepSeek                                                                        | Pelo adaptador do Claude com um perfil de fornecedor (experimental) e pelo OpenCode por ACP              |
| DeepSeek Harness (dsh)                                                                  | Fica de fora por agora: o ACP dele é só para automação (sem modos, sem retomar, permissões por política) |
| Resto (Gemini/Antigravity, Qwen, Kimi Code, Copilot, Cursor, Grok, Goose, Cline, Vibe…) | Um adaptador ACP genérico, com entradas revistas uma a uma no código                                     |

**Ordem:** S0 → M1b Confiança → M1c Agentes como dados → M1d DeepSeek → M1e Ferramentas ricas →
M1f Codex → M1g ACP → M1h MCP + REA.

1. Segurança primeiro: hoje a interface escolhe `cwd` e modo à vontade; cada agente novo multiplica isso.
2. Agentes como dados e depois DeepSeek: o perfil é só env sobre o adaptador do Claude já testado,
   e torna reais o registo, a política de env e o seletor sem transporte novo.
3. Codex antes do ACP: foi o primeiro que pediste, testa o contrato a sério e constrói o par JSON-RPC,
   o arranque seguro e o gravador que o ACP reaproveita. O SDK do ACP 2.0 saiu ontem e ganha tempo.
4. MCP no fim e opcional; a metade do Claude pode sair logo a seguir ao M1d.

**Decisões por omissão (muda-as se quiseres):**

- Projetos novos entram como "sem confiança", com pergunta nativa.
- Modos de acesso total (bypass, yolo, `dangerFullAccess`) nunca aparecem.
- O `codex.exe` vai dentro do instalador (versão fixada, tipos batem certo).
- Agentes só binários (Antigravity, Cursor, Copilot) não entram nesta ronda.
- O segundo agente ACP, depois do OpenCode, escolhe-se no M1g.
- Fuses: chega uma leitura dos fuses e um arranque à mão; sem build `dist:e2e`.

## Regras para toda a sequência

1. **O Claude nunca parte.** Em projetos de confiança, env, `settingSources` e "Permitir sempre"
   ficam iguais. Ficam verdes em cada passo: `normalizer.test.ts`, `claude-adapter.test.ts`,
   `engine.test.ts` e o smoke (`apps/desktop/e2e/smoke.spec.ts`) com os mesmos test ids
   (`new-session`, `welcome-new-session`, `model-haiku`, `effort-low`, `mode-plan`,
   `permission-card`, `tool-block[data-tool]`).
2. **Um passo, um commit revisível**, pt-PT, Conventional Commits.
3. **A interface só manda ids**: `projectId`, `agentId`, ids de modo/modelo/effort. Nunca `cwd`,
   linhas de comando, valores de env nem URLs.
4. **O que alarga confiança passa por um diálogo nativo no main** (padrão do `projects.add`).
5. **Executáveis vivem no código**: entradas de agentes e MCP são constantes TS com
   `reviewedVersion` (e sha256 nos binários). Não há UI para acrescentar executáveis.
6. **Entrada de qualquer pacote de agente, MCP ou IA:** versão exata, `npm pack` para o scratchpad,
   rever ficheiros, scripts de instalação, licença e dependências, entrada no DECISIONS. Nunca
   `npx …@latest`, nunca ferramentas que reescrevem configs globais.
7. **Arrancar só caminhos absolutos**, nunca `shell: true` (no Windows um nome solto é procurado
   primeiro no `cwd`, e um repo podia plantar um `codex.exe`).
8. **Feito** = `pnpm typecheck`, `pnpm lint`, `pnpm test` limpos, mais as corridas reais do marco.

---

## S0: SDK 0.3.304 e o plano no repo

- `packages/engine/package.json` e `apps/desktop/package.json`: `@anthropic-ai/claude-agent-sdk`
  `0.3.304` (iguais nos dois); `pnpm-lock.yaml`.
- Copiar este plano para `docs/plano.md`; `CLAUDE.md:4` passa a apontar para lá e para o DECISIONS.
- `DECISIONS.md`, entrada "plano multi-agente": ordem, veredicto do REA, o antigo "M1b = ACP" é
  retirado e a revisão do contrato (`DECISIONS.md:34`) passa para o fecho do M1f. Notas do SDK:
  0.3.300 valida o `updatedInput` dos hooks (não nos afeta, usamos `canUseTool`); 0.3.302 liga os
  subagentes fork por omissão (mais blocos `parentToolId` planos) e põe fornecedores de terceiros em
  `default` (passamos sempre `permissionMode`).
- Testes: regravar as 4 fixtures (`pnpm --filter @solline/engine record <nome>`); se o
  `normalizer.test.ts` falhar, corrigir o normalizador. As corridas reais dizem se algo mudou.
- Feito: três comandos limpos e smoke `SOLLINE_E2E_SDK=1` verde.
- Commit: `chore(engine): subir o Agent SDK para 0.3.304`

---

## M1b: Confiança (só Claude, nada de novo à vista)

### B1: interface → motor

Contrato em `packages/protocol/src/commands.ts`:

```ts
const Text = z.string().min(1).max(200_000);
export const SessionCreatePayload = z
  .object({
    // interface -> main
    projectId: z.string().min(1).max(64),
    agent: AgentKind, // AgentId no M1c
    mode: z.string().min(1).max(64).optional(), // ausente = modo por omissão do agente
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(32).optional(),
  })
  .strict();
export const SessionStartPayload = SessionCreatePayload.extend({ cwd: z.string().min(1) }).strict();
/** main -> motor; não está no CommandNameSchema, por isso a IPC nunca o consegue nomear. */
export const internalCommandSchemas = {
  'session.start': { payload: SessionStartPayload, result: SessionCreateResult },
} as const;
// MAIN_COMMANDS += 'session.create'; EngineCommandName = engine subset + internos;
// engineCommandSchemas e EngineRequestEnvelope com z.enum(engineCommandNames)
// session.send: Text; permission.answer answers: record(string.max(500), string.max(10_000)), até 8 chaves
```

- `SessionInfo` (`conversation.ts`) ganha `projectId`.
- Novo `packages/protocol/src/capabilities.ts`: `findModel` sai de `pills.tsx:8-14` para o motor e
  a interface validarem modelos da mesma forma.

Ficheiros:

- `apps/desktop/src/main/projects.ts`: `get(id)`.
- Novo `apps/desktop/src/main/session-policy.ts` (função pura): `resolveSessionStart(store, payload, stat)`
  devolve o `SessionStartPayload`; "Projeto desconhecido" / "A pasta do projeto já não existe".
- `apps/desktop/src/main/index.ts`: `handleMain(command, payload)`; `session.create` chama
  `engine.request('session.start', await resolveSessionStart(...))`.
- `apps/desktop/src/main/engine-host.ts`: `request` usa `engineCommandSchemas`; o timeout passa a `session.start`.
- `packages/engine/src/engine.ts`: handler `session.start`; `handle` valida com `EngineRequestEnvelope`.
- `packages/engine/src/session-manager.ts`: `create` recebe o start payload; opções `staticModes`,
  `defaultModes` e `checkCwd` injetável (absoluto + `isDirectory`); `setMode/setModel/setEffort`
  validam contra `adapter.capabilities()`; se o modo pedido não vier nas capacidades depois do
  `start()` (ex. `auto` sem suporte no modelo), volta a `default` com aviso.
- `packages/engine/src/adapters/claude-sdk.ts`: `toPermissionMode(id)` só aceita `CLAUDE_MODES`
  (o `setMode` lança); `#sdkOptions` usa `toPermissionModeOr(id, 'default')` para o resume;
  `toEffortLevel(id)` só `low|medium|high|xhigh|max`. Acaba com os casts; `bypassPermissions` e
  `dontAsk` deixam de ser pedíveis.
- `apps/desktop/src/renderer/src/stores/app.ts`: manda `{ projectId, agent: 'claude' }`.
- `apps/desktop`: `vitest` (já no lockfile) + `vitest.config.ts`; `test` = `vitest run && electron-vite build && playwright test`.
- `packages/engine/test/helpers.ts`: `testSessionManager(factories)`.

Testes: atualizar quem cria sessões (`engine.test.ts`, `claude-adapter.test.ts`,
`claude-sdk.scenarios.integration.test.ts`) com `projectId` e `mkdtemp`. Novos: `session.create`
direto ao motor rejeitado; `cwd` no payload da interface rejeitado (`strict`); `cwd` relativo ou
inexistente rejeitado; `setMode('bypassPermissions')` lança; modelo desconhecido lança; effort fora
do modelo lança; texto grande rejeitado; `auto` sem suporte volta a `default`.
`session-policy.test.ts`. No smoke, `solline.request('session.create', {agent:'claude', cwd:'C:\\'})` falha.

Commit: `fix(desktop): sessões só em projetos conhecidos e modos validados no motor`

### B2: endurecer o Electron

- `main/index.ts`:
  - `isTrustedSender`: `e.sender === mainWindow.webContents`, frame de topo, e a mesma condição do
    load: com dev URL, origem exatamente igual; senão, URL igual ao `index.html` em `file://`
    (sem maiúsculas no win32).
  - `setPermissionRequestHandler(... cb(false))`, `setPermissionCheckHandler(() => false)`,
    bloquear `will-attach-webview` e janelas novas.
  - `setWindowOpenHandler`: `new URL`, só `https:`, sem user/password.
- `renderer/index.html`: CSP com `object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`
  (a meta fica a fonte: `file://` não tem cabeçalhos).
- `electron-builder.config.mjs`: `electronFuses` (runAsNode off, cookie encryption on,
  NODE_OPTIONS e `--inspect` off, asar integrity on, onlyLoadAppFromAsar on,
  `grantFileProtocolExtraPrivileges` on porque os módulos em `file://` precisam).
- `CLAUDE.md`: regra "nenhum agente corre como Electron-as-node".
- `DECISIONS.md`: o asar integrity não cobre `app.asar.unpacked`; os fuses tiram sobretudo runAsNode,
  NODE_OPTIONS e inspect.
- Testes no smoke: `window.open('https://…')` chama o `openExternal` (stub) e `http://` não;
  `navigator.permissions.query({name:'geolocation'})` dá `denied`.
- Feito: comandos limpos; depois do `pnpm dist`, ler os fuses do `Solline.exe` com `@electron/fuses`
  (já vem com o electron-builder) e registar; a app instalada abre e responde ao ping.
- Commit: `fix(desktop): origem exata no IPC, permissões negadas, CSP e fuses`

### B3: projetos sem confiança

- `Project` ganha `trusted`; `ProjectsFile` passa a `version: 2` e migra os antigos para `trusted: true`.
- `SessionStartPayload` ganha `trusted` (o main preenche); `AgentStartOptions` ganha `projectTrusted`;
  `PermissionBlock` ganha `alwaysScope?: 'session' | 'persistent'`; comando `projects.setTrusted`.
- `projects.add` pergunta "Confias neste projeto?" (botão por omissão "Não confiar") e explica que,
  sem confiança, o Claude não lê `.claude/` nem o `CLAUDE.md` do projeto. Ligar a confiança pede confirmação.
- `claude-sdk.ts`: `settingSources` = `[]` (isolado) / `['user','project','local']` (confiança) /
  `['user']` (sem confiança). Sem confiança, `toPermissionResult` muda os destinos para `'session'`
  e o cartão diz "Permitir nesta sessão" (senão escrevia `<repo>/.claude/settings.local.json`).
- `asks.tsx`: rótulo conforme `alwaysScope`. `sidebar.tsx`: escudo clicável na linha do projeto (`project-trust`).
- Testes: `settingSources` por caso e reescrita de destino só sem confiança (via `fakeQuery().options()`);
  migração v1→v2; smoke com stub do `dialog.showMessageBox`.
- Commit: `fix(desktop): projetos sem confiança só leem as definições do utilizador`

---

## M1c: Agentes como dados (só Claude; muda só o texto à vista)

Contrato (`conversation.ts`, `commands.ts`, `events.ts`):

```ts
export const AgentId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/); // substitui AgentKind
export const ModeRisk = z.enum(['read-only', 'plan', 'ask', 'edits', 'auto', 'full']);
// ModeOption += { risk }; SessionSettings.mode -> nullable (agentes sem modos)
export const AgentFeatures = z.object({
  cost: z.boolean(),
  context: z.boolean(),
  resume: z.boolean(),
});
// AgentCapabilities += { effortOrder: string[], features }
// Usage += { tokens: { input, output, cachedInput?, reasoning? } | null }   // último total, nunca somado
// ModelUsageRow.costUsd -> nullable; ConversationDelta += { type: 'capabilities', capabilities }
export const AgentDescriptor = z.object({
  id: AgentId,
  label: z.string(),
  transport: z.enum(['claude-sdk', 'codex-app-server', 'acp']),
  status: z.enum(['ready', 'not-found', 'needs-login', 'needs-key', 'unreviewed', 'error']),
  detail: z.string().optional(),
  experimental: z.boolean(),
  untrustedProjects: z.enum(['allowed', 'refused']),
  login: z
    .object({ kind: z.enum(['in-app', 'command']), command: z.string().optional() })
    .optional(),
});
// comando 'agents.list' -> { agents } (deteta em cada chamada; "Verificar de novo" volta a chamar)
```

Motor:

- Commit só de mudança de nomes: `adapters/claude-*.ts` e `claude-executable.ts` → `adapters/claude/{sdk,normalizer,tools,executable}.ts`.
- Partilhados: `src/timeout.ts` (`withTimeout`, de `sdk.ts`); `adapters/shared/turns.ts`
  (`userTurnDelta`, avisos de interrompido/erro, `crashMessage(label)`); exportar `clip` e `baseName`.
- `packages/engine/src/env.ts`:
  ```ts
  export interface EnvPolicy {
    base: 'host' | 'no-secrets'; // os dois tiram INHERITED
    keys?: readonly string[]; // passam mesmo em 'no-secrets'
    drop?: readonly string[];
    fromEnv?: Readonly<Record<string, string>>; // destino <- variável de origem
    overlay?: Readonly<Record<string, string>>; // aplicado no FIM
  }
  export const SECRET_NAME =
    /(^|_)(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$|^(AWS|AZURE)_|^(GH|GITHUB|HF|NPM)_TOKEN$/i;
  export function agentEnv(
    policy: EnvPolicy,
    source = process.env,
  ): Record<string, string | undefined>;
  export const CLAUDE_ENV_POLICY: EnvPolicy = {
    base: 'host',
    overlay: { CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP_ID },
  };
  export const sanitizedEnv = (s = process.env) => agentEnv(CLAUDE_ENV_POLICY, s);
  ```
  O Claude fica em `host` (igual a hoje). `scripts/record-fixtures.mjs` deixa a cópia da regex e importa `sanitizedEnv`.
- Novo `packages/engine/src/agents/registry.ts`: `AgentDefinition { id, label, transport,
experimental?, envPolicy, defaultMode, staticModes, untrustedProjects, detect(), create }` e
  `builtinRegistry({ claudeExecutable, isolated, dataDir })`.
- `session-manager.ts`: recebe `{ emit, registry }`; recusa agente `refused` em projeto sem confiança
  ("Este agente só corre em projetos de confiança"); passa `env: agentEnv(def.envPolicy)`; espelha
  deltas `capabilities`; tira `costUsd` quando `!features.cost`.
- `sdk.ts`: `env: options.env ?? sanitizedEnv()`; `capabilitiesFrom` com risco
  (`default→ask`, `acceptEdits→edits`, `plan→plan`, `auto→auto`), `effortOrder` e features todas true;
  o normalizador emite também `usage.tokens`.
- `engine.ts`: `adapters` fica como override por id (os testes continuam); handler `agents.list`.

Interface (`apps/desktop/src/renderer/src/`):

- `stores/app.ts`: fatia `agents` + `loadAgents()`; `createSession(projectId, agentId = 'claude')`.
- `stores/session.ts`: `tokens: null` e o delta `capabilities`.
- `features/agents/use-agent-label.ts` substitui os "Claude" fixos (`app.tsx`, `composer.tsx`,
  `conversation.tsx`, `asks.tsx`).
- `components/icons.tsx`: ícones por `ModeRisk` (+ `read-only` e `full`).
- `pills.tsx`: ordem do effort vem das capacidades; sem modos, não há pílula de modo.
- `composer.tsx`: contexto só com `features.context`; custo só com `features.cost`, senão tokens.
- `conversation.tsx`: "Retomar" só com `features.resume`.
- `components/menu.tsx` (sai de `pills.tsx`, com `side` e `ActionItem`).
- `features/agents/new-session-button.tsx`: botão dividido, mantém os test ids; seta só com mais de um
  agente; itens não prontos ou recusados aparecem desligados com o motivo.

Testes: suite de contrato `packages/engine/test/contract/` com `describe.each(harnesses)` sobre os
mesmos cenários (reaproveita `fakeQuery`, `loadFixture`, `reduce`, `recordingSink`);
`test/real-agents.ts` lê `SOLLINE_AGENTS` (omissão `claude`; `SOLLINE_SKIP_SDK=1` = nenhum);
`env.test.ts` prova que `agentEnv(CLAUDE_ENV_POLICY)` é igual ao `sanitizedEnv` antigo.

Commits: `refactor(engine): mover o adaptador do Claude para adapters/claude` ·
`feat(protocol): agentes como dados, capacidades e tokens` ·
`feat(desktop): rótulo do agente, ícones por risco e escolha do agente`

---

## M1d: Modelos DeepSeek pelo Claude Code (experimental)

Dito às claras na UI e no DECISIONS: são os _modelos_ DeepSeek, não o DeepSeek Harness; o código vai
para os servidores da DeepSeek; a Anthropic não suporta este encaminhamento (não encontrei proibição).

- Passo 0 (spike, corrida real com `SOLLINE_AGENTS=claude:deepseek` e `DEEPSEEK_API_KEY`): registar
  `init.models`, uso/custo, se `thinking adaptive` e effort são aceites, primeira corrida com
  `CLAUDE_CONFIG_DIR` vazio, e se existem `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` e
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` na 2.1.304.
- Novo `packages/engine/src/agents/profiles.ts` com `ProviderProfile` e `DEEPSEEK`
  (`baseUrl: https://api.deepseek.com/anthropic`, `tokenEnvVar: DEEPSEEK_API_KEY`, modelos
  `deepseek-flash[1m]`/`deepseek-flash`, `hideModes: ['auto']`) e `profileDefinition(base, p, dataDir)`:
  id `claude:deepseek`, env `{ base: 'no-secrets', drop: ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'],
fromEnv: { ANTHROPIC_AUTH_TOKEN: p.tokenEnvVar }, overlay: { ANTHROPIC_BASE_URL, ANTHROPIC_MODEL,
ANTHROPIC_DEFAULT_*_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, …, CLAUDE_CONFIG_DIR: <userData>/profiles/deepseek } }`.
- `engine-host.ts` passa `SOLLINE_DATA_DIR`; `apps/desktop/src/engine/index.ts` → `EngineOptions.dataDir`.
- `ClaudeSdkOptions.profile`: relabel de modelos, esconde `auto`, `features.cost = false`
  (`costUsd: null`, senão mostrava preços do Claude), `settingSources: []`, destino das permissões sempre `'session'`.
- Regras duras, cada uma com teste: sem `DEEPSEEK_API_KEY` não arranca (`needs-key`, "Define
  DEEPSEEK_API_KEY nas variáveis de ambiente e reabre a Solline"; a Solline nunca guarda a chave);
  `ANTHROPIC_API_KEY` cai sempre; `CLAUDE_CONFIG_DIR` isolado (o login claude.ai nunca chega a um URL de terceiros).
- `CLAUDE.md`: cada subida do SDK corre também `SOLLINE_AGENTS=claude,claude:deepseek`.
- Feito: por clique, uma sessão DeepSeek faz um turno com ferramenta e cartão de permissão; mostra
  tokens e não custo; smoke do Claude igual.
- Commit: `feat(engine): modelos DeepSeek pelo Claude Code (experimental), chave só pela variável de ambiente`

---

## M1e: Ferramentas ricas (só Claude; lista de tarefas e diffs neutros)

- Passo 0: cenário `todo` no `record-fixtures.mjs`; ver se aparece `TodoWrite` ou `TaskCreate/TaskUpdate`
  (o `archive/crab-crew/hooks/register.tsx` trata os dois).
- Contrato (tudo opcional, os testes atuais continuam):
  ```ts
  export const ToolCategory = z.enum([
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other',
  ]); // = ToolKind do ACP
  export const ToolContent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('diff'),
      path: z.string(),
      oldText: z.string().nullable(),
      newText: z.string(),
    }),
    z.object({ type: z.literal('patch'), path: z.string(), unified: z.string() }),
    z.object({ type: z.literal('command'), command: z.string(), cwd: z.string().optional() }),
  ]);
  // ToolBlock += { category?, locations?: {path, line?}[], content?: ToolContent[], hidden? }
  // PermissionBlock += { category?, content?, canAlwaysDeny? }
  export const TodoBlock = z.object({
    kind: z.literal('todo'),
    id: z.string(),
    entries: z.array(
      z.object({
        id: z.string().optional(),
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
        priority: z.enum(['high', 'medium', 'low']).optional(),
      }),
    ),
  });
  // AskStatus += 'denied-always'; PermissionAnswer += { decision: 'deny-always' }
  ```
- Motor: `toolShape(name, input)` em `adapters/claude/tools.ts` (Edit/MultiEdit/Write → `diff`,
  Bash → `command`, Read → `read`, Glob/Grep → `search`, web → `fetch`, ExitPlanMode → `switch_mode`);
  o normalizador preenche os campos, esconde `ExitPlanMode`, `AskUserQuestion`, `TodoWrite` e `Task*`,
  e mantém um `TodoBlock` por turno; `deny-always` só com `canAlwaysDeny`.
- Interface: `conversation.tsx` filtra por `hidden` (sai o `SHOWN_AS_CARD`) e desenha `todo` (`TodoView`
  em `blocks.tsx`); `tool-input.tsx` lê `content` (diff, patch, comando) e perde os ramos por nome de
  ferramenta; `asks.tsx` com "Negar sempre".
- Feito: nenhum nome de ferramenta do Claude na interface; a lista de tarefas aparece.
- Commit: `feat(protocol): categoria, diffs e tarefas neutros nas ferramentas`

---

## M1f: Codex nativo (`codex app-server`)

**Passo 0, entrada (commit próprio).** `npm pack` de `@openai/codex@0.163.0` e do pacote win32
(`@openai/codex-win32-x64`): ficheiros, licença Apache-2.0, sha256 do `codex.exe` contra o release,
env que o lançador define, e se o Codex lê config/hooks do projeto em pastas sem confiança. Fixar nos
dois `package.json`; `asarUnpack` do pacote win32; `scripts/codex-gen.mjs` corre
`codex app-server generate-ts --out src/adapters/codex/protocol` e escreve `GENERATED_FROM`
(se o strict falhar, gera `.d.ts`); pasta nos ignores do ESLint. DECISIONS: login ChatGPT só para uso
pessoal e local; app-server é experimental, por isso fixar e regenerar em cada subida.
Commit: `chore(engine): codex 0.163.0 revisto e tipos do app-server gerados`

**Infraestrutura partilhada (o M1g reaproveita):**

- `packages/engine/src/rpc/json-rpc.ts`, `JsonRpcPeer`: NDJSON com/sem campo `jsonrpc` (o Codex omite,
  o ACP manda), UTF-8 em streaming, `\r`, linhas não-JSON ignoradas e registadas, `request/notify/
onRequest/onNotification`, `-32601` para métodos desconhecidos, stderr em anel de 4k, `exited` rejeita pendentes.
- `packages/engine/src/rpc/spawn.ts`: `spawnAgent` exige caminho absoluto, `windowsHide`, nunca `shell`;
  `killTree(pid)` com `%SystemRoot%\System32\taskkill.exe /T /F`.
- `permission-broker.ts`: `cancel(id, reason)`.

**Adaptador (`packages/engine/src/adapters/codex/`):**

- `executable.ts`: `codex.exe` nativo dentro do pacote win32 (reaproveita `toUnpackedPath`).
- `modes.ts`: `read-only` (on-request + readOnly), `ask` por omissão (untrusted + workspaceWrite),
  `auto` (on-request + workspaceWrite); acesso total não existe. Ao arrancar, ver se o sandbox do
  Windows está pronto; se não, esconde `auto` e avisa "O sandbox do Windows não está pronto: todos os
  comandos pedem autorização".
- `tools.ts`: `commandExecution` → execute/`command`; `fileChange` → edit/`patch`; `mcpToolCall` → other; `webSearch` → fetch.
- `normalizer.ts`: `turn/started`, `item/started|completed`, `item/agentMessage/delta`,
  `item/reasoning/summaryTextDelta`, `turn/plan/updated` → `TodoBlock`, `thread/tokenUsage/updated` →
  tokens (último total) e contexto, `turn/completed` → `turn.end`, `error/warning` → avisos.
- `adapter.ts`, `CodexAppServerAdapter` (um app-server por sessão, transporte injetável):
  `initialize`(clientInfo do `app.ts`, `experimentalApi: false`) → `account/read` (sem login →
  `AuthRequiredError`) → `model/list` (efforts por modelo) → `thread/start` ou `thread/resume`.
  Modelo/effort/modo valem a partir do turno seguinte (`turn/start` com overrides). Pedidos do servidor
  num `switch` exaustivo sobre a união gerada: aprovações de comando/ficheiro → `PermissionBlock`
  (`accept` / `acceptForSession` / `decline` / `cancel`); `tool/requestUserInput` e elicitação → recusa
  explícita + aviso (por agora); `serverRequest/resolved` cancela o cartão. Interromper →
  `turn/interrupt`; fechar → stdin, 5 s, `killTree`; queda → `error` com `crashMessage('Codex')`.
- Registo: env `{ base: 'no-secrets', keys: ['OPENAI_API_KEY','CODEX_API_KEY'], overlay: <do lançador> }`,
  `defaultMode: 'ask'`, `untrustedProjects: 'refused'` (salvo prova em contrário na entrada).

**Login:** `agents.login` (main) → motor `agents.loginStart` → `account/login/start{type:'chatgpt'}`;
o main só abre o `authUrl` se o host estiver na allowlist (`auth.openai.com`); evento
`agents.changed` no fim. O Codex guarda as credenciais dele; a Solline nunca as lê.
Na interface, `needs-login` aparece como "Entrar com ChatGPT".

**Testes:** `scripts/record-codex.mjs` (proxy que grava `{dir, msg}` e tira cwd, ids, email, URLs de
login); `json-rpc.test.ts`; `spawn.test.ts` (um `codex.exe` plantado no cwd nunca é escolhido);
`codex-normalizer.test.ts`; `codex-adapter.test.ts`; teste de deriva (`GENERATED_FROM` = versão
fixada); harness `codex` na suite de contrato; corrida real `SOLLINE_AGENTS=codex`.

Feito: por clique, uma sessão Codex faz streaming, aprovações, lista de tarefas, pílulas de
modelo/effort/modo e tokens; interromper funciona; uma queda oferece "Retomar"; login ChatGPT
funciona; projeto sem confiança recusa; revisão do contrato feita no DECISIONS.
Commits: `feat(engine): par JSON-RPC e arranque seguro de agentes` · `feat(engine): Codex pelo app-server` ·
`feat(desktop): escolher o Codex e entrar com ChatGPT`

---

## M1g: Adaptador ACP genérico

- `@agentclientprotocol/sdk@2.0.0` fixado **só para tipos**; o transporte é o `JsonRpcPeer` do M1f
  (`jsonrpc: "2.0"`) atrás de um `AcpConnection`, para isolar as mudanças do 2.0.
- `packages/engine/src/adapters/acp/`:
  - `normalizer.ts`: chunks de mensagem/pensamento por `messageId`; `tool_call(_update)` por merges
    parciais num mapa; `plan` → `TodoBlock`; `usage_update` → contexto e custo só em USD;
    `current_mode_update`/`config_option_update` → `settings` e `capabilities`; replay do `session/load`
    descartado. `end_turn` → done; `cancelled` → interrompido; `max_tokens`/`max_turn_requests` → done + aviso;
    `refusal` ou erro RPC → erro + aviso.
  - `capabilities.ts`: modelos/modos/effort pelas config options (`model`, `mode`, `thought_level`),
    com recurso ao `models` antigo (estilo Gemini) e aos `modes` antigos; `resume` =
    `sessionCapabilities.resume || loadSession`; `classifyModeRisk` esconde `full` (`yolo|bypass|full|never`).
  - `adapter.ts`: `initialize` com `fs` e `terminal` a false; aceita `authMethods` vazio;
    `auth_required` → `needs-login`; `session/new{cwd, mcpServers: []}`; se o modo inicial for `full`,
    muda para o mais seguro ou recusa; resume por `session/resume` ou `session/load`; o `send` não espera
    pelo `session/prompt`; cancelar resolve todas as permissões pendentes como `cancelled`; permissões com
    `canAlwaysAllow`/`canAlwaysDeny` e os rótulos do agente; `switch_mode` → `PlanBlock`; modelo/effort/modo
    por `session/set_config_option`, com recurso a `session/set_model`/`session/set_mode`.
- `packages/engine/src/agents/which.ts`: procura no PATH+PATHEXT **sem o cwd nem entradas relativas**;
  transforma shims `.cmd` do npm em `node.exe` absoluto + script; versão lida do `package.json` ao lado ou hash.
- `packages/engine/src/agents/catalog.ts`: entradas no código (`launch`, `reviewedVersion`, `sha256?`,
  `envPolicy`, `untrustedProjects`, `loginCommand?`, `overlayEnv?`); versão diferente → `unreviewed`.
  Primeiro o **OpenCode** (com `OPENCODE_CONFIG_CONTENT` a pôr edit/bash/webfetch em `ask`,
  `untrustedProjects: 'refused'`), depois um segundo à escolha; uma entrada por commit, depois da entrada.
- Contrato: `PermissionBlock += { allowAlwaysLabel?, denyAlwaysLabel? }`; comando `agents.setKeys`
  (nomes de variáveis, confirmação nativa, guardado pelo main em `<userData>/agent-settings.json`);
  `SessionStartPayload += agentKeys`; `window.solline.clipboard.writeText`.
- Interface: `features/agents/agents-dialog.tsx` (estado, versão instalada/revista, chaves, "Copiar
  comando de login", "Verificar de novo"), aberto pelo seletor e pelo rodapé da barra lateral.
  README, `apps/desktop/package.json` e `CLAUDE.md:3` passam a "Cliente de desktop para agentes de código".
- Testes: ligação falsa que reproduz `test/fixtures/acp/*.jsonl` (gravadas com `scripts/record-acp.mjs`);
  `acp-normalizer.test.ts`, `acp-adapter.test.ts`, `which.test.ts`, `catalog.test.ts`;
  `test/fakes/acp-agent.mjs` como processo real; harness `acp` na suite de contrato; corridas reais
  `SOLLINE_AGENTS=opencode,<segundo>`.
- Feito: pela UI, o OpenCode com a DeepSeek como fornecedor faz streaming, ferramenta, cartão de
  permissão, interromper e pílulas das config options; projeto sem confiança recusa; smoke do Claude igual.
- Commits: `feat(engine): adaptador ACP genérico` · `feat(engine): OpenCode no catálogo` · um por entrada extra

---

## M1h: Servidores MCP por sessão e REA (opcional)

- `packages/engine/src/mcp/catalog.ts` (entradas no código, `executesCode`, env revisto no git);
  comando `mcp.list`; `SessionCreatePayload += mcpServerIds` (até 8); `AgentStartOptions += mcpServers`;
  `AgentFeatures += mcpServers`.
- Claude: `options.mcpServers` stdio (o `acceptEdits` não aprova MCP sozinho); ACP: `session/new|resume.mcpServers`;
  Codex: desligado até se verificar o caminho pela config do thread.
- Política: com um servidor `executesCode` ligado, sem `auto`/`full` e sem "Permitir sempre" nas
  ferramentas dele. Seletor "Servidores MCP" clicável na nova sessão.
- REA: scan do `rea-agents` na versão do momento (6.7.0 hoje), instalado em `<userData>/mcp/rea` com
  `npm install --ignore-scripts` (salta o download do Frida); rever em cada subida (4 majors em 5 dias).
  Auditoria opcional: passagem estática do REA ao `release/win-unpacked/resources/app.asar`, cruzada com os fuses.
- Testes: forma do `options.mcpServers`, parâmetros do `session/new`, política `executesCode`,
  `unreviewed`, corrida real com um servidor eco feito à mão (`test/fakes/echo-mcp.mjs`).
- Commits: `feat(engine): servidores MCP por sessão no Claude` · `feat(engine): servidores MCP por sessão no ACP`

---

## O que não fazemos

| O quê                                                                            | Porquê                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Engenharia reversa de harnesses com o REA                                        | Interfaces públicas; termos proíbem; art. 6 não se aplica; o REA não abre o `claude.exe` |
| dsh no seletor                                                                   | ACP só para automação; rever quando tiver permissões interativas, modos e retomar        |
| `claude-agent-acp` ou `codex-acp`                                                | Embrulhos com perdas; `codex-acp` só se o Codex nativo chumbar na entrada                |
| Modos de acesso total                                                            | Nunca oferecidos                                                                         |
| UI para juntar agentes/MCP, `npx @latest`, `rea setup`, escrever configs globais | Saltavam a entrada                                                                       |
| Login dentro da app para agentes ACP                                             | Copia-se o comando de login do CLI; o Codex é exceção (o exe vem dentro da app)          |
| `fs`/`terminal` do ACP, `experimentalApi` do Codex                               | Ainda não desenhados na interface                                                        |
| Apertar o env do Claude                                                          | Partia Bash, hooks e MCP pessoais                                                        |
| Histórico (M3), reinício do motor (M5), subagentes aninhados (M2)                | Fora deste plano                                                                         |

## Riscos

- **Deriva:** app-server do Codex experimental (fixar, regenerar, teste de deriva); SDK do ACP 2.0 com
  um dia (isolado pelo seam); CLIs ACP que se atualizam sozinhos vão aparecer como `unreviewed`.
- **Perfil DeepSeek sem suporte oficial:** cada subida do SDK pode partir; marcado experimental com
  corrida própria. A DeepSeek ignora `cache_control`, fica mais caro.
- **Windows:** prontidão do sandbox do Codex por confirmar; a denylist de segredos não apanha nomes estranhos.
- **Configs partilhadas:** `~/.codex/config.toml` (MCP e hooks pessoais) entra nas sessões Codex;
  um CLI global mais novo pode criar threads que o servidor fixado não retoma.
- **Heurísticas:** `classifyModeRisk` é uma regex; o âmbito do "permitir sempre" no ACP é do agente.
- **Instalador maior** com o `codex.exe`.
- **Por confirmar na entrada:** `cline --acp`, `goose acp`, precedência do config inline do OpenCode,
  as duas variáveis do Claude Code do M1d, env do lançador do Codex e o comportamento em projetos sem
  confiança, forma do `item/permissions/requestApproval`.

## Verificação ponta a ponta

1. Cada passo: `pnpm typecheck`, `pnpm lint`, `pnpm test` (vitest do motor e do desktop, build, smoke).
2. Corridas reais: `SOLLINE_E2E_SDK=1 pnpm --filter @solline/desktop test`;
   `SOLLINE_AGENTS=claude,claude:deepseek,codex,opencode pnpm --filter @solline/engine test`;
   `SOLLINE_SKIP_SDK=1` salta todas.
3. Pacote: `pnpm dist`, ler os fuses do `Solline.exe`, instalar, abrir à mão, ping.
4. Guião manual na app instalada:
   1. Projeto A com confiança, projeto B sem.
   2. A + Claude: edição com cartão, "Permitir sempre", interromper, retomar.
   3. B + Claude: "Permitir nesta sessão", nada escrito em `B\.claude\`, `CLAUDE.md` do projeto não lido.
   4. DeepSeek: tokens sim, custo não; sem chave, item desligado com a dica.
   5. Codex: login ChatGPT, aprovação, lista de tarefas, interromper, matar o `codex.exe` e "Retomar"; em B recusa.
   6. OpenCode com DeepSeek em A: cartão e pílulas; em B recusa.
   7. (Opcional) REA numa sessão Claude: corre atrás de cartão, sem "Permitir sempre".
   8. Na consola da página: `solline.request('session.create', {agent:'claude', cwd:'C:\\'})` e
      `setMode('bypassPermissions')` falham; `window.open('http://x')` não faz nada.
