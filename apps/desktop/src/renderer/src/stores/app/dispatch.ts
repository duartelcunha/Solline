import type { EngineEvent } from '@solline/protocol';
import { morphs } from '../../lib/morph.ts';
import { receiveMcpCatalog } from '../mcp-catalog.ts';
import { receiveRules } from '../rules.ts';
import { reduceSession } from '../session.ts';
import { receiveSpaces } from '../spaces.ts';
import { sessionActions } from './actions-sessions.ts';
import {
  adoptMissingLanes,
  earlyEvents,
  enqueue,
  isStartingSplit,
  scheduleChildAdoption,
  sessionStores,
  useApp,
} from './state.ts';

/** Todos os eventos do motor entram por aqui. */
export function dispatch(event: EngineEvent): void {
  if (event.type === 'spaces.changed') {
    receiveSpaces(event.spaces);
    return;
  }
  if (event.type === 'rules.changed') {
    receiveRules(event.rules);
    return;
  }
  if (event.type === 'mcp.changed') {
    receiveMcpCatalog(event.mcp);
    return;
  }
  if (event.type === 'race.state') {
    useApp.setState((s) => ({ races: { ...s.races, [event.race.id]: event.race } }));
    if (event.race.kind === 'split' && event.race.phase !== 'closed' && !isStartingSplit())
      void adoptMissingLanes(event.race);
    return;
  }
  if (event.type === 'engine.error' && event.sessionId) {
    const store = sessionStores.get(event.sessionId);
    if (store) store.setState({ actionError: event.message });
    else useApp.setState({ notice: event.message });
    return;
  }
  if (event.type === 'engine.error') {
    useApp.setState({ notice: event.message, engineOffline: true });
    for (const store of sessionStores.values()) {
      enqueue(() => {
        const { info } = store.getState();
        if (info.state === 'error') return;
        store.setState(
          reduceSession(store.getState(), {
            kind: 'event',
            type: 'session.state',
            sessionId: info.id,
            state: 'error',
            error: event.message,
          }),
        );
      }, false);
    }
    return;
  }
  if (event.type === 'session.archived') {
    const store = sessionStores.get(event.sessionId);
    if (!store) return;
    const already = store.getState().info.archived === true;
    store.setState(reduceSession(store.getState(), event));
    if (!already) useApp.setState({ celebrate: event.sessionId });
    return;
  }
  if (event.type === 'engine.ready') {
    useApp.setState({ engineOffline: false });
    return;
  }
  if (event.type === 'agents.changed') {
    if (event.error) useApp.setState({ notice: event.error });
    void sessionActions.loadAgents();
    return;
  }
  const store = sessionStores.get(event.sessionId);
  if (!store) {
    const early = earlyEvents.get(event.sessionId) ?? [];
    if (early.length < 500) early.push(event);
    earlyEvents.set(event.sessionId, early);
    scheduleChildAdoption();
    return;
  }
  const apply = () => store.setState(reduceSession(store.getState(), event));
  const { activeSessionId, view } = useApp.getState();
  enqueue(apply, view === 'session' && event.sessionId === activeSessionId && morphs(event));
}
