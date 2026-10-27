import * as Menu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, Handshake, Network } from 'lucide-react';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { actions, useSession } from '../../stores/app.ts';
import { handoffGate } from './handoff-model.ts';

function usePassToGate(sessionId: string) {
  const state = useSession(sessionId, (s) => s.info.state);
  const handedTo = useSession(sessionId, (s) => s.info.handedTo);
  return handoffGate({ state, ...(handedTo ? { handedTo } : {}) });
}

/** "Passar a…": um botão pequeno que abre o diálogo (no painel de rever). */
export function PassToButton({ sessionId }: { sessionId: string }) {
  const gate = usePassToGate(sessionId);
  return (
    <button
      type="button"
      disabled={!gate.enabled}
      onClick={() => actions.openHandoff(sessionId)}
      aria-label="Passar a…"
      title={gate.reason ?? 'Passar a outro agente'}
      data-testid="pass-to-icon"
      className="sl-press grid size-7 place-items-center rounded-control text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-50"
    >
      <Handshake size={15} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** O menu da sessão, no cabeçalho: as ações que mudam o rumo do trabalho. */
export function SessionMenu({ sessionId }: { sessionId: string }) {
  const gate = usePassToGate(sessionId);
  return (
    <MenuShell
      title="Sessão"
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          aria-label="Mais ações da sessão"
          title="Mais ações"
          data-testid="session-menu"
          className="no-drag sl-press grid size-7 place-items-center rounded-control text-muted outline-none hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover"
        >
          <Ellipsis size={15} strokeWidth={1.9} aria-hidden />
        </Menu.Trigger>
      }
    >
      <ActionItem
        title="Passar a…"
        description={gate.reason ?? 'Continuar noutro agente, na mesma pasta'}
        icon={<Handshake size={14} />}
        disabled={!gate.enabled}
        onSelect={() => actions.openHandoff(sessionId)}
        testId="session-pass-to"
      />
      <ActionItem
        title="Mapa"
        description="Ver as sessões ligadas deste projeto"
        icon={<Network size={14} />}
        onSelect={() => actions.openMap()}
        testId="session-map"
      />
    </MenuShell>
  );
}
