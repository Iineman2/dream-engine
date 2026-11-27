// The data layer for the future predictive map. Every nap becomes training
// data: one row per wake-up (trial table) and one row per nap (session table),
// joining what was played (stimulus), what state you were in, what came back
// (report, ratings, incorporation), the learning outcome (memory task), and
// the daily context (check-ins, imported metrics such as Anki retention).

import { isAnalyzable } from './adaptive.js';
import { reportText, scoringText, lexicalScore, toCSV, parseCSV } from './scoring.js';
import { conditionInfo } from './study.js';
import { themedRetention, fluency, other } from './benefit.js';
import { words } from './text.js';
import { memorySummary } from './memory.js';
import { spearman } from './stats.js';
import { cueArousals } from './arousal.js';

const pad = (n) => String(n).padStart(2, '0');
export function localDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = (v) => (v === undefined || v === null ? null : v ? 1 : 0);
const byStart = (a, b) => String(a.startedAt).localeCompare(String(b.startedAt));
export const metricKey = (name) => 'm_' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function context(state) {
  return {
    targets: new Map((state.targets || []).map((t) => [t.id, t])),
    studies: new Map((state.studies || []).map((s) => [s.id, s])),
    checkins: new Map((state.checkins || []).map((c) => [c.date, c])),
    metrics: (state.metrics || []).reduce((m, x) => {
      if (!m.has(x.date)) m.set(x.date, {});
      m.get(x.date)[metricKey(x.name)] = num(x.value);
      return m;
    }, new Map()),
  };
}

