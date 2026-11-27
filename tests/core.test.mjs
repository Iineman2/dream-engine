import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32, shuffle, beta, hashString } from '../js/core/rng.js';
import { stem, stems } from '../js/core/text.js';
import { compileTarget, compareTargets, NEUTRAL } from '../js/core/compiler.js';
import { lexicalScore, toCSV, parseCSV, blindQueue, blindCode, blindPacketCSV, parseScoresCSV, reportText } from '../js/core/scoring.js';
import { wilson, binomTailHalf, permutationTest, choose } from '../js/core/stats.js';
import { armStats, chooseArm, onsetEstimate, onsetWindow, ONSET } from '../js/core/adaptive.js';
import { buildPlan, planDurationSec, validateParams, drawOnsetMin } from '../js/core/protocol.js';
import { makeSchedule, createStudy, nextAllocation } from '../js/core/study.js';
import { canStartSession, effectiveWindow, pauseState, consentValid, CONSENT_ITEMS, CONSENT_VERSION } from '../js/core/safety.js';
import { analyzeStudy } from '../js/core/analysis.js';
import { emptyState, validateImport, migrate } from '../js/core/schema.js';

// ---------- helpers ----------
const consent = { version: CONSENT_VERSION, at: '2026-11-24T00:00:00Z', items: Object.fromEntries(CONSENT_ITEMS.map((c) => [c.key, true])) };
const mkTarget = (id, input) => ({ id, ...compileTarget(input).target });
const forest = mkTarget('tA', { environment: 'a purple forest', emotion: 'awe', related: 'violet trees woods' });
const ocean = mkTarget('tB', { environment: 'an ocean of light', sensation: 'floating', related: 'water waves glowing' });
let n = 0;
function mkSession(study, condition, { blind, transcript = 'some report', speed = 1, status = 'complete', startedAt, morning, rounds, rehearsal } = {}) {
  n++;
  const t = startedAt || new Date(Date.UTC(2026, 10, 1, 10, 0) + n * 864e5).toISOString();
  return {
    id: `s${n}`, studyId: study.id, condition, rehearsal: !!rehearsal, status, startedAt: t, endedAt: t,
    params: { speed, armId: 'mid' },
    rounds: rounds || [{ round: 1, transcript, state: 'drifting' }],
    morning: morning === undefined ? { at: t, report: '', disruption: 1 } : morning,
    blind: blind || null,
  };
}

// ---------- rng ----------
test('rng is deterministic and shuffle is a permutation', () => {
  const a = mulberry32(42), b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const arr = [1, 2, 3, 4, 5, 6, 7];
  const s = shuffle(arr, mulberry32(7));
  assert.deepEqual([...s].sort(), arr);
  assert.notDeepEqual(s, arr);
  assert.equal(hashString('purple forest'), hashString('purple forest'));
});

test('beta sampler stays in (0,1) with the right mean', () => {
  const r = mulberry32(1);
  let sum = 0;
  for (let i = 0; i < 4000; i++) { const x = beta(r, 3, 7); assert.ok(x > 0 && x < 1); sum += x; }
  assert.ok(Math.abs(sum / 4000 - 0.3) < 0.02);
});

// ---------- text ----------
test('stemming is consistent across inflections', () => {
  for (const [a, b] of [['speeds', 'speed'], ['trees', 'tree'], ['flying', 'flies'], ['swimming', 'swim'], ['glowed', 'glowing'], ['oceans', 'ocean'], ['forests', 'forest']]) {
    assert.equal(stem(a), stem(b), `${a} vs ${b}`);
  }
  assert.deepEqual(stems('I remember the purple forest!'), ['purple', 'forest']);
});

// ---------- compiler ----------
test('compiler builds a Dormio-style cue, lexicon and motif', () => {
  const r = compileTarget({ environment: 'a purple forest.', emotion: 'awe' });
  assert.ok(r.ok);
  assert.equal(r.target.cuePhrase, 'Remember to think of a purple forest.');
  assert.deepEqual(r.target.lexicon.map((x) => x.word).sort(), ['awe', 'forest', 'purple']);
  assert.equal(r.target.motif.length, 3);
  assert.deepEqual(compileTarget({ environment: 'a purple forest' }).target.motif, r.target.motif);
  assert.notDeepEqual(r.target.motif, NEUTRAL.motif);
  assert.match(r.target.visualization, /You are in a purple forest\./);
});

