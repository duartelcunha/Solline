import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { WindowAction, WindowState } from '@solline/protocol/bridge';
import { useApp } from '../../stores/app.ts';
import './window-controls.css';

export function WindowControls() {
  const [state, setState] = useState<WindowState>({
    maximized: false,
    customControls: false,
    revision: -1,
  });
  const [open, setOpen] = useState(false);
  const [coarse, setCoarse] = useState(
    () => !matchMedia('(hover: hover) and (pointer: fine)').matches,
  );
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissed = useRef(false);
  const pressed = useRef(false);
  const hovered = useRef(false);
  const acting = useRef(false);
  const focusFirst = useRef(false);
  const focusHandle = useRef(false);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const schedule = useCallback(() => {
    cancel();
    if (pressed.current || root.current?.contains(document.activeElement)) return;
    timer.current = setTimeout(() => setOpen(false), 240);
  }, [cancel]);
  useEffect(() => {
    let alive = true;
    const receive = (next: WindowState) => {
      if (alive) setState((previous) => (next.revision >= previous.revision ? next : previous));
    };
    const off = window.solline.window.onState(receive);
    void window.solline.window
      .state()
      .then(receive)
      .catch(() => {
        if (alive)
          useApp.setState({ notice: 'Não foi possível consultar os controlos da janela.' });
      });
    const media = matchMedia('(hover: hover) and (pointer: fine)');
    const changed = () => setCoarse(!media.matches);
    const blur = () => {
      cancel();
      pressed.current = false;
      hovered.current = false;
      setOpen(false);
    };
    const release = () => {
      if (!pressed.current) return;
      pressed.current = false;
      if (!hovered.current) schedule();
    };
    media.addEventListener('change', changed);
    window.addEventListener('blur', blur);
    // The pointer may leave this region while pressed. Its release still ends our gesture.
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('lostpointercapture', release, true);
    return () => {
      alive = false;
      off();
      cancel();
      media.removeEventListener('change', changed);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('lostpointercapture', release, true);
    };
  }, [cancel, schedule]);
  const visible = coarse || open;
  useLayoutEffect(() => {
    if (visible && focusFirst.current) {
      focusFirst.current = false;
      first.current?.focus();
    }
    if (!visible && focusHandle.current) {
      focusHandle.current = false;
      handle.current?.focus();
    }
  }, [visible]);
  function reveal(keyboard = false) {
    if (keyboard) {
      if (visible) first.current?.focus();
      else focusFirst.current = true;
    }
    cancel();
    dismissed.current = false;
    setOpen(true);
  }
  async function act(action: WindowAction) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await window.solline.window.action(action);
    } catch (error) {
      useApp.setState({ notice: error instanceof Error ? error.message : String(error) });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  if (!state.customControls) return null;
  return (
    <div
      ref={root}
      className="window-controls no-drag"
      data-open={visible}
      data-coarse={coarse}
      data-testid="window-controls"
      onPointerEnter={() => {
        hovered.current = true;
        if (!dismissed.current) reveal();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        dismissed.current = false;
        schedule();
      }}
      onPointerDown={() => {
        pressed.current = true;
        cancel();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          cancel();
          timer.current = setTimeout(() => setOpen(false), 240);
        }
      }}
      onKeyDown={(event) => {
        if (
          coarse ||
          event.key !== 'Escape' ||
          document.querySelector('[role="dialog"][data-state="open"]')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
        dismissed.current = true;
        focusHandle.current = true;
        setOpen(false);
      }}
    >
      <span className="window-controls-surface" aria-hidden="true" />
      <button
        ref={handle}
        type="button"
        className="window-controls-handle"
        aria-label="Controlos da janela"
        aria-expanded={visible}
        aria-controls="window-actions"
        tabIndex={visible ? -1 : 0}
        onFocus={() => {
          if (!dismissed.current) reveal(true);
        }}
        onClick={() => reveal(true)}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            reveal(true);
          }
        }}
      >
        <span aria-hidden="true" />
      </button>
      <div
        id="window-actions"
        role="group"
        aria-label="Controlos da janela"
        className="window-actions"
        inert={!visible}
      >
        <button
          ref={first}
          type="button"
          aria-label="Minimizar janela"
          disabled={busy}
          onClick={() => void act('minimize')}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          aria-label={state.maximized ? 'Restaurar tamanho da janela' : 'Maximizar janela'}
          disabled={busy}
          onClick={() => void act('toggle-maximize')}
        >
          {state.maximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          type="button"
          aria-label="Fechar janela"
          disabled={busy}
          onClick={() => void act('close')}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
