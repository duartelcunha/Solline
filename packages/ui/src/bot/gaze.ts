/** One pointer listener and at most one queued frame, shared by visible companions. */
type Gaze = (x: number | null, y: number | null) => void;
interface Watcher {
  update: Gaze;
  measure?: () => void;
}
const watchers = new Set<Watcher>();
let frame: number | null = null;
let x: number | null = null;
let y: number | null = null;
function notify() {
  frame = null;
  // Read every visible figure before writing any transform: no read/write layout thrashing.
  if (x !== null && y !== null) for (const watcher of watchers) watcher.measure?.();
  for (const watcher of watchers) watcher.update(x, y);
}
function move(event: PointerEvent) {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
  x = event.clientX;
  y = event.clientY;
  if (frame === null) frame = requestAnimationFrame(notify);
}
function leave() {
  x = null;
  y = null;
  if (frame === null) frame = requestAnimationFrame(notify);
}
export function watchGaze(update: Gaze, measure?: () => void): () => void {
  const watcher = { update, measure };
  if (!watchers.size) {
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    window.addEventListener('blur', leave);
  }
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (!watchers.size) {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
      window.removeEventListener('blur', leave);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      x = null;
      y = null;
    }
  };
}
