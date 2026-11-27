// v0.4 integration helpers: session lines and voices, the own-voice
// checklist, binding content, motion detection, and the new export columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileTarget, NEUTRAL } from '../js/core/compiler.js';
import { SCRIPT_H2023 } from '../js/core/protocol.js';
import { V1_PROTOCOL, DEFAULT_PROTOCOL, createStudy } from '../js/core/study.js';
import { DEFAULT_SETTINGS, emptyState } from '../js/core/schema.js';
import { sessionRows, trialRows } from '../js/core/trials.js';
import {
  newStudyProtocol, voiceIdFor, sessionLines, needsBinding, targetCore, bindingScreen, voiceChecklist,
  motionDetector, BIND_SEC, BIND_PLAYS, MOTION_THRESHOLD,
} from '../js/core/runtime.js';

const forest = { id: 'tA', voiceId: 'v_cueA', startVoiceId: 'v_startA', ...compileTarget({ label: 'purple forest', environment: 'a purple forest', emotion: 'awe' }).target };
const ocean = { id: 'tB', voiceId: null, ...compileTarget({ label: 'ocean of light', environment: 'an ocean of light', sensation: 'floating' }).target };
// A target saved by v0.3: emotion clause in the cue, no startPhrase.
const oldForest = { id: 'tOld', voiceId: null, label: 'purple forest', dims: { environment: 'a purple forest', emotion: 'awe' }, cuePhrase: 'Remember to think of a purple forest, and feel awe.', lexicon: [], motif: [67, 69, 72] };
const settings = { ...structuredClone(DEFAULT_SETTINGS), neutralVoiceId: 'v_neutral', wakeVoiceId: 'v_wake', scriptVoiceIds: { ...DEFAULT_SETTINGS.scriptVoiceIds, alert: 'v_alert', controlCue: 'v_ccue' } };
const H = { ...DEFAULT_PROTOCOL };

test('newStudyProtocol follows the settings; emotion scores always on', () => {
  assert.deepEqual(newStudyProtocol(DEFAULT_SETTINGS), { script: 'h2023', binding: true, emotionScores: true });
  assert.deepEqual(newStudyProtocol({ scriptVersion: 'v1', bindingStep: false }), { script: 'v1', binding: false, emotionScores: true });
});

test('voiceIdFor maps scriptLines voice keys to recordings', () => {
  assert.equal(voiceIdFor('target.voiceId', forest, settings), 'v_cueA');
  assert.equal(voiceIdFor('target.startVoiceId', forest, settings), 'v_startA');
  assert.equal(voiceIdFor('target.startVoiceId', ocean, settings), null);
  assert.equal(voiceIdFor('neutralVoiceId', null, settings), 'v_neutral');
  assert.equal(voiceIdFor('alert', null, settings), 'v_alert');
  assert.equal(voiceIdFor('stateAsk', null, settings), null);
  assert.equal(voiceIdFor(null, null, settings), null);
});

test('sessionLines: h2023 per condition, per-line own voice with TTS fallback', () => {
  const a = sessionLines({ protocol: H, condition: 'A', target: forest, settings, own: true });
  assert.equal(a.start.text, 'Think of a purple forest.');
  assert.equal(a.cue.text, 'Remember to think of a purple forest.');
  assert.equal(a.alert.text, SCRIPT_H2023.alert);
  assert.equal(a.stateAsk.text, SCRIPT_H2023.stateAsk);
  assert.equal(a.back.text, SCRIPT_H2023.back);
  assert.deepEqual([a.start.voiceId, a.cue.voiceId, a.alert.voiceId, a.stateAsk.voiceId, a.back.voiceId], ['v_startA', 'v_cueA', 'v_alert', null, null]);
  const tts = sessionLines({ protocol: H, condition: 'A', target: forest, settings, own: false });
  assert.ok(Object.values(tts).every((l) => l.voiceId === null), 'device-voice mode never uses recordings');

  const c = sessionLines({ protocol: H, condition: 'control', target: null, settings, own: true });
  assert.equal(c.start.text, SCRIPT_H2023.controlStart);
  assert.equal(c.cue.text, SCRIPT_H2023.controlCue);
  assert.equal(c.cue.voiceId, 'v_ccue');

  const w = sessionLines({ protocol: H, condition: 'WA', target: forest, settings, own: true });
  assert.equal(w.alert.text, SCRIPT_H2023.alertWake);
  assert.equal(w.stateAsk, null);
  assert.equal(w.back, null);

  const old = sessionLines({ protocol: H, condition: 'A', target: oldForest, settings });
  assert.equal(old.start.text, 'Think of a purple forest.', 'old targets derive the start line');
});

