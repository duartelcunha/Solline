// Grava mensagens reais do SDK para os testes do normalizador.
// Uso: node scripts/record-fixtures.mjs <nome> (corre com Haiku, effort low, numa pasta temporária).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? 'edit-with-permission';
const SCENARIOS = {
  'edit-with-permission': {
    files: { 'notes.txt': 'The quick alpha fox.\n' },
    prompt:
      'Read notes.txt, then use the Edit tool to replace the word "alpha" with "beta" in it. Reply with one short sentence when done.',
  },
  'plain-answer': {
    files: {},
    prompt: 'In one sentence, what is a monorepo? Use **bold** for the key term.',
  },
  thinking: {
    files: {},
    prompt: 'Think it through step by step first, then answer in one line: is 391 a prime number?',
  },
  'denied-edit': {
    files: { 'notes.txt': 'The quick alpha fox.\n' },
    prompt:
      'Use the Edit tool to replace "alpha" with "gamma" in notes.txt (read it first). If the edit is refused, reply with one short sentence and stop.',
    deny: true,
  },
};
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`cenário desconhecido: ${name}`);

const STRIP =
  /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|ANTHROPIC_BASE_URL|USE_LOCAL_OAUTH|USE_STAGING_OAUTH|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE|AI_AGENT)$/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k)));
env.CLAUDE_AGENT_SDK_CLIENT_APP = 'solline';

const cwd = await mkdtemp(path.join(tmpdir(), 'solline-rec-'));
for (const [file, content] of Object.entries(scenario.files))
  await writeFile(path.join(cwd, file), content);

const records = [];
let done;
const finished = new Promise((r) => (done = r));
async function* prompt() {
  yield {
    type: 'user',
    message: { role: 'user', content: scenario.prompt },
    parent_tool_use_id: null,
  };
  await finished;
}

const q = query({
  prompt: prompt(),
  options: {
    model: 'haiku',
    effort: 'low',
    thinking: { type: 'adaptive', display: 'summarized' },
    permissionMode: 'default',
    includePartialMessages: true,
    settingSources: [],
    cwd,
    env,
    canUseTool: async (toolName, input, options) => {
      const { signal, ...rest } = options;
      records.push({ kind: 'canUseTool', toolName, input, options: rest });
      if (scenario.deny) return { behavior: 'deny', message: 'The user refused this action.' };
      return { behavior: 'allow', updatedInput: input };
    },
  },
});
for await (const message of q) {
  records.push({ kind: 'message', message });
  if (message.type === 'result') break;
}
done();
q.close();
const finalText = await readFile(path.join(cwd, 'notes.txt'), 'utf8').catch(() => null);
await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
/**
 * Limpa o que não deve ir para o git: o JSON parcial das ferramentas chega aos bocados (e com
 * ele o caminho da pasta temporária), por isso junta-se num só delta; o init fica só com os
 * campos que o normalizador lê; listas de comandos e plugins da máquina saem.
 */
function sanitize(list) {
  const out = [];
  let open = null;
  for (const record of list) {
    const m = record.message;
    if (record.kind === 'message' && m.type === 'system' && m.subtype === 'commands_changed')
      continue;
    // O uso do plano da conta não interessa aos testes.
    if (record.kind === 'message' && m.type === 'rate_limit_event') continue;
    if (record.kind === 'message' && m.type === 'system' && m.subtype === 'init') {
      const {
        type,
        subtype,
        cwd: c,
        session_id,
        model,
        permissionMode,
        apiKeySource,
        claude_code_version,
        effort,
        uuid,
      } = m;
      out.push({
        kind: 'message',
        message: {
          type,
          subtype,
          cwd: c,
          session_id,
          model,
          permissionMode,
          apiKeySource,
          claude_code_version,
          effort,
          uuid,
          tools: ['Read', 'Edit', 'Write', 'Bash'],
          mcp_servers: [],
          slash_commands: [],
          output_style: 'default',
          skills: [],
          plugins: [],
        },
      });
      continue;
    }
    if (
      record.kind === 'message' &&
      m.type === 'stream_event' &&
      m.event.type === 'content_block_delta' &&
      m.event.delta.type === 'input_json_delta'
    ) {
      if (open && open.event.index === m.event.index) {
        open.event.delta.partial_json += m.event.delta.partial_json;
        continue;
      }
      open = m;
      out.push(record);
      continue;
    }
    open = null;
    out.push(record);
  }
  return out;
}

// Os caminhos da pasta temporária ficam neutros para não guardar caminhos da máquina.
// Apanha o caminho com qualquer nível de escape (o JSON parcial vem escapado duas vezes).
const cwdPattern = new RegExp(
  cwd
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\\\+|/)'),
  'g',
);
const json = sanitize(records)
  .map((r) => JSON.stringify(r))
  .join('\n')
  .replace(cwdPattern, '<cwd>');
const out = path.join(here, '..', 'test', 'fixtures', `${name}.jsonl`);
await writeFile(out, json + '\n');
console.log(`${records.length} registos em ${out}; ficheiro final: ${JSON.stringify(finalText)}`);
