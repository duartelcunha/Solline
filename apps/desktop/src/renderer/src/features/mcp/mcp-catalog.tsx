import { useEffect, useState } from 'react';
import {
  BadgeCheck,
  CircleAlert,
  CircleDashed,
  CircleCheck,
  Plus,
  Search,
  ShieldQuestion,
  Wrench,
  X,
} from 'lucide-react';
import type { McpCatalogServer, McpRegistryResult, McpSearchResult } from '@solline/protocol';
import { actions } from '../../stores/app.ts';
import { useMcpCatalog } from '../../stores/mcp-catalog.ts';
import {
  alreadyAdded,
  buildManual,
  changeLines,
  emptyManual,
  filledValues,
  needsApproval,
  registryRows,
  sourceInfo,
  statusInfo,
  verifiedLabel,
  type ManualEnvRow,
  type ManualForm,
  type StatusTone,
} from './mcp-model.ts';

const button = 'space-control sl-press';

const TONE_ICON: Record<StatusTone, typeof CircleCheck> = {
  ok: CircleCheck,
  wait: CircleDashed,
  bad: CircleAlert,
};

/** O estado diz-se com ícone e palavras; a cor só reforça. */
export function StatusChip({ server }: { server: McpCatalogServer }) {
  const info = statusInfo(server);
  const Icon = TONE_ICON[info.tone];
  const tone =
    info.tone === 'bad' ? 'text-danger' : info.tone === 'wait' ? 'text-attention' : 'text-muted';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium ${tone}`}
      data-testid="mcp-status"
      data-status={server.status}
    >
      <Icon size={13} aria-hidden />
      {info.label}
    </span>
  );
}

function Secrets({ server }: { server: McpCatalogServer }) {
  const secrets = server.spec.env.filter((env) => env.secret);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 1800);
    return () => clearTimeout(timer);
  }, [saved]);
  if (!secrets.length) return null;
  return (
    <div className="grid gap-2.5" data-testid="mcp-secrets">
      <p className="text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">Segredos</p>
      {secrets.map((env) => {
        const id = `secret-${server.id}-${env.name}`;
        const value = values[env.name] ?? '';
        return (
          <div key={env.name} className="grid gap-1.5">
            <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="font-mono font-medium">{env.name}</span>
              <span className="text-subtle">
                {env.required ? 'obrigatória' : 'opcional'}
                {env.description ? ` · ${env.description}` : ''}
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                placeholder="Escreve para guardar ou mudar"
                className="min-w-0 flex-1 font-mono"
                onChange={(e) => setValues({ ...values, [env.name]: e.target.value })}
              />
              <button
                type="button"
                className={button}
                disabled={value === ''}
                onClick={() =>
                  void actions.setMcpSecret(server.id, env.name, value).then((ok) => {
                    if (!ok) return;
                    setValues((now) => ({ ...now, [env.name]: '' }));
                    setSaved(env.name);
                  })
                }
              >
                Guardar
              </button>
              <button
                type="button"
                className={button}
                onClick={() =>
                  void actions.setMcpSecret(server.id, env.name, null).then((ok) => {
                    if (ok) setSaved(`${env.name}:tirado`);
                  })
                }
              >
                Tirar valor
              </button>
            </div>
            {saved === env.name || saved === `${env.name}:tirado` ? (
              <p role="status" className="text-[11.5px] text-muted">
                {saved === env.name
                  ? 'Guardado no Gestor de Credenciais. Não volta a aparecer aqui.'
                  : 'Valor tirado do Gestor de Credenciais.'}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="text-[11.5px] text-subtle">
        Os valores ficam só no Gestor de Credenciais do Windows e nunca se mostram depois.
      </p>
    </div>
  );
}

function ServerCard({ server }: { server: McpCatalogServer }) {
  const info = statusInfo(server);
  const source = sourceInfo(server.spec.source);
  const [showTools, setShowTools] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'probe' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  const publicEnv = server.spec.env.filter((env) => !env.secret && env.value !== undefined);
  const pending = needsApproval(server);
  const run = (kind: 'approve' | 'probe' | 'remove', work: () => Promise<unknown>) => {
    setBusy(kind);
    void work().finally(() => setBusy(null));
  };
  return (
    <li
      data-testid="mcp-server"
      data-status={server.status}
      className="grid gap-4 rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="truncate text-[13.5px] font-medium">{server.spec.label}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted">
            <span className="break-all">{source.title}</span>
            {source.version ? <span>· versão fixada {source.version}</span> : null}
            {source.verified ? (
              <span className="inline-flex items-center gap-1" data-testid="mcp-verified">
                ·{' '}
                {source.verified === verifiedLabel(null) ? (
                  <ShieldQuestion size={12} aria-hidden />
                ) : (
                  <BadgeCheck size={12} aria-hidden />
                )}
                {source.verified}
              </span>
            ) : null}
          </p>
        </div>
        <StatusChip server={server} />
      </div>

      <code className="block rounded-sm border border-line bg-surface-sunken px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-all select-text">
        {server.commandLine}
      </code>

      {publicEnv.length ? (
        <p className="text-[11.5px] text-muted">
          Variáveis públicas:{' '}
          {publicEnv.map((env) => (
            <code key={env.name} className="mr-2 font-mono">
              {env.name}={env.value}
            </code>
          ))}
        </p>
      ) : null}

      {info.hint ? (
        <p
          className={`text-[12.5px] ${server.status === 'error' ? 'text-danger' : 'text-muted'}`}
          data-testid="mcp-hint"
        >
          {info.hint}
        </p>
      ) : null}

      {server.status === 'changed' && server.changed ? (
        <div
          className="grid gap-1.5 rounded-control bg-attention-soft px-3 py-2.5 text-[12.5px] text-attention"
          data-testid="mcp-changed"
        >
          {changeLines(server.changed).map((group) => (
            <p key={group.label}>
              <span className="font-medium">{group.label}: </span>
              <span className="font-mono text-[11.5px]">{group.names.join(', ')}</span>
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {pending ? (
          <button
            type="button"
            className={`${button} space-primary`}
            disabled={busy !== null}
            onClick={() => run('approve', () => actions.approveMcpServer(server.id))}
            data-testid="mcp-approve"
          >
            {server.status === 'changed' ? 'Aprovar de novo' : 'Aprovar'}
          </button>
        ) : null}
        {server.tools ? (
          <button
            type="button"
            className={button}
            aria-expanded={showTools}
            onClick={() => setShowTools(!showTools)}
            data-testid="mcp-tools-toggle"
          >
            <Wrench size={13} />
            {server.tools.length === 1 ? '1 ferramenta' : `${server.tools.length} ferramentas`}
          </button>
        ) : null}
        {server.approved ? (
          <button
            type="button"
            className={button}
            disabled={busy !== null}
            onClick={() => run('probe', () => actions.probeMcpServer(server.id))}
            data-testid="mcp-probe"
          >
            {busy === 'probe' ? 'A sondar…' : server.tools ? 'Sondar outra vez' : 'Sondar'}
          </button>
        ) : null}
        <button
          type="button"
          className={`${button} ml-auto ${confirming ? 'text-danger' : ''}`}
          disabled={busy !== null}
          onClick={() =>
            confirming
              ? run('remove', () => actions.removeMcpServer(server.id))
              : setConfirming(true)
          }
          data-testid="mcp-remove"
        >
          {confirming ? 'Confirmar' : 'Tirar'}
        </button>
      </div>

      {showTools && server.tools ? (
        <ul className="grid gap-2 border-t border-line pt-3" data-testid="mcp-tools">
          {server.tools.length === 0 ? (
            <li className="text-[12.5px] text-muted">Este servidor não anunciou ferramentas.</li>
          ) : null}
          {server.tools.map((tool) => (
            <li key={tool.name} className="text-[12.5px]">
              <span className="font-mono text-[12px] font-medium">{tool.name}</span>
              {tool.description ? (
                <span className="mt-0.5 block text-muted select-text">{tool.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <Secrets server={server} />
    </li>
  );
}

function EnvInputs({
  rows,
  idPrefix,
  onChange,
}: {
  rows: ManualEnvRow[];
  idPrefix: string;
  onChange: (rows: ManualEnvRow[]) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="grid gap-2.5">
      {rows.map((row, index) => (
        <div key={row.name || index} className="grid gap-1.5">
          <label
            htmlFor={`${idPrefix}-${row.name}`}
            className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
          >
            <span className="font-mono font-medium">{row.name}</span>
            <span className="text-subtle">
              {row.secret ? 'segredo' : 'público'} · {row.required ? 'obrigatória' : 'opcional'}
            </span>
          </label>
          <input
            id={`${idPrefix}-${row.name}`}
            type={row.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={row.value}
            className="font-mono"
            onChange={(e) =>
              onChange(rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
            }
          />
        </div>
      ))}
    </div>
  );
}

function RegistryCard({ result }: { result: McpRegistryResult }) {
  const servers = useMcpCatalog((s) => s.data.servers);
  const existing = alreadyAdded(servers, result);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(() => registryRows(result));
  const [busy, setBusy] = useState(false);
  const { values, missing } = filledValues(rows);
  async function add() {
    setBusy(true);
    const added = await actions.addMcpServer({
      source: { kind: 'registry', name: result.name, version: result.version },
      values,
    });
    setBusy(false);
    if (added) setOpen(false);
  }
  return (
    <li
      data-testid="mcp-result"
      className="grid gap-3 rounded-md border border-line bg-surface p-4"
    >
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-medium">{result.title || result.name}</h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted">
          <span className="break-all" data-testid="mcp-namespace">
            {result.namespace}
          </span>
          <span className="inline-flex items-center gap-1" data-testid="mcp-verified">
            ·{' '}
            {result.verified ? (
              <BadgeCheck size={12} aria-hidden />
            ) : (
              <ShieldQuestion size={12} aria-hidden />
            )}
            {verifiedLabel(result.verified)}
          </span>
          <span>· versão fixada {result.packageVersion}</span>
        </p>
      </div>
      {result.description ? (
        <p className="text-[12.5px] leading-relaxed text-muted select-text">{result.description}</p>
      ) : null}
      <code className="block rounded-sm border border-line bg-surface-sunken px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-all select-text">
        {result.commandLine}
      </code>
      {result.env.length ? (
        <p className="text-[11.5px] text-muted">
          Pede:{' '}
          {result.env.map((env) => (
            <code key={env.name} className="mr-2 font-mono">
              {env.name}
              {env.secret ? ' (segredo)' : ''}
            </code>
          ))}
        </p>
      ) : null}
      {open && result.env.length ? (
        <div className="grid gap-3 border-t border-line pt-3">
          <EnvInputs rows={rows} idPrefix={`env-${result.name}`} onChange={setRows} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {existing ? (
          <span className="text-[12px] text-muted" data-testid="mcp-already">
            Já está no catálogo
          </span>
        ) : result.env.length > 0 && !open ? (
          <button
            type="button"
            className={`${button} space-primary`}
            onClick={() => setOpen(true)}
            data-testid="mcp-add-open"
          >
            <Plus size={13} />
            Acrescentar
          </button>
        ) : (
          <button
            type="button"
            className={`${button} space-primary`}
            disabled={busy || missing !== null}
            title={missing ? `Falta o valor de ${missing}` : undefined}
            onClick={() => void add()}
            data-testid="mcp-add"
          >
            <Plus size={13} />
            Acrescentar
          </button>
        )}
        {open ? (
          <button type="button" className={button} onClick={() => setOpen(false)}>
            Cancelar
          </button>
        ) : null}
      </div>
    </li>
  );
}

function RegistrySearch() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{
    searched: string;
    results: McpRegistryResult[];
    next: string | null;
    skipped: McpSearchResult['skipped'];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  async function search(cursor?: string) {
    const text = (cursor ? (state?.searched ?? query) : query).trim();
    if (!text || busy) return;
    setBusy(true);
    const found = await actions.searchMcp(text, cursor);
    setBusy(false);
    if (!found) return;
    setState({
      searched: text,
      results: cursor && state ? [...state.results, ...found.results] : found.results,
      next: found.nextCursor,
      skipped: found.skipped,
    });
  }
  const left = state ? state.skipped.remote + state.skipped.other : 0;
  return (
    <div className="grid gap-4">
      <form
        className="flex items-center gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Pesquisar no registo oficial"
          placeholder="Pesquisar no registo oficial de servidores MCP"
          value={query}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="mcp-search-input"
        />
        <button
          type="submit"
          className={button}
          disabled={!query.trim() || busy}
          data-testid="mcp-search"
        >
          <Search size={14} />
          Pesquisar
        </button>
      </form>
      <p className="text-[11.5px] text-subtle">
        Só o texto que escreves sai do computador. Entram servidores npm e PyPI com versão fixada.
      </p>
      {busy && !state ? <p className="text-[12.5px] text-muted">A pesquisar…</p> : null}
      {state && state.results.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="mcp-no-results">
          Nada encontrado para «{state.searched}».
        </p>
      ) : null}
      {state?.results.length ? (
        <ul className="grid gap-3" data-testid="mcp-results">
          {state.results.map((result) => (
            <RegistryCard key={`${result.name}@${result.version}`} result={result} />
          ))}
        </ul>
      ) : null}
      {state && left > 0 ? (
        <p className="text-[11.5px] text-subtle" data-testid="mcp-skipped-results">
          {left === 1 ? 'Ficou 1 entrada' : `Ficaram ${left} entradas`} de fora: servidores remotos
          ou de outro tipo que a Solline ainda não arranca.
        </p>
      ) : null}
      {state?.next ? (
        <button
          type="button"
          className={`${button} justify-self-start`}
          disabled={busy}
          onClick={() => void search(state.next ?? undefined)}
        >
          Mais resultados
        </button>
      ) : null}
    </div>
  );
}

function ManualAdd() {
  const [form, setForm] = useState<ManualForm>(emptyManual);
  const [busy, setBusy] = useState(false);
  const built = buildManual(form);
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!built.ok || busy) return;
    setBusy(true);
    const added = await actions.addMcpServer({
      source: { kind: 'manual', spec: built.spec },
      values: built.values,
    });
    setBusy(false);
    if (added) setForm(emptyManual);
  }
  const setEnv = (env: ManualEnvRow[]) => setForm({ ...form, env });
  return (
    <form onSubmit={(e) => void add(e)} className="grid gap-4" data-testid="mcp-manual">
      <div>
        <label className="space-label" htmlFor="mcp-label">
          Nome
        </label>
        <input
          id="mcp-label"
          value={form.label}
          maxLength={80}
          placeholder="Por exemplo: Documentação interna"
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
      </div>
      <div>
        <label className="space-label" htmlFor="mcp-command">
          Comando
        </label>
        <input
          id="mcp-command"
          value={form.command}
          maxLength={300}
          className="font-mono"
          placeholder="npx"
          spellCheck={false}
          onChange={(e) => setForm({ ...form, command: e.target.value })}
        />
      </div>
      <div>
        <label className="space-label" htmlFor="mcp-args">
          Argumentos, um por linha
        </label>
        <textarea
          id="mcp-args"
          value={form.args}
          rows={3}
          className="font-mono"
          placeholder={'-y\nexemplo@1.2.3'}
          spellCheck={false}
          onChange={(e) => setForm({ ...form, args: e.target.value })}
        />
      </div>
      <fieldset className="grid gap-3">
        <legend className="space-label">Variáveis</legend>
        {form.env.map((row, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-control border border-line p-3"
            data-testid="mcp-env-row"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label={`Nome da variável ${index + 1}`}
                value={row.name}
                maxLength={64}
                placeholder="NOME_DA_VARIAVEL"
                className="font-mono"
                spellCheck={false}
                onChange={(e) =>
                  setEnv(form.env.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
                }
              />
              <button
                type="button"
                className={button}
                aria-label={`Tirar a variável ${index + 1}`}
                onClick={() => setEnv(form.env.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            </div>
            <input
              aria-label={`Valor da variável ${index + 1}`}
              type={row.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={row.value}
              placeholder={row.secret ? 'Guardado no Gestor de Credenciais' : 'Valor público'}
              className="font-mono"
              onChange={(e) =>
                setEnv(form.env.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
              }
            />
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <label className="space-check">
                <input
                  type="checkbox"
                  checked={row.secret}
                  onChange={(e) =>
                    setEnv(
                      form.env.map((r, i) =>
                        i === index ? { ...r, secret: e.target.checked } : r,
                      ),
                    )
                  }
                />
                <span>Segredo</span>
              </label>
              <label className="space-check">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(e) =>
                    setEnv(
                      form.env.map((r, i) =>
                        i === index ? { ...r, required: e.target.checked } : r,
                      ),
                    )
                  }
                />
                <span>Obrigatória</span>
              </label>
            </div>
          </div>
        ))}
        <button
          type="button"
          className={`${button} justify-self-start`}
          onClick={() =>
            setEnv([...form.env, { name: '', secret: true, required: false, value: '' }])
          }
          data-testid="mcp-env-add"
        >
          <Plus size={13} />
          Variável
        </button>
      </fieldset>
      {built.ok === false && built.error ? (
        <p className="text-[12px] text-danger" role="alert">
          {built.error}
        </p>
      ) : null}
      <button
        type="submit"
        className={`${button} space-primary justify-self-start`}
        disabled={!built.ok || busy}
        data-testid="mcp-manual-add"
      >
        Acrescentar ao catálogo
      </button>
    </form>
  );
}

/**
 * O catálogo global de servidores MCP: acrescentas um servidor uma vez, aprovas o que a Solline
 * vai arrancar e cada projeto escolhe quais usa. Os segredos ficam no Gestor de Credenciais.
 */
export function McpCatalog() {
  const servers = useMcpCatalog((s) => s.data.servers);
  const loaded = useMcpCatalog((s) => s.loaded);
  const [adding, setAdding] = useState<'registry' | 'manual'>('registry');
  useEffect(() => {
    void actions.loadMcpCatalog();
  }, []);
  return (
    <section className="max-w-[800px]" aria-label="Catálogo de servidores MCP">
      <div>
        <h2 className="text-sm font-medium">Servidores MCP</h2>
        <p className="mt-1 text-[12px] text-muted">
          Acrescentas um servidor uma vez e cada projeto escolhe quais usa. Nada arranca sem a tua
          aprovação.
        </p>
      </div>

      {servers.length ? (
        <ul className="mt-5 grid gap-3" data-testid="mcp-servers">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </ul>
      ) : loaded ? (
        <div className="space-empty" data-testid="mcp-empty">
          <Wrench size={30} strokeWidth={1} aria-hidden />
          <p>Ainda sem servidores.</p>
          <span>Pesquisa no registo oficial ou acrescenta um à mão.</span>
        </div>
      ) : null}

      <div className="mt-8 grid gap-4 border-t border-line pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Acrescentar</h2>
          <div className="space-tabs" role="group" aria-label="De onde vem o servidor">
            <button
              type="button"
              aria-pressed={adding === 'registry'}
              onClick={() => setAdding('registry')}
              data-testid="mcp-add-registry"
            >
              Registo oficial
            </button>
            <button
              type="button"
              aria-pressed={adding === 'manual'}
              onClick={() => setAdding('manual')}
              data-testid="mcp-add-manual"
            >
              À mão
            </button>
          </div>
        </div>
        {adding === 'registry' ? <RegistrySearch /> : <ManualAdd />}
      </div>
    </section>
  );
}
