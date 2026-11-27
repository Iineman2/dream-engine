// Word-pair memory task around each nap: an objective "rate of learning"
// measure. You study N random noun pairs before the nap, take an immediate
// associative test (baseline), then the same test after the nap.
// Basis: naps improve declarative recall (Lahl et al. 2008) and dreaming about
// a learning task predicts better consolidation (Wamsley et al. 2010).

import { mulberry32, shuffle } from './rng.js';
import { stem } from './text.js';

export const WORDS = `
apple anchor arrow badge basket beard bell bench blanket bottle bridge brush bucket button cabin camera
candle canoe carpet castle chain chair cherry chimney clock coat coin comb compass cookie crown desk
diamond drum eagle engine feather fence flag flute fork fountain glove goat guitar hammer harbor helmet
honey horse jacket kettle ladder lamp lemon lion lock magnet marble mirror monkey needle onion orange
paddle palace pepper piano pillow pocket pumpkin puzzle rabbit radio ribbon rocket rope saddle scarf
shoe shovel sock spoon stamp statue sugar sword table tent ticket tiger tomato towel tractor train
trumpet tunnel umbrella violin wagon wallet whistle window wheel zebra bread brick cactus carrot cloak
crayon dolphin envelope ferry gate lantern mask medal parrot pearl pencil penguin plate rake robot
salt sled snail spider tray vase wolf yacht barrel cannon dragon garlic hook kitten lobster mitten
mushroom napkin oven peach pliers quilt raft sandal skate stool teapot thimble trophy turtle walnut
`.split(/\s+/).filter(Boolean);

export const PAIR_MS = 4000;

export function makePairs(seed, n = 16, excludeStems = []) {
  const ex = new Set(excludeStems);
  const pool = shuffle(WORDS.filter((w) => !ex.has(stem(w))), mulberry32(seed));
  if (pool.length < 2 * n) throw new Error('Not enough words for that many pairs.');
  return Array.from({ length: n }, (_, i) => ({ cue: pool[2 * i], answer: pool[2 * i + 1] }));
}

// Associative recognition: the distractors are other pairs' answers, so you
// must remember which word went with which, not just which words you saw.
export function makeTest(pairs, seed) {
  const rng = mulberry32(seed);
  const answers = pairs.map((p) => p.answer);
  return shuffle(pairs, rng).map((p) => {
    const lures = shuffle(answers.filter((a) => a !== p.answer), rng).slice(0, 3);
    return { cue: p.cue, answer: p.answer, options: shuffle([p.answer, ...lures], rng) };
  });
}

export function scoreResponses(responses) {
  const correct = responses.filter((r) => r.correct).length;
  const rts = responses.map((r) => r.rtMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const medianRtMs = rts.length ? (rts.length % 2 ? rts[(rts.length - 1) / 2] : (rts[rts.length / 2 - 1] + rts[rts.length / 2]) / 2) : null;
  return { correct, n: responses.length, acc: responses.length ? correct / responses.length : NaN, medianRtMs };
}

export function memorySummary(mem) {
  if (!mem?.immediate) return null;
  const imm = mem.immediate.correct / mem.immediate.n;
  const del = mem.delayed ? mem.delayed.correct / mem.delayed.n : null;
  return {
    n: mem.immediate.n,
    immediate: imm,
    delayed: del,
    change: del == null ? null : del - imm,
    delayMin: mem.delayed ? Math.round((Date.parse(mem.delayed.at) - Date.parse(mem.immediate.at)) / 60000) : null,
  };
}
