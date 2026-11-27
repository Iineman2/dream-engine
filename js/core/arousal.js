// Per-cue arousal logging and the cue-volume staircase. Pure functions over
// session.events (timestamps ISO) and session.rounds[].cueWoke.
//
// woke = tap within the window OR the participant answered "yes" to "did the
// cue wake you?". Motion is recorded but deliberately not used for `woke`.

import { conditionInfo } from './study.js';

export const AROUSAL_WINDOW_SEC = 60;
export const STEP_DOWN = 0.08;
export const STEP_UP = 0.02;

const ms = (t) => Date.parse(t);
const round4 = (x) => Math.round(x * 1e4) / 1e4;

// One row per in-sleep cue: { sessionId, round, t, volume, tap, motion, answer, woke }.
export function cueArousals(session) {
  const events = session?.events || [];
  const rows = [];
  for (const cue of events) {
    if (cue.type !== 'cue' || cue.phase !== 'hypnagogia') continue;
    const t0 = ms(cue.t);
    const end = t0 + AROUSAL_WINDOW_SEC * 1000;
    let wakeAt = Infinity;
    for (const e of events) if (e.type === 'wake' && ms(e.t) > t0 && ms(e.t) < wakeAt) wakeAt = ms(e.t);
    const inWindow = (type) => events.some((e) => e.type === type && ms(e.t) >= t0 && ms(e.t) <= end && ms(e.t) < wakeAt);
    const tap = inWindow('tap');
    const motion = inWindow('motion');
    const r = (session.rounds || []).find((x) => x.round === cue.round);
    const answer = r?.cueWoke ?? null;
    rows.push({
      sessionId: session.id,
      round: cue.round,
      t: cue.t,
      volume: typeof cue.volume === 'number' ? cue.volume : null,
      tap,
      motion,
      answer,
      woke: tap || answer === 'yes',
      // No tap and no definite "no": we can't tell whether the cue woke you.
      unknown: !(tap || answer === 'yes' || answer === 'no'),
    });
  }
  return rows;
}

// Complete or aborted (a cue that woke you and ended the session counts),
// non-rehearsal, speed-1 in-sleep sessions of incubation conditions only.
const eligible = (s) => {
  if (!s || (s.status !== 'complete' && s.status !== 'aborted') || s.rehearsal || s.params?.speed !== 1) return false;
  const info = conditionInfo(s.condition);
  return info.state === 'sleep' && !info.plain;
};

// The staircase only learns from adaptive-volume sessions under the h2023 script.
const adaptiveSession = (s) => s.params?.audio?.adaptiveVolume === true && s.params?.protocol?.script !== 'v1';

function chronologicalCues(sessions, filter = () => true) {
  const rows = [];
  for (const s of sessions || []) if (eligible(s) && filter(s)) rows.push(...cueArousals(s));
  return rows.map((r, i) => ({ r, i })).sort((a, b) => ms(a.r.t) - ms(b.r.t) || a.i - b.i).map((x) => x.r);
}

export function volumeTable(sessions) {
  const by = new Map();
  for (const c of chronologicalCues(sessions)) {
    if (c.volume == null) continue;
    const v = Math.round(Math.round(c.volume / 0.05) * 0.05 * 100) / 100;
    const row = by.get(v) || { volume: v, cues: 0, woke: 0, unknown: 0, wakeRate: 0, motion: 0 };
    row.cues++;
    if (c.woke) row.woke++;
    if (c.unknown) row.unknown++;
    if (c.motion) row.motion++;
    by.set(v, row);
  }
  // Wake rate is over cues with a known outcome.
  return [...by.values()].sort((a, b) => a.volume - b.volume).map((r) => ({ ...r, wakeRate: r.cues - r.unknown > 0 ? r.woke / (r.cues - r.unknown) : 0 }));
}

// Weighted up-down staircase: woke -> -0.08, not woke -> +0.02, clamped to
// [min, max]. Stationary wake rate = up / (up + down) = 20 %.
export function nextCueVolume(sessions, { start, min = 0.1, max = 1 } = {}) {
  const clamp = (v) => round4(Math.min(max, Math.max(min, v)));
  let volume = clamp(start ?? 0.6);
  const history = [];
  for (const c of chronologicalCues(sessions, adaptiveSession)) {
    if (c.unknown) continue; // outcome unknown: no step
    volume = clamp(volume + (c.woke ? -STEP_DOWN : STEP_UP));
    history.push({ sessionId: c.sessionId, round: c.round, t: c.t, woke: c.woke, volume });
  }
  return { volume, history };
}
