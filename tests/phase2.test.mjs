import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileTarget } from '../js/core/compiler.js';
import { stem } from '../js/core/text.js';
import { createStudy, createBenefitStudy, makeSchedule, conditionInfo, BENEFIT_CONDITIONS, phaseOneDone, parseObjects, extendStudy, cuedTargetId } from '../js/core/study.js';
import { buildPlan, buildPlainPlan, planDurationSec } from '../js/core/protocol.js';
import { makeThemedSets, makeThemedTest, scoreThemed, themedRetention, fluency, nextPostTask, autObject, analyzeBenefit, creativityQueue, creativityPacketCSV, parseCreativityCSV } from '../js/core/benefit.js';
import { dreamText, scoringText, isScoreable, blindQueue, blindPacketCSV, parseScoresCSV, parseCSV, toCSV } from '../js/core/scoring.js';
import { signFlipTest, holm } from '../js/core/stats.js';
import { armStats, onsetEstimate } from '../js/core/adaptive.js';
import { analyzeStudy } from '../js/core/analysis.js';
import { canStartSession, pauseState, CONSENT_ITEMS, CONSENT_VERSION } from '../js/core/safety.js';
import { sessionRows } from '../js/core/trials.js';
import { emptyState } from '../js/core/schema.js';

const T = (id, input) => ({ id, ...compileTarget(input).target });
const forest = T('tA', { label: 'purple forest', environment: 'a purple forest', related: 'violet trees woods' });
const ocean = T('tB', { label: 'ocean of light', environment: 'an ocean of light', related: 'water waves' });
const OBJ = { A: ['tree', 'moss', 'owl'], B: ['wave', 'shell', 'pearl'] };

let n = 0;
function sess(study, condition, extra = {}) {
  n++;
  const t = new Date(Date.UTC(2026, 11, 1, 10) + n * 864e5).toISOString();
  return {
    id: `p${n}`, studyId: study.id, index: n, condition, rehearsal: false, status: 'complete', startedAt: t, endedAt: t,
    params: { speed: 1, armId: 'mid' },
    rounds: [{ round: 1, transcript: 'something', state: 'drifting' }],
    morning: { at: t, report: '', disruption: 1 },
    blind: null,
    ...extra,
  };
}
const phase1 = () => createStudy({ targetAId: 'tA', targetBId: 'tB', blocks: 1, seed: 3 });

// ---------- design ----------
test('condition map: what is cued, asleep or awake, plain nap', () => {
  assert.deepEqual(conditionInfo('SA'), { cued: 'A', state: 'sleep', plain: false });
  assert.deepEqual(conditionInfo('WB'), { cued: 'B', state: 'wake', plain: false });
  assert.deepEqual(conditionInfo('plain'), { cued: null, state: 'sleep', plain: true });
  assert.deepEqual(conditionInfo('A'), { cued: 'A', state: 'sleep', plain: false });
  assert.equal(conditionInfo('control').cued, null);
});

test('Phase 2 study: balanced blocks of 5, validated, carries safety acks', () => {
  const p1 = { ...phase1(), acks: [{ at: '2026-11-30T00:00:00Z' }] };
  const b = createBenefitStudy({ parent: p1, objects: OBJ, blocks: 6, seed: 9 });
  assert.equal(b.kind, 'benefit');
  assert.equal(b.schedule.length, 30);
  for (let i = 0; i < 6; i++) assert.deepEqual(b.schedule.slice(i * 5, i * 5 + 5).sort(), [...BENEFIT_CONDITIONS].sort());
  assert.deepEqual(b.targetIds, p1.targetIds);
  assert.equal(b.primary, 'creativity');
  assert.equal(b.acks.length, 1);
  assert.equal(cuedTargetId(b, 'WA'), 'tA');
  assert.equal(cuedTargetId(b, 'plain'), null);
  assert.equal(extendStudy(b, 1, 4).schedule.length, 35);
  assert.throws(() => createBenefitStudy({ parent: p1, objects: { A: ['tree'], B: OBJ.B } }), /at least 3/);
  assert.throws(() => createBenefitStudy({ parent: p1, objects: { A: [...OBJ.A, 'Wave'], B: OBJ.B } }), /one theme only/);
  assert.throws(() => createBenefitStudy({ parent: p1, objects: OBJ, primary: 'mood' }));
  assert.throws(() => createBenefitStudy({ parent: b, objects: OBJ }), /Phase 1/);
  assert.deepEqual(parseObjects('tree, Moss ,, tree;owl\nfern'), ['tree', 'Moss', 'owl', 'fern']);
  assert.deepEqual(makeSchedule(1, 2, BENEFIT_CONDITIONS), makeSchedule(1, 2, BENEFIT_CONDITIONS));
});