test('sessionLines: v1 keeps the v0.3 lines and voices', () => {
  const a = sessionLines({ protocol: V1_PROTOCOL, condition: 'A', target: oldForest, settings, own: true });
  assert.equal(a.start, null);
  assert.equal(a.stateAsk, null);
  assert.equal(a.back, null);
  assert.equal(a.cue.text, oldForest.cuePhrase);
  assert.equal(a.alert.text, NEUTRAL.wakePhrase);
  assert.equal(a.alert.voiceId, 'v_wake');
  const c = sessionLines({ protocol: V1_PROTOCOL, condition: 'control', target: null, settings, own: true });
  assert.equal(c.cue.text, NEUTRAL.cuePhrase);
  assert.equal(c.cue.voiceId, 'v_neutral');
});

test('needsBinding: h2023 with binding, incubation sessions only', () => {
  for (const c of ['A', 'B', 'control', 'SA', 'SB', 'WA', 'WB']) assert.equal(needsBinding(H, c), true, c);
  assert.equal(needsBinding(H, 'plain'), false);
  assert.equal(needsBinding({ ...H, binding: false }, 'A'), false);
  assert.equal(needsBinding({ script: 'v1', binding: true, emotionScores: true }, 'A'), false, 'no binding on the v1 script');
  assert.equal(needsBinding(V1_PROTOCOL, 'A'), false);
  assert.equal(BIND_SEC, 120);
  assert.deepEqual(BIND_PLAYS.map((p) => [p.at, p.line]), [[0, 'start'], [40, 'cue'], [80, 'cue']]);
});

test('bindingScreen: target with and without emotion, control', () => {
  assert.equal(targetCore(forest), 'a purple forest');
  const a = bindingScreen(forest);
  assert.equal(a.text, 'Picture a purple forest. Let yourself feel awe.');
  assert.deepEqual(a.questions.map((q) => q.key), ['feel', 'vivid']);
  assert.equal(a.questions[0].label, 'How strongly did you feel awe?');
  assert.equal(a.questions[1].label, 'How vivid was a purple forest?');
  const b = bindingScreen(ocean);
  assert.equal(b.text, 'Picture an ocean of light.');
  assert.deepEqual(b.questions.map((q) => q.key), ['vivid']);
  const c = bindingScreen(null);
  assert.equal(c.variant, 'control');
  assert.equal(c.text, 'Observe your thoughts.');
  assert.deepEqual(c.questions.map((q) => q.key), ['calm']);
});

test('voiceChecklist: lines per protocol and study kind', () => {
  const steer = voiceChecklist({ protocol: H, kind: 'steer', targets: [forest, ocean], settings });
  assert.deepEqual(steer.map((r) => r.id), ['script:alert', 'script:stateAsk', 'script:back', 'script:controlStart', 'script:controlCue', 'start:tA', 'cue:tA', 'start:tB', 'cue:tB']);
  assert.deepEqual(steer.filter((r) => r.voiceId).map((r) => r.id), ['script:alert', 'script:controlCue', 'start:tA', 'cue:tA']);
  assert.equal(steer.find((r) => r.id === 'start:tB').text, 'Think of an ocean of light.');
  assert.deepEqual(steer.find((r) => r.id === 'start:tB').rec, { kind: 'target-start', id: 'tB' });
  const benefit = voiceChecklist({ protocol: H, kind: 'benefit', targets: [forest, ocean], settings });
  assert.deepEqual(benefit.slice(0, 4).map((r) => r.id), ['script:alert', 'script:alertWake', 'script:stateAsk', 'script:back']);
  const v1 = voiceChecklist({ protocol: V1_PROTOCOL, kind: 'steer', targets: [oldForest], settings });
  assert.deepEqual(v1.map((r) => [r.id, r.voiceId]), [['neutral', 'v_neutral'], ['wake', 'v_wake'], ['cue:tOld', null]]);
});

test('motionDetector: low-pass gravity, threshold, throttle, armed only', () => {
  const d = motionDetector();
  const still = { x: 0, y: 0.2, z: 9.8 };
  assert.equal(d(still, 0), null, 'first reading only seeds gravity');
  for (let i = 1; i <= 20; i++) assert.equal(d(still, i * 50), null, 'a still phone never fires');
  assert.equal(d({ x: null, y: 1, z: 2 }, 1100), null, 'null readings are ignored');
  const kick = { x: 4, y: 0.2, z: 9.8 };
  const m = d(kick, 1200);
  assert.ok(m > MOTION_THRESHOLD, `kick fires (${m})`);
  assert.equal(d(kick, 1300), null, 'throttled within 2 s');
  for (let i = 0; i < 30; i++) d(still, 1400 + i * 50);
  assert.ok(d(kick, 3300) > MOTION_THRESHOLD, 'fires again after 2 s');
  const e = motionDetector();
  e(still, 0);
  assert.equal(e(kick, 5000, false), null, 'not armed outside wait steps');
  assert.ok(e(kick, 5100, true) > MOTION_THRESHOLD, 'disarmed readings do not consume the throttle');
  const small = motionDetector();
  small(still, 0);
  assert.equal(small({ x: 1, y: 0.2, z: 9.8 }, 100), null, 'below 1.5 m/s^2 after smoothing');
});

