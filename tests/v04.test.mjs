import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileTarget, compareTargets, startPhraseOf, NEUTRAL } from '../js/core/compiler.js';
import { buildPlan, buildPlainPlan, scriptLines, SCRIPT_H2023, PHASE_TEXT } from '../js/core/protocol.js';
import { createStudy, createBenefitStudy, studyProtocol } from '../js/core/study.js';
import { emptyState, migrate, validateImport, DEFAULT_SETTINGS, SCHEMA_VERSION } from '../js/core/schema.js';
import { cueArousals, volumeTable, nextCueVolume, AROUSAL_WINDOW_SEC } from '../js/core/arousal.js';
import { RUBRIC, RUBRIC_V1, rubricFor, EMOTION_RUBRIC, blindPacketCSV, parseScoresCSV, parseCSV, toCSV } from '../js/core/scoring.js';
import { analyzeStudy } from '../js/core/analysis.js';

const mkTarget = (id, input) => ({ id, ...compileTarget(input).target });
const P = { rounds: 3, recordSec: 60, betweenMin: 5, hypnaMin: 2, onsetMin: 10, lieDownSec: 60 };

// ---------- schema / migration ----------
test('schema v4: new defaults, v3 migration, import accepts v3 and v4', () => {
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(DEFAULT_SETTINGS.scriptVersion, 'h2023');
  assert.equal(DEFAULT_SETTINGS.bindingStep, true);
  assert.equal(DEFAULT_SETTINGS.adaptiveVolume, true);
  assert.equal(DEFAULT_SETTINGS.cueVolumeMax, 0.8);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS.scriptVoiceIds).sort(), ['alert', 'alertWake', 'back', 'controlCue', 'controlStart', 'stateAsk']);

  const blind = { A: 2, B: 1, at: 'x', rater: 'me' };
  const v3 = {
    version: 3, targets: [], settings: { cueVolume: 0.5, scriptVoiceIds: { alert: 'vid1' } },
    studies: [{ id: 'old', kind: 'steer', targetIds: { A: 'a', B: 'b' }, schedule: [] }, { id: 'new', protocol: { script: 'h2023', binding: true, emotionScores: true } }],
    sessions: [{ id: 's1', blind }],
  };
  const m = migrate(v3);
  assert.equal(m.version, 4);
  assert.deepEqual(m.studies[0].protocol, { script: 'v1', binding: false, emotionScores: false });
  assert.equal(m.studies[1].protocol.script, 'h2023', 'existing protocol untouched');
  assert.equal(m.settings.scriptVoiceIds.alert, 'vid1');
  assert.equal(m.settings.scriptVoiceIds.back, null, 'deep-merged defaults');
  assert.equal(m.settings.cueVolume, 0.5);
  assert.deepEqual(m.sessions[0].blind, blind, 'blind {A,B} survives untouched');
  assert.equal(v3.studies[0].protocol, undefined, 'input not mutated');

  const base = { targets: [], studies: [], sessions: [] };
  assert.ok(validateImport({ ...base, version: 3 }).ok);
  assert.ok(validateImport({ ...base, version: 4 }).ok);
  assert.ok(!validateImport({ ...base, version: 5 }).ok);
  assert.equal(emptyState().version, 4);
});

// ---------- study protocol ----------
test('studies store a protocol; old studies read as v1', () => {
  const s = createStudy({ targetAId: 'a', targetBId: 'b', seed: 1 });
  assert.deepEqual(s.protocol, { script: 'h2023', binding: true, emotionScores: true });
  const v1 = createStudy({ targetAId: 'a', targetBId: 'b', seed: 1, protocol: { script: 'v1', binding: false, emotionScores: false } });
  assert.deepEqual(studyProtocol(v1), { script: 'v1', binding: false, emotionScores: false });
  assert.deepEqual(studyProtocol({ id: 'legacy' }), { script: 'v1', binding: false, emotionScores: false });
  assert.deepEqual(studyProtocol(undefined), { script: 'v1', binding: false, emotionScores: false });
  const objs = { A: ['x1', 'x2', 'x3'], B: ['y1', 'y2', 'y3'] };
  assert.equal(createBenefitStudy({ parent: s, objects: objs, seed: 2 }).protocol.script, 'h2023');
  assert.equal(createBenefitStudy({ parent: s, objects: objs, seed: 2, protocol: { script: 'v1', binding: false, emotionScores: false } }).protocol.binding, false);
});