test('compiler validates and warns', () => {
  assert.equal(compileTarget({ emotion: 'joy' }).ok, false);
  const long = compileTarget({ environment: 'a vast shimmering crystalline cathedral floating above an endless ocean of soft light' , emotion: 'deep and boundless compassion' });
  assert.ok(long.warnings.some((w) => /words/.test(w)));
  const custom = compileTarget({ environment: 'a purple forest', cuePhrase: 'Purple forest' });
  assert.equal(custom.target.cuePhrase, 'Purple forest.');
  assert.ok(compileTarget({ environment: 'mars', awareness: 'notice' }).target.cuePhrase.includes('Notice that you are dreaming'));
});

test('compareTargets flags shared words and lucidity confounds', () => {
  assert.equal(compareTargets(forest, ocean).ok, true);
  const forest2 = mkTarget('tC', { environment: 'a dark forest' });
  const c = compareTargets(forest, forest2);
  assert.equal(c.ok, false);
  assert.deepEqual(c.overlap, ['forest']);
  const lucid = mkTarget('tD', { environment: 'a desert', awareness: 'notice' });
  assert.ok(compareTargets(forest, lucid).warnings.some((w) => /lucidity/.test(w)));
});

// ---------- scoring ----------
test('lexical score counts distinct target concepts, capped at 3', () => {
  const r = lexicalScore('I was walking through violet woods, purple trees everywhere', forest.lexicon);
  assert.deepEqual(r.hits.sort(), ['purple', 'trees', 'violet', 'woods'].sort());
  assert.equal(r.score, 3);
  assert.equal(lexicalScore('a kitchen with my aunt', forest.lexicon).score, 0);
  assert.equal(lexicalScore('floating in glowing water', ocean.lexicon).score, 3);
});

test('CSV round-trips quotes, commas, newlines and neutralises formulas', () => {
  const rows = [['code', 'report'], ['AB12', 'He said "fly", then\nwe flew, far'], ['X', '=HYPERLINK(1)']];
  const back = parseCSV(toCSV(rows));
  assert.deepEqual(back[1], rows[1]);
  assert.equal(back[2][1], "'=HYPERLINK(1)");
});

test('blind queue: only scoreable, unscored sessions of this study, in code order', () => {
  const study = { id: 'st1', seed: 99, targetIds: { A: 'tA', B: 'tB' } };
  const other = { id: 'st2', seed: 1 };
  const ss = [
    mkSession(study, 'A'), mkSession(study, 'B'), mkSession(study, 'control'),
    mkSession(study, 'A', { blind: { A: 1, B: 0 } }),
    mkSession(study, 'A', { speed: 30 }),
    mkSession(study, 'B', { rehearsal: true }),
    mkSession(study, 'B', { transcript: '', morning: { at: 'x', report: '' } }),
    mkSession(other, 'A'),
  ];
  const q = blindQueue(ss, study);
  assert.deepEqual(q.map((s) => s.id).sort(), ss.slice(0, 3).map((s) => s.id).sort());
  const codes = q.map((s) => blindCode(s.id, study.seed));
  assert.deepEqual(codes, [...codes].sort());
});

test('blind packet export/import maps scores back by code', () => {
  const study = { id: 'st3', seed: 5, targetIds: { A: 'tA', B: 'tB' } };
  const ss = [mkSession(study, 'A', { transcript: 'purple trees' }), mkSession(study, 'B', { transcript: 'warm water' })];
  const csv = blindPacketCSV(ss, study, [forest, ocean]);
  assert.ok(!csv.includes('2026-'), 'packet must not leak dates');
  assert.ok(!/\bcontrol\b/.test(csv), 'packet must not leak conditions');
  const rows = parseCSV(csv);
  rows[1][6] = '3'; rows[1][7] = '0';
  rows[2][6] = '0'; rows[2][7] = '2';
  const res = parseScoresCSV(toCSV(rows), ss, study);
  assert.deepEqual(res.errors, []);
  assert.equal(res.updates.length, 2);
  const bad = parseScoresCSV('code,score_A,score_B\r\nZZZZZZ,1,1\r\n' + rows[1][0] + ',5,1\r\n', ss, study);
  assert.equal(bad.updates.length, 0);
  assert.equal(bad.errors.length, 2);
});

