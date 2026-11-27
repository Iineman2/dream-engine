// The "learning engine" for V0. Two small, inspectable adaptive mechanisms:
//  1. An onset staircase that tunes when the first cue fires, from how you
//     rated round 1 (still awake -> later, deeply asleep -> earlier).
//  2. A Thompson-sampling bandit over the three Dormio timing profiles,
//     rewarded when a later round catches you in hypnagogia ("drifting").
// Both are derived from session data on every call; there is no hidden state.

import { beta } from './rng.js';
import { conditionInfo } from './study.js';

export const ARMS = [
  { id: 'short', hypnaMin: 1, betweenMin: 3, label: '1 min in hypnagogia, 3 min to fall back asleep' },
  { id: 'mid', hypnaMin: 2, betweenMin: 5, label: '2 min in hypnagogia, 5 min to fall back asleep' },
  { id: 'long', hypnaMin: 3, betweenMin: 7, label: '3 min in hypnagogia, 7 min to fall back asleep' },
];

export const ONSET = { defaultMin: 10, step: 2, floor: 4, ceil: 25, halfWidth: 2.5 };

export const STATES = [
  { value: 'awake', label: 'Still awake', desc: 'Not drifting yet' },
  // Label matches the spoken question ("Awake, halfway, or asleep?"); the stored value stays 'drifting'.
  { value: 'drifting', label: 'Halfway (drifting)', desc: 'Images, half-dreams, hypnagogia' },
  { value: 'asleep', label: 'Asleep', desc: 'Hard to wake, little memory' },
  { value: 'unsure', label: 'Not sure', desc: '' },
];

export function isAnalyzable(s) {
  return s.status === 'complete' && !s.rehearsal && s.params?.speed === 1;
}

const byStart = (a, b) => String(a.startedAt).localeCompare(String(b.startedAt));

// Only incubation naps teach the timing engine. Phase 2 stay-awake sessions
// would push the onset estimate later, and plain naps have no cue timing.
export function teachesTiming(s) {
  const info = conditionInfo(s.condition);
  return isAnalyzable(s) && info.state === 'sleep' && !info.plain;
}

export function armStats(sessions) {
  const stats = Object.fromEntries(ARMS.map((a) => [a.id, { id: a.id, successes: 0, failures: 0 }]));
  for (const s of sessions) {
    if (!teachesTiming(s) || !stats[s.params.armId]) continue;
    for (const r of s.rounds || []) {
      if (r.round < 2) continue; // round 1 is governed by the onset staircase
      if (r.state === 'drifting') stats[s.params.armId].successes++;
      else if (r.state === 'awake' || r.state === 'asleep') stats[s.params.armId].failures++;
    }
  }
  for (const st of Object.values(stats)) {
    st.alpha = 1 + st.successes;
    st.beta = 1 + st.failures;
    st.n = st.successes + st.failures;
    st.mean = st.alpha / (st.alpha + st.beta);
  }
  return stats;
}

export function chooseArm(stats, rng) {
  let best = null, bestDraw = -1;
  for (const a of ARMS) {
    const st = stats[a.id];
    const draw = beta(rng, st.alpha, st.beta);
    if (draw > bestDraw) { bestDraw = draw; best = a; }
  }
  return best;
}

export function onsetEstimate(sessions) {
  let est = ONSET.defaultMin;
  const history = [];
  for (const s of sessions.filter(teachesTiming).sort(byStart)) {
    const r1 = (s.rounds || []).find((r) => r.round === 1);
    if (!r1) continue;
    const before = est;
    if (r1.state === 'awake') est += ONSET.step;
    else if (r1.state === 'asleep') est -= ONSET.step;
    est = Math.min(ONSET.ceil, Math.max(ONSET.floor, est));
    if (r1.state === 'awake' || r1.state === 'asleep' || r1.state === 'drifting') history.push({ sessionId: s.id, state: r1.state, before, after: est });
  }
  return { estimate: est, history };
}

export function onsetWindow(estimate) {
  return {
    minMin: Math.max(3, estimate - ONSET.halfWidth),
    maxMin: Math.min(ONSET.ceil + ONSET.halfWidth, estimate + ONSET.halfWidth),
  };
}
