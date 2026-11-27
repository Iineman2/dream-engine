// Phase 2: does engineered dreaming help, beyond normal sleep?
//
// Every session, whatever its condition, has the same tasks:
//  - Before: learn two word-pair sets, one bound to each theme. That theme's
//    cue is played as its set begins, so the cue becomes a reminder of the set
//    (the conditioning step of targeted memory reactivation; Konkoly et al. 2025
//    paired each pre-sleep task with its own sound in the same way).
//  - After: retest both sets, then a themed Alternative Uses Task for each theme
//    (Horowitz et al. 2023 used a "tree" AUT after a "tree" incubation nap).
//
// Because both themes are measured after the same session, cued minus uncued
// holds the sleep, the wake-ups, the voice and the timing constant. Only what
// the cue, and so the dream, was aimed at differs. Comparing that difference
// asleep (SA/SB) with awake (WA/WB) asks whether the dreaming carries the
// effect, not just hearing the cue. Comparing the cued theme after an
// incubation nap with a plain nap asks whether it beats normal sleep.

import { mulberry32, shuffle } from './rng.js';
import { stem } from './text.js';
import { WORDS } from './memory.js';
import { conditionInfo } from './study.js';
import { blindCode, toCSV, parseCSV } from './scoring.js';
import { mean, permutationTest, signFlipTest, holm, spearman } from './stats.js';
import { isAnalyzable } from './adaptive.js';

export const THEMES = ['A', 'B'];
export const other = (th) => (th === 'A' ? 'B' : 'A');
export const AUT_SEC = 180; // Horowitz et al. 2023 gave 3 minutes
export const PAIRS_PER_THEME = 10;
export const READY = { sleep: 8, wake: 8, plain: 4 };

export const AUT_SCALE = [
  { score: 1, label: 'Obvious', desc: 'Common, expected uses only.' },
  { score: 2, label: 'Somewhat', desc: 'Mostly common uses, one or two less obvious ones.' },
  { score: 3, label: 'Creative', desc: 'Several unusual uses.' },
  { score: 4, label: 'Very', desc: 'Mostly unusual, clever or surprising uses.' },
  { score: 5, label: 'Exceptional', desc: 'Highly original uses that change how you see the object.' },
];

export const OUTCOMES = {
  creativity: { label: 'Creativity', unit: 'points on the 1–5 blind rating', desc: 'blind 1–5 rating of the themed Alternative Uses Task', fmt: (x) => x.toFixed(2) },
  memory: { label: 'Memory', unit: 'percentage points of retention', desc: 'retention of the theme’s word pairs (after minus before)', fmt: (x) => `${Math.round(x * 100)} pts` },
  fluency: { label: 'Fluency', unit: 'uses listed', desc: 'number of uses listed in the Alternative Uses Task (objective)', fmt: (x) => x.toFixed(1) },
};

// ---------- word-pair sets ----------
export function makeThemedSets(seed, nPerSet = PAIRS_PER_THEME, excludeStems = []) {
  const ex = new Set(excludeStems);
  const rng = mulberry32(seed);
  const pool = shuffle(WORDS.filter((w) => !ex.has(stem(w))), rng);
  if (pool.length < 4 * nPerSet) throw new Error('Not enough words for that many pairs.');
  const mk = (off) => Array.from({ length: nPerSet }, (_, i) => ({ cue: pool[off + 2 * i], answer: pool[off + 2 * i + 1] }));
  return { A: mk(0), B: mk(2 * nPerSet), order: rng() < 0.5 ? ['A', 'B'] : ['B', 'A'] };
}

// Lures come from the same theme's answers, so remembering which theme a word
// belonged to doesn't give the answer away.
export function makeThemedTest(sets, seed) {
  const rng = mulberry32(seed);
  const items = [];
  for (const th of THEMES) {
    const answers = sets[th].map((p) => p.answer);
    for (const p of sets[th]) {
      const lures = shuffle(answers.filter((a) => a !== p.answer), rng).slice(0, 3);
      items.push({ theme: th, cue: p.cue, answer: p.answer, options: shuffle([p.answer, ...lures], rng) });
    }
  }
  return shuffle(items, rng);
}