// ---------- compiler ----------
test('compiler: cue drops the emotion clause, adds startPhrase; old targets derive it', () => {
  const t = compileTarget({ environment: 'a tree', emotion: 'awe' }).target;
  assert.equal(t.cuePhrase, 'Remember to think of a tree.');
  assert.equal(t.startPhrase, 'Think of a tree.');
  const lucid = compileTarget({ environment: 'a tree', awareness: 'notice' }).target;
  assert.equal(lucid.cuePhrase, 'Remember to think of a tree. Notice that you are dreaming.');
  assert.equal(compileTarget({ environment: 'a tree', cuePhrase: 'Purple tree' }).target.cuePhrase, 'Purple tree.');

  assert.equal(startPhraseOf(t), 'Think of a tree.');
  assert.equal(startPhraseOf({ label: 'Forest', cuePhrase: 'Remember to think of a purple forest, and feel awe.' }), 'Think of a purple forest.');
  assert.equal(startPhraseOf({ label: 'Forest', cuePhrase: 'Remember to think of a forest. Notice that you are dreaming.' }), 'Think of a forest.');
  assert.equal(startPhraseOf({ label: 'Purple forest', cuePhrase: 'Purple forest.' }), 'Think of Purple forest.');
});

test('compareTargets: emotion warnings do not change ok', () => {
  const A = mkTarget('a', { environment: 'a purple forest', emotion: 'awe', related: 'violet' });
  const B = mkTarget('b', { environment: 'an ocean of light', emotion: 'peace', related: 'waves' });
  const clean = compareTargets(A, B);
  assert.ok(clean.ok);
  assert.ok(!clean.warnings.some((w) => /Emotion scores/.test(w)));

  const noB = compareTargets(A, mkTarget('b', { environment: 'an ocean of light', related: 'waves' }));
  assert.ok(noB.ok);
  assert.ok(noB.warnings.some((w) => /Emotion scores can't tell A from B/.test(w)));
  const noA = compareTargets(mkTarget('a', { environment: 'a purple forest', related: 'violet' }), B);
  assert.ok(noA.ok && noA.warnings.some((w) => /Emotion scores/.test(w)));

  const same = compareTargets(A, mkTarget('b', { environment: 'an ocean of light', emotion: 'Awe', related: 'waves' }));
  assert.ok(same.warnings.some((w) => /same emotion/.test(w)));
  const stemmed = compareTargets(mkTarget('a', { environment: 'a purple forest', emotion: 'wonders', related: 'violet' }), mkTarget('b', { environment: 'an ocean of light', emotion: 'wonder', related: 'waves' }));
  assert.ok(stemmed.warnings.some((w) => /same emotion/.test(w)));
});

// ---------- protocol script ----------
test('scriptLines: h2023 per condition and state', () => {
  const t = mkTarget('a', { environment: 'a tree', emotion: 'awe' });
  const h = { script: 'h2023', binding: true, emotionScores: true };
  assert.equal(SCRIPT_H2023.alertWake, "Please tell me what's going through your mind.");

  const s = scriptLines({ protocol: h, state: 'sleep', isControl: false, target: t });
  assert.equal(s.start, 'Think of a tree.');
  assert.equal(s.cue, 'Remember to think of a tree.');
  assert.equal(s.alert, "You're falling asleep. Please tell me, what's going through your mind?");
  assert.equal(s.stateAsk, 'And were you asleep? Awake, halfway, or asleep?');
  assert.equal(s.back, 'You can fall back asleep now.');
  assert.deepEqual(s.voiceKeys, { start: 'target.startVoiceId', cue: 'target.voiceId', alert: 'alert', stateAsk: 'stateAsk', back: 'back' });

  const w = scriptLines({ protocol: h, state: 'wake', target: t });
  assert.equal(w.alert, "Please tell me what's going through your mind.");
  assert.equal(w.stateAsk, null);
  assert.equal(w.back, null);
  assert.equal(w.voiceKeys.alert, 'alertWake');
  assert.equal(w.cue, 'Remember to think of a tree.');

  const c = scriptLines({ protocol: h, state: 'sleep', isControl: true, target: null });
  assert.equal(c.start, 'Observe your thoughts.');
  assert.equal(c.cue, 'Remember to observe your thoughts.');
  assert.equal(c.alert, s.alert);
  assert.equal(c.voiceKeys.start, 'controlStart');
  assert.equal(c.voiceKeys.cue, 'controlCue');
  assert.equal(scriptLines({ protocol: h, isControl: true, target: t }).cue, 'Remember to observe your thoughts.', 'control ignores the target');

  // old target without startPhrase derives it
  const old = { label: 'Forest', cuePhrase: 'Remember to think of a forest, and feel awe.' };
  assert.equal(scriptLines({ protocol: h, target: old }).start, 'Think of a forest.');
  // user override of cuePhrase wins
  assert.equal(scriptLines({ protocol: h, target: mkTarget('x', { environment: 'a tree', cuePhrase: 'Tree' }) }).cue, 'Tree.');
});

test('scriptLines: h2023 target cue never carries the v0.3 emotion clause', () => {
  const h = { script: 'h2023' };
  const cue = (cuePhrase) => scriptLines({ protocol: h, target: { label: 'a forest', cuePhrase } }).cue;
  assert.equal(cue('Remember to think of a purple forest, and feel awe.'), 'Remember to think of a purple forest.');
  assert.equal(cue('Remember to think of a purple forest, and feel awe. Notice that you are dreaming.'), 'Remember to think of a purple forest. Notice that you are dreaming.');
  assert.equal(cue('Remember to think of a purple forest. Notice that you are dreaming.'), 'Remember to think of a purple forest. Notice that you are dreaming.');
  assert.equal(cue('Tree'), 'Tree');
  const v1 = scriptLines({ protocol: { script: 'v1' }, target: { label: 'x', cuePhrase: 'Remember to think of x, and feel awe.' } });
  assert.equal(v1.cue, 'Remember to think of x, and feel awe.', 'v1 unchanged');
});

test('rubricFor: v1 gets the v0.3 wording, h2023 the idea rubric', () => {
  assert.equal(rubricFor({ script: 'v1' }), RUBRIC_V1);
  assert.equal(rubricFor(undefined), RUBRIC_V1);
  assert.equal(rubricFor({ script: 'h2023' }), RUBRIC);
  assert.equal(RUBRIC_V1[2].desc, 'A clearly recognisable element of the target.');
  assert.ok(RUBRIC.every((r) => /Ignore the feeling/.test(r.desc)));
  assert.ok(RUBRIC_V1.every((r) => !/feeling/i.test(r.desc)));
});

test('scriptLines: v1 keeps the v0.3 behaviour', () => {
  const t = mkTarget('a', { environment: 'a tree', emotion: 'awe' });
  for (const protocol of [{ script: 'v1', binding: false, emotionScores: false }, undefined]) {
    const s = scriptLines({ protocol, state: 'sleep', target: t });
    assert.equal(s.cue, t.cuePhrase);
    assert.equal(s.alert, NEUTRAL.wakePhrase);
    assert.equal(s.start, null);
    assert.equal(s.stateAsk, null);
    assert.equal(s.back, null);
    const c = scriptLines({ protocol, isControl: true, target: t });
    assert.equal(c.cue, NEUTRAL.cuePhrase);
  }
  assert.equal(scriptLines({ protocol: { script: 'v1' }, target: null }).cue, NEUTRAL.cuePhrase);
});

test('buildPlan: h2023 sequence; default plan is unchanged', () => {
  const base = buildPlan(P);
  assert.deepEqual(buildPlan({ ...P, script: 'v1' }), base);
  assert.deepEqual(buildPlan({ ...P, preSleepCue: true }).slice(0, 3).map((s) => s.phase), ['settle', 'pre-sleep', 'onset']);
  assert.ok(!base.some((s) => s.kind === 'say'));

  const plan = buildPlan({ ...P, script: 'h2023' });
  assert.deepEqual(plan.slice(0, 3), [
    { kind: 'wait', phase: 'settle', sec: 60 },
    { kind: 'say', phase: 'start', line: 'start' },
    { kind: 'wait', phase: 'onset', sec: 600 },
  ]);
  const round1 = plan.slice(3, 3 + 9).map((s) => `${s.kind}:${s.phase}${s.line ? ':' + s.line : ''}`);
  assert.deepEqual(round1, ['cue:hypnagogia', 'wait:hypnagogia', 'wake:wake', 'record:report', 'say:state:stateAsk', 'record:state', 'cue:return', 'say:back:back', 'wait:between']);
  const sr = plan.filter((s) => s.kind === 'record' && s.phase === 'state');
  assert.equal(sr.length, 3);
  assert.ok(sr.every((s) => s.sec === 8));
  assert.equal(plan.filter((s) => s.line === 'back').length, 2, 'no back after the last round');
  assert.equal(plan.filter((s) => s.phase === 'return').length, 2);
  assert.equal(plan.at(-1).kind, 'chime');
  assert.equal(plan.at(-2).phase, 'state');

  const wake = buildPlan({ ...P, script: 'h2023', state: 'wake' });
  assert.ok(!wake.some((s) => s.line === 'stateAsk' || s.line === 'back' || s.phase === 'state'));
  assert.equal(wake.filter((s) => s.phase === 'return').length, 2);

  // plain plan unchanged and unaffected by script
  assert.deepEqual(buildPlainPlan({ ...P, script: 'h2023' }).map((s) => s.phase), ['settle', 'sleep', 'wake', 'report', 'end']);
  for (const k of ['start', 'state', 'back']) assert.ok(PHASE_TEXT[k]);
});

// ---------- arousal ----------
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const iso = (sec, base = T0) => new Date(base + sec * 1000).toISOString();
let ns = 0;
function nap({ condition = 'A', base = T0 + ns * 864e5, cues, extra = [], rounds, speed = 1, rehearsal = false, status = 'complete', adaptive = true, script = 'h2023' } = {}) {
  ns++;
  const events = [];
  cues.forEach((c, i) => {
    events.push({ t: iso(c.at ?? i * 400, base), type: 'cue', phase: 'hypnagogia', round: i + 1, volume: c.volume });
    events.push({ t: iso((c.at ?? i * 400) + (c.wakeAfter ?? 120), base), type: 'wake', round: i + 1 });
  });
  events.push(...extra.map((e) => ({ ...e, t: iso(e.at, base) })));
  return {
    id: `n${ns}`, studyId: 'st', condition, status, rehearsal, startedAt: iso(0, base),
    params: { speed, audio: { adaptiveVolume: adaptive }, protocol: { script } }, events,
    rounds: rounds || cues.map((c, i) => ({ round: i + 1, cueWoke: c.answer ?? null })),
  };
}

test('cueArousals: tap window, answer, motion not used for woke', () => {
  const s = nap({
    cues: [{ volume: 0.6, answer: 'no' }, { volume: 0.5, answer: 'yes' }, { volume: 0.4, answer: 'no' }, { volume: 0.3 }],
    extra: [
      { at: 30, type: 'tap' },              // 30 s after cue 1 -> tap
      { at: 400 + 90, type: 'tap' },        // after cue 2 wake at 520? wake at 520, tap at 490 -> but beyond 60 s window
      { at: 800 + 10, type: 'motion' },     // motion only for cue 3
      { at: 1200 + 130, type: 'tap' },      // after cue 4's wake (1320) -> not counted
    ],
  });
  const rows = cueArousals(s);
  assert.equal(rows.length, 4);
  assert.equal(AROUSAL_WINDOW_SEC, 60);
  assert.deepEqual(rows[0], { sessionId: s.id, round: 1, t: iso(0, T0 + (ns - 1) * 864e5), volume: 0.6, tap: true, motion: false, answer: 'no', woke: true, unknown: false });
  assert.equal(rows[1].tap, false);
  assert.equal(rows[1].answer, 'yes');
  assert.equal(rows[1].woke, true, 'answer yes counts');
  assert.equal(rows[2].motion, true);
  assert.equal(rows[2].woke, false, 'motion alone is not a wake');
  assert.equal(rows[3].tap, false, 'tap after the next wake event is excluded');
  assert.equal(rows[3].answer, null);
  assert.equal(rows[3].woke, false);
  assert.equal(rows[3].unknown, true, 'no tap and no answer is unknown, not a non-wake');
  assert.equal(rows[2].unknown, false, 'answer no is a known non-wake');
  assert.equal(cueArousals(nap({ cues: [{ volume: 0.5, answer: 'unsure' }] }))[0].unknown, true);

  // wake event cuts the window short: tap 50 s after cue but wake at 40 s
  const cut = nap({ cues: [{ volume: 0.5, wakeAfter: 40 }], extra: [{ at: 50, type: 'tap' }] });
  assert.equal(cueArousals(cut)[0].tap, false);
  // return cues (not hypnagogia) are not rows
  const withReturn = nap({ cues: [{ volume: 0.5 }] });
  withReturn.events.push({ t: iso(300, T0), type: 'cue', phase: 'return', round: 1, volume: 0.5 });
  assert.equal(cueArousals(withReturn).length, 1);
});

test('volumeTable: buckets by 0.05, analyzable sleep naps only', () => {
  const good = nap({ cues: [{ volume: 0.61, answer: 'yes' }, { volume: 0.6, answer: 'no' }, { volume: 0.42, answer: 'no' }], extra: [{ at: 800 + 5, type: 'motion' }] });
  const tapped = nap({ condition: 'B', cues: [{ volume: 0.59 }], extra: [{ at: 20, type: 'tap' }] });
  const ignored = [
    nap({ cues: [{ volume: 0.6, answer: 'yes' }], rehearsal: true }),
    nap({ cues: [{ volume: 0.6, answer: 'yes' }], speed: 20 }),
    nap({ cues: [{ volume: 0.6, answer: 'yes' }], status: 'running' }),
    nap({ condition: 'plain', cues: [{ volume: 0.6, answer: 'yes' }] }),
    nap({ condition: 'WA', cues: [{ volume: 0.6, answer: 'yes' }] }),
  ];
  // aborted sleep naps count (a cue that woke you and ended the session); unknown cues are counted separately
  const aborted = nap({ cues: [{ volume: 0.2, answer: 'yes' }], status: 'aborted' });
  const unk = nap({ cues: [{ volume: 0.8 }, { volume: 0.8, answer: 'unsure' }, { volume: 0.8, answer: 'no' }] });
  const table = volumeTable([good, tapped, aborted, unk, ...ignored]);
  assert.deepEqual(table.map((r) => r.volume), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(table.find((r) => r.volume === 0.2).woke, 1);
  const r80 = table.find((r) => r.volume === 0.8);
  assert.deepEqual([r80.cues, r80.woke, r80.unknown, r80.wakeRate], [3, 0, 2, 0]);
  assert.equal(table.find((r) => r.volume === 0.6).unknown, 0);
  const r60 = table.find((r) => r.volume === 0.6);
  assert.equal(r60.cues, 3);
  assert.equal(r60.woke, 2);
  assert.ok(Math.abs(r60.wakeRate - 2 / 3) < 1e-9);
  const r40 = table.find((r) => r.volume === 0.4);
  assert.deepEqual([r40.cues, r40.woke, r40.wakeRate, r40.motion], [1, 0, 0, 1]);
  assert.deepEqual(volumeTable([]), []);
});

test('nextCueVolume: steps, clamp, chronological order, convergence', () => {
  const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  assert.equal(nextCueVolume([], { start: 0.6 }).volume, 0.6);
  assert.deepEqual(nextCueVolume([], { start: 0.6 }).history, []);

  const woke = nap({ cues: [{ volume: 0.6, answer: 'yes' }] });
  approx(nextCueVolume([woke], { start: 0.6 }).volume, 0.52);
  const slept = nap({ cues: [{ volume: 0.6, answer: 'no' }] });
  approx(nextCueVolume([slept], { start: 0.6 }).volume, 0.62);

  // clamp to max and min
  const many = (answer, k) => nap({ cues: Array.from({ length: k }, () => ({ volume: 0.5, answer })) });
  assert.equal(nextCueVolume([many('no', 30)], { start: 0.7, max: 0.8 }).volume, 0.8);
  assert.equal(nextCueVolume([many('yes', 30)], { start: 0.7 }).volume, 0.1);
  assert.equal(nextCueVolume([many('yes', 30)], { start: 0.7, min: 0.2 }).volume, 0.2);
  assert.equal(nextCueVolume([], { start: 0.95, max: 0.8 }).volume, 0.8, 'start is clamped');

  // chronological by event time, not array order: early 'yes' then late 'no'
  const early = nap({ base: T0, cues: [{ volume: 0.6, answer: 'yes' }] });
  const late = nap({ base: T0 + 5 * 864e5, cues: [{ volume: 0.6, answer: 'no' }] });
  const a = nextCueVolume([late, early], { start: 0.5 });
  const b = nextCueVolume([early, late], { start: 0.5 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.history.map((h) => h.woke), [true, false]);
  approx(a.volume, 0.5 - 0.08 + 0.02);
  // v1-script and non-adaptive sessions never step the staircase; aborted sessions do
  assert.equal(nextCueVolume([nap({ cues: [{ volume: 0.6, answer: 'yes' }], script: 'v1' })], { start: 0.5 }).volume, 0.5);
  assert.equal(nextCueVolume([nap({ cues: [{ volume: 0.6, answer: 'yes' }], adaptive: false })], { start: 0.5 }).volume, 0.5);
  approx(nextCueVolume([nap({ cues: [{ volume: 0.6, answer: 'yes' }], status: 'aborted' })], { start: 0.5 }).volume, 0.42);
  // unknown cues (no tap, answer missing or unsure) make no step
  const unk2 = nextCueVolume([nap({ cues: [{ volume: 0.6 }, { volume: 0.6, answer: 'unsure' }, { volume: 0.6, answer: 'no' }] })], { start: 0.5 });
  approx(unk2.volume, 0.52);
  assert.equal(unk2.history.length, 1);
  // ineligible sessions are ignored
  assert.equal(nextCueVolume([nap({ cues: [{ volume: 0.6, answer: 'yes' }], rehearsal: true })], { start: 0.5 }).volume, 0.5);

  // convergence: a deterministic sleeper who wakes above threshold hovers just around it
  const thr = 0.45;
  const sessions = [];
  let vol = 0.8;
  for (let i = 0; i < 40; i++) {
    const answer = vol > thr ? 'yes' : 'no';
    sessions.push(nap({ base: T0 + i * 864e5, cues: [{ volume: vol, answer }] }));
    vol = nextCueVolume(sessions, { start: 0.8 }).volume;
  }
  assert.ok(vol > thr - 0.1 && vol < thr + 0.05, `settled at ${vol}`);
  const hist = nextCueVolume(sessions, { start: 0.8 }).history;
  const tail = hist.slice(-10);
  const rate = tail.filter((h) => h.woke).length / tail.length;
  assert.ok(Math.abs(rate - 0.2) <= 0.1, `tail wake rate ${rate}`);
});

// ---------- scoring CSV ----------
const forest = mkTarget('tA', { environment: 'a purple forest', emotion: 'awe', related: 'violet trees woods' });
const ocean = mkTarget('tB', { environment: 'an ocean of light', related: 'water waves glowing' });
const study = { id: 'st', seed: 9, targetIds: { A: 'tA', B: 'tB' } };
let nr = 0;
function rated(condition, transcript, blind) {
  nr++;
  return {
    id: `r${nr}`, studyId: 'st', condition, status: 'complete', rehearsal: false, startedAt: iso(0, T0 + nr * 864e5),
    params: { speed: 1 }, rounds: [{ round: 1, transcript, state: 'drifting' }], blind: blind || null,
  };
}

test('rubric text and CSV round-trip, with and without emotion columns', () => {
  assert.equal(RUBRIC.length, 4);
  assert.ok(RUBRIC.every((r) => /Ignore the feeling/.test(r.desc)));
  assert.deepEqual(EMOTION_RUBRIC.map((r) => r.label), ['Absent', 'Faint', 'Clear', 'Dominant']);

  const ss = [rated('A', 'purple trees'), rated('B', 'warm water')];
  const csv = blindPacketCSV(ss, study, [forest, ocean]);
  const rows = parseCSV(csv);
  assert.deepEqual(rows[0], ['code', 'target_A', 'target_B', 'emotion_A_target', 'emotion_B_target', 'report', 'idea_A', 'idea_B', 'emotion_A', 'emotion_B']);
  assert.ok(rows.slice(1).every((r) => r[3] === 'awe' && r[4] === ''));
  assert.ok(!/\b(WB|control|2026-)\b/.test(csv));

  // with emotion columns: blank emotion_B -> null
  rows[1][6] = '3'; rows[1][7] = '0'; rows[1][8] = '2'; rows[1][9] = '';
  rows[2][6] = '1'; rows[2][7] = '2'; rows[2][8] = ''; rows[2][9] = '';
  const res = parseScoresCSV(toCSV(rows), ss, study);
  assert.deepEqual(res.errors, []);
  assert.equal(res.updates.length, 2);
  const u1 = res.updates.find((u) => u.A === 3);
  assert.deepEqual(u1, { sessionId: u1.sessionId, A: 3, B: 0, emoA: 2, emoB: null });
  const u2 = res.updates.find((u) => u.A === 1);
  assert.deepEqual([u2.B, u2.emoA, u2.emoB], [2, null, null]);

  // legacy score_A/score_B, no emotion columns
  const legacy = parseScoresCSV(`code,score_A,score_B\r\n${rows[1][0]},2,1\r\n`, ss, study);
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(legacy.updates.map((u) => [u.A, u.B, u.emoA, u.emoB]), [[2, 1, null, null]]);
  // new headers without emotion columns
  const noEmo = parseScoresCSV(`code,idea_A,idea_B\r\n${rows[1][0]},0,3\r\n`, ss, study);
  assert.deepEqual(noEmo.updates.map((u) => [u.A, u.B, u.emoA, u.emoB]), [[0, 3, null, null]]);

  // rejects
  assert.equal(parseScoresCSV(`code,idea_A,idea_B,emotion_A,emotion_B\r\n${rows[1][0]},1,1,4,0\r\n`, ss, study).updates.length, 0);
  assert.equal(parseScoresCSV(`code,idea_A,idea_B,emotion_A,emotion_B\r\n${rows[1][0]},1,1,1.5,0\r\n`, ss, study).errors.length, 1);
  assert.equal(parseScoresCSV(`code,idea_A,idea_B,emotion_A,emotion_B\r\n${rows[1][0]},1,,0,0\r\n`, ss, study).updates.length, 0);
  assert.equal(parseScoresCSV(`code,idea_A,idea_B,emotion_A,emotion_B\r\n${rows[1][0]},,,,\r\n`, ss, study).errors.length, 0, 'blank row is unscored');
  assert.equal(parseScoresCSV('code,foo\r\n', ss, study).errors.length, 1);
});

// ---------- analysis ----------
test('analyzeStudy: emotion and link blocks; existing outputs unchanged', () => {
  const targets = [forest, ocean];
  const mk = (cond, idea, emoA, emoB) => rated(cond, 'some report', { A: idea[0], B: idea[1], emoA, emoB });
  const ss = [
    mk('A', [3, 0], 3, 0), mk('A', [2, 1], 2, 1), mk('A', [3, 1], 1, 2), mk('A', [1, 1], 0, 0),
    mk('B', [0, 3], 0, 3), mk('B', [1, 2], 1, 2), mk('B', [2, 2], 2, 2), mk('B', [0, 2], null, null),
    mk('control', [0, 0], 0, 0),
  ];
  const r = analyzeStudy(study, ss, targets);
  assert.equal(r.primary.nA, 4);
  assert.equal(r.primary.nB, 4);
  assert.ok(r.specificity && r.table && r.safety, 'existing blocks present');

  // emotion: d(A)= [3,1,-1,0] mean .75 ; d(B)= [-3,-1,0] mean -4/3 (null session dropped)
  assert.equal(r.emotion.primary.nA, 4);
  assert.equal(r.emotion.primary.nB, 3);
  assert.ok(Math.abs(r.emotion.primary.meanDA - 0.75) < 1e-9);
  assert.ok(Math.abs(r.emotion.primary.meanDB + 4 / 3) < 1e-9);
  assert.ok(Math.abs(r.emotion.primary.effect - (0.75 + 4 / 3)) < 1e-9);
  assert.ok(r.emotion.primary.p > 0 && r.emotion.primary.p <= 1);
  // specificity: A-cued: 3>0 hit, 2>1 hit, 1<2 miss, 0=0 tie ; B-cued: 3>0 hit, 2>1 hit, 2=2 tie
  assert.deepEqual([r.emotion.specificity.hits, r.emotion.specificity.misses, r.emotion.specificity.ties, r.emotion.specificity.decisive], [4, 1, 2, 5]);

  // link over cued sessions with both cued scores (7): idea/emotion of the cued target
  // A: (3,3) both; (2,2) both; (3,1) ideaOnly; (1,0) neither. B: (3,3) both; (2,2) both; (2,2) both.
  assert.deepEqual(
    [r.link.n, r.link.bothLanded, r.link.ideaOnly, r.link.emotionOnly, r.link.neither],
    [7, 5, 1, 0, 1],
  );
  assert.ok(Math.abs(r.link.meanIdeaWhenEmotion - (3 + 2 + 3 + 2 + 2) / 5) < 1e-9);
  assert.ok(Math.abs(r.link.meanIdeaWhenNoEmotion - 2) < 1e-9);

  // legacy sessions without emotion scores give empty blocks and leave the rest alone
  const old = [mk('A', [3, 0]), mk('B', [0, 3])].map((s) => ({ ...s, blind: { A: s.blind.A, B: s.blind.B } }));
  const ro = analyzeStudy(study, old, targets);
  assert.equal(ro.emotion.n, 0);
  assert.equal(ro.link.n, 0);
  assert.ok(Number.isNaN(ro.link.meanIdeaWhenEmotion));
  assert.equal(ro.primary.nA, 1);

  // emotion-without-idea cases (emotionOnly)
  const eo = analyzeStudy(study, [mk('A', [0, 0], 3, 0), mk('B', [0, 0], 0, 3)], targets);
  assert.equal(eo.link.emotionOnly, 2);
});