test('reportText joins round transcripts and the morning report', () => {
  const s = { rounds: [{ transcript: ' a ' }, { transcript: '' }, { transcript: 'b' }], morning: { report: 'c' } };
  assert.equal(reportText(s), 'a\n\nb\n\nc');
});

// ---------- stats ----------
test('wilson and binomial tail match known values', () => {
  const w = wilson(5, 10);
  assert.ok(Math.abs(w.lo - 0.2366) < 1e-3 && Math.abs(w.hi - 0.7634) < 1e-3);
  assert.ok(Math.abs(binomTailHalf(10, 10) - 1 / 1024) < 1e-12);
  assert.equal(binomTailHalf(0, 7), 1);
  assert.ok(Math.abs(binomTailHalf(8, 10) - 56 / 1024) < 1e-12);
  assert.equal(choose(16, 8), 12870);
});

test('permutation test: exact and Monte Carlo paths', () => {
  const ex = permutationTest([3, 3, 3], [0, 0, 0]);
  assert.equal(ex.method, 'exact');
  assert.ok(Math.abs(ex.p - 1 / 20) < 1e-12);
  assert.equal(permutationTest([1, 1], [1, 1]).p, 1);
  const big = permutationTest(Array(20).fill(2), Array(20).fill(0));
  assert.equal(big.method, 'monte-carlo');
  assert.ok(big.p < 0.001);
  const nul = permutationTest([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1], [2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1]);
  assert.ok(nul.p > 0.2);
  assert.ok(Number.isNaN(permutationTest([], [1]).p));
});

// ---------- adaptive ----------
test('arm stats only learn from rounds >= 2 of real sessions', () => {
  const study = { id: 'st4' };
  const s1 = mkSession(study, 'A', { rounds: [{ round: 1, state: 'drifting' }, { round: 2, state: 'drifting' }, { round: 3, state: 'asleep' }] });
  s1.params.armId = 'short';
  const s2 = mkSession(study, 'B', { speed: 20, rounds: [{ round: 2, state: 'drifting' }] });
  s2.params.armId = 'short';
  const st = armStats([s1, s2]);
  assert.equal(st.short.successes, 1);
  assert.equal(st.short.failures, 1);
  assert.equal(st.mid.n, 0);
});

test('Thompson sampling prefers a clearly better arm', () => {
  const st = { short: { alpha: 21, beta: 1 }, mid: { alpha: 1, beta: 21 }, long: { alpha: 2, beta: 10 } };
  const r = mulberry32(3);
  let short = 0;
  for (let i = 0; i < 500; i++) if (chooseArm(st, r).id === 'short') short++;
  assert.ok(short > 480);
});

test('onset staircase moves later when awake, earlier when asleep, and clamps', () => {
  const study = { id: 'st5' };
  const seq = ['awake', 'awake', 'drifting', 'asleep', 'unsure'].map((state) => mkSession(study, 'A', { rounds: [{ round: 1, state }] }));
  const o = onsetEstimate(seq);
  assert.equal(o.estimate, ONSET.defaultMin + 2);
  assert.equal(o.history.length, 4);
  const many = Array.from({ length: 20 }, () => mkSession(study, 'A', { rounds: [{ round: 1, state: 'asleep' }] }));
  assert.equal(onsetEstimate(many).estimate, ONSET.floor);
  const w = onsetWindow(ONSET.floor);
  assert.ok(w.minMin >= 3 && w.maxMin > w.minMin);
  const d = drawOnsetMin({ minMin: 7.5, maxMin: 12.5 }, mulberry32(9));
  assert.ok(d >= 7.5 && d <= 12.5 && Number.isInteger(d * 2));
});

