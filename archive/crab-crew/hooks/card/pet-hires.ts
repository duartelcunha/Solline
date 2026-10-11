// The hi-res pixel pet: what the `pet` effort icon (./effort-icon) draws on the
// knob and in the collapsed bar. Pure: no `$`, no I/O, deterministic.
//
// One pose per effort level, each with one designed play (a list of whole-pixel
// frames and how long each shows) that starts from the rest frame and ends on it:
//
//   low    Derretido             melted; ripples, tries to rise, splats back
//   medium Café                  cup raised; steam curls up, a sip, a perk-up
//   high   A teclar              paws on the keys; a stroke every 100 ms
//   xhigh  A teclar mais rápido  strained, a stroke every 60 ms; the 5x7 sweat
//                                drop slides off the temple in 8 steps of 80 ms
//   max    Godmode · Aura        a stroke every 30 ms, the paws a translucent
//                                smear, calm face, white eyes, a 1 px gold aura
//
// Rendering: the frames sit on a 64 x 52 canvas. A level is drawn in a nested
// <svg> whose viewBox is the tight crop of every frame of its play (nothing is
// clipped, the aura included), scaled by PET_HIRES_SCALE as a whole: one sprite
// pixel is half a knob unit, so it is one device pixel at 2x and the pixel art
// is never resampled inside a frame. shape-rendering="crispEdges".
//
// A play is one animated element: the cells every frame shares are drawn once,
// the rest of each frame is laid out side by side in a strip, and one
// animateTransform (calcMode="discrete") moves the strip a whole frame at a
// time behind the crop. At rest (and with reduced motion) only the rest frame
// is drawn, with nothing animated.

export type PetHiresData = {
  tag: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  name: string
  /** ms per typing stroke (the play's beat) */
  stroke: number
  /** xhigh: the sweat drop's slide (ms per step, steps) */
  drop?: { ms: number; steps: number }
  seq: readonly (readonly number[])[]
  rest: string
  frames: readonly string[]
}

type Theme = 'dark' | 'light'

/** Uniform scale of the whole sprite (knob units per sprite pixel). */
export const PET_HIRES_SCALE = 0.5

/* ================= decoding ================= */

const levelOf = (x: number): number => Math.max(0, Math.min(4, Math.round(Number.isFinite(x) ? x : 0)))

function decodeRows(s: string, fill: string, base?: readonly string[]): string[] {
  const rows = s.split('|')
  const out: string[] = []
  for (let y = 0; y < PET_HIRES_H; y++) {
    let r = ''
    for (const m of (rows[y] ?? '').matchAll(/(\d*)(\D)/g)) r += (m[2] ?? '').repeat(m[1] ? Number(m[1]) : 1)
    r = r.padEnd(PET_HIRES_W, fill)
    if (base) {
      const b = base[y] ?? ''
      r = [...r].map((c, x) => (c === '_' ? (b[x] ?? '.') : c)).join('')
    }
    out.push(r)
  }
  return out
}

type Box = { x0: number; y0: number; x1: number; y1: number }
type Level = { data: PetHiresData; frames: string[][]; box: Box; ax: number; ay: number; ms: number }

const cache: (Level | undefined)[] = []

function bbox(frames: readonly (readonly string[])[]): Box {
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const g of frames) {
    g.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        if (r[x] === '.') continue
        b.x0 = Math.min(b.x0, x), b.y0 = Math.min(b.y0, y), b.x1 = Math.max(b.x1, x + 1), b.y1 = Math.max(b.y1, y + 1)
      }
    })
  }
  return b
}

function level(L: number): Level {
  const i = levelOf(L)
  const hit = cache[i]
  if (hit) return hit
  const data = PET_HIRES_LEVELS[i] ?? PET_HIRES_LEVELS[0]!
  const rest = decodeRows(data.rest, '.')
  const frames = [rest, ...data.frames.map(f => decodeRows(f, '_', rest))]
  const r = bbox([rest])
  /* (ax, ay) lands on the knob centre: the sprite's middle column, the rest pose's middle row (even, so
     every sprite pixel edge stays on the half-unit grid) */
  const ay = 2 * Math.round((r.y0 + r.y1) / 4)
  const lv: Level = { data, frames, box: bbox(frames), ax: PET_HIRES_W / 2, ay, ms: data.seq.reduce((a, s) => a + (s[1] ?? 0), 0) }
  cache[i] = lv
  return lv
}

/** Every frame of `level`'s play as rows of cell chars ('.' empty); frame 0 is the rest frame. */
export function petHiresFrames(L: number): readonly (readonly string[])[] {
  return level(L).frames
}
/** The play of `level`: [frame, ms] pairs, ending on the rest frame. */
export function petHiresSeq(L: number): readonly (readonly number[])[] {
  return level(L).data.seq
}
/** Length (ms) of `level`'s play. */
export function petHiresPlayMs(L: number): number {
  return level(L).ms
}
/** ms per typing stroke at `level` (its beat). */
export function petHiresStroke(L: number): number {
  return level(L).data.stroke
}
/** The crop drawn for `level`, in canvas px (viewBox), and where it lands around the knob centre (units). */
export function petHiresViewport(L: number): { viewBox: Box; x: number; y: number; width: number; height: number } {
  const v = level(L), S = PET_HIRES_SCALE, b = v.box
  return { viewBox: { ...b }, x: (b.x0 - v.ax) * S, y: (b.y0 - v.ay) * S, width: (b.x1 - b.x0) * S, height: (b.y1 - b.y0) * S }
}

