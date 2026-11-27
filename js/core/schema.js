// Persistent state shape, defaults, migration and import validation.

import { ALL_CONDITIONS, V1_PROTOCOL } from './study.js';

export const SCHEMA_VERSION = 4;

// Defaults follow the published Dormio / Dormio Light protocol. Everything
// marked experimental is my own addition and is off unless you turn it on.
export const DEFAULT_SETTINGS = {
  voiceMode: 'tts', // 'tts' | 'own'
  ttsVoiceURI: '',
  ttsRate: 0.85,
  cueVolume: 0.6,
  wakeVolume: 0.85,
  recordSec: 60,
  rounds: 3,
  lieDownSec: 60,
  window: { start: '09:00', end: '20:00' },
  neutralVoiceId: null,
  wakeVoiceId: null,
  // Outcome measurement. The Phase 1 word-pair test is untargeted (it isn't
  // linked to the dream cue), so it is off by default; Phase 2 always uses
  // theme-bound word pairs.
  memoryTask: false,
  memoryPairs: 16,
  pairsPerTheme: 10,
  // Experimental (not part of the published protocol)
  preSleepCue: false,
  cueMotif: false,
  adaptiveTiming: true, // varies timing only among Dormio's own option values
  // v0.4: script, binding step and cue-volume staircase.
  scriptVersion: 'h2023', // 'h2023' | 'v1' (applies to newly created studies)
  bindingStep: true,
  adaptiveVolume: true,
  cueVolumeMax: 0.8,
  scriptVoiceIds: { alert: null, alertWake: null, stateAsk: null, back: null, controlStart: null, controlCue: null },
};

export function emptyState(now = new Date()) {
  return {
    version: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    consent: null,
    settings: structuredClone(DEFAULT_SETTINGS),
    targets: [],
    studies: [],
    sessions: [],
    checkins: [],
    metrics: [],
    activeStudyId: null,
  };
}

export function migrate(state) {
  const base = emptyState();
  const s = { ...base, ...(state || {}) };
  s.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(state?.settings || {}) };
  s.settings.window = { ...DEFAULT_SETTINGS.window, ...(state?.settings?.window || {}) };
  s.settings.scriptVoiceIds = { ...DEFAULT_SETTINGS.scriptVoiceIds, ...(state?.settings?.scriptVoiceIds || {}) };
  if ((state?.version ?? 0) < 2) {
    // v1 defaulted the (experimental) pre-sleep cue on; v2 follows the published protocol.
    s.settings.preSleepCue = false;
  }
  if ((state?.version ?? 0) < 3 && !(state?.sessions || []).some((x) => x.memory)) {
    // v3: the untargeted memory test is off unless you were already using it.
    s.settings.memoryTask = false;
  }
  for (const k of ['targets', 'studies', 'sessions', 'checkins', 'metrics']) if (!Array.isArray(s[k])) s[k] = [];
  // v4: studies created before v0.4 keep the v0.3 protocol exactly.
  s.studies = s.studies.map((st) => (st && !st.protocol ? { ...st, protocol: { ...V1_PROTOCOL } } : st));
  s.version = SCHEMA_VERSION;
  return s;
}

export function validateImport(obj) {
  const errors = [];
  const data = obj && obj.app === 'dream-engine' ? obj.state : obj;
  if (!data || typeof data !== 'object') return { ok: false, errors: ['Not a Dream Engine export.'] };
  if (typeof data.version !== 'number') errors.push('Missing version.');
  else if (data.version > SCHEMA_VERSION) errors.push(`Export is from a newer version (${data.version}).`);
  for (const k of ['targets', 'studies', 'sessions']) if (!Array.isArray(data[k])) errors.push(`Missing ${k} list.`);
  for (const k of ['checkins', 'metrics']) if (data[k] !== undefined && !Array.isArray(data[k])) errors.push(`${k} must be a list.`);
  for (const s of data.sessions || []) {
    if (!s.id || !s.startedAt || !ALL_CONDITIONS.includes(s.condition)) { errors.push('A session record is malformed.'); break; }
  }
  for (const t of data.targets || []) {
    if (!t.id || !Array.isArray(t.lexicon)) { errors.push('A target record is malformed.'); break; }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors, state: migrate(data), blobs: obj.blobs || null };
}
