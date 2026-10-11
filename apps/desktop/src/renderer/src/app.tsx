import { useEffect, useState } from 'react';
import { ArrowUp, Moon, Plus, Sun } from 'lucide-react';
import { APP_NAME } from '@solline/protocol/app';
import type { CommandResult } from '@solline/protocol';
import type { Theme } from '@solline/protocol/bridge';

const THEME_KEY = 'solline.theme';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    void window.solline.window.setTheme(theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

type PingState =
  | { status: 'pending' }
  | { status: 'ok'; ms: number; reply: CommandResult<'engine.ping'> }
  | { status: 'error'; message: string };

function usePing(): PingState {
  const [state, setState] = useState<PingState>({ status: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = performance.now();
    window.solline.engine
      .ping()
      .then((reply) => {
        if (alive) setState({ status: 'ok', ms: Math.round(performance.now() - started), reply });
      })
      .catch((error: unknown) => {
        if (alive) setState({ status: 'error', message: String(error) });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

type CheckState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: CommandResult<'engine.sdkCheck'> }
  | { status: 'error'; message: string };

export function App() {
  const [theme, toggleTheme] = useTheme();
  const ping = usePing();
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });

  async function runCheck() {
    setCheck({ status: 'running' });
    try {
      setCheck({ status: 'done', result: await window.solline.engine.sdkCheck() });
    } catch (error) {
      setCheck({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div className="grid h-full grid-cols-[15.5rem_1fr]">
      <Sidebar ping={ping} />

      <main className="flex min-w-0 flex-col">
        <header className="drag flex h-11 shrink-0 items-center justify-end pr-[9.5rem]">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
            data-testid="theme-toggle"
            className="no-drag grid size-8 place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg active:scale-95"
          >
            {theme === 'dark' ? (
              <Sun size={16} strokeWidth={1.75} />
            ) : (
              <Moon size={16} strokeWidth={1.75} />
            )}
          </button>
        </header>

        <section className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-8">
          <div className="text-center">
            <h1 className="text-[2rem] leading-tight font-semibold tracking-[-0.025em]">
              {APP_NAME}
            </h1>
            <p className="mt-1.5 text-muted">Poder do terminal, facilidade da app.</p>
          </div>

          <EngineCard check={check} onCheck={runCheck} />
        </section>

        <Composer />
      </main>
    </div>
  );
}

function Sidebar({ ping }: { ping: PingState }) {
  return (
    <aside className="flex flex-col border-r border-line bg-sidebar">
      <div className="drag flex h-11 shrink-0 items-center gap-2 px-4">
        <span aria-hidden className="size-2.5 rounded-full bg-accent" />
        <span className="text-[13px] font-semibold tracking-[-0.01em]">{APP_NAME}</span>
      </div>

      <div className="px-3 pt-2">
        <button
          type="button"
          disabled
          title="Chega no próximo marco"
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-[13px] text-muted disabled:cursor-default"
        >
          <Plus size={15} strokeWidth={1.75} />
          Nova sessão
        </button>
      </div>

      <div className="mt-5 px-5 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
        Sessões
      </div>
      <p className="px-5 pt-2 text-[13px] text-subtle">Ainda sem sessões.</p>

      <div className="mt-auto border-t border-line px-4 py-3" data-testid="engine-status">
        <EngineStatus ping={ping} />
      </div>
    </aside>
  );
}

function EngineStatus({ ping }: { ping: PingState }) {
  if (ping.status === 'pending') {
    return <StatusLine dot="bg-subtle" label="A ligar o motor…" />;
  }
  if (ping.status === 'error') {
    return <StatusLine dot="bg-danger" label="Motor sem resposta" detail={ping.message} />;
  }
  return (
    <StatusLine
      dot="bg-success"
      label="Motor ligado"
      detail={`pong em ${ping.ms} ms · v${ping.reply.engineVersion}`}
      testId="ping-reply"
    />
  );
}

function StatusLine(props: { dot: string; label: string; detail?: string; testId?: string }) {
  return (
    <div className="flex items-start gap-2.5" data-testid={props.testId}>
      <span aria-hidden className={`mt-[7px] size-1.5 shrink-0 rounded-full ${props.dot}`} />
      <div className="min-w-0">
        <div className="text-[13px]">{props.label}</div>
        {props.detail ? (
          <div className="truncate font-mono text-[11px] text-subtle">{props.detail}</div>
        ) : null}
      </div>
    </div>
  );
}

function EngineCard({ check, onCheck }: { check: CheckState; onCheck: () => void }) {
  const running = check.status === 'running';
  return (
    <div className="w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-raised">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium">Motor</div>
          <div className="text-[12px] text-muted">
            Uma pergunta curta a Haiku, para provar o SDK.
          </div>
        </div>
        <button
          type="button"
          onClick={onCheck}
          disabled={running}
          data-testid="sdk-check"
          className="shrink-0 rounded-sm border border-line-strong px-3 py-1.5 text-[13px] font-medium transition-[background-color,transform] duration-100 hover:bg-surface-hover active:scale-[0.97] disabled:opacity-60"
        >
          {running ? 'A testar…' : 'Testar motor'}
        </button>
      </div>

      {check.status === 'done' ? (
        <dl
          data-testid="sdk-check-result"
          className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-line pt-4 text-[12px]"
        >
          <Row label="Modelo" value={check.result.model} />
          <Row label="Credencial" value={check.result.apiKeySource} />
          <Row
            label="Resposta"
            value={check.result.result}
            tone={check.result.isError ? 'text-danger' : undefined}
          />
          <Row label="Custo" value={`US$ ${check.result.totalCostUsd.toFixed(6)}`} />
          <Row label="Binário" value={check.result.claudeExecutable ?? 'escolhido pelo SDK'} />
        </dl>
      ) : null}

      {check.status === 'error' ? (
        <p
          data-testid="sdk-check-error"
          className="mt-4 border-t border-line pt-4 text-[12px] text-danger"
        >
          {check.message}
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string | undefined }) {
  return (
    <>
      <dt className="text-subtle">{label}</dt>
      <dd className={`m-0 font-mono break-words select-text ${tone ?? ''}`}>{value}</dd>
    </>
  );
}

function Composer() {
  return (
    <div className="shrink-0 px-8 pb-6">
      <div className="mx-auto flex max-w-3xl items-end gap-3 rounded-lg border border-line bg-surface p-3 shadow-raised">
        <textarea
          disabled
          rows={2}
          placeholder="Escreve uma mensagem… (a conversa chega no próximo marco)"
          aria-label="Mensagem"
          className="min-h-11 flex-1 resize-none bg-transparent px-1 text-[14px] outline-none placeholder:text-subtle disabled:cursor-default"
        />
        <button
          type="button"
          disabled
          aria-label="Enviar"
          className="grid size-8 place-items-center rounded-full bg-surface-sunken text-subtle"
        >
          <ArrowUp size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