function sessionRow(s, ctx) {
  const p = s.params || {};
  const audio = p.audio || {};
  const study = ctx.studies.get(s.studyId);
  const A = study && ctx.targets.get(study.targetIds.A);
  const B = study && ctx.targets.get(study.targetIds.B);
  const text = reportText(s);
  const scored = scoringText(s);
  const lexA = A ? lexicalScore(scored, A.lexicon).score : null;
  const lexB = B ? lexicalScore(scored, B.lexicon).score : null;
  const info = conditionInfo(s.condition);
  const cued = info.cued;
  const uncued = cued ? other(cued) : null;
  const ret = themedRetention(s.themed);
  const aut = s.aut || {};
  const autB = s.autBlind || {};
  const flu = (th) => (aut[th] ? fluency(aut[th].text) : null);
  const m = s.morning || {};
  const date = localDate(s.startedAt);
  const today = ctx.checkins.get(date) || {};
  const next = ctx.checkins.get(addDays(date, 1)) || {};
  const rounds = s.rounds || [];
  const mem = memorySummary(s.memory) || {};
  return {
    session_id: s.id,
    study_id: s.studyId || '',
    phase: study ? (study.kind === 'benefit' ? 2 : 1) : null,
    date,
    hour: new Date(s.startedAt).getHours(),
    status: s.status,
    analyzable: isAnalyzable(s) ? 1 : 0,
    speed: num(p.speed),
    condition: s.condition,
    state: info.state,
    plain_nap: info.plain ? 1 : 0,
    cued_theme: cued ?? '',
    cued_target: s.targetId ? ctx.targets.get(s.targetId)?.label ?? '' : '',
    arm: p.armId ?? '',
    adaptive_timing: bool(p.adaptive),
    onset_min: num(p.onsetMin),
    hypna_min: num(p.hypnaMin),
    between_min: num(p.betweenMin),
    rounds_planned: num(p.rounds),
    rounds_done: rounds.length,
    record_sec: num(p.recordSec),
    pre_sleep_cue: bool(p.preSleepCue),
    motif: bool(audio.motif),
    voice_mode: audio.voiceMode ?? p.voiceMode ?? '',
    script: p.protocol?.script ?? '',
    cue_volume: num(audio.cueVolume),
    adaptive_volume: bool(audio.adaptiveVolume),
    wake_volume: num(audio.wakeVolume),
    tts_rate: num(audio.ttsRate),
    n_drifting: rounds.filter((r) => r.state === 'drifting').length,
    n_awake: rounds.filter((r) => r.state === 'awake').length,
    n_asleep: rounds.filter((r) => r.state === 'asleep').length,
    report_words: words(text).length,
    dream_report_words: info.state === 'sleep' ? words(scored).length : null,
    blind_A: num(s.blind?.A),
    blind_B: num(s.blind?.B),
    blind_cued: cued && s.blind ? num(s.blind[cued]) : null,
    blind_uncued: uncued && s.blind ? num(s.blind[uncued]) : null,
    blind_rater: s.blind?.rater ?? '',
    blind_emo_A: num(s.blind?.emoA),
    blind_emo_B: num(s.blind?.emoB),
    bind_feel: num(s.binding?.feel),
    bind_vivid: num(s.binding?.vivid),
    bind_calm: num(s.binding?.calm),
    lex_A: lexA,
    lex_B: lexB,
    lex_cued: cued === 'A' ? lexA : cued === 'B' ? lexB : null,
    vividness: num(m.vividness),
    valence: num(m.valence),
    intensity: num(m.intensity),
    immersion: num(m.immersion),
    bizarreness: num(m.bizarreness),
    lucidity: num(m.lucidity),
    disruption: num(m.disruption),
    distressing: s.morning ? bool(m.distressing) : null,
    mem_pairs: num(mem.n),
    mem_immediate: num(mem.immediate),
    mem_delayed: num(mem.delayed),
    mem_change: num(mem.change),
    mem_delay_min: num(mem.delayMin),
    mem_A_retention: ret ? num(ret.A) : null,
    mem_B_retention: ret ? num(ret.B) : null,
    mem_cued_retention: ret && cued ? num(ret[cued]) : null,
    mem_uncued_retention: ret && uncued ? num(ret[uncued]) : null,
    aut_A_object: aut.A?.object ?? '',
    aut_B_object: aut.B?.object ?? '',
    aut_A_fluency: flu('A'),
    aut_B_fluency: flu('B'),
    aut_cued_fluency: cued ? flu(cued) : null,
    aut_uncued_fluency: uncued ? flu(uncued) : null,
    aut_A_rating: num(autB.A),
    aut_B_rating: num(autB.B),
    aut_cued_rating: cued ? num(autB[cued]) : null,
    aut_uncued_rating: uncued ? num(autB[uncued]) : null,
    sleep_hours_last_night: num(today.sleepHours),
    sleep_quality_last_night: num(today.sleepQuality),
    mood_same_day: num(today.mood),
    unreal_same_day: num(today.unreal),
    substances_same_day: bool(today.substances),
    next_day_mood: num(next.mood),
    next_day_sharpness: num(next.sharpness),
    next_day_unreal: num(next.unreal),
    next_day_confusion: bool(next.confusion),
    ...(ctx.metrics.get(date) || {}),
  };
}

export function sessionRows(state) {
  const ctx = context(state);
  return (state.sessions || []).filter((s) => !s.rehearsal).sort(byStart).map((s) => sessionRow(s, ctx));
}

// Walks the event log so each wake-up knows exactly which cues preceded it.
function roundStimuli(events) {
  const out = {};
  const start = events.find((e) => e.type === 'start');
  let cues = [];
  for (const e of events) {
    if (e.type === 'cue') cues.push(e);
    else if (e.type === 'wake') {
      const last = cues[cues.length - 1];
      out[e.round] = {
        cues_in_round: cues.length,
        cues_played: cues.filter((c) => c.played !== false).length,
        sec_last_cue_to_wake: last ? Math.round((Date.parse(e.t) - Date.parse(last.t)) / 1000) : null,
        wake_sec_from_start: start ? Math.round((Date.parse(e.t) - Date.parse(start.t)) / 1000) : null,
      };
    } else if (e.type === 'record-stop' && e.phase === 'state') {
      // h2023: the spoken answer to "were you asleep?", same round.
      if (out[e.round]) out[e.round].state_audio_bytes = e.bytes ?? null;
    } else if (e.type === 'record-stop') {
      if (out[e.round]) out[e.round].audio_bytes = e.bytes ?? null;
      cues = [];
    }
  }
  return out;
}