export function scoreThemed(responses) {
  const out = {};
  for (const th of THEMES) {
    const rs = responses.filter((r) => r.theme === th);
    out[th] = { correct: rs.filter((r) => r.correct).length, n: rs.length };
  }
  return out;
}

export function themedRetention(mem) {
  if (!mem?.immediate || !mem.delayed) return null;
  const out = {};
  for (const th of THEMES) {
    const i = mem.immediate.byTheme[th], d = mem.delayed.byTheme[th];
    out[th] = i?.n && d?.n ? d.correct / d.n - i.correct / i.n : null;
  }
  return out.A === null || out.B === null ? null : out;
}

// ---------- Alternative Uses Task ----------
export function autObject(study, index, theme) {
  const list = study.objects[theme];
  return list[Math.max(0, index) % list.length];
}

export function fluency(text) {
  const seen = new Set();
  for (const raw of String(text || '').split(/[\n;]+/)) {
    const x = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim().toLowerCase();
    if (x.length >= 2) seen.add(x);
  }
  return seen.size;
}

export function autOrder(seed) {
  return mulberry32((seed ^ 0x5bd1e995) >>> 0)() < 0.5 ? ['A', 'B'] : ['B', 'A'];
}

// What still has to happen after the report: the retest, then both AUTs.
export function nextPostTask(s) {
  if (!s?.themed || s.status !== 'complete' || !s.morning) return null;
  if (!s.themed.delayed) return { kind: 'delayed' };
  for (const th of s.themed.autOrder || THEMES) if (!s.aut?.[th]) return { kind: 'aut', theme: th };
  return null;
}