/* ================= markup ================= */

/** paint attributes of a cell char in `theme` (#RRGGBBAA becomes the colour + its opacity) */
function paint(c: string, theme: Theme, how: 'fill' | 'stroke'): string {
  const h = c === 'G' ? PET_HIRES_THEME_G[theme] : (PET_HIRES_PAL[c] ?? '#FF00FF')
  if (h.length === 9) return `${how}="${h.slice(0, 7)}" ${how}-opacity="${Math.round((parseInt(h.slice(7), 16) / 255) * 100) / 100}"`
  return `${how}="${h}"`
}

/**
 * Paths per colour. Each horizontal run of a colour is a rect, and a run repeated on the rows below
 * merges into one taller rect (a filled path). A one-row rect is half the bytes as a 1 px stroke along
 * its middle (butt caps: the same cells exactly), so those are strokes in a group lowered by half a
 * pixel. `at(x, y)` gives the char drawn at (x, y) ('.' none); `dx` shifts frame k of a strip.
 */
function paths(cells: Array<{ dx: number; at: (x: number, y: number) => string }>, theme: Theme): string {
  type R = { x: number; y: number; w: number; h: number }
  const byColour = new Map<string, R[]>()
  for (const { dx, at } of cells) {
    const open = new Map<string, R>()
    for (let y = 0; y < PET_HIRES_H; y++) {
      const next = new Map<string, R>()
      let x = 0
      while (x < PET_HIRES_W) {
        const c = at(x, y)
        if (c === '.') { x++; continue }
        let w = 1
        while (x + w < PET_HIRES_W && at(x + w, y) === c) w++
        const key = `${c},${x},${w}`
        const o = open.get(key)
        if (o && o.y + o.h === y) {
          o.h++
          next.set(key, o)
        } else {
          const r = { x: x + dx, y, w, h: 1 }
          if (!byColour.has(c)) byColour.set(c, [])
          byColour.get(c)!.push(r)
          next.set(key, r)
        }
        x += w
      }
      open.clear()
      for (const [k, r] of next) open.set(k, r)
    }
  }
  let s = '', lines = ''
  for (const [c, rs] of byColour) {
    rs.sort((a, b) => a.y - b.y || a.x - b.x)
    let d = '', px = 0, py = 0
    for (const r of rs.filter(r => r.h > 1)) {
      d += d ? `m${r.x - px} ${r.y - py}` : `M${r.x} ${r.y}`
      d += `h${r.w}v${r.h}h-${r.w}z`
      px = r.x, py = r.y
    }
    if (d) s += `<path ${paint(c, theme, 'fill')} d="${d}"/>`
    d = ''
    for (const r of rs.filter(r => r.h === 1)) {
      d += (d ? `m${r.x - px} ${r.y - py}` : `M${r.x} ${r.y}`) + `h${r.w}`
      px = r.x + r.w, py = r.y
    }
    if (d) lines += `<path ${paint(c, theme, 'stroke')} d="${d}"/>`
  }
  return s + (lines ? `<g transform="translate(0 .5)" fill="none">${lines}</g>` : '')
}

/** The rest frame alone; and for a play, the cells every frame shares plus the strip of the rest (memoized). */
const layerCache = new Map<string, { rest: string; shared: string; strip: string }>()
function layers(L: number, theme: Theme): { rest: string; shared: string; strip: string } {
  const key = `${levelOf(L)}|${theme}`
  const hit = layerCache.get(key)
  if (hit) return hit
  const fr = level(L).frames, rest = fr[0] ?? []
  const same = rest.map((r, y) => [...r].map((c, x) => fr.every(g => g[y]?.[x] === c)))
  const own = (x: number, y: number): boolean => !(same[y]?.[x] ?? true)
  const out = {
    rest: paths([{ dx: 0, at: (x, y) => rest[y]?.[x] ?? '.' }], theme),
    shared: paths([{ dx: 0, at: (x, y) => (own(x, y) ? '.' : (rest[y]?.[x] ?? '.')) }], theme),
    strip: paths(fr.map((g, k) => ({ dx: k * PET_HIRES_W, at: (x: number, y: number) => (own(x, y) ? (g[y]?.[x] ?? '.') : '.') })), theme),
  }
  layerCache.set(key, out)
  return out
}

const r3 = (x: number): number => {
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? 0 : r
}

/**
 * The pet at `level` centred on the knob (0, 0). `play`: the play in flight, `elapsed` ms after it
 * started (null, or past its end: the rest frame alone, nothing animated).
 */
