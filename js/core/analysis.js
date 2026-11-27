// Pre-registered analysis for an A / B / control incubation study.
//
// Primary outcome: blind 0–3 incorporation scores for both targets on every
// report. For each A- or B-cued session, d = score(A) - score(B).
// H1: d is higher after A cues than after B cues (one-sided permutation test).
// Secondary: cued-beats-uncued sign test, per-condition incorporation rates,
// and the same analysis run on the lexical scorer as a bias cross-check.

import { isAnalyzable } from './adaptive.js';
import { wilson, permutationTest, binomTailHalf, mean } from './stats.js';
import { lexicalScore, scoringText, isScoreable } from './scoring.js';

export const READY_PER_ARM = 8;

export function scoresFor(session, source, A, B) {
  if (source === 'blind') return session.blind ? { A: session.blind.A, B: session.blind.B, emoA: session.blind.emoA ?? null, emoB: session.blind.emoB ?? null } : null;
  const text = scoringText(session);
  if (!text) return null;
  return { A: lexicalScore(text, A.lexicon).score, B: lexicalScore(text, B.lexicon).score };
}

export function analyzeStudy(study, sessions, targets, { source = 'blind' } = {}) {
  const A = targets.find((t) => t.id === study.targetIds.A);
  const B = targets.find((t) => t.id === study.targetIds.B);
  if (!A || !B) throw new Error('Study targets are missing.');
  const mine = sessions.filter((s) => s.studyId === study.id && !s.rehearsal && s.params?.speed === 1);
  const done = mine.filter(isAnalyzable);
  const counts = { A: 0, B: 0, control: 0 };
  for (const s of done) counts[s.condition]++;
  const aborted = mine.filter((s) => s.status === 'aborted').length;

  const scored = done.map((s) => ({ s, sc: scoresFor(s, source, A, B) })).filter((x) => x.sc);
  const unscored = done.filter((s) => isScoreable(s) && !scoresFor(s, source, A, B)).length;
  // Naps with no dream report (every wake-up rated "still awake" and nothing
  // else recalled) can't be scored. If one condition has many more of these,
  // the cue may be keeping you awake.
  const noDream = { A: 0, B: 0, control: 0 };
  for (const s of done) if (!isScoreable(s) && noDream[s.condition] !== undefined) noDream[s.condition]++;
  const dreamShare = {};
  for (const c of ['A', 'B', 'control']) {
    const rs = done.filter((s) => s.condition === c).flatMap((s) => s.rounds || []).filter((r) => r.state);
    dreamShare[c] = { k: rs.filter((r) => r.state === 'drifting' || r.state === 'asleep').length, n: rs.length };
  }

  const dA = scored.filter((x) => x.s.condition === 'A').map((x) => x.sc.A - x.sc.B);
  const dB = scored.filter((x) => x.s.condition === 'B').map((x) => x.sc.A - x.sc.B);
  const perm = permutationTest(dA, dB);
  const primary = { nA: dA.length, nB: dB.length, meanDA: mean(dA), meanDB: mean(dB), effect: perm.stat, p: perm.p, method: perm.method };

  let hits = 0, misses = 0, ties = 0;
  for (const { s, sc } of scored) {
    if (s.condition === 'control') continue;
    const other = s.condition === 'A' ? 'B' : 'A';
    if (sc[s.condition] > sc[other]) hits++;
    else if (sc[s.condition] < sc[other]) misses++;
    else ties++;
  }
  const decisive = hits + misses;
  const w = wilson(hits, decisive);
  const specificity = { hits, misses, ties, decisive, rate: w.p, lo: w.lo, hi: w.hi, p: decisive ? binomTailHalf(hits, decisive) : NaN };

  // Emotion scores (blind source only): same primary-style test on emoA - emoB.
  const emoRows = scored.filter((x) => x.s.condition !== 'control' && x.sc.emoA != null && x.sc.emoB != null);
  const eA = emoRows.filter((x) => x.s.condition === 'A').map((x) => x.sc.emoA - x.sc.emoB);
  const eB = emoRows.filter((x) => x.s.condition === 'B').map((x) => x.sc.emoA - x.sc.emoB);
  const ePerm = permutationTest(eA, eB);
  let eh = 0, em = 0, et = 0;
  for (const { s, sc } of emoRows) {
    const mine1 = s.condition === 'A' ? sc.emoA : sc.emoB, other1 = s.condition === 'A' ? sc.emoB : sc.emoA;
    if (mine1 > other1) eh++; else if (mine1 < other1) em++; else et++;
  }
  const eDec = eh + em;
  const ew = wilson(eh, eDec);
  const emotion = {
    n: emoRows.length,
    primary: { nA: eA.length, nB: eB.length, meanDA: mean(eA), meanDB: mean(eB), effect: ePerm.stat, p: ePerm.p, method: ePerm.method },
    specificity: { hits: eh, misses: em, ties: et, decisive: eDec, rate: ew.p, lo: ew.lo, hi: ew.hi, p: eDec ? binomTailHalf(eh, eDec) : NaN },
  };

  // Exploratory link: does the idea come in with the feeling? Cued A/B sessions
  // with both cued scores (idea and emotion of the cued target); landed = score >= 2.
  const link = { n: 0, bothLanded: 0, ideaOnly: 0, emotionOnly: 0, neither: 0, meanIdeaWhenEmotion: NaN, meanIdeaWhenNoEmotion: NaN };
  const ideaWithEmo = [], ideaWithoutEmo = [];
  for (const { s, sc } of scored) {
    if (s.condition === 'control') continue;
    const idea = sc[s.condition], emo = s.condition === 'A' ? sc.emoA : sc.emoB;
    if (idea == null || emo == null) continue;
    link.n++;
    const il = idea >= 2, el = emo >= 2;
    if (il && el) link.bothLanded++; else if (il) link.ideaOnly++; else if (el) link.emotionOnly++; else link.neither++;
    (el ? ideaWithEmo : ideaWithoutEmo).push(idea);
  }
  link.meanIdeaWhenEmotion = mean(ideaWithEmo);
  link.meanIdeaWhenNoEmotion = mean(ideaWithoutEmo);

  const table = {};
  for (const T of ['A', 'B']) {
    table[T] = {};
    for (const c of ['A', 'B', 'control']) {
      const rows = scored.filter((x) => x.s.condition === c);
      const k = rows.filter((x) => x.sc[T] >= 2).length;
      table[T][c] = { k, n: rows.length, ...wilson(k, rows.length) };
    }
  }

  const withMorning = done.filter((s) => s.morning);
  const safety = {
    meanDisruption: mean(withMorning.map((s) => Number(s.morning.disruption) || 0)),
    distressing: withMorning.filter((s) => s.morning.distressing).length,
    lucid: withMorning.filter((s) => Number(s.morning.lucidity) >= 2).length,
    n: withMorning.length,
  };

  return {
    source,
    labels: { A: A.label, B: B.label },
    counts,
    aborted,
    scored: scored.length,
    unscored,
    noDream,
    dreamShare,
    primary,
    specificity,
    emotion,
    link,
    table,
    safety,
    ready: primary.nA >= READY_PER_ARM && primary.nB >= READY_PER_ARM,
  };
}
