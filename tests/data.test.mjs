import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WORDS, makePairs, makeTest, scoreResponses, memorySummary } from '../js/core/memory.js';
import { sessionRows, trialRows, rowsToCSV, associations, parseMetricsCSV, mergeMetrics, localDate, addDays, metricKey } from '../js/core/trials.js';
import { spearman } from '../js/core/stats.js';
import { compileTarget } from '../js/core/compiler.js';
import { stem } from '../js/core/text.js';
import { parseCSV } from '../js/core/scoring.js';
import { migrate, emptyState, validateImport, DEFAULT_SETTINGS } from '../js/core/schema.js';

const T = (id, input) => ({ id, ...compileTarget(input).target });
const forest = T('tA', { label: 'purple forest', environment: 'a purple forest', related: 'violet trees woods' });
const ocean = T('tB', { label: 'ocean of light', environment: 'an ocean of light', related: 'water waves' });

// ---------- memory task ----------
test('word pairs: unique words, seeded, and target words excluded', () => {
  assert.equal(new Set(WORDS).size, WORDS.length);
  const ex = ['candle', 'horse', 'piano'].map(stem);
  const p = makePairs(42, 16, ex);
  const used = p.flatMap((x) => [x.cue, x.answer]);
  assert.equal(p.length, 16);
  assert.equal(new Set(used).size, 32);
  assert.ok(!used.some((w) => ['candle', 'horse', 'piano'].includes(w)));
  assert.deepEqual(makePairs(42, 16, ex), p);
  assert.throws(() => makePairs(1, 200));
});

test('associative test: options are the answer plus 3 other pairs’ answers', () => {
  const p = makePairs(7, 12);
  const items = makeTest(p, 99);
  const answers = new Set(p.map((x) => x.answer));
  assert.equal(items.length, 12);
  for (const it of items) {
    assert.equal(it.options.length, 4);
    assert.equal(new Set(it.options).size, 4);
    assert.ok(it.options.includes(it.answer));
    assert.ok(it.options.every((o) => answers.has(o)), 'lures must be other studied answers');
    assert.equal(p.find((x) => x.cue === it.cue).answer, it.answer);
  }
  assert.notDeepEqual(makeTest(p, 100).map((x) => x.cue), items.map((x) => x.cue));
});

test('memory scoring and summary', () => {
  const r = scoreResponses([{ correct: true, rtMs: 900 }, { correct: false, rtMs: 1500 }, { correct: true, rtMs: 1100 }, { correct: true, rtMs: 700 }]);
  assert.deepEqual([r.correct, r.n, r.medianRtMs], [3, 4, 1000]);
  const s = memorySummary({ immediate: { at: '2026-11-25T10:00:00Z', correct: 10, n: 16 }, delayed: { at: '2026-11-25T10:45:00Z', correct: 12, n: 16 } });
  assert.equal(s.change, 0.125);
  assert.equal(s.delayMin, 45);
  assert.equal(memorySummary({ immediate: { at: 'x', correct: 4, n: 8 }, delayed: null }).change, null);
  assert.equal(memorySummary(null), null);
});

// ---------- stats ----------
test('spearman: monotone, inverse, ties, missing values', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]).rho, 1);
  assert.equal(spearman([1, 2, 3, 4], [9, 7, 5, 1]).rho, -1);
  const tied = spearman([1, 1, 2, 3], [1, 2, 3, 4]);
  assert.ok(tied.rho > 0.9 && tied.rho < 1);
  const miss = spearman([1, null, 3, 4, ''], [2, 5, 6, null, 1]);
  assert.equal(miss.n, 2);
  assert.ok(Number.isNaN(miss.rho));
});