export function petHiresMarkup(L: number, theme: Theme, play: { elapsed: number } | null = null): string {
  const v = level(L)
  const vp = petHiresViewport(L), b = vp.viewBox
  const open = `<svg x="${r3(vp.x)}" y="${r3(vp.y)}" width="${r3(vp.width)}" height="${r3(vp.height)}" viewBox="${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}" overflow="hidden" shape-rendering="crispEdges">`
  const t = play ? play.elapsed : -1
  const art = layers(L, theme)
  if (!(t >= 0 && t < v.ms)) return open + art.rest + '</svg>'
  /* the frame on screen at `elapsed`, then the discrete track (it ends on the rest frame and holds it) */
  let acc = 0, cur = 0
  const kt: number[] = [], vals: string[] = []
  for (const [f = 0, ms = 0] of v.data.seq) {
    if (acc <= t) cur = f
    kt.push(r3(acc / v.ms))
    vals.push(`${-f * PET_HIRES_W} 0`)
    acc += ms
  }
  const an = `<animateTransform attributeName="transform" type="translate" calcMode="discrete" values="${vals.join(';')}" keyTimes="${kt.join(';')}" dur="${r3(v.ms / 1000)}s" begin="${r3(-t / 1000)}s" fill="freeze"/>`
  return open + art.shared + `<g transform="translate(${-cur * PET_HIRES_W} 0)">${an}${art.strip}</g></svg>`
}

// <generated>
// Generated by petlab/emit_ts.py from the approved gen.py. Do not edit by hand.
/** Canvas of every frame (px); the 48 x 32 sprite sits at (8, 20). */
export const PET_HIRES_W = 64
export const PET_HIRES_H = 52
/** Fixed colours by cell char (#RRGGBBAA = translucent). 'G' (steam, motion marks) follows the theme: PET_HIRES_THEME_G. */
export const PET_HIRES_PAL: Readonly<Record<string, string>> = { B: '#D97757', C: '#5B3524', D: '#B85E41', E: '#1A1A1C', H: '#EC9C80', I: '#FFFFFF', L: '#C4C4CA', M: '#E4E4E8', Q: '#5FA9E2', S: '#8E4128', T: '#232327', V: '#30A46C', W: '#F5F0E8', a: '#F5BE5E', c: '#EE8559', e: '#D9775766', g: '#E6957A', l: '#86868D', m: '#7A7A80', n: '#3577B5', p: '#FFE6A8', q: '#E8F4FC', u: '#FFC23D', w: '#C8BBAA', z: '#FFF6DA' }
export const PET_HIRES_THEME_G: Readonly<Record<'dark' | 'light', string>> = { dark: '#A3A3AA', light: '#9A9AA1' }
/**
 * Per level 0 low .. 4 max. rest: the designed rest frame (frame 0), rows joined by '|', run-length
 * ('4B' = 4 cells of B, '.' empty, trailing empties dropped). frames[i - 1]: frame i as a diff of rest
 * ('_' = as rest). seq: the one play, [frame, ms] pairs, ending on the rest frame. stroke: ms per typing stroke.
 */
