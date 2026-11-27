// Session plan builder. Mirrors MIT Dormio's timer protocol
// (christinatchen.github.io/dormio/timer): settle -> fall asleep -> cue ->
// hypnagogia -> wake prompt -> recorded report -> cue -> fall back asleep ...
// with one addition: an optional pre-sleep cue right after settling.

import { NEUTRAL, startPhraseOf } from './compiler.js';

export const LIMITS = { minRounds: 1, maxRounds: 5, minRecordSec: 15, maxRecordSec: 120, minBetweenMin: 3, minLieDownSec: 30, maxLieDownSec: 180 };

export function drawOnsetMin(window, rng) {
  const raw = window.minMin + rng() * (window.maxMin - window.minMin);
  return Math.round(raw * 2) / 2;
}

export function validateParams(p) {
  const errors = [];
  if (!Number.isInteger(p.rounds) || p.rounds < LIMITS.minRounds || p.rounds > LIMITS.maxRounds) errors.push(`Rounds must be ${LIMITS.minRounds}–${LIMITS.maxRounds}.`);
  if (!(p.recordSec >= LIMITS.minRecordSec && p.recordSec <= LIMITS.maxRecordSec)) errors.push(`Report window must be ${LIMITS.minRecordSec}–${LIMITS.maxRecordSec} s.`);
  if (!(p.betweenMin >= LIMITS.minBetweenMin)) errors.push(`At least ${LIMITS.minBetweenMin} min to fall back asleep.`);
  if (!(p.hypnaMin > 0)) errors.push('Hypnagogia wait must be positive.');
  if (!(p.onsetMin > 0)) errors.push('Sleep-onset wait must be positive.');
  if (!(p.lieDownSec >= LIMITS.minLieDownSec && p.lieDownSec <= LIMITS.maxLieDownSec)) errors.push(`Settle time must be ${LIMITS.minLieDownSec}–${LIMITS.maxLieDownSec} s.`);
  return errors;
}

// Horowitz et al. 2023 script (Sci Rep, Supplementary 1.1-1.2). {X} = target core.
export const SCRIPT_H2023 = {
  start: 'Think of {X}.',
  cue: 'Remember to think of {X}.',
  alert: "You're falling asleep. Please tell me, what's going through your mind?",
  alertWake: "Please tell me what's going through your mind.",
  stateAsk: 'And were you asleep? Awake, halfway, or asleep?',
  back: 'You can fall back asleep now.',
  controlStart: 'Observe your thoughts.',
  controlCue: 'Remember to observe your thoughts.',
};

export const STATE_ASK_SEC = 8;

// The v0.3 cue form carried the feeling (", and feel …"). The h2023 script's
// cue is about the idea only, so drop that clause and keep everything else.
export function stripEmotionClause(cue) {
  const s = String(cue || '');
  const m = s.match(/^([\s\S]*?),\s*and feel [\s\S]*?(\. Notice that you are dreaming)?\.?$/);
  return m ? `${m[1]}${m[2] || ''}.` : s;
}

// Which text and which recording each spoken line uses.
// Returns { start, cue, alert, stateAsk|null, back|null, voiceKeys }.
// voiceKeys: 'target.startVoiceId' / 'target.voiceId' point at the target; every
// other key is a settings.scriptVoiceIds key (v1 keeps the v0.3 settings keys
// 'neutralVoiceId' / 'wakeVoiceId').
export function scriptLines({ protocol, state = 'sleep', isControl = false, target = null } = {}) {
  const wake = state === 'wake';
  if ((protocol?.script || 'v1') !== 'h2023') {
    const useTarget = !isControl && !!target;
    return {
      start: null,
      cue: useTarget && target.cuePhrase ? target.cuePhrase : NEUTRAL.cuePhrase,
      alert: NEUTRAL.wakePhrase,
      stateAsk: null,
      back: null,
      voiceKeys: { start: null, cue: useTarget ? 'target.voiceId' : 'neutralVoiceId', alert: 'wakeVoiceId', stateAsk: null, back: null },
    };
  }
  const core = (t) => String(t || '').replace(/\.$/, '');
  let start, cue, keys;
  if (isControl || !target) {
    start = SCRIPT_H2023.controlStart;
    cue = SCRIPT_H2023.controlCue;
    keys = { start: 'controlStart', cue: 'controlCue' };
  } else {
    start = startPhraseOf(target) || SCRIPT_H2023.start.replace('{X}', core(target.label));
    cue = stripEmotionClause(target.cuePhrase) || SCRIPT_H2023.cue.replace('{X}', core(target.label));
    keys = { start: 'target.startVoiceId', cue: 'target.voiceId' };
  }
  return {
    start,
    cue,
    alert: wake ? SCRIPT_H2023.alertWake : SCRIPT_H2023.alert,
    stateAsk: wake ? null : SCRIPT_H2023.stateAsk,
    back: wake ? null : SCRIPT_H2023.back,
    voiceKeys: { ...keys, alert: wake ? 'alertWake' : 'alert', stateAsk: wake ? null : 'stateAsk', back: wake ? null : 'back' },
  };
}

