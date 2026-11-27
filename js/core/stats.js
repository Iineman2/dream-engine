// Small-sample statistics for an n-of-1 incubation study.

import { mulberry32 } from './rng.js';

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

// Spearman rank correlation over pairs where both values are numbers.
export function spearman(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (x !== null && y !== null && x !== '' && y !== '' && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) pairs.push([Number(x), Number(y)]);
  }
  const n = pairs.length;
  if (n < 3) return { rho: NaN, n };
  const rx = ranks(pairs.map((p) => p[0])), ry = ranks(pairs.map((p) => p[1]));
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return { rho: sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN, n };
}

export function wilson(k, n, z = 1.96) {
  if (!n) return { p: NaN, lo: NaN, hi: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

export function choose(n, k) {
  if (k < 0 || k > n) return 0;
  return Math.round(Math.exp(logChoose(n, Math.min(k, n - k))));
}

// One-sided exact binomial tail P(X >= k | n, 0.5).
export function binomTailHalf(k, n) {
  if (n === 0) return 1;
  let p = 0;
  for (let i = k; i <= n; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, p);
}

// One-sided permutation test of mean(x) - mean(y) > 0.
// Exact enumeration when feasible, otherwise seeded Monte Carlo.
export function permutationTest(x, y, { maxExact = 200000, iterations = 20000, seed = 12345 } = {}) {
  const nx = x.length, ny = y.length;
  if (!nx || !ny) return { stat: NaN, p: NaN, method: 'none' };
  const all = x.concat(y);
  const N = all.length;
  const total = all.reduce((a, b) => a + b, 0);
  const stat = mean(x) - mean(y);
  const eps = 1e-9;
  const statFor = (sumX) => sumX / nx - (total - sumX) / ny;
  const combos = choose(N, nx);
  if (combos <= maxExact) {
    let count = 0, seen = 0;
    const rec = (start, left, sum) => {
      if (left === 0) { seen++; if (statFor(sum) >= stat - eps) count++; return; }
      for (let i = start; i <= N - left; i++) rec(i + 1, left - 1, sum + all[i]);
    };
    rec(0, nx, 0);
    return { stat, p: count / seen, method: 'exact', permutations: seen };
  }
  const rng = mulberry32(seed);
  let count = 0;
  const idx = all.map((_, i) => i);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < nx; i++) {
      const j = i + Math.floor(rng() * (N - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
      sum += all[idx[i]];
    }
    if (statFor(sum) >= stat - eps) count++;
  }
  return { stat, p: (count + 1) / (iterations + 1), method: 'monte-carlo', permutations: iterations };
}

// One-sided sign-flip permutation test of mean(xs) > 0, for paired or
// within-session differences. Exact up to 2^18 sign patterns, else seeded
// Monte Carlo.
export function signFlipTest(xs, { maxExact = 18, iterations = 20000, seed = 54321 } = {}) {
  const n = xs.length;
  if (!n) return { stat: NaN, p: NaN, method: 'none' };
  const stat = mean(xs);
  const eps = 1e-9;
  if (n <= maxExact) {
    const total = 2 ** n;
    let count = 0;
    for (let m = 0; m < total; m++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += (m >> i) & 1 ? -xs[i] : xs[i];
      if (s / n >= stat - eps) count++;
    }
    return { stat, p: count / total, method: 'exact', permutations: total };
  }
  const rng = mulberry32(seed);
  let count = 0;
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rng() < 0.5 ? -xs[i] : xs[i];
    if (s / n >= stat - eps) count++;
  }
  return { stat, p: (count + 1) / (iterations + 1), method: 'monte-carlo', permutations: iterations };
}

// Holm–Bonferroni adjusted p-values. Missing (non-finite) p-values stay NaN and
// don't count towards the family size.
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const out = ps.map(() => NaN);
  let run = 0;
  idx.forEach(([p, i], k) => {
    run = Math.max(run, Math.min(1, (m - k) * p));
    out[i] = run;
  });
  return out;
}