export const PET_HIRES_LEVELS: readonly PetHiresData[] = [
  {
    tag: 'low', name: "Derretido", stroke: 70,
    seq: [[1, 70], [2, 70], [3, 90], [4, 170], [3, 60], [5, 110], [6, 60], [0, 40]],
    rest: "||||||||||||||||||||||||||||||||||||||18.28H|17.H28BD|16.H30BD|16.31BD|16.4BE2BE16BE2BE3BD|16.5B2E18B2E4BD|9.6H33BD6H|8.40BD6BD|8.47BD|7.8BD32BD8B|6.52B|6.5D42B5D|6.52D|5.54S",
    frames: [
      "|||||||||||||||||||||||||||||||||||||19_4H8_4H8_2H|19_4B8_4B8_2B||||||||||||5_D51_.",
      "|||||||||||||||||||||||||||||||||||||27_4H8_4H|27_4B8_4B||||||||||||6_.51_D",
      "|||||||||||||||||||||||||||||||||||23_4H8_4H|18_5H4B8H4B7H|17_H28BD|16_H30BD|16_2B2_4E16_4E2_BD|16_B3_4E16_4E|21_2E18_2E|20_B2_B16_B2_B|9_6H6_2B18_2B6_5HD|9_6B.31_D.6B|15_.31_D.|48_D|15_BD30_DBD|50_D|52_D|5_D51_.",
      "|||||||||||||||||||||||||||||||||18_28H|17_H28BD|16_H4B2E18B2E4BD|16_4B4E16B4E3BD|16_4B4E16B4E3BD|16_5B2E18B2E4BD|16_2B28_BD|16_B|9_6H34_5HD|9_6B5_B2_B16_B2_B5_5BD|9_6B6_2B18_2B6_5BD|9_6B2.29_D2.6B|15_2.29_D2.|15_.31_D.|14_.B_D28_D2_.|13_.35_D.|11_.39_D.|6_.50_.|5_.52_.",
      "||||||||||||||||||||||||||||||||||||||18_28.|17_.28H.|16_.H28_D.|16_H|20_B2_B16_B2_B|20_E2_E16_E2_E|8_H6_.31_D.6_H|7_B40_B6_BD|7_B47_BD|6_B7_DB32_BD7_B|5_B52_B|5_D52_D|4_2D52_2D|3_2S54_2S",
      "|||||||||||||||||||||||||||||||||||||27_4H8_4H|27_4B8_4B||||||||||||6_.51_D",
    ],
  },
  {
    tag: 'medium', name: "Café", stroke: 120,
    seq: [[1, 120], [2, 120], [3, 100], [4, 260], [5, 90], [6, 150], [7, 70], [0, 40]],
    rest: "||||||||||50.G|50.G|49.G3.G|49.G4.G|50.G3.G|50.G|49.G||48.7w|48.w5Cw|18.28H2.w5W3w|17.H28BD.w5Ww.w|16.H30BDw5Ww.w|16.H30BDw5W3w|16.31BD7H|16.31BD8B|16.31BD8B|16.4B4E16B4E3BD8B|9.7H4B4E16B4E3BD8B|8.13B2E18B2E4BD8B|8.39BD8B|8.39B8D|8.38B2D|8.39BD|8.39BD|9.7D31BD|16.D30BD|16.31BD|16.31BD|16.31BD|16.31BD|16.31BD|17.30D|18.28D|16.4D4.4S8.4S4.4D|16.4B4.4D8.4D4.4B|16.4B4.4D8.4D4.4B|16.4B4.4D8.4D4.4B|16.4B4.4D8.4D4.4B|16.4B4.4D8.4D4.4B|16.4B4.4D8.4D4.4B|16.4B4.4D8.4D4.4B",
    frames: [
      "||||||||||49_G.||49_.G|53_G.|49_G.||49_.G",
      "||||||||||49_G.|49_G.|49_.G2_.G|49_.G2_G.|49_G.2_G.|49_G.|49_.",
      "|||||||||||49_G.|53_.G|49_.G|53_G.|50_.|49_.",
      "||||||||||50_.|50_.|46_6w_.|45_w6Cw_.|45_w7Ww.|46_w6W3w|46_w6Ww_w|47_w6W3w|47_w6W|48_7H|48_8B.|48_8B.|48_8B.|48_8B.|48_8B||48_7D.|20_4B16_4B4_8.|20_B2_B16_B2_B4_8.|20_E2BE16_E2BE4_8.|48_8.|48_7.|46_B",
      "||||||||||50_.|50_.|49_.3_.|49_.4_.|50_.3_.|50_.|49_.|||||||||21_2E18_2E|20_4E16_4E",
      "|||||||||||49_G.|53_.G|49_.G|50_.3_.|50_.|49_.|||||||||21_2E18_2E|20_4E16_4E",
      "|||||||||||49_G.|53_.G|49_.G|53_G.|49_G.|49_.|||||||||||20_4B16_4B||21_2B18_2B",
    ],
  },
  {
    tag: 'high', name: "A teclar", stroke: 100,
    seq: [[1, 100], [2, 100], [3, 100], [4, 100], [5, 100], [6, 100], [7, 100], [0, 120]],
    rest: "||||||||||||||||||||18.28H|17.H28BD|16.H30BD|16.H30BD|16.31BD|16.31BD|16.31BD|16.31BD|16.4B4E16B4E3BD|16.4B4E16B4E3BD|16.4B4E16B4E3BD|16.31BD|10.6H31BD6H|9.H6BH30BH6BH|9.D7BH28BH7BD|10.D7BH26BH7BD|11.D7BH24BH7BD|12.D7BH22BH7BD|13.D7BHB18lBH7BD|14.D7Bl18Tl7BD|15.D6BlT3BT6MT3m3Tl6BD|16.6Dl18Tl6D|16.6Sl3T4QT7M3Tl6S|18.4Dl18Tl4D|16.4D2.l3T2BT7V5Tl2.4D|16.4B2.l18Tl2.4B|16.4B2.lT5mT4MTB5Tl2.4B|16.4B2.l18Tl2.4B|16.4B2.l18Tl2.4B|16.4B2.20l2.4B|16.4B24L4B|16.3B26l3B",
    frames: [
      "||||||||||||||||||||||||||||||10_7H|9_H6B_2H|9_D6B3_H|9_.D5_B3_H|9_2.2D4_B3_H|10_3.2D3_B2_DS|11_4.6D2S|12_4.6S|13_3.5_B|14_2.|15_.8_2T4QT3_4M|16_6B|16_.5D4_2BT7V2T||24_5mT4M2T||24_3BT2M_TBT_T",
      "||||||||||||||||||||||||||||||47_7H|45_2H7BH|44_H2_7BD|43_H3_B5_D.|42_H3_B4_2D2.|41_SD2_B3_2D3.|41_2S6D4.|42_6S4.|42_B4_D3.|47_D2.|24_2T4QT3_4M9_D.|42_5B|26_2BT7V2T4_5D.||24_5mT4M2T||24_3BT2M5_3m_B",
      "||||||||||||||||||||||||||||||10_7H|9_H6B_2H|9_D6B3_H|9_.D5_B3_H|9_2.2D4_B3_H|10_3.2D3_B2_DS|11_4.6D2S|12_4.6S|13_3.5_B|14_2.|15_.8_2T_BT7V2T|16_6B|16_.5D2_5mTM3_4T||24_2B_T6MT3m||24_2T4QT_TB_T",
      "||||||||||||||||||||||||||||||47_7H|45_2H7BH|44_H2_7BD|43_H3_B5_D.|42_H3_B4_2D2.|41_SD2_B3_2D3.|41_2S6D4.|42_6S4.|42_B4_D3.|47_D2.|24_2T_BT7V2T9_D.|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m||24_2T4QT3_4M_B",
      "||||||||||||||||||||||||||||||10_7H|9_H6B_2H|9_D6B3_H|9_.D5_B3_H|9_2.2D4_B3_H|10_3.2D3_B2_DS|11_4.6D2S|12_4.6S|13_3.5_B|14_2.|15_.8_5mT5_3T|16_6B|16_.5D2_3BT3M3_T3m||26_4QT7M||24_2T2BT2VTBT_T",
      "||||||||||||||||||||||||||||||47_7H|45_2H7BH|44_H2_7BD|43_H3_B5_D.|42_H3_B4_2D2.|41_SD2_B3_2D3.|41_2S6D4.|42_6S4.|42_B4_D3.|47_D2.|24_5mT5_3T9_D.|42_5B|24_3BT3M3_T3m4_5D.||26_4QT7M||24_2T2BT7V_B",
      "||||||||||||||||||||||||||||||10_7H|9_H6B_2H|9_D6B3_H|9_.D5_B3_H|9_2.2D4_B3_H|10_3.2D3_B2_DS|11_4.6D2S|12_4.6S|13_3.5_B|14_2.|15_.|16_6B|16_.5D||||28_TB4T_T",
    ],
  },
  {
    tag: 'xhigh', name: "A teclar mais rápido", stroke: 60, drop: { ms: 80, steps: 8 },
    seq: [[1, 60], [2, 20], [3, 40], [4, 40], [5, 20], [6, 60], [7, 60], [8, 20], [9, 40], [10, 40], [11, 20], [12, 60], [13, 60], [14, 20], [15, 40], [16, 40], [0, 60]],
    rest: "|||||||||||||||||||48.Q|18.28H2.Q|17.H28BD3Q|16.H29BQq2Qn|16.H29BQq2Qn|16.30B3Q2n|16.31B3n|16.31BD|16.4B2E20B2E3BD|16.4B3E18B3E3BD|16.4B4E16B4E3BD|10.7H3B4E16B4E3BD|9.H7B2H28BD|9.D9BH27BD6H|10.D9BH26BH6BH|11.2D8BH24BH7BD|13.2D6BDS22BH7BD|15.6D2S21BH7BD|16.6S21BH7BD|6.5G5.7B18lBH7BD|16.6Bl18Tl7BD|7.6G3.6BlT2BT5MT4Q4Tl6BD|16.6Bl18Tl6D|17.5Dl3T6mT4V4Tl6S|18.4Dl18Tl4D|16.4D2.lT2BT5MT4Q4Tl2.4D|16.4B2.l18Tl.2u3B|16.4B2.l3T6mT4V4Tl2.zu2B|16.4B2.l18Tl2.4B|16.4B2.lT2BT5MT4Q4Tl2.4B|16.4B2.20l2.4B|16.4B20L3uL4B|16.3B26l3B",
    frames: [
      "||||||||||||||||||||||||||||||10_6.B30_7H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB8_2B_5M_4Q10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D4_6m_4V5_5B|16_6S4_6T_4T5_5D.|18_u5_2B_5M_4Q|20_u3_2T_5T_4T|16_u_u7_6m_4V6_.B|26_6T_4T7_2B|24_2B_5M_4Q|24_2T_5T_4T||21_3u16_3L",
      "||||||||||||||||||||||||||||||||||||||||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V",
      "|||||||||||||||||||48_.||47_._.|46_BQ2_.||47_q_Q|46_3Q_n|47_3n||||||||||||||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V",
      "|||||||||||||||||||48_.||47_._.|46_BQ2_.||47_q_Q|46_3Q_n|47_3n||||10_6.B30_7H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB10_6m_4V10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D2_2B_5M_4Q5_5B|16_6S4_6T_4T5_5D.|18_u7_6m_4V|20_u3_2T_5T_4T|16_u_u5_2B_5M_4Q6_.B|26_6T_4T7_2B|26_6m_4V|24_2T_5T_4T||21_3u16_3L",
      "|||||||||||||||||||48_.|48_.|47_._.|46_BD_2.|46_BQ2_.|47_q_Q|46_Qq2Qn|46_3Q2n|47_3n|||10_6.B30_7H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB10_6m_4V10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D2_2B_5M_4Q5_5B|16_6S4_6T_4T5_5D.|18_u7_6m_4V|20_u3_2T_5T_4T|16_u_u5_2B_5M_4Q6_.B|26_6T_4T7_2B|26_6m_4V|24_2T_5T_4T||21_3u16_3L",
      "|||||||||||||||||||48_.|48_.|47_._.|46_BD_2.|46_BQ2_.|47_q_Q|46_Qq2Qn|46_3Q2n|47_3n",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD_2.|46_BD_2.|46_B2_Q.|46_Qq2Qn|46_Qq2Qn|46_3Q2n|47_3n||10_6.B30_7H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB8_2B_5M_4Q10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D4_6m_4V5_5B|16_6S4_6T_4T5_5D.|18_u5_2B_5M_4Q|20_u3_2T_5T_4T|16_u_u7_6m_4V6_.B|26_6T_4T7_2B|24_2B_5M_4Q|24_2T_5T_4T||21_3u16_3L",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD_2.|46_BD_2.|46_B2_Q.|46_Qq2Qn|46_Qq2Qn|46_3Q2n|47_3n||||||||||||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD_2.|46_BD_2.|47_3Q|46_Qq2Qn|46_Qq2Qn|46_3Q2n|47_3n|||||||||||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD_2.|46_BD_2.|47_3Q|46_Qq2Qn|46_Qq2Qn|46_3Q2n|47_3n|10_6.B30_7H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB10_6m_4V10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D2_2B_5M_4Q5_5B|16_6S4_6T_4T5_5D.|18_u7_6m_4V|20_u3_2T_5T_4T|16_u_u5_2B_5M_4Q6_.B|26_6T_4T7_2B|26_6m_4V|24_2T_5T_4T||21_3u16_3L",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD_2.|46_BD_2.|47_DQ.|47_3Q|46_Qq2Qn|46_Qq2Qn|46_3Q2n|10_6.B30_3n4H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB10_6m_4V10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D2_2B_5M_4Q5_5B|16_6S4_6T_4T5_5D.|18_u7_6m_4V|20_u3_2T_5T_4T|16_u_u5_2B_5M_4Q6_.B|26_6T_4T7_2B|26_6m_4V|24_2T_5T_4T||21_3u16_3L",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD_2.|46_BD_2.|47_DQ.|47_3Q|46_Qq2Qn|46_Qq2Qn|46_3Q2n|47_3n",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD3.|46_BD3.|47_D2.|||47_Q|47_n|10_6.B30_7H|9_7._2B26_2HBQ5BH|9_.6H3_B24_H2_QqQ4BD|9_HB5_H3_B22_H3_Q2n3_D.|9_D3B4_H3_B20_H3_B_n2_2D2.|10_D4B3_H2_2B18_SD2_B3_2D3.|11_D7BH3B18_2S6D4.|12_D7BHB20_6S4.|6_5.2_D2B5_H20_B4_D3.2_5G|14_DB8_2B_5M_4Q10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D4_6m_4V5_5B|16_6S4_6T_4T5_5D.|18_u5_2B_5M_4Q|20_u3_2T_5T_4T|16_u_u7_6m_4V6_.B|26_6T_4T7_2B|24_2B_5M_4Q|24_2T_5T_4T||21_3u16_3L",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD3.|46_BD3.|47_D2.|||47_Q|47_n||48_Q|47_QqQ|47_Q2n|48_n||||||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD3.|46_BD3.|47_D2.|||47_Q|47_n||||||48_Q|47_QqQ|47_Q2n|48_n||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V||24_2BT5M_4Q||24_2T6m_4V",
      "|||||||||||||||||||48_.|48_.|47_3.|46_BD3.|46_BD3.|46_BD3.|47_D2.|||47_Q|47_n|10_6.B30_7H|9_7._2B26_2H7BH|9_.6H3_B24_H2_7BD|9_HB5_H3_B22_H3_B5_D.|9_D3B4_H3_B20_H3_B4_2D2.|10_D4B3_H2_2B18_SD2_B2_Q2D3.|11_D7BH3B18_2S4DQqQ3.|12_D7BHB20_5SQ2n2.|6_5.2_D2B5_H20_B4_Dn2.2_5G|14_DB10_6m_4V10_D2.|7_6.2_D8_2T_5T_4T10_D.2_6G|16_6D2_2B_5M_4Q5_5B|16_6S4_6T_4T5_5D.|18_u7_6m_4V|20_u3_2T_5T_4T|16_u_u5_2B_5M_4Q6_.B|26_6T_4T7_2B|26_6m_4V|24_2T_5T_4T||21_3u16_3L",
    ],
  },
  {
    tag: 'max', name: "Godmode · Aura", stroke: 30,
    seq: [[1, 60], [2, 45], [3, 30], [4, 30], [5, 30], [6, 30], [7, 30], [8, 30], [9, 30], [10, 30], [11, 30], [12, 30], [13, 30], [14, 30], [15, 30], [16, 30], [17, 30], [18, 30], [19, 30], [20, 30], [21, 30], [22, 30], [23, 30], [24, 30], [25, 45], [26, 60], [0, 60]],
    rest: "|||||||||||49.a|||||||16.32a6.p|15.2a30.2a|14.2a2.28H2.2a|14.a2.H28BD2.a|14.a.H30BD.a|14.a.H30BD.a|5.a8.a.31BD.a|14.a.31BD.a|14.a.31BD.a|14.a.31BD.a|14.a.4B4I16B4I3BD.a|14.a.4B4I16B4I3BD.a|8.7a.4B4p16B4p3BD.7a|7.2a7.31BD7.2a|7.c2.6H31BD6H2.c|7.c.H6BH30BH6BH.c|7.c.D7BH28BH7BD.c|10.D7BH26BH7BD|11.D7BH5B14g5BH7BD|12.D7BH2B18g2BH7BD|13.D7BHB18lBH7BD|14.D7Bl18Tl7BD|15.D6BlT3BT6MT3m3Tl6BD|16.6Dl18Tl6D|16.6Sl3T4QT7M3Tl6S|18.4Dl18Tl4D|16.4D2.l3T2BT7V5Tl2.4D|16.4B2.l18Tl2.4B|16.4B2.lT5mT4MTB5Tl2.4B|16.4B2.l18Tl2.4B|16.4B2.l18Tl2.4B|16.4B2.20l2.4B|16.4B24L4B|16.3B26l3B",
    frames: [
      "|||||||||||49_.|||||||54_.|||||||||||50_6a|49_6._a|48_6H_.|47_H6BH|46_HB6_D|45_HB6_D.|44_HB6_D.|43_HB6_D.|42_HB6_D.|41_HB6_D.|24_3B_6M_3m10_D.|24_3T_6T_3T10_.|26_4Q_7M|26_4T_7T|26_2B_7V|26_2T_7T|24_5m_4M|24_5T_4T_T|24_3B_6M_3m",
      "|||||||||||49_.||||||||||||5_a|5_.|||||8_6a|7_a_6.|8_._6H|9_H6BH|9_D6_BH|9_.D6_BH|10_.D6_BH|11_.D6_BH|12_.D6_BH|13_.D6_BH|14_.D|15_.8_2T4QT3_4M||26_2BT7V2T||24_5mT4M2T||24_3BT2M5_3m||14_p11_4Q_7M11_p|14_p34_p|14_p34_p",
      "|||||||||||49_.||||||||||||5_a|5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|24_2T_BT7V2T9_De|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m|14_p34_p|14_p9_2T4QT3_4M11_p|14_p34_p|14_p11_2B_7V13_p",
      "|||||||||||||||||54_p|54_.|||||5_c|5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_5mT5_3T|16_6B|13_2p_.5D2_3BT3M3_T3m11_2p|14_p34_p|14_p11_4QT7M11_p|14_p34_p|24_2T2BT7V||24_5m_4M",
      "|||||||||||||||||54_p|54_.||||5_c||5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|10_2p35_D2e2_2p|11_2p34_De2_2p|12_2p28_5B3_2p|13_2p27_5D._2p||||35_T||24_3B_6M_3m",
      "||||||||||49_a|49_.||||||54_c|54_.||||5_c||5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|7_2p2_4e6D2S32_2p|8_2p2_4e6S32_2p|9_2p2_3e5_B31_2p|10_2p2_2e36_2p|15_e8_2T4QT3_4M|16_6B|16_.5D4_2BT7V2T||24_5mT4M2T||24_3BT2M5_3m||26_4Q_7M",
      "||||||||||49_a|49_.|||||54_c||54_.||||||5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|7_p35_H3_B5_De_p|7_p34_H3_B4_2D2e_p|7_p33_SD2_B3_2D3e2_p|7_2p32_2S6D4e2_2p|42_6S4e|42_B4_D3e|47_D2e|24_2T_BT7V2T9_De|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m||24_2T4QT3_4M||26_2B_7V",
      "||||||||||49_c|49_.|||||54_c||54_.||||||5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_p2.7H31_6e2.p|7_p.H6B_2H29_7e.p|7_p_D6B3_H34_e_p|7_p_eD5_B3_H35_p|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_5mT5_3T|16_6B|16_.5D2_3BT3M3_T3m||26_4QT7M||24_2T2BT7V||24_5m_4M",
      "|||||||||49_c||49_.|||||||54_.||||||5_.|||14_p34_p|8_7p34_7p|7_2p5_.34_.5_2p|7_p2.6e31_7H2.p|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|47_De|42_5B|42_5D.||||35_T||24_3B_6M_3m",
      "|||||||||49_c||49_.|||||||54_.||||||5_.8_p34_p|14_p34_p|14_p34_p|14_p34_p|8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_2T4QT3_4M|16_6B|16_.5D4_2BT7V2T||24_5mT4M2T||24_3BT2M5_3m||26_4Q_7M",
      "|||||||||||49_.|||||||54_.|||14_p34_p|14_p34_p|14_p34_p|5_.8_p34_p||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|24_2T_BT7V2T9_De|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m||24_2T4QT3_4M||26_2B_7V",
      "|||||||||||49_.|||||||16_32p6_.|15_2p30_2p|14_2p32_2p|14_p34_p|||5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_5mT5_3T|16_6B|16_.5D2_3BT3M3_T3m||26_4QT7M||24_2T2BT7V||24_5m_4M",
      "|||||||||||49_.|||||||16_32p6_.|15_2p30_2p|14_2p32_2p|14_p34_p|14_p34_p|14_p34_p|5_.8_p34_p|14_p34_p|14_p34_p|14_p34_p|8_7p34_7p|7_2p5_.34_.5_2p|7_p2.6e31_7H2.p|7_p.7e29_2H7BH.p|7_p_e34_H2_7BD_p|7_p35_H3_B5_De_p|7_p34_H3_B4_2D2e_p|7_p33_SD2_B3_2D3e2_p|7_2p32_2S6D4e2_2p|8_2p32_6S4e2_2p|9_2p31_B4_D3e2_2p|47_D2e|47_De|42_5B|42_5D.||||35_T||24_3B_6M_3m",
      "|||||||||||49_.|||||||16_32p6_.|15_2p30_2p|14_2p32_2p|14_p34_p|14_p34_p|14_p34_p|5_.8_p34_p|14_p34_p|14_p34_p|14_p34_p|8_7p34_7p|7_2p5_.34_.5_2p|7_p2.7H31_6e2.p|7_p.H6B_2H29_7e.p|7_p_D6B3_H34_e_p|7_p_eD5_B3_H35_p|7_p_2e2D4_B3_H34_p|7_p2_3e2D3_B2_DS33_p|7_2p2_4e6D2S32_2p|8_2p2_4e6S32_2p|9_2p2_3e5_B31_2p|14_2e|15_e8_2T4QT3_4M|16_6B|16_.5D4_2BT7V2T||24_5mT4M2T||24_3BT2M5_3m||26_4Q_7M",
      "|||||||||||49_.|||||||54_.||||||5_.||||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|24_2T_BT7V2T9_De|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m||24_2T4QT3_4M||26_2B_7V",
      "|||||||||||49_.|||||||54_.||||||5_.||||5_c2_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_5mT5_3T|16_6B|16_.5D2_3BT3M3_T3m||26_4QT7M||24_2T2BT7V||24_5m_4M",
      "|||||||||||49_.|||||||54_.||||||5_.|||5_c|8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|47_De|42_5B|42_5D.||||35_T||24_3B_6M_3m",
      "|||||||||||49_.|||||||54_.|||54_c|||5_.|||5_a|8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_2T4QT3_4M|16_6B|16_.5D4_2BT7V2T||24_5mT4M2T||24_3BT2M5_3m||26_4Q_7M",
      "|||||||||||49_.|||||||54_.|||54_c|||5_.|||5_a|8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|24_2T_BT7V2T9_De|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m||24_2T4QT3_4M||26_2B_7V",
      "|||||||||||49_.||49_c|||||54_.||54_p||||5_.||5_a||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_5mT5_3T|16_6B|16_.5D2_3BT3M3_T3m||26_4QT7M||24_2T2BT7V||24_5m_4M",
      "|||||||||||49_.||49_c|||||54_.||54_p||||5_.||5_a||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|47_De|42_5B|42_5D.||||35_T||24_3B_6M_3m",
      "|||||||||||49_.||49_a|||||54_.||54_p||||5_.||5_a||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_2T4QT3_4M|16_6B|16_.5D4_2BT7V2T||24_5mT4M2T||24_3BT2M5_3m||26_4Q_7M",
      "|||||||||||49_.|49_a||||||54_.|54_p|||||5_.|5_a|||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.6e31_7H2.a|8_.7e29_2H7BH.|9_e34_H2_7BD|43_H3_B5_De|42_H3_B4_2D2e|41_SD2_B3_2D3e|41_2S6D4e|42_6S4e|42_B4_D3e|47_D2e|24_2T_BT7V2T9_De|42_5B|24_5mTM3_4T4_5D.||24_2B_T6MT3m||24_2T4QT3_4M||26_2B_7V",
      "|||||||||||49_.|49_a||||||54_.|54_p|||||5_.|5_a|||8_6a36_6a|7_2a5_.34_.5_2a|7_a2.7H31_6e2.a|8_.H6B_2H29_7e.|9_D6B3_H34_e|9_eD5_B3_H|9_2e2D4_B3_H|10_3e2D3_B2_DS|11_4e6D2S|12_4e6S|13_3e5_B|14_2e|15_e8_5mT5_3T|16_6B|16_.5D2_3BT3M3_T3m||26_4QT7M||24_2T2BT7V||24_5m_4M",
      "|||||||||||49_.|49_a||||||54_.|54_p|||||5_.|5_a||||50_6a|49_6._a|48_6H_.|47_H6BH|46_HB6_D|45_HB6_D.|44_HB6_D.|43_HB6_D.|42_HB6_D.|41_HB6_D.|24_5m_4M14_D.|24_3T_6T_3T10_.|24_3B_6M_3m|26_4T_7T|26_4Q_7M|26_2T_7T|26_2B_7V|24_5T_4T_T|24_5m_4M",
      "|||||||||||||||||||||||||||||8_6a|7_a_6.|8_._6H|9_H6BH|9_D6_BH|9_.D6_BH|10_.D6_BH|11_.D6_BH|12_.D6_BH|13_.D6_BH|14_.D|15_.||||||35_T||24_3B_6M_3m",
    ],
  },
]
// </generated>