// ---------- trial / session tables ----------
function fixtureState() {
  const study = { id: 'st1', seed: 1, targetIds: { A: 'tA', B: 'tB' }, schedule: ['A'], acks: [] };
  const t = (h, m, s = 0) => new Date(2026, 10, 25, h, m, s).toISOString();
  const session = {
    id: 's1', studyId: 'st1', index: 0, condition: 'A', targetId: 'tA', rehearsal: false, status: 'complete',
    startedAt: t(14, 0), endedAt: t(14, 40),
    params: { rounds: 2, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: false, armId: 'mid', adaptive: true, speed: 1,
      audio: { voiceMode: 'tts', cueVolume: 0.6, wakeVolume: 0.85, ttsRate: 0.85, motif: false } },
    events: [
      { t: t(14, 0), type: 'start' },
      { t: t(14, 11), type: 'cue', phase: 'hypnagogia', round: 1, played: true },
      { t: t(14, 13), type: 'wake', round: 1 },
      { t: t(14, 13, 5), type: 'record-start', round: 1 },
      { t: t(14, 14, 5), type: 'record-stop', round: 1, bytes: 5000 },
      { t: t(14, 14, 10), type: 'cue', phase: 'return', round: 1, played: false },
      { t: t(14, 19, 10), type: 'cue', phase: 'hypnagogia', round: 2, played: true },
      { t: t(14, 21, 10), type: 'wake', round: 2 },
      { t: t(14, 21, 15), type: 'record-stop', round: 2, bytes: 6000 },
    ],
    rounds: [
      { round: 2, state: 'drifting', transcript: 'violet trees everywhere', audioId: 'a2' },
      { round: 1, state: 'awake', transcript: 'nothing much', audioId: null },
    ],
    morning: { at: t(14, 45), report: 'a purple glow', vividness: 3, valence: 1, intensity: 2, immersion: 3, bizarreness: 1, lucidity: 1, disruption: 1, distressing: false },
    blind: { A: 2, B: 0, rater: 'self' },
    memory: { immediate: { at: t(13, 55), correct: 10, n: 16 }, delayed: { at: t(14, 50), correct: 12, n: 16 } },
  };
  const qa = { ...session, id: 's2', startedAt: t(16, 0), params: { ...session.params, speed: 60 } };
  const rehearsal = { ...session, id: 's3', rehearsal: true };
  return {
    ...emptyState(),
    targets: [forest, ocean],
    studies: [study],
    sessions: [qa, session, rehearsal],
    checkins: [
      { date: '2026-11-25', at: t(8, 0), sleepHours: 7, sleepQuality: 3, mood: 1, sharpness: 3, unreal: 0, confusion: false, substances: true },
      { date: '2026-11-26', at: new Date(2026, 10, 26, 8).toISOString(), mood: 2, sharpness: 4, unreal: 1, confusion: false },
    ],
    metrics: [{ date: '2026-11-25', name: 'Anki retention', value: 0.91 }],
  };
}

test('date helpers work in local time and across month ends', () => {
  assert.equal(localDate(new Date(2026, 10, 25, 23, 59)), '2026-11-25');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(metricKey('Anki retention %'), 'm_anki_retention');
});

test('session table joins stimulus, outcomes, memory, check-ins and metrics', () => {
  const rows = sessionRows(fixtureState());
  assert.equal(rows.length, 2, 'rehearsals are excluded, speeded QA sessions kept but flagged');
  const r = rows.find((x) => x.session_id === 's1');
  assert.equal(rows[0].session_id, 's1', 'sorted by start time');
  assert.equal(r.analyzable, 1);
  assert.equal(rows.find((x) => x.session_id === 's2').analyzable, 0);
  assert.equal(r.date, '2026-11-25');
  assert.equal(r.cued_target, 'purple forest');
  assert.equal(r.n_drifting, 1);
  assert.equal(r.blind_cued, 2);
  assert.equal(r.lex_cued, 3, 'violet + trees + purple');
  assert.equal(r.immersion, 3);
  assert.equal(r.mem_change, 0.125);
  assert.equal(r.mem_delay_min, 55);
  assert.equal(r.sleep_hours_last_night, 7);
  assert.equal(r.substances_same_day, 1);
  assert.equal(r.next_day_mood, 2);
  assert.equal(r.next_day_sharpness, 4);
  assert.equal(r.m_anki_retention, 0.91);
  assert.equal(r.cue_volume, 0.6);
  assert.equal(r.motif, 0);
});