test('Phase 1 counts as done when its sequence is used up or it is closed', () => {
  const p1 = phase1();
  assert.equal(phaseOneDone(p1, []), false);
  const used = p1.schedule.map((c) => sess(p1, c));
  assert.equal(phaseOneDone(p1, used), true);
  assert.equal(phaseOneDone({ ...p1, status: 'closed' }, []), true);
});

test('plain nap matches the incubation nap length with no cues and one wake-up at the end', () => {
  const p = { rounds: 3, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: true };
  const plain = buildPlainPlan(p);
  assert.equal(planDurationSec(plain), planDurationSec(buildPlan({ ...p, preSleepCue: false })));
  assert.equal(plain.filter((x) => x.kind === 'cue').length, 0);
  assert.equal(plain.filter((x) => x.kind === 'wake').length, 1);
  assert.deepEqual(plain.map((x) => x.kind), ['wait', 'wait', 'wake', 'record', 'chime']);
});

// ---------- tasks ----------
test('themed word-pair sets: disjoint, seeded, exclude target words; lures stay within a theme', () => {
  const ex = forest.lexicon.concat(ocean.lexicon).map((x) => x.stem);
  const sets = makeThemedSets(5, 10, ex);
  const words = [...sets.A, ...sets.B].flatMap((p) => [p.cue, p.answer]);
  assert.equal(new Set(words).size, 40);
  assert.ok(!words.some((w) => ex.includes(stem(w))));
  assert.deepEqual(makeThemedSets(5, 10, ex), sets);
  assert.ok(['A,B', 'B,A'].includes(sets.order.join()));
  const items = makeThemedTest(sets, 77);
  assert.equal(items.length, 20);
  for (const it of items) {
    const own = new Set(sets[it.theme].map((p) => p.answer));
    assert.ok(it.options.every((o) => own.has(o)), 'lures must come from the same theme');
    assert.ok(it.options.includes(it.answer));
  }
  const res = scoreThemed(items.map((it, i) => ({ theme: it.theme, correct: i % 2 === 0 })));
  assert.equal(res.A.n + res.B.n, 20);
  const r = themedRetention({ immediate: { byTheme: { A: { correct: 5, n: 10 }, B: { correct: 6, n: 10 } } }, delayed: { byTheme: { A: { correct: 8, n: 10 }, B: { correct: 6, n: 10 } } } });
  assert.ok(Math.abs(r.A - 0.3) < 1e-12 && r.B === 0);
  assert.equal(themedRetention({ immediate: {}, delayed: null }), null);
});

test('fluency counts distinct uses, one per line', () => {
  assert.equal(fluency('a boat\n- a hat\n\nA boat\n2. a drum; a ladder\nx'), 4);
  assert.equal(fluency(''), 0);
  assert.equal(fluency('3D printer filament\n10) a raft'), 2, 'only list markers are stripped');
});

test('after-session tasks run in order: retest, then both creative-uses tasks', () => {
  const s = { status: 'complete', morning: { at: 'x' }, themed: { autOrder: ['B', 'A'], delayed: null } };
  assert.deepEqual(nextPostTask(s), { kind: 'delayed' });
  s.themed.delayed = { at: 'y' };
  assert.deepEqual(nextPostTask(s), { kind: 'aut', theme: 'B' });
  s.aut = { B: { text: '' } };
  assert.deepEqual(nextPostTask(s), { kind: 'aut', theme: 'A' });
  s.aut.A = { text: '' };
  assert.equal(nextPostTask(s), null);
  assert.equal(nextPostTask({ ...s, aut: null, status: 'aborted' }), null, 'no tasks after an aborted session');
  assert.equal(nextPostTask({ status: 'complete', morning: {} }), null, 'Phase 1 sessions have none');
  const b = createBenefitStudy({ parent: phase1(), objects: OBJ });
  assert.deepEqual([0, 1, 2, 3, -1].map((i) => autObject(b, i, 'A')), ['tree', 'moss', 'owl', 'tree', 'tree']);
});