// p.script = 'h2023' selects the Horowitz 2023 step sequence; p.state ('sleep' |
// 'wake') only matters there. Without p.script the plan is the v0.3 plan.
export function buildPlan(p) {
  const errors = validateParams(p);
  if (errors.length) throw new Error(errors.join(' '));
  if (p.script === 'h2023') return buildH2023Plan(p);
  const steps = [{ kind: 'wait', phase: 'settle', sec: p.lieDownSec }];
  if (p.preSleepCue) steps.push({ kind: 'cue', phase: 'pre-sleep' });
  steps.push({ kind: 'wait', phase: 'onset', sec: p.onsetMin * 60 });
  for (let r = 1; r <= p.rounds; r++) {
    steps.push({ kind: 'cue', phase: 'hypnagogia', round: r });
    steps.push({ kind: 'wait', phase: 'hypnagogia', round: r, sec: p.hypnaMin * 60 });
    steps.push({ kind: 'wake', phase: 'wake', round: r });
    steps.push({ kind: 'record', phase: 'report', round: r, sec: p.recordSec });
    if (r < p.rounds) {
      steps.push({ kind: 'cue', phase: 'return', round: r });
      steps.push({ kind: 'wait', phase: 'between', round: r, sec: p.betweenMin * 60 });
    }
  }
  steps.push({ kind: 'chime', phase: 'end' });
  return steps;
}

function buildH2023Plan(p) {
  const sleep = p.state !== 'wake';
  const steps = [
    { kind: 'wait', phase: 'settle', sec: p.lieDownSec },
    { kind: 'say', phase: 'start', line: 'start' },
    { kind: 'wait', phase: 'onset', sec: p.onsetMin * 60 },
  ];
  for (let r = 1; r <= p.rounds; r++) {
    steps.push({ kind: 'cue', phase: 'hypnagogia', round: r });
    steps.push({ kind: 'wait', phase: 'hypnagogia', round: r, sec: p.hypnaMin * 60 });
    steps.push({ kind: 'wake', phase: 'wake', round: r });
    steps.push({ kind: 'record', phase: 'report', round: r, sec: p.recordSec });
    if (sleep) {
      steps.push({ kind: 'say', phase: 'state', round: r, line: 'stateAsk' });
      steps.push({ kind: 'record', phase: 'state', round: r, sec: STATE_ASK_SEC });
    }
    if (r < p.rounds) {
      steps.push({ kind: 'cue', phase: 'return', round: r });
      if (sleep) steps.push({ kind: 'say', phase: 'back', round: r, line: 'back' });
      steps.push({ kind: 'wait', phase: 'between', round: r, sec: p.betweenMin * 60 });
    }
  }
  steps.push({ kind: 'chime', phase: 'end' });
  return steps;
}

export function planDurationSec(steps) {
  return steps.reduce((t, s) => t + (s.sec || 0), 0);
}

// Phase 2 "normal sleep" baseline: the same settle time and the same total
// length as the incubation nap these parameters would give, but no cues and no
// mid-nap wake-ups. One wake prompt and report at the end, so dream recall is
// still collected.
export function buildPlainPlan(p) {
  const total = planDurationSec(buildPlan({ ...p, preSleepCue: false }));
  return [
    { kind: 'wait', phase: 'settle', sec: p.lieDownSec },
    { kind: 'wait', phase: 'sleep', sec: total - p.lieDownSec - p.recordSec },
    { kind: 'wake', phase: 'wake', round: 1 },
    { kind: 'record', phase: 'report', round: 1, sec: p.recordSec },
    { kind: 'chime', phase: 'end' },
  ];
}

export const PHASE_TEXT = {
  sleep: 'Sleeping',
  settle: 'Lie down and get comfortable',
  'pre-sleep': 'Hold the intention',
  onset: 'Falling asleep',
  hypnagogia: 'Hypnagogia',
  wake: 'Waking you gently',
  report: 'Say what you were experiencing',
  return: 'Drift back',
  between: 'Falling back asleep',
  start: 'Hold the thought',
  state: 'Were you asleep? Awake, halfway, or asleep?',
  back: 'You can fall back asleep now',
  end: 'Session complete',
};
