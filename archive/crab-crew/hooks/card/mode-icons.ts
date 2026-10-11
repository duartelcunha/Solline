// The permission-mode icons: what the card's mode pills, the collapsed bar and
// the earlier-reply line show for plan / auto / default / acceptEdits. Pure: no
// `$`, no I/O.
//
// 16 x 16 px line art in the card's style: 1.5 px stroke, round caps and joins,
// no fill (a dot is a zero-length segment with a round cap). Coordinates are in
// a 16 px box with (0, 0) at the top left; `modeIcon` places the box.
//
//   plan         a compass (ring + needle)
//   auto         a circular arrow with a small spark in its gap
//   default      a speech bubble holding "?"  (shown as "Ask")
//   acceptEdits  a pencil with a check         (shown as "Edits")

import { MODE_NAME, type Mode } from './parse'

/** The box every icon is drawn in (px). */
export const MODE_ICON_SIZE = 16
/** The stroke every icon is drawn with (px). */
export const MODE_ICON_STROKE = 1.5

/** Path data per mode, in the 16 px box. Each entry is one stroked `<path>`. */
export const MODE_ICON: Readonly<Record<Mode, readonly string[]>> = {
  plan: [
    'M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5Z',
    'M10.65 5.35L9.1 9.1L5.35 10.65L6.9 6.9Z',
  ],
  auto: [
    'M7.5 3.5A5 5 0 1 0 12.5 8.5',
    'M10.6 10.2L12.5 8.3L14.4 10.2',
    'M12.5 1.75v3M11 3.25h3',
  ],
  default: [
    'M4 2h8a2.25 2.25 0 0 1 2.25 2.25v4.75a2.25 2.25 0 0 1-2.25 2.25H7.75L4.5 14.25v-3H4a2.25 2.25 0 0 1-2.25-2.25V4.25A2.25 2.25 0 0 1 4 2Z',
    'M6.5 5.5a1.5 1.5 0 1 1 2.2 1.33c-.42.22-.7.6-.7 1.07',
    'M8 9.6v.01',
  ],
  acceptEdits: [
    'M9 2.5a1.42 1.42 0 1 1 2 2L4.25 11.25L1.5 12l.75-2.75Z',
    'M9.25 12.25l1.75 1.75l3.5-3.5',
  ],
}

const XML_ESC = (s: string): string => s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

export type ModeIconOpts = {
  /** top-left of the 16 px box (default 0, 0) */
  x?: number
  y?: number
  /** a `<title>` child (the hover tooltip), e.g. the mode's name */
  title?: string
  /** extra attributes on the group (opacity, …) */
  attrs?: string
  /** inner markup placed first in the group (SMIL children: <animate>, <animateTransform>) */
  anim?: string
}

/** The stroked paths of one icon in `colour`, no wrapper (for callers that place it themselves). */
export function modeIconPaths(mode: Mode, colour: string): string {
  return (MODE_ICON[mode] ?? MODE_ICON.default)
    .map(d => `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${MODE_ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('')
}

/** One icon as a `<g>` in `colour`, its 16 px box at (x, y). */
export function modeIcon(mode: Mode, colour: string, opts: ModeIconOpts = {}): string {
  const x = opts.x ?? 0, y = opts.y ?? 0
  const at = x || y ? ` transform="translate(${+x.toFixed(2)} ${+y.toFixed(2)})"` : ''
  const title = opts.title ? `<title>${XML_ESC(opts.title)}</title>` : ''
  return `<g${at}${opts.attrs ? ' ' + opts.attrs : ''}>${title}${opts.anim ?? ''}${modeIconPaths(mode, colour)}</g>`
}

/** The icon alone as a standalone SVG `px` wide (previews). */
export function renderModeIcon(mode: Mode, colour: string, px = MODE_ICON_SIZE): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${MODE_ICON_SIZE} ${MODE_ICON_SIZE}" role="img" aria-label="${XML_ESC(MODE_NAME[mode])}">${modeIconPaths(mode, colour)}</svg>`
}