// ---------- scoring only dreams ----------
test('only dream reports are scored; awake sessions score their mentation', () => {
  const rounds = [{ round: 1, transcript: 'thinking about lunch', state: 'awake' }, { round: 2, transcript: 'violet trees', state: 'drifting' }, { round: 3, transcript: 'falling', state: '' }];
  const s = { condition: 'A', status: 'complete', params: { speed: 1 }, rounds, morning: { report: 'more trees' } };
  assert.equal(dreamText(s), 'violet trees\n\nfalling\n\nmore trees');
  assert.equal(scoringText(s), dreamText(s));
  assert.ok(scoringText({ ...s, condition: 'WA' }).includes('lunch'));
  assert.equal(isScoreable({ ...s, rounds: [rounds[0]], morning: { report: '' } }), false, 'awake-only naps have no dream to score');
  const p1 = phase1();
  const r = analyzeStudy(p1, [sess(p1, 'A', { rounds: [rounds[0]] }), sess(p1, 'B')], [forest, ocean]);
  assert.deepEqual(r.noDream, { A: 1, B: 0, control: 0 });
  assert.deepEqual(r.dreamShare.A, { k: 0, n: 1 });
});

test('blind scoring spans both phases without leaking which is which', () => {
  const p1 = phase1();
  const b = createBenefitStudy({ parent: p1, objects: OBJ, seed: 11 });
  const ss = [sess(p1, 'A', { rounds: [{ round: 1, transcript: 'purple trees', state: 'drifting' }] }), sess(b, 'WB', { rounds: [{ round: 1, transcript: 'warm water', state: 'awake' }] })];
  assert.equal(blindQueue(ss, [p1, b]).length, 2);
  assert.equal(blindQueue(ss, p1).length, 1, 'a single study still works');
  const csv = blindPacketCSV(ss, [p1, b], [forest, ocean]);
  assert.ok(!/WB|benefit|steer|2026-/.test(csv));
  const rows = parseCSV(csv);
  rows[1][6] = '2'; rows[1][7] = '0'; rows[2][6] = '0'; rows[2][7] = '3';
  const res = parseScoresCSV(toCSV(rows), ss, [p1, b]);
  assert.deepEqual(res.errors, []);
  assert.equal(res.updates.length, 2);
});

// ---------- stats ----------
test('sign-flip test and Holm correction', () => {
  const all = signFlipTest([1, 1, 1, 1, 1]);
  assert.equal(all.method, 'exact');
  assert.equal(all.p, 1 / 32);
  assert.ok(signFlipTest([1, -1, 1, -1]).p > 0.5);
  const big = signFlipTest(Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? -0.5 : 1)));
  assert.equal(big.method, 'monte-carlo');
  assert.ok(big.p < 0.01);
  assert.ok(Number.isNaN(signFlipTest([]).p));
  const h = holm([0.01, 0.04, NaN]);
  assert.ok(Math.abs(h[0] - 0.02) < 1e-12 && Math.abs(h[1] - 0.04) < 1e-12 && Number.isNaN(h[2]));
  assert.deepEqual(holm([0.04, 0.01]).map((x) => +x.toFixed(4)), [0.04, 0.02]);
});

// ---------- learning engine ----------
test('stay-awake sessions and plain naps do not teach the timing engine', () => {
  const b = createBenefitStudy({ parent: phase1(), objects: OBJ });
  const awake = [1, 2, 3].map(() => sess(b, 'WA', { rounds: [{ round: 1, state: 'awake' }, { round: 2, state: 'awake' }] }));
  const plain = sess(b, 'plain', { rounds: [{ round: 1, state: 'asleep' }] });
  assert.equal(onsetEstimate([...awake, plain]).history.length, 0);
  assert.equal(armStats(awake).mid.n, 0);
  const napped = sess(b, 'SA', { rounds: [{ round: 1, state: 'awake' }, { round: 2, state: 'drifting' }] });
  assert.equal(onsetEstimate([napped]).history.length, 1);
  assert.equal(armStats([napped]).mid.successes, 1);
});