test('exports: trial cue_* columns, session bind_* and emotion columns', () => {
  const study = createStudy({ targetAId: forest.id, targetBId: ocean.id, blocks: 2, seed: 5 });
  const t = (s) => new Date(Date.UTC(2026, 10, 3, 13, 0, s)).toISOString();
  const session = {
    id: 's1', studyId: study.id, index: 0, condition: 'A', targetId: forest.id, rehearsal: false,
    params: { rounds: 2, speed: 1, protocol: { ...H }, audio: { voiceMode: 'tts', cueVolume: 0.55, wakeVolume: 0.85, ttsRate: 0.85, motif: false, adaptiveVolume: true } },
    status: 'complete', startedAt: t(0), endedAt: t(59),
    events: [
      { t: t(0), type: 'start' },
      { t: t(1), type: 'cue', phase: 'hypnagogia', round: 1, volume: 0.55 },
      { t: t(5), type: 'tap' },
      { t: t(10), type: 'wake', round: 1 },
      { t: t(11), type: 'record-stop', phase: 'report', round: 1, bytes: 100 },
      { t: t(12), type: 'record-stop', phase: 'state', round: 1, bytes: 40 },
      { t: t(13), type: 'cue', phase: 'return', round: 1, volume: 0.55 },
      { t: t(20), type: 'cue', phase: 'hypnagogia', round: 2, volume: 0.55 },
      { t: t(22), type: 'motion', mag: 2.1 },
      { t: t(30), type: 'wake', round: 2 },
      { t: t(31), type: 'record-stop', phase: 'report', round: 2, bytes: 90 },
      { t: t(32), type: 'record-stop', phase: 'state', round: 2, bytes: 30 },
    ],
    rounds: [
      { round: 1, audioId: 'a1', stateAudioId: 'a1s', transcript: 'trees', state: 'drifting', cueWoke: 'no' },
      { round: 2, audioId: 'a2', stateAudioId: null, transcript: 'water', state: 'asleep', cueWoke: 'unsure' },
    ],
    morning: { at: t(59), report: '', disruption: 1 },
    blind: { A: 2, B: 0, emoA: 3, emoB: null, at: t(59), rater: 'self' },
    binding: { sec: 120, plays: [], feel: 7, vivid: 6, at: t(0) },
  };
  const state = { ...emptyState(), targets: [forest, ocean], studies: [study], sessions: [session] };
  const [row] = sessionRows(state);
  assert.equal(row.script, 'h2023');
  assert.equal(row.cue_volume, 0.55);
  assert.equal(row.adaptive_volume, 1);
  assert.deepEqual([row.bind_feel, row.bind_vivid, row.bind_calm], [7, 6, null]);
  assert.deepEqual([row.blind_emo_A, row.blind_emo_B], [3, null]);
  const rows = trialRows(state);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.round, r.cue_volume, r.cue_woke, r.cue_tap, r.cue_motion, r.cue_arousal]), [[1, 0.55, 'no', 1, 0, 1], [2, 0.55, 'unsure', 0, 1, 0]]);
  assert.deepEqual(rows.map((r) => [r.audio_bytes, r.state_audio_bytes, r.has_state_audio]), [[100, 40, 1], [90, 30, 0]], 'the state clip does not overwrite the report clip');
  assert.deepEqual(rows.map((r) => r.cues_in_round), [1, 2], 'return cue still counts toward the next round');

  // A v0.3 session (no protocol, no arousal data) exports blanks, not errors.
  const old = { ...session, id: 's0', params: { ...session.params, protocol: undefined }, binding: undefined, blind: { A: 1, B: 0 }, events: [], rounds: [{ round: 1, transcript: 'x', state: 'awake' }] };
  const [orow] = sessionRows({ ...state, sessions: [old] });
  assert.deepEqual([orow.script, orow.bind_feel, orow.blind_emo_A], ['', null, null]);
  const [otr] = trialRows({ ...state, sessions: [old] });
  assert.deepEqual([otr.cue_volume, otr.cue_woke, otr.cue_tap, otr.cue_arousal], [null, '', null, null]);
});