test('trial table: one row per wake-up with the cues that preceded it', () => {
  const rows = trialRows(fixtureState()).filter((x) => x.session_id === 's1');
  assert.deepEqual(rows.map((x) => x.round), [1, 2]);
  const [r1, r2] = rows;
  assert.equal(r1.cues_in_round, 1);
  assert.equal(r1.sec_last_cue_to_wake, 120);
  assert.equal(r1.wake_sec_from_start, 13 * 60);
  assert.equal(r1.state_at_wake, 'awake');
  assert.equal(r1.audio_bytes, 5000);
  assert.equal(r2.cues_in_round, 2, 'return cue after round 1 plus hypnagogia cue of round 2');
  assert.equal(r2.cues_played, 1, 'the failed TTS cue is counted as not played');
  assert.equal(r2.round_lex_cued, 2);
  assert.equal(r2.has_audio, 1);
  assert.equal(r2.mem_change, 0.125, 'session outcomes repeat on each trial row');
});

test('CSV export has a stable header union and blank nulls', () => {
  const csv = rowsToCSV([{ a: 1, b: null }, { a: 2, c: 'x,y' }]);
  const rows = parseCSV(csv);
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['1', '', '']);
  assert.deepEqual(rows[2], ['2', '', 'x,y']);
  const full = parseCSV(rowsToCSV(trialRows(fixtureState())));
  assert.ok(full[0].includes('state_at_wake') && full[0].includes('m_anki_retention') && full[0].includes('next_day_mood'));
});

test('associations need n >= 5 analyzable naps', () => {
  const st = fixtureState();
  assert.ok(associations(sessionRows(st)).every((a) => Number.isNaN(a.rho)));
  const base = st.sessions[1];
  const many = Array.from({ length: 6 }, (_, i) => ({
    ...base, id: `m${i}`, startedAt: new Date(2026, 10, 1 + i, 14).toISOString(),
    rounds: Array.from({ length: i % 3 + 1 }, (_, k) => ({ round: k + 1, state: 'drifting' })),
    memory: { immediate: { at: 'x', correct: 8, n: 16 }, delayed: { at: 'x', correct: 8 + (i % 3), n: 16 } },
  }));
  const a = associations(sessionRows({ ...st, sessions: many })).find((x) => x.x === 'mem_change' && x.y === 'n_drifting');
  assert.equal(a.n, 6);
  assert.equal(a.rho, 1);
});

test('metrics import validates rows and merges by date + metric', () => {
  const res = parseMetricsCSV('date,metric,value\r\n2026-11-25,anki_retention,0.9\r\n25/11/2026,x,1\r\n2026-11-26,,1\r\n2026-11-26,steps,abc\r\n');
  assert.equal(res.items.length, 1);
  assert.equal(res.errors.length, 3);
  assert.deepEqual(parseMetricsCSV('a,b\r\n1,2').errors, ['Expected columns: date, metric, value.']);
  const merged = mergeMetrics([{ date: '2026-11-25', name: 'anki_retention', value: 0.5 }, { date: '2026-11-24', name: 'x', value: 1 }], res.items);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((m) => m.date === '2026-11-25').value, 0.9);
  assert.equal(merged[0].date, '2026-11-24');
});

test('schema v3: research-faithful defaults and migrations', () => {
  assert.equal(DEFAULT_SETTINGS.cueMotif, false);
  assert.equal(DEFAULT_SETTINGS.preSleepCue, false);
  assert.equal(DEFAULT_SETTINGS.memoryTask, false, 'the untargeted memory test is off by default');
  assert.equal(DEFAULT_SETTINGS.pairsPerTheme, 10);
  const v1 = { version: 1, targets: [], studies: [], sessions: [], settings: { preSleepCue: true, rounds: 4, memoryTask: true } };
  const m = migrate(v1);
  assert.equal(m.version, 4);
  assert.equal(m.settings.memoryTask, false);
  const inUse = migrate({ version: 2, targets: [], studies: [], sessions: [{ id: 's', memory: {} }], settings: { memoryTask: true } });
  assert.equal(inUse.settings.memoryTask, true, 'a memory test already in use is not switched off mid-study');
  assert.equal(m.settings.preSleepCue, false);
  assert.equal(m.settings.rounds, 4);
  assert.deepEqual([m.checkins, m.metrics], [[], []]);
  assert.equal(validateImport({ ...emptyState(), checkins: 'nope' }).ok, false);
  assert.ok(validateImport(v1).ok);
});