// ---------- protocol ----------
test('plan mirrors the Dormio timer loop', () => {
  const p = { rounds: 3, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: true };
  const steps = buildPlan(p);
  const count = (k) => steps.filter((s) => s.kind === k).length;
  assert.equal(count('cue'), 1 + 3 + 2);
  assert.equal(count('wake'), 3);
  assert.equal(count('record'), 3);
  assert.equal(steps.at(-1).kind, 'chime');
  assert.equal(planDurationSec(steps), 60 + 600 + 3 * 120 + 3 * 60 + 2 * 300);
  // after each report except the last: cue then between-wait
  const i = steps.findIndex((s) => s.kind === 'record');
  assert.deepEqual([steps[i + 1].kind, steps[i + 2].phase], ['cue', 'between']);
  assert.equal(buildPlan({ ...p, preSleepCue: false }).filter((s) => s.kind === 'cue').length, 5);
  assert.ok(validateParams({ ...p, rounds: 6 }).length);
  assert.ok(validateParams({ ...p, betweenMin: 2 }).length);
  assert.throws(() => buildPlan({ ...p, recordSec: 5 }));
});

// ---------- study ----------
test('blocked randomisation is balanced, seeded, and allocation is consumed', () => {
  const sch = makeSchedule(123, 8);
  assert.equal(sch.length, 24);
  for (let b = 0; b < 8; b++) assert.deepEqual(sch.slice(b * 3, b * 3 + 3).sort(), ['A', 'B', 'control']);
  assert.deepEqual(makeSchedule(123, 8), sch);
  assert.notDeepEqual(makeSchedule(124, 8), sch);
  const study = createStudy({ targetAId: 'tA', targetBId: 'tB', blocks: 1, seed: 123 });
  assert.equal(nextAllocation(study, []).index, 0);
  const s = [mkSession(study, study.schedule[0], { status: 'aborted' }), mkSession(study, 'A', { speed: 30 })];
  assert.equal(nextAllocation(study, s).index, 1, 'aborted sessions consume, speeded QA sessions do not');
  s.push(mkSession(study, study.schedule[1]), mkSession(study, study.schedule[2]));
  assert.equal(nextAllocation(study, s), null);
  assert.throws(() => createStudy({ targetAId: 'x', targetBId: 'x' }));
});

// ---------- safety ----------
test('safety: daytime window, daily cap, gap, pending report, pause and consent', () => {
  const study = createStudy({ targetAId: 'tA', targetBId: 'tB', blocks: 4, seed: 1 });
  const at = (h, m = 0) => new Date(2026, 10, 24, h, m);
  const checkin = { date: '2026-11-24', at: at(8).toISOString(), mood: 1, unreal: 0, confusion: false };
  const base = { ...emptyState(), consent, targets: [forest, ocean], studies: [study], checkins: [checkin] };
  assert.ok(canStartSession({ now: at(14), state: base, study }).ok);
  assert.match(canStartSession({ now: at(14), state: { ...base, checkins: [] }, study }).reasons.join(), /check-in/);
  const confused = [{ ...checkin, confusion: true }];
  assert.match(canStartSession({ now: at(14), state: { ...base, checkins: confused }, study }).reasons.join(), /dream with something that really happened/);
  assert.equal(pauseState({ ...study, acks: [{ at: at(9).toISOString() }] }, [], confused).paused, false, 'ack after the check-in clears it');
  assert.equal(pauseState(study, [], [{ ...checkin, unreal: 3 }]).paused, true);
  assert.equal(pauseState(study, [], [{ ...checkin, unreal: 2 }]).paused, false);
  assert.match(canStartSession({ now: at(3), state: base, study }).reasons.join(), /night-time/);
  assert.match(canStartSession({ now: at(23), state: { ...base, settings: { ...base.settings, window: { start: '00:00', end: '23:59' } } }, study }).reasons.join(), /22:00/);
  assert.deepEqual(effectiveWindow({ start: '00:00', end: '23:59' }), { startMin: 360, endMin: 1320 });
  assert.ok(canStartSession({ now: at(3), state: base, study, speed: 30 }).ok, 'speeded QA sessions skip the clock limits');
  assert.equal(canStartSession({ now: at(14), state: { ...base, consent: null }, study }).ok, false);

  const s1 = mkSession(study, 'A', { startedAt: at(9).toISOString() });
  s1.endedAt = at(9, 40).toISOString();
  assert.match(canStartSession({ now: at(10), state: { ...base, sessions: [s1] }, study }).reasons.join(), /between sessions/);
  const s2 = mkSession(study, 'B', { startedAt: at(12).toISOString() });
  s2.endedAt = at(12, 30).toISOString();
  assert.match(canStartSession({ now: at(16), state: { ...base, sessions: [s1, s2] }, study }).reasons.join(), /per day/);
  const pending = mkSession(study, 'A', { startedAt: at(9).toISOString(), morning: null });
  pending.endedAt = pending.startedAt;
  assert.match(canStartSession({ now: at(15), state: { ...base, sessions: [pending] }, study }).reasons.join(), /Finish the report/);

  const d = mkSession(study, 'A', { morning: { at: '2026-11-02T00:00:00Z', distressing: true, disruption: 1 } });
  assert.equal(pauseState(study, [d]).paused, true);
  const acked = { ...study, acks: [{ at: '2026-11-03T00:00:00Z', reason: 'ok' }] };
  assert.equal(pauseState(acked, [d]).paused, false);
  const rough = [1, 2, 3].map((i) => mkSession(study, 'A', { morning: { at: `2026-11-1${i}T00:00:00Z`, disruption: 4 } }));
  assert.equal(pauseState(study, rough).paused, true);
  assert.ok(consentValid(consent));
  assert.equal(consentValid({ ...consent, items: { ...consent.items, mic: false } }), false);

  const own = { ...base, settings: { ...base.settings, voiceMode: 'own' } };
  // v1 (v0.3) studies still need every recording; Horowitz-script studies fall back to TTS per line.
  assert.match(canStartSession({ now: at(14), state: own, study: { ...study, protocol: { script: 'v1', binding: false, emotionScores: false } } }).reasons.join(), /Own-voice/);
  assert.doesNotMatch(canStartSession({ now: at(14), state: own, study }).reasons.join(), /Own-voice/);
});

