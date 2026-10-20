// Grava conversas reais com o codex app-server para os testes do adaptador do Codex.
// Uso: pnpm --filter @solline/engine record:codex <cenário> (numa pasta temporária, effort baixo).
// Cada linha é { dir: 'out' | 'in', msg }: out vai para o Codex, in vem dele.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEnv } from '../src/env.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const name = process.argv[2] ?? 'plain-answer';

const SCENARIOS = {
  'plain-answer': {
    files: {},
    prompt: 'In one sentence, what is a monorepo? Use **bold** for the key term.',
    mode: 'ask',
  },
  'edit-with-permission': {
    files: { 'notes.txt': 'The quick alpha fox.\n' },
    prompt:
      'Replace the word "alpha" with "beta" in notes.txt by editing the file. Reply with one short sentence when done.',
    mode: 'read-only',
    answer: 'accept',
  },
  'denied-edit': {
    files: { 'notes.txt': 'The quick alpha fox.\n' },
    prompt:
      'Replace the word "alpha" with "gamma" in notes.txt by editing the file. If you are not allowed, reply with one short sentence and stop.',
    mode: 'read-only',
    answer: 'decline',
  },
  'command-with-permission': {
    files: { 'notes.txt': 'The quick alpha fox.\n' },
    prompt:
      'Run the shell command `node -e "console.log(41+1)"` and tell me the output in one sentence.',
    mode: 'ask',
    answer: 'accept',
  },
};
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`cenário desconhecido: ${name}`);

const POLICIES = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
};

const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
const pkg = `@openai/codex-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const exe = path.join(
  path.dirname(require.resolve(`${pkg}/package.json`)),
  'vendor',
  target,
  'bin',
  'codex.exe',
);

const cwd = await mkdtemp(path.join(tmpdir(), 'solline-codex-rec-'));
for (const [file, content] of Object.entries(scenario.files))
  await writeFile(path.join(cwd, file), content);

const env = agentEnv({ base: 'no-secrets', keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
const child = spawn(exe, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.on('data', (c) => process.stderr.write(`[codex] ${c}`));

const records = [];
const waiters = new Map();
let nextId = 1;
let notify = () => undefined;
const done = new Promise((resolve) => (notify = resolve));
let buffer = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf('\n');
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    records.push({ dir: 'in', msg });
    if (msg.method && msg.id !== undefined) void onServerRequest(msg);
    else if (msg.method) onNotification(msg);
    else if (msg.id !== undefined) waiters.get(msg.id)?.(msg);
  }
});

function send(msg) {
  records.push({ dir: 'out', msg });
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    send({ id, method, ...(params === undefined ? {} : { params }) });
  });
}

async function onServerRequest(msg) {
  const answer = scenario.answer ?? 'decline';
  if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval') {
    send({ id: msg.id, result: { decision: answer } });
  } else if (msg.method === 'mcpServer/elicitation/request') {
    send({ id: msg.id, result: { action: 'decline', content: null, _meta: null } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: `não suportado: ${msg.method}` } });
  }
}
function onNotification(msg) {
  if (msg.method === 'turn/completed') notify();
}

const timeout = setTimeout(() => {
  console.error('tempo esgotado');
  notify();
}, 240_000);

try {
  const init = await request('initialize', {
    clientInfo: { name: 'solline', title: 'Solline', version: '0.0.1' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  send({ method: 'initialized' });
  console.log('init', init.platformOs);
  const account = await request('account/read', {});
  console.log('conta', account.account?.type ?? 'nenhuma');
  const models = await request('model/list', {});
  const model = models.data.find((m) => m.isDefault) ?? models.data[0];
  const efforts = model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  console.log('modelos', models.data.map((m) => `${m.id}${m.isDefault ? '*' : ''}[${m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(',')}]`).join(' '));
  const sandbox = await request('windowsSandbox/readiness').catch((e) => ({ error: String(e) }));
  console.log('sandbox', JSON.stringify(sandbox));
  const policy = POLICIES[scenario.mode];
  const started = await request('thread/start', { cwd, model: model.id, ...policy });
  const effort = ['minimal', 'low'].find((e) => efforts.includes(e));
  await request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: scenario.prompt, text_elements: [] }],
    ...(effort ? { effort } : {}),
  });
  await done;
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  setTimeout(() => child.kill(), 3_000).unref();
}

// Tira o que identifica a máquina e a conta: pasta, CODEX_HOME, email, ids da conta e da
// instalação, nome do PC, limites de uso e os servidores MCP pessoais do ~/.codex.
const DROP = new Set([
  'remoteControl/status/changed',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
]);
const kept = records.filter((r) => !DROP.has(r.msg.method));
const home = path.join(process.env.USERPROFILE ?? '', '.codex');
let text = kept.map((r) => JSON.stringify(r)).join('\n') + '\n';
for (const [from, to] of [
  [cwd, '<cwd>'],
  [home, '<codex-home>'],
]) {
  text = text.split(JSON.stringify(from).slice(1, -1)).join(to);
}
text = text
  .replace(/"email":"[^"]*"/g, '"email":"<email>"')
  .replace(
    /"(chatgptAccountId|installationId|serverName|accountId|userId)":"[^"]*"/g,
    '"$1":"<redacted>"',
  )
  .replace(/"planType":"[^"]*"/g, '"planType":"<plan>"');
const out = path.join(here, '..', 'test', 'fixtures', 'codex', `${name}.jsonl`);
await writeFile(out, text);
const final = scenario.files['notes.txt'] ? await readFile(path.join(cwd, 'notes.txt'), 'utf8') : null;
await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
console.log(`${kept.length} mensagens em ${out}; ficheiro final: ${JSON.stringify(final)}`);
process.exit(0);