// ---------- analysis ----------
function benefitData(b, { dream = 0, cue = 0, wakeups = 0 } = {}) {
  // dream: extra benefit to the cued theme when asleep; cue: extra benefit from
  // hearing the cue at all (asleep or awake); wakeups: cost of the wake-ups.
  const out = [];
  const jitter = (i) => ((i * 37) % 7) / 20;
  for (let i = 0; i < 8; i++) {
    for (const c of BENEFIT_CONDITIONS) {
      const info = conditionInfo(c);
      const base = 3 + jitter(i) - (info.state === 'sleep' && !info.plain ? wakeups : 0);
      const v = { A: base, B: base + 0.1 };
      if (info.cued) v[info.cued] += cue + (info.state === 'sleep' ? dream : 0);
      const r = (x) => Math.max(1, Math.min(5, Math.round(x)));
      const pairs = (x) => Math.max(0, Math.min(10, Math.round(x * 2)));
      out.push(sess(b, c, {
        rounds: [{ round: 1, state: info.state === 'wake' ? 'awake' : 'drifting', transcript: 'x' }],
        blind: info.cued ? { [info.cued]: info.state === 'sleep' ? 2 : 1, [info.cued === 'A' ? 'B' : 'A']: 0 } : { A: 0, B: 0 },
        aut: { A: { object: 'tree', text: 'a\n'.repeat(r(v.A)) }, B: { object: 'wave', text: 'b\n'.repeat(r(v.B)) } },
        autBlind: { A: r(v.A), B: r(v.B) },
        themed: { immediate: { byTheme: { A: { correct: 5, n: 10 }, B: { correct: 5, n: 10 } } }, delayed: { byTheme: { A: { correct: 5 + pairs(v.A - 3), n: 10 }, B: { correct: 5 + pairs(v.B - 3), n: 10 } } } },
      }));
    }
  }
  return out;
}

test('Phase 2 analysis finds a dream-specific benefit and rejects a cue-only one', () => {
  const b = createBenefitStudy({ parent: phase1(), objects: OBJ, primary: 'creativity' });
  const dreamy = analyzeBenefit(b, benefitData(b, { dream: 1.6 }), [forest, ocean]);
  assert.deepEqual(dreamy.counts, { SA: 8, SB: 8, WA: 8, WB: 8, plain: 8 });
  assert.equal(dreamy.ready, true);
  const P = dreamy.outcomes.creativity;
  assert.ok(P.beyond.effect > 1 && P.beyond.p < 0.01, `beyond ${P.beyond.effect} p ${P.beyond.p}`);
  assert.ok(P.dreaming.effect > 1 && P.dreaming.p < 0.01, `dreaming ${P.dreaming.effect} p ${P.dreaming.p}`);
  assert.ok(P.beyond.pHolm >= P.beyond.p && P.dreaming.pHolm >= P.dreaming.p);
  assert.ok(dreamy.outcomes.memory.dreaming.p < 0.01, 'memory moves with it in this synthetic data');
  assert.ok(dreamy.incorporation.sleep > dreamy.incorporation.wake);
  assert.deepEqual(dreamy.dreamShare.WA, { k: 0, n: 8 });

  // Hearing the cue helps equally awake or asleep: not a dream effect.
  const cueOnly = analyzeBenefit(b, benefitData(b, { cue: 1.6 }), [forest, ocean]).outcomes.creativity;
  assert.ok(cueOnly.cuedVsUncued.p < 0.01, 'cued beats uncued after the nap...');
  assert.ok(cueOnly.dreaming.p > 0.2, '...but no more than when awake');

  // Nothing at all.
  const nul = analyzeBenefit(b, benefitData(b), [forest, ocean]).outcomes.creativity;
  assert.ok(nul.beyond.p > 0.2 && nul.dreaming.p > 0.2);

  // Wake-ups cost something: the uncued theme falls below a plain nap.
  const cost = analyzeBenefit(b, benefitData(b, { wakeups: 1 }), [forest, ocean]).outcomes.creativity;
  assert.ok(cost.cost.effect < -0.5);
});

