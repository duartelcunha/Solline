/** One pointer listener and at most one queued frame, shared by visible companions. */
type Gaze = (x: number | null, y: number | null) => void;
const watchers = new Set<Gaze>();
let frame: number | null = null;
let x: number | null = null;
let y: number | null = null;
function notify() {
  frame = null;
  for (const watcher of watchers) watcher(x, y);
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
export function watchGaze(watcher: Gaze): () => void {
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
