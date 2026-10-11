/**
 * The "Crab Crew" settings pane: its id, its sections and their options (pure;
 * register.tsx draws them and owns the setters the pane and `/crab` share).

 *
 * The pet per level is fixed (low Derretido, medium Café, high A teclar,
 * xhigh faster, max Godmode): there is no pose setting; an old stored
 * `petPose` is ignored.
 */
import type { EffortIconKind } from './card/effort-icon'

export const SETTINGS_PANE = 'crab-settings'
export const SETTINGS_TITLE = 'Crab Crew'

export type Option<V extends string> = { value: V; label: string }

export const ICON_OPTIONS: readonly Option<EffortIconKind>[] = [
  { value: 'star', label: 'Estrela' },
  { value: 'pet', label: 'Pet' },
  { value: 'moon', label: 'Lua' },
  { value: 'dumbbell', label: 'Haltere' },
  { value: 'wave', label: 'Onda' },
]
export const ON_OFF_OPTIONS: readonly Option<'on' | 'off'>[] = [
  { value: 'on', label: 'Ligado' },
  { value: 'off', label: 'Desligado' },
]
/** "Cliques no card": Direto = the Client region over the card (default); Botões = a compact native row. */
export const CLICK_OPTIONS: readonly Option<'direct' | 'buttons'>[] = [
  { value: 'direct', label: 'Direto' },
  { value: 'buttons', label: 'Botões' },
]
export const MOTION_OPTIONS: readonly Option<'full' | 'reduced'>[] = [
  { value: 'full', label: 'Completo' },
  { value: 'reduced', label: 'Reduzido' },
]
export const THEME_OPTIONS: readonly Option<'auto' | 'light' | 'dark'>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
]

export const pick = <V extends string>(options: readonly Option<V>[], v: string): V | null => options.find(o => o.value === v)?.value ?? null