// ---------- analysis ----------
test('analysis detects a real incorporation effect and not a null one', () => {
  const study = createStudy({ targetAId: 'tA', targetBId: 'tB', blocks: 8, seed: 2 });
  const works = [];
  for (let i = 0; i < 8; i++) {
    works.push(mkSession(study, 'A', { blind: { A: 2, B: 0 }, transcript: 'purple trees' }));
    works.push(mkSession(study, 'B', { blind: { A: 0, B: 2 }, transcript: 'glowing water' }));
    works.push(mkSession(study, 'control', { blind: { A: 0, B: 0 }, transcript: 'my kitchen' }));
  }
  const r = analyzeStudy(study, works, [forest, ocean]);
  assert.deepEqual(r.counts, { A: 8, B: 8, control: 8 });
  assert.equal(r.primary.effect, 4);
  assert.equal(r.primary.method, 'exact');
  assert.ok(Math.abs(r.primary.p - 1 / 12870) < 1e-12);
  assert.equal(r.specificity.hits, 16);
  assert.equal(r.specificity.rate, 1);
  assert.ok(Math.abs(r.specificity.p - 1 / 65536) < 1e-12, 'sign-test p must not be overwritten by the proportion');
  assert.equal(r.table.A.A.k, 8);
  assert.equal(r.table.A.control.k, 0);
  assert.equal(r.ready, true);
  const lex = analyzeStudy(study, works, [forest, ocean], { source: 'lexical' });
  assert.ok(lex.primary.p < 0.001);

  const nul = [];
  for (let i = 0; i < 8; i++) {
    const sc = i % 2 ? { A: 1, B: 0 } : { A: 0, B: 1 };
    nul.push(mkSession(study, 'A', { blind: sc }), mkSession(study, 'B', { blind: sc }));
  }
  const rn = analyzeStudy(study, nul, [forest, ocean]);
  assert.equal(rn.primary.effect, 0);
  assert.ok(rn.primary.p > 0.4);
});

// ---------- schema ----------
test('import validation and migration', () => {
  assert.equal(validateImport(null).ok, false);
  assert.equal(validateImport({ version: 1 }).ok, false);
  const ok = validateImport({ app: 'dream-engine', state: { ...emptyState(), settings: { rounds: 4 } } });
  assert.ok(ok.ok);
  assert.equal(ok.state.settings.rounds, 4);
  assert.equal(ok.state.settings.recordSec, 60);
  assert.equal(validateImport({ version: 99, targets: [], studies: [], sessions: [] }).ok, false);
  assert.deepEqual(migrate({ version: 0 }).targets, []);
});