export function trialRows(state) {
  const ctx = context(state);
  const rows = [];
  for (const s of (state.sessions || []).filter((x) => !x.rehearsal).sort(byStart)) {
    const base = sessionRow(s, ctx);
    const stim = roundStimuli(s.events || []);
    const arousal = cueArousals(s);
    const target = s.targetId ? ctx.targets.get(s.targetId) : null;
    for (const r of [...(s.rounds || [])].sort((a, b) => a.round - b.round)) {
      // The in-sleep cue before this wake-up (none in plain naps).
      const c = arousal.find((x) => x.round === r.round);
      rows.push({
        ...base,
        round: r.round,
        state_at_wake: r.state || '',
        round_words: words(r.transcript || '').length,
        round_lex_cued: target ? lexicalScore(r.transcript || '', target.lexicon).score : null,
        has_audio: r.audioId ? 1 : 0,
        has_state_audio: r.stateAudioId ? 1 : 0,
        cue_volume: c ? c.volume : null,
        cue_woke: r.cueWoke ?? '',
        cue_tap: c ? bool(c.tap) : null,
        cue_motion: c ? bool(c.motion) : null,
        cue_arousal: c ? bool(c.woke) : null,
        cues_in_round: null, cues_played: null, sec_last_cue_to_wake: null, wake_sec_from_start: null, audio_bytes: null, state_audio_bytes: null,
        ...(stim[r.round] || {}),
      });
    }
  }
  return rows;
}

export function rowsToCSV(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return toCSV([cols, ...rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c])))]);
}

// Exploratory only: with a few dozen naps most of these will be noise.
export const ASSOCIATIONS = [
  ['mem_change', 'n_drifting', 'Memory change vs. rounds caught drifting'],
  ['mem_change', 'blind_cued', 'Memory change vs. cued-theme incorporation'],
  ['mem_change', 'disruption', 'Memory change vs. sleep disruption'],
  ['vividness', 'n_drifting', 'Vividness vs. rounds caught drifting'],
  ['lucidity', 'next_day_unreal', 'Lucidity vs. next-day unreality'],
  ['disruption', 'next_day_mood', 'Sleep disruption vs. next-day mood'],
];

export function associations(rows, minN = 5) {
  const ok = rows.filter((r) => r.analyzable === 1);
  return ASSOCIATIONS.map(([x, y, label]) => {
    const { rho, n } = spearman(ok.map((r) => r[x]), ok.map((r) => r[y]));
    return { x, y, label, n, rho: n >= minN ? rho : NaN };
  });
}

export function parseMetricsCSV(text) {
  const rows = parseCSV(text);
  const errors = [];
  const items = [];
  if (!rows.length) return { items, errors: ['The file is empty.'] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const di = head.indexOf('date'), mi = head.indexOf('metric'), vi = head.indexOf('value');
  if (di < 0 || mi < 0 || vi < 0) return { items, errors: ['Expected columns: date, metric, value.'] };
  rows.slice(1).forEach((r, k) => {
    const date = (r[di] || '').trim(), name = (r[mi] || '').trim(), value = Number((r[vi] || '').trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`Row ${k + 2}: date must be YYYY-MM-DD.`); return; }
    if (!name || metricKey(name) === 'm_') { errors.push(`Row ${k + 2}: missing metric name.`); return; }
    if (!Number.isFinite(value)) { errors.push(`Row ${k + 2}: value must be a number.`); return; }
    items.push({ date, name, value });
  });
  return { items, errors };
}

export function mergeMetrics(existing, items) {
  const key = (x) => `${x.date}|${metricKey(x.name)}`;
  const map = new Map((existing || []).map((x) => [key(x), x]));
  for (const x of items) map.set(key(x), x);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
