// Scoring: the blind human rubric (primary outcome) and the lexical
// cross-check (secondary, condition-blind by construction).

import { hashString } from './rng.js';
import { stems } from './text.js';
import { conditionInfo } from './study.js';

// Idea score: the content of the theme (places, objects, events, sensations).
export const RUBRIC = [
  { score: 0, label: 'Absent', desc: 'Nothing in the report matches the content of this theme. Ignore the feeling.' },
  { score: 1, label: 'Faint', desc: 'A vague or ambiguous place, object, event or sensation that might match. Ignore the feeling.' },
  { score: 2, label: 'Clear', desc: 'A clearly recognisable place, object, event or sensation from the theme. Ignore the feeling.' },
  { score: 3, label: 'Central', desc: 'The content of the theme is central to the report. Ignore the feeling.' },
];

// The v0.3 rubric, shown unchanged for studies locked to the v1 protocol.
export const RUBRIC_V1 = [
  { score: 0, label: 'Absent', desc: 'Nothing in the report relates to this target.' },
  { score: 1, label: 'Faint', desc: 'A vague or ambiguous element that might relate.' },
  { score: 2, label: 'Clear', desc: 'A clearly recognisable element of the target.' },
  { score: 3, label: 'Central', desc: 'The target is a central theme of the report.' },
];

// v1 studies use the v0.3 wording; h2023 studies use the idea rubric.
export const rubricFor = (protocol) => ((protocol?.script || 'v1') === 'h2023' ? RUBRIC : RUBRIC_V1);

// Emotion score: how strongly the report carries the target's feeling, whatever the content.
export const EMOTION_RUBRIC = [
  { score: 0, label: 'Absent', desc: 'The report does not carry this feeling, whatever the content.' },
  { score: 1, label: 'Faint', desc: 'A hint of this feeling, whatever the content.' },
  { score: 2, label: 'Clear', desc: 'The feeling is clearly present, whatever the content.' },
  { score: 3, label: 'Dominant', desc: 'The feeling dominates the report, whatever the content.' },
];

export function reportText(session) {
  const parts = [];
  for (const r of session.rounds || []) if (r.transcript && r.transcript.trim()) parts.push(r.transcript.trim());
  if (session.morning && session.morning.report && session.morning.report.trim()) parts.push(session.morning.report.trim());
  return parts.join('\n\n');
}

// Only what you experienced while drifting or asleep counts as a dream report.
// Wake-ups you rated "still awake" are waking thoughts, so they are left out.
export function dreamText(session) {
  const parts = [];
  for (const r of session.rounds || []) if (r.state !== 'awake' && r.transcript && r.transcript.trim()) parts.push(r.transcript.trim());
  if (session.morning && session.morning.report && session.morning.report.trim()) parts.push(session.morning.report.trim());
  return parts.join('\n\n');
}

// The text that gets scored for incorporation: dream reports after a nap,
// waking mentation in a Phase 2 stay-awake session (a manipulation check).
export function scoringText(session) {
  return conditionInfo(session.condition).state === 'wake' ? reportText(session) : dreamText(session);
}

export function lexicalScore(text, lexicon) {
  const present = new Set(stems(text));
  const hits = lexicon.filter((x) => present.has(x.stem)).map((x) => x.word);
  return { score: Math.min(3, hits.length), hits };
}

export function blindCode(sessionId, studySeed) {
  return hashString(`${sessionId}:${studySeed}`).toString(36).padStart(7, '0').slice(-6).toUpperCase();
}

export function isScoreable(session) {
  return session.status === 'complete' && !session.rehearsal && session.params?.speed === 1 && scoringText(session).length > 0;
}

const studyList = (studies) => [].concat(studies || []).filter(Boolean);
const byCodeOrder = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

// Scoreable sessions of one or more studies with their blind codes, in a stable
// order that is unrelated to date, phase or condition.
function coded(sessions, studies) {
  const list = studyList(studies);
  const out = [];
  for (const s of sessions) {
    const study = list.find((x) => x.id === s.studyId);
    if (study && isScoreable(s)) out.push({ s, study, code: blindCode(s.id, study.seed) });
  }
  return out.sort(byCodeOrder);
}

// Unscored, scoreable sessions.
export function blindQueue(sessions, studies) {
  return coded(sessions, studies).filter((x) => !x.s.blind).map((x) => x.s);
}

function csvField(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  const s = String(text).replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// A packet an independent rater can score without seeing dates or conditions.
export function blindPacketCSV(sessions, studies, targets) {
  const rows = [['code', 'target_A', 'target_B', 'emotion_A_target', 'emotion_B_target', 'report', 'idea_A', 'idea_B', 'emotion_A', 'emotion_B']];
  for (const x of coded(sessions, studies)) {
    const A = targets.find((t) => t.id === x.study.targetIds.A);
    const B = targets.find((t) => t.id === x.study.targetIds.B);
    rows.push([x.code, A?.label ?? 'A', B?.label ?? 'B', A?.dims?.emotion ?? '', B?.dims?.emotion ?? '', scoringText(x.s), '', '', '', '']);
  }
  return toCSV(rows);
}

export function parseScoresCSV(text, sessions, studies) {
  const rows = parseCSV(text);
  const errors = [];
  const updates = [];
  if (!rows.length) return { updates, errors: ['The file is empty.'] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ci = head.indexOf('code'), ai = col('idea_a', 'score_a'), bi = col('idea_b', 'score_b');
  const eai = head.indexOf('emotion_a'), ebi = head.indexOf('emotion_b');
  if (ci < 0 || ai < 0 || bi < 0) return { updates, errors: ['Expected columns: code, idea_A, idea_B (or legacy score_A, score_B).'] };
  const list = studyList(studies);
  const byCode = new Map();
  for (const s of sessions) {
    const st = list.find((x) => x.id === s.studyId);
    if (st) byCode.set(blindCode(s.id, st.seed), s);
  }
  rows.slice(1).forEach((r, k) => {
    const code = (r[ci] || '').trim().toUpperCase();
    const a = (r[ai] || '').trim(), b = (r[bi] || '').trim();
    if (!code) return;
    const ea = eai >= 0 ? (r[eai] || '').trim() : '', eb = ebi >= 0 ? (r[ebi] || '').trim() : '';
    if (a === '' && b === '' && ea === '' && eb === '') return; // unscored row
    const s = byCode.get(code);
    const A = Number(a), B = Number(b);
    if (!s) { errors.push(`Row ${k + 2}: unknown code ${code}.`); return; }
    const ok = (x) => Number.isInteger(x) && x >= 0 && x <= 3;
    const emo = (v) => (v === '' ? null : Number(v));
    const emoA = emo(ea), emoB = emo(eb);
    if (a === '' || b === '' || ![A, B].every(ok) || ![emoA, emoB].every((x) => x === null || ok(x))) { errors.push(`Row ${k + 2}: scores must be whole numbers 0–3.`); return; }
    updates.push({ sessionId: s.id, A, B, emoA, emoB });
  });
  return { updates, errors };
}
