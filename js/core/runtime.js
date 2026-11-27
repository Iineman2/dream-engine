// Pure helpers for the v0.4 session runtime: which spoken lines a session uses
// and which recording each line plays from, the own-voice checklist, the
// pre-sleep binding step, and motion detection for per-cue arousal logging.
// No DOM, no audio: the app and the runner call these.

import { scriptLines, SCRIPT_H2023 } from './protocol.js';
import { NEUTRAL, startPhraseOf } from './compiler.js';
import { conditionInfo } from './study.js';

export const LINE_KEYS = ['start', 'cue', 'alert', 'stateAsk', 'back'];

// Item 4: the binding step.
export const BIND_SEC = 120;
export const BIND_PLAYS = [{ at: 0, line: 'start' }, { at: 40, line: 'cue' }, { at: 80, line: 'cue' }];

// Item 2: motion. Magnitude of (accelerationIncludingGravity - low-pass gravity).
export const MOTION_THRESHOLD = 1.5; // m/s^2
export const MOTION_GAP_MS = 2000; // at most one logged event per 2 s
export const MOTION_ALPHA = 0.8; // low-pass smoothing for the gravity estimate
export const MOTION_WAIT_MS = 5000; // no readings by then -> 'motion-unavailable'

// The protocol a study created now would get (spec: versioning rule).
export function newStudyProtocol(settings) {
  return { script: settings?.scriptVersion === 'v1' ? 'v1' : 'h2023', binding: !!settings?.bindingStep, emotionScores: true };
}

// Recording id for a scriptLines() voice key.
export function voiceIdFor(key, target, settings) {
  if (!key) return null;
  if (key === 'target.voiceId') return target?.voiceId || null;
  if (key === 'target.startVoiceId') return target?.startVoiceId || null;
  if (key === 'neutralVoiceId' || key === 'wakeVoiceId') return settings?.[key] || null;
  return settings?.scriptVoiceIds?.[key] || null;
}

// The spoken lines of one session: { start, cue, alert, stateAsk, back }, each
// { text, voiceKey, voiceId } or null when the script has no such line.
// voiceId is only filled in own-voice mode; a null voiceId means TTS.
export function sessionLines({ protocol, condition, target = null, settings, own = false }) {
  const info = conditionInfo(condition);
  const sl = scriptLines({ protocol, state: info.state, isControl: !target, target });
  const out = {};
  for (const k of LINE_KEYS) {
    const text = sl[k];
    const voiceKey = sl.voiceKeys[k] || null;
    out[k] = text ? { text, voiceKey, voiceId: own ? voiceIdFor(voiceKey, target, settings) : null } : null;
  }
  return out;
}

export const needsBinding = (protocol, condition) => protocol?.script === 'h2023' && !!protocol.binding && !conditionInfo(condition).plain;

// "Think of a purple forest." -> "a purple forest"
export function targetCore(target) {
  return startPhraseOf(target).replace(/^\s*think of\s+/i, '').replace(/[.!?]+$/, '').trim();
}

// What the binding screen shows and asks.
export function bindingScreen(target) {
  if (!target) {
    return { variant: 'control', text: SCRIPT_H2023.controlStart, questions: [{ key: 'calm', label: 'How calm do you feel?' }] };
  }
  const core = targetCore(target);
  const emotion = String(target.dims?.emotion || '').trim();
  return {
    variant: 'target',
    core,
    emotion,
    text: emotion ? `Picture ${core}. Let yourself feel ${emotion}.` : `Picture ${core}.`,
    questions: [...(emotion ? [{ key: 'feel', label: `How strongly did you feel ${emotion}?` }] : []), { key: 'vivid', label: `How vivid was ${core}?` }],
  };
}

const SCRIPT_LABELS = {
  alert: 'Wake prompt',
  alertWake: 'Wake prompt, stay-awake sessions',
  stateAsk: 'State question',
  back: 'Fall back asleep',
  controlStart: 'Control: start',
  controlCue: 'Control: cue',
};

// Every recordable line a study (or a new study, with kind 'steer' and all
// targets) uses. rec = { kind, id } names the slot the app records into.
export function voiceChecklist({ protocol, kind = 'steer', targets = [], settings }) {
  const rows = [];
  const add = (id, label, text, rec, voiceId) => rows.push({ id, label, text, rec, voiceId: voiceId || null });
  if (protocol?.script === 'h2023') {
    const ids = settings?.scriptVoiceIds || {};
    // Phase 2 has stay-awake sessions but no control condition.
    const keys = kind === 'benefit' ? ['alert', 'alertWake', 'stateAsk', 'back'] : ['alert', 'stateAsk', 'back', 'controlStart', 'controlCue'];
    for (const k of keys) add(`script:${k}`, SCRIPT_LABELS[k], SCRIPT_H2023[k], { kind: 'script', id: k }, ids[k]);
    for (const t of targets) {
      const sl = scriptLines({ protocol, state: 'sleep', target: t });
      add(`start:${t.id}`, `${t.label}: start`, sl.start, { kind: 'target-start', id: t.id }, t.startVoiceId);
      add(`cue:${t.id}`, `${t.label}: cue`, sl.cue, { kind: 'target', id: t.id }, t.voiceId);
    }
  } else {
    if (kind !== 'benefit') add('neutral', 'Neutral cue', NEUTRAL.cuePhrase, { kind: 'neutral', id: '' }, settings?.neutralVoiceId);
    add('wake', 'Wake prompt', NEUTRAL.wakePhrase, { kind: 'wake', id: '' }, settings?.wakeVoiceId);
    for (const t of targets) add(`cue:${t.id}`, `${t.label}: cue`, t.cuePhrase || NEUTRAL.cuePhrase, { kind: 'target', id: t.id }, t.voiceId);
  }
  return rows;
}

// Returns push(a, nowMs, armed) -> magnitude when a motion event should be
// logged, else null. Gravity is tracked on every reading; events are only
// emitted while armed (the runner arms it during wait steps) and throttled.
export function motionDetector({ threshold = MOTION_THRESHOLD, gapMs = MOTION_GAP_MS, alpha = MOTION_ALPHA } = {}) {
  let g = null;
  let last = -Infinity;
  return (a, now, armed = true) => {
    if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return null;
    if (!g) { g = { x: a.x, y: a.y, z: a.z }; return null; }
    g = { x: alpha * g.x + (1 - alpha) * a.x, y: alpha * g.y + (1 - alpha) * a.y, z: alpha * g.z + (1 - alpha) * a.z };
    const m = Math.hypot(a.x - g.x, a.y - g.y, a.z - g.z);
    if (!armed || m <= threshold || now - last < gapMs) return null;
    last = now;
    return m;
  };
}
