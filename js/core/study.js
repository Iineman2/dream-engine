// Study design. Two pre-registered phases, each allocated by blocked
// randomisation. The allocation sequence is fixed when a study is created and
// revealed one session at a time, at session start, so you cannot pick which
// condition you get. A revealed allocation is consumed even if the session is
// aborted (intention-to-treat).
//
// Phase 1 ("steer"): does the cue change what I dream about?
//   A, B = nap cued with target A or B; control = nap with a neutral cue.
// Phase 2 ("benefit"): does engineered dreaming help, beyond normal sleep?
//   SA, SB = nap cued with A or B (targeted dream incubation)
//   WA, WB = stay awake through identical cues and prompts (cue without dreaming)
//   plain  = ordinary nap of the same length, no cues and no mid-nap wake-ups

import { mulberry32, shuffle, newId, newSeed } from './rng.js';

export const V1_PROTOCOL = Object.freeze({ script: 'v1', binding: false, emotionScores: false });
export const DEFAULT_PROTOCOL = Object.freeze({ script: 'h2023', binding: true, emotionScores: true });
export const studyProtocol = (study) => (study?.protocol ? { ...study.protocol } : { ...V1_PROTOCOL });

export const CONDITIONS = ['A', 'B', 'control'];
export const BENEFIT_CONDITIONS = ['SA', 'SB', 'WA', 'WB', 'plain'];

const INFO = {
  A: { cued: 'A', state: 'sleep', plain: false },
  B: { cued: 'B', state: 'sleep', plain: false },
  control: { cued: null, state: 'sleep', plain: false },
  SA: { cued: 'A', state: 'sleep', plain: false },
  SB: { cued: 'B', state: 'sleep', plain: false },
  WA: { cued: 'A', state: 'wake', plain: false },
  WB: { cued: 'B', state: 'wake', plain: false },
  plain: { cued: null, state: 'sleep', plain: true },
};
export const ALL_CONDITIONS = Object.keys(INFO);

export function conditionInfo(condition) {
  return INFO[condition] || { cued: null, state: 'sleep', plain: false };
}

export const studyKind = (study) => study?.kind || 'steer';
export const conditionsOf = (study) => (studyKind(study) === 'benefit' ? BENEFIT_CONDITIONS : CONDITIONS);

export function makeSchedule(seed, blocks, conditions = CONDITIONS) {
  const rng = mulberry32(seed);
  const out = [];
  for (let b = 0; b < blocks; b++) out.push(...shuffle(conditions, rng));
  return out;
}

export function createStudy({ targetAId, targetBId, blocks = 8, seed = newSeed(), now = new Date(), protocol }) {
  if (!targetAId || !targetBId || targetAId === targetBId) throw new Error('A study needs two different targets.');
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 40) throw new Error('Blocks must be 1–40.');
  return {
    id: newId('study'),
    kind: 'steer',
    protocol: { ...DEFAULT_PROTOCOL, ...(protocol || {}) },
    seed,
    targetIds: { A: targetAId, B: targetBId },
    blocks,
    schedule: makeSchedule(seed, blocks),
    createdAt: now.toISOString(),
    status: 'active',
    acks: [],
  };
}

// Sessions that consumed a real allocation (speeded QA sessions never do).
export function allocatedSessions(study, sessions) {
  return sessions.filter((s) => s.studyId === study.id && !s.rehearsal && s.params?.speed === 1);
}

export function nextAllocation(study, sessions) {
  const index = allocatedSessions(study, sessions).length;
  if (index >= study.schedule.length) return null;
  return { index, condition: study.schedule[index] };
}

export function extendStudy(study, blocks, seed = newSeed()) {
  return { ...study, schedule: study.schedule.concat(makeSchedule(seed, blocks, conditionsOf(study))), blocks: study.blocks + blocks, status: 'active' };
}

export function cuedTargetId(study, condition) {
  const c = conditionInfo(condition).cued;
  return c ? study.targetIds[c] : null;
}

// Phase 2 only makes sense once Phase 1 has run its course.
export function phaseOneDone(study, sessions) {
  return studyKind(study) === 'steer' && (study.status === 'closed' || nextAllocation(study, sessions) === null);
}

export const PRIMARY_OUTCOMES = ['creativity', 'memory'];
export const MIN_OBJECTS = 3;

export function parseObjects(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[,\n;]/)) {
    const w = raw.trim().replace(/\s+/g, ' ');
    if (!w || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  return out;
}

export function createBenefitStudy({ parent, primary = 'creativity', objects, blocks = 6, seed = newSeed(), now = new Date(), protocol }) {
  if (studyKind(parent) !== 'steer') throw new Error('Phase 2 builds on a Phase 1 study.');
  if (!PRIMARY_OUTCOMES.includes(primary)) throw new Error('Pick creativity or memory as the primary outcome.');
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 40) throw new Error('Blocks must be 1–40.');
  const A = objects?.A || [], B = objects?.B || [];
  if (A.length < MIN_OBJECTS || B.length < MIN_OBJECTS) throw new Error(`List at least ${MIN_OBJECTS} objects for each theme.`);
  const shared = A.filter((x) => B.some((y) => y.toLowerCase() === x.toLowerCase()));
  if (shared.length) throw new Error(`Each object must belong to one theme only (${shared.join(', ')}).`);
  return {
    id: newId('study'),
    kind: 'benefit',
    parentId: parent.id,
    protocol: { ...DEFAULT_PROTOCOL, ...(protocol || {}) },
    seed,
    targetIds: { ...parent.targetIds },
    primary,
    objects: { A: [...A], B: [...B] },
    blocks,
    schedule: makeSchedule(seed, blocks, BENEFIT_CONDITIONS),
    createdAt: now.toISOString(),
    status: 'active',
    // Safety acknowledgements carry over, so an old check-in can't re-pause a new phase.
    acks: [...(parent.acks || [])],
  };
}
