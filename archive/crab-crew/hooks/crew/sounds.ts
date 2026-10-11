/**
 * Crew sounds (pure: no `$`, no I/O): which clip plays when (decision 6).
 * register.tsx plays them with `$.audio.play({ asset: SOUND_ASSETS[kind] })`,
 * each behind its own switch. chime.wav and tap.wav are made by
 * tools/make_sounds.py (click.wav is hand-made). The generated costume's prompt
 * and parser live in ./costumes.ts.
 */

export const SOUND_KINDS = ['click', 'chime', 'tap'] as const
export type SoundKind = (typeof SOUND_KINDS)[number]

/** Plugin-relative asset path of each clip, for `$.audio.play({ asset })`. */
export const SOUND_ASSETS: Readonly<Record<SoundKind, string>> = {
  click: 'assets/click.wav',
  chime: 'assets/chime.wav',
  tap: 'assets/tap.wav',
}

export function isSoundKind(v: unknown): v is SoundKind {
  return typeof v === 'string' && (SOUND_KINDS as readonly string[]).includes(v)
}

/** A turn or subagent at least this long earns the chime when it finishes. */
export const CHIME_MIN_MS = 120_000

/** True when a finished turn/subagent took long enough (>= 2 min) to chime. */
export function shouldChime(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= CHIME_MIN_MS
}

/** Notification types that mean "the app is waiting on the user". */
const APPROVAL_TYPE = /permission|idle|elicitation|approv/i
/** Fallback on the message when a Notification carries no usable type. */
const APPROVAL_TEXT = /needs your (permission|approval)|waiting for your (input|approval)|requires? (your )?approval/i

/**
 * Whether a classic hook payload means the app needs the user's approval, so
 * the gentle tap should play:
 * - `classic.PermissionRequest` (any tool) -> true;
 * - `classic.Notification` whose `notification_type` names a permission,
 *   idle or elicitation prompt (`permission_prompt`, `idle_prompt`, ...);
 *   when the type is empty, the message is checked instead;
 * - anything else (auth_success, other events, junk) -> false.
 */
export function isApprovalNotification(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const o = input as Record<string, unknown>
  const ev = o.hook_event_name
  if (ev === 'PermissionRequest') return true
  if (ev !== 'Notification') return false
  const type = typeof o.notification_type === 'string' ? o.notification_type.trim() : ''
  if (type) return APPROVAL_TYPE.test(type)
  const msg = `${typeof o.title === 'string' ? o.title : ''} ${typeof o.message === 'string' ? o.message : ''}`
  return APPROVAL_TEXT.test(msg)
}

/** Two approval signals closer than this are one tap (a PermissionRequest and its permission_prompt Notification). */
export const TAP_DEBOUNCE_MS = 1500

/**
 * Whether a tap may play now: none played yet, or the last one is at least
 * `windowMs` old. Clips are not queued, so the two events one permission prompt
 * raises would otherwise play over each other.
 */
export function shouldTap(lastTapAt: number | null | undefined, now: number, windowMs = TAP_DEBOUNCE_MS): boolean {
  if (lastTapAt === null || lastTapAt === undefined || !Number.isFinite(lastTapAt)) return true
  return now - lastTapAt >= windowMs || now < lastTapAt
}