test('creativity rating packet: blind, round-trips by code, rejects bad rows', () => {
  const b = createBenefitStudy({ parent: phase1(), objects: OBJ, seed: 21 });
  const ss = [sess(b, 'SA', { aut: { A: { object: 'tree', text: 'a ladder\na drum' }, B: { object: 'wave', text: 'a slide' } } }), sess(b, 'plain', { aut: { A: { object: 'moss', text: 'a pillow' }, B: { object: 'shell', text: 'a cup' } } })];
  assert.equal(creativityQueue(ss, [b]).length, 4);
  const csv = creativityPacketCSV(ss, [b]);
  assert.ok(!/SA|plain|2026-|p\d/.test(csv), 'no condition, date or session id');
  const rows = parseCSV(csv);
  rows.slice(1).forEach((r, i) => { r[3] = String(i + 1); });
  rows.push(['NOPE12', 'x', 'y', '3']);
  rows.push([rows[1][0], 'x', 'y', '9']);
  const res = parseCreativityCSV(toCSV(rows), ss, [b]);
  assert.equal(res.updates.length, 4);
  assert.equal(res.errors.length, 2);
  for (const u of res.updates) {
    const s = ss.find((x) => x.id === u.sessionId);
    s.autBlind = { ...(s.autBlind || {}), [u.theme]: u.rating };
  }
  assert.equal(creativityQueue(ss, [b]).length, 0);
});

// ---------- safety + data ----------
const consent = { version: CONSENT_VERSION, at: '2026-11-24T00:00:00Z', items: Object.fromEntries(CONSENT_ITEMS.map((c) => [c.key, true])) };

test('safety: unfinished after-session tests block the next session; awake sessions do not dilute disruption', () => {
  const b = createBenefitStudy({ parent: phase1(), objects: OBJ });
  const now = new Date(2026, 11, 20, 15, 0);
  const s = sess(b, 'SA', { startedAt: new Date(2026, 11, 19, 12).toISOString(), endedAt: new Date(2026, 11, 19, 12, 40).toISOString(), themed: { autOrder: ['A', 'B'], delayed: null } });
  const state = { ...emptyState(), consent, sessions: [s], checkins: [{ date: '2026-12-20', at: now.toISOString(), mood: 0, unreal: 0 }] };
  const r = canStartSession({ now, state, study: b });
  assert.ok(r.reasons.some((x) => x.includes('after-session tests')), r.reasons.join(' | '));
  s.themed.delayed = { at: 'x' }; s.aut = { A: {}, B: {} };
  assert.ok(canStartSession({ now, state, study: b }).ok);

  const heavy = [1, 2].map(() => sess(b, 'SA', { morning: { at: '2026-12-25T00:00:00Z', disruption: 4 } }));
  const awake = sess(b, 'WA', { morning: { at: '2026-12-26T00:00:00Z', disruption: null } });
  const third = sess(b, 'SB', { morning: { at: '2026-12-27T00:00:00Z', disruption: 3 } });
  assert.ok(pauseState(b, [...heavy, awake, third]).paused, 'the awake session is skipped, not counted as 0');
});

test('session table carries Phase 2 outcomes', () => {
  const p1 = phase1();
  const b = createBenefitStudy({ parent: p1, objects: OBJ });
  const s = sess(b, 'WB', {
    blind: { A: 0, B: 2 },
    aut: { A: { object: 'tree', text: 'a roof\na ladder' }, B: { object: 'wave', text: 'a drum\na lamp\na bridge' } },
    autBlind: { A: 2, B: 4 },
    themed: { immediate: { byTheme: { A: { correct: 5, n: 10 }, B: { correct: 5, n: 10 } } }, delayed: { byTheme: { A: { correct: 6, n: 10 }, B: { correct: 8, n: 10 } } } },
  });
  const [row] = sessionRows({ ...emptyState(), targets: [forest, ocean], studies: [p1, b], sessions: [s] });
  assert.equal(row.phase, 2);
  assert.equal(row.state, 'wake');
  assert.equal(row.cued_theme, 'B');
  assert.equal(row.blind_cued, 2);
  assert.equal(row.blind_uncued, 0);
  assert.equal(row.aut_cued_fluency, 3);
  assert.equal(row.aut_uncued_rating, 2);
  assert.ok(Math.abs(row.mem_cued_retention - 0.3) < 1e-12);
  assert.ok(Math.abs(row.mem_uncued_retention - 0.1) < 1e-12);
  assert.equal(row.dream_report_words, null, 'awake sessions have no dream report');
});
