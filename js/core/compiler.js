// Dream compiler: turns a desired experience into the concrete artefacts the
// session needs — a short spoken cue (Dormio style: "remember to think of …"),
// a pre-sleep visualisation script, a sound motif, and a lexicon used only by
// the lexical cross-check scorer. Local and deterministic; no model calls.

import { hashString } from './rng.js';
import { words, stem, stems } from './text.js';

export const DIMENSIONS = [
  { key: 'environment', label: 'Environment', hint: 'Where are you? e.g. a purple forest, an ocean of light' },
  { key: 'emotion', label: 'Emotion', hint: 'How do you want to feel? e.g. awe, peace, compassion' },
  { key: 'narrative', label: 'Narrative', hint: 'What happens? e.g. meeting a guide, exploring ruins' },
  { key: 'sensation', label: 'Sensation', hint: 'What does your body feel? e.g. flying, floating, warm water' },
];

export const AWARENESS = [
  { value: 'none', label: 'No lucidity goal' },
  { value: 'notice', label: 'Also cue “notice that you are dreaming”' },
];

// Neutral phrases are identical across conditions so that the only thing the
// randomisation changes is the content of the cue.
export const NEUTRAL = {
  cuePhrase: 'Relax, and let your mind wander.',
  wakePhrase: 'Tell me what you’re thinking about.',
  motif: [72, 72, 72],
};

const PENTATONIC = [67, 69, 72, 74, 76, 79, 81, 84];
// Words that show up in almost every report regardless of condition.
const GENERIC = new Set(['dream', 'sleep', 'asleep', 'awake', 'mind', 'wander', 'relax', 'person', 'people', 'place', 'time']);

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(/[.!?;,:]+$/, '');

export function buildLexicon(texts) {
  const seen = new Map();
  for (const t of texts) {
    for (const w of words(t)) {
      const s = stem(w);
      if (s.length < 3 || GENERIC.has(w) || GENERIC.has(s)) continue;
      if (!seen.has(s)) seen.set(s, w);
    }
  }
  return [...seen.entries()].map(([s, w]) => ({ stem: s, word: w }));
}

export function motifFor(key) {
  const h = hashString(String(key).toLowerCase());
  const notes = [h & 7, (h >>> 3) & 7, (h >>> 6) & 7].map((i) => PENTATONIC[i]);
  if (notes[0] === notes[1] && notes[1] === notes[2]) notes[2] = PENTATONIC[((h >>> 6) + 3) & 7];
  // Never collide with the neutral motif.
  if (notes.every((n, i) => n === NEUTRAL.motif[i])) notes[1] = PENTATONIC[0];
  return notes;
}

export function compileTarget(input = {}) {
  const dims = {
    environment: clean(input.environment),
    emotion: clean(input.emotion),
    narrative: clean(input.narrative),
    sensation: clean(input.sensation),
    awareness: input.awareness === 'notice' ? 'notice' : 'none',
  };
  const related = clean(input.related);
  const core = dims.environment || dims.narrative || dims.sensation || clean(input.label);
  const errors = [];
  const warnings = [];
  if (!core) errors.push('Describe at least an environment, a narrative or a sensation.');

  const label = clean(input.label) || core.slice(0, 48);

  let suggested = core ? `Remember to think of ${core}` : '';
  if (core && dims.awareness === 'notice') suggested += '. Notice that you are dreaming';
  if (suggested) suggested += '.';
  const cuePhrase = clean(input.cuePhrase) ? clean(input.cuePhrase) + '.' : suggested;

  const nWords = cuePhrase.split(/\s+/).filter(Boolean).length;
  if (nWords > 14) warnings.push(`The cue is ${nWords} words. Short cues work best at sleep onset (Dormio used phrases like “remember to think of a tree”).`);

  const visualization = [
    dims.environment && `You are in ${dims.environment}.`,
    dims.narrative && `${dims.narrative[0].toUpperCase()}${dims.narrative.slice(1)}.`,
    dims.sensation && `You notice the feeling of ${dims.sensation}.`,
    dims.emotion && `A sense of ${dims.emotion} fills you.`,
  ].filter(Boolean).join(' ');

  const lexicon = buildLexicon([label, dims.environment, dims.narrative, dims.sensation, dims.emotion, related]);
  if (core && lexicon.length < 2) warnings.push('Add a few related words so the lexical cross-check has something to look for.');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    target: {
      label,
      dims,
      related,
      cuePhrase,
      startPhrase: core ? `Think of ${core}.` : '',
      visualization,
      lexicon,
      motif: motifFor(label || core),
    },
  };
}

// Start line for a target. Targets saved before v0.4 lack startPhrase, so
// derive it from the cue ("Remember to think of X, and feel Y." -> "Think of X.").
export function startPhraseOf(target) {
  if (!target) return '';
  if (target.startPhrase) return target.startPhrase;
  const cue = String(target.cuePhrase || '');
  const m = /^\s*remember to think of\s+(.*)$/i.exec(cue);
  if (m) {
    const core = clean(m[1].split(/,\s*and feel|\.\s*Notice that you are dreaming/i)[0]);
    if (core) return `Think of ${core}.`;
  }
  const label = clean(target.label);
  return label ? `Think of ${label}.` : '';
}

export function compareTargets(a, b) {
  const warnings = [];
  const bStems = new Set(b.lexicon.map((x) => x.stem));
  const overlap = a.lexicon.filter((x) => bStems.has(x.stem)).map((x) => x.word);
  if (a.id && a.id === b.id) warnings.push('Target A and target B must be different targets.');
  if (overlap.length) warnings.push(`A and B share words (${overlap.join(', ')}). Shared words make it impossible to tell which target showed up.`);
  if (a.dims.awareness !== b.dims.awareness) warnings.push('Only one target includes a lucidity cue. That difference would be confounded with the content difference.');
  const ea = stems(a.dims?.emotion || '').join(' '), eb = stems(b.dims?.emotion || '').join(' ');
  if (!ea || !eb) warnings.push(`${!ea && !eb ? 'Neither target has' : !ea ? 'Target A has no' : 'Target B has no'} emotion. Emotion scores can't tell A from B.`);
  else if (ea === eb) warnings.push("A and B carry the same emotion. Emotion scores can't tell A from B.");
  if (a.motif.join() === b.motif.join()) warnings.push('Both targets produced the same sound motif. Rename one of them.');
  return { overlap, warnings, ok: overlap.length === 0 && !(a.id && a.id === b.id) };
}