// ---------- blind creativity rating ----------
export function creativityItems(sessions, studies) {
  const list = [].concat(studies || []).filter((x) => x?.kind === 'benefit');
  const out = [];
  for (const s of sessions) {
    const study = list.find((x) => x.id === s.studyId);
    if (!study || !isAnalyzable(s) || !s.aut) continue;
    for (const th of THEMES) {
      const a = s.aut[th];
      if (a) out.push({ s, theme: th, study, code: blindCode(`${s.id}:${th}`, study.seed), object: a.object, text: a.text || '' });
    }
  }
  return out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export const creativityQueue = (sessions, studies) => creativityItems(sessions, studies).filter((x) => !Number.isInteger(x.s.autBlind?.[x.theme]));

export function creativityPacketCSV(sessions, studies) {
  const rows = [['code', 'object', 'uses', 'rating_1_to_5']];
  for (const x of creativityItems(sessions, studies)) rows.push([x.code, x.object, x.text, '']);
  return toCSV(rows);
}

export function parseCreativityCSV(text, sessions, studies) {
  const rows = parseCSV(text);
  const errors = [];
  const updates = [];
  if (!rows.length) return { updates, errors: ['The file is empty.'] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const ci = head.indexOf('code'), ri = head.indexOf('rating_1_to_5');
  if (ci < 0 || ri < 0) return { updates, errors: ['Expected columns: code, rating_1_to_5.'] };
  const byCode = new Map(creativityItems(sessions, studies).map((x) => [x.code, x]));
  rows.slice(1).forEach((r, k) => {
    const code = (r[ci] || '').trim().toUpperCase();
    const raw = (r[ri] || '').trim();
    if (!code || raw === '') return;
    const x = byCode.get(code);
    const v = Number(raw);
    if (!x) { errors.push(`Row ${k + 2}: unknown code ${code}.`); return; }
    if (!Number.isInteger(v) || v < 1 || v > 5) { errors.push(`Row ${k + 2}: rating must be a whole number 1–5.`); return; }
    updates.push({ sessionId: x.s.id, theme: x.theme, rating: v });
  });
  return { updates, errors };
}

// ---------- analysis ----------
export function outcomeValues(s, outcome) {
  if (outcome === 'memory') return themedRetention(s.themed);
  if (outcome === 'creativity') {
    const b = s.autBlind || {};
    return Number.isInteger(b.A) && Number.isInteger(b.B) ? { A: b.A, B: b.B } : null;
  }
  if (outcome === 'fluency') return s.aut?.A && s.aut?.B ? { A: fluency(s.aut.A.text), B: fluency(s.aut.B.text) } : null;
  return null;
}

function contrasts(rows, outcome) {
  const sleepD = [], wakeD = [], cuedSleep = [], uncuedSleep = [], plainLevel = [];
  for (const { s, info } of rows) {
    const o = outcomeValues(s, outcome);
    if (!o) continue;
    if (info.plain) { plainLevel.push((o.A + o.B) / 2); continue; }
    if (!info.cued) continue;
    const d = o[info.cued] - o[other(info.cued)];
    if (info.state === 'sleep') { sleepD.push(d); cuedSleep.push(o[info.cued]); uncuedSleep.push(o[other(info.cued)]); }
    else wakeD.push(d);
  }
  const beyond = permutationTest(cuedSleep, plainLevel);
  const dreaming = permutationTest(sleepD, wakeD);
  const cuedVsUncued = signFlipTest(sleepD);
  return {
    n: { sleep: sleepD.length, wake: wakeD.length, plain: plainLevel.length },
    beyond: { effect: beyond.stat, p: beyond.p, method: beyond.method, cued: mean(cuedSleep), plain: mean(plainLevel) },
    dreaming: { effect: dreaming.stat, p: dreaming.p, method: dreaming.method, sleep: mean(sleepD), wake: mean(wakeD) },
    cuedVsUncued: { effect: cuedVsUncued.stat, p: cuedVsUncued.p, method: cuedVsUncued.method },
    cost: { effect: mean(uncuedSleep) - mean(plainLevel) },
  };
}

export function analyzeBenefit(study, sessions, targets) {
  const A = targets.find((t) => t.id === study.targetIds.A);
  const B = targets.find((t) => t.id === study.targetIds.B);
  const mine = sessions.filter((s) => s.studyId === study.id && !s.rehearsal && s.params?.speed === 1);
  const done = mine.filter(isAnalyzable);
  const rows = done.map((s) => ({ s, info: conditionInfo(s.condition) }));
  const counts = Object.fromEntries(['SA', 'SB', 'WA', 'WB', 'plain'].map((c) => [c, done.filter((s) => s.condition === c).length]));

  const outcomes = {};
  for (const k of Object.keys(OUTCOMES)) outcomes[k] = contrasts(rows, k);
  // The two pre-registered questions on the primary outcome, Holm-corrected.
  const prim = outcomes[study.primary];
  const [hBeyond, hDreaming] = holm([prim.beyond.p, prim.dreaming.p]);
  prim.beyond.pHolm = hBeyond;
  prim.dreaming.pHolm = hDreaming;

  // Manipulation checks: did the cue reach the dream, and did you stay awake
  // in the stay-awake sessions?
  const incorp = { sleep: [], wake: [] };
  const mediation = { incorp: [], d: [] };
  for (const { s, info } of rows) {
    if (!info.cued || !s.blind) continue;
    const di = s.blind[info.cued] - s.blind[other(info.cued)];
    incorp[info.state].push(di);
    if (info.state === 'sleep') {
      const o = outcomeValues(s, study.primary);
      if (o) { mediation.incorp.push(di); mediation.d.push(o[info.cued] - o[other(info.cued)]); }
    }
  }
  const dreamShare = {};
  for (const c of Object.keys(counts)) {
    const rs = done.filter((s) => s.condition === c).flatMap((s) => s.rounds || []).filter((r) => r.state);
    dreamShare[c] = { k: rs.filter((r) => r.state === 'drifting' || r.state === 'asleep').length, n: rs.length };
  }
  const med = spearman(mediation.incorp, mediation.d);
  const n = prim.n;
  return {
    labels: { A: A?.label ?? 'A', B: B?.label ?? 'B' },
    primary: study.primary,
    counts,
    aborted: mine.filter((s) => s.status === 'aborted').length,
    outcomes,
    incorporation: { sleep: mean(incorp.sleep), wake: mean(incorp.wake), nSleep: incorp.sleep.length, nWake: incorp.wake.length },
    dreamShare,
    mediation: { rho: med.rho, n: med.n },
    ready: n.sleep >= READY.sleep && n.wake >= READY.wake && n.plain >= READY.plain,
  };
}
