import * as db from './db.js';
import * as audio from './audio.js';
import { SessionRunner, requestMotionPermission } from './runner.js';
import { compileTarget, compareTargets, startPhraseOf, DIMENSIONS, AWARENESS, NEUTRAL } from './core/compiler.js';
import { rubricFor, EMOTION_RUBRIC, blindQueue, blindPacketCSV, parseScoresCSV, scoringText, blindCode } from './core/scoring.js';
import { ARMS, STATES, ONSET, armStats, chooseArm, onsetEstimate, onsetWindow } from './core/adaptive.js';
import { makePairs, makeTest, scoreResponses, memorySummary, PAIR_MS } from './core/memory.js';
import { sessionRows, trialRows, rowsToCSV, associations, parseMetricsCSV, mergeMetrics, localDate } from './core/trials.js';
import { mean } from './core/stats.js';
import { buildPlan, buildPlainPlan, planDurationSec, drawOnsetMin, PHASE_TEXT, LIMITS, SCRIPT_H2023 } from './core/protocol.js';
import { createStudy, createBenefitStudy, nextAllocation, cuedTargetId, allocatedSessions, extendStudy, conditionInfo, conditionsOf, studyKind, studyProtocol, phaseOneDone, parseObjects, MIN_OBJECTS } from './core/study.js';
import { volumeTable, nextCueVolume } from './core/arousal.js';
import { newStudyProtocol, sessionLines, needsBinding, bindingScreen, voiceChecklist, BIND_SEC, BIND_PLAYS, LINE_KEYS } from './core/runtime.js';
import { makeThemedSets, makeThemedTest, scoreThemed, themedRetention, autObject, autOrder, fluency, nextPostTask, creativityQueue, creativityPacketCSV, parseCreativityCSV, analyzeBenefit, AUT_SEC, AUT_SCALE, OUTCOMES, READY as BENEFIT_READY } from './core/benefit.js';
import { canStartSession, pauseState, consentValid, CONSENT_ITEMS, CONSENT_VERSION, SAFETY, UNREAL_PAUSE } from './core/safety.js';
import { analyzeStudy, READY_PER_ARM } from './core/analysis.js';
import { emptyState, migrate, validateImport } from './core/schema.js';
import { mulberry32, newSeed, newId } from './core/rng.js';

const APP_VERSION = '0.4.0';
const params = new URLSearchParams(location.search);
const SPEED = Math.min(120, Math.max(1, Math.round(Number(params.get('speed')) || 1)));
const REHEARSAL_SPEED = 20;
// QA only: with ?speed>1 a test run may force a condition (?cond=WA). Real sessions never can.
const FORCE_COND = SPEED > 1 ? params.get('cond') : null;

let S = null;
const ui = { view: 'home', draft: {}, editTargetId: null, reportId: null, scoreDraft: {}, runner: null, night: null, recording: null, rehearsal: null, endArmed: false, learn: null, test: null, pendingMemory: null, aut: null, binding: null };
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let objectURLs = [];

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const pval = (p) => (!Number.isFinite(p) ? '–' : p < 0.001 ? '< 0.001' : p.toFixed(3));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const save = () => db.saveState(S);
const activeStudy = () => S.studies.find((s) => s.id === S.activeStudyId) || null;
const target = (id) => S.targets.find((t) => t.id === id) || null;
const lockedTargetIds = () => new Set(S.studies.flatMap((s) => [s.targetIds.A, s.targetIds.B]));
const realSession = (s) => !s.rehearsal && s.params?.speed === 1;
const todayCheckin = () => S.checkins.find((c) => c.date === localDate(new Date())) || null;
const excludedStems = () => S.targets.flatMap((t) => t.lexicon.map((x) => x.stem));
const studyById = (id) => S.studies.find((s) => s.id === id) || null;
const latest = (pred) => [...S.studies].reverse().find(pred) || null;
// The Phase 1 study shown in Results: the active one, the parent of the active Phase 2, or the latest.
function steerStudy() {
  const a = activeStudy();
  if (a && studyKind(a) === 'steer') return a;
  if (a && a.parentId) return studyById(a.parentId);
  return latest((x) => studyKind(x) === 'steer');
}
function benefitStudy() {
  const a = activeStudy();
  if (a && studyKind(a) === 'benefit') return a;
  return latest((x) => studyKind(x) === 'benefit');
}
// A finished Phase 1 that doesn't have a Phase 2 yet.
const phaseTwoParent = () => latest((x) => phaseOneDone(x, S.sessions) && !S.studies.some((b) => b.parentId === x.id));
const themeLabel = (th, study) => target(study?.targetIds?.[th])?.label || th;

// ---------- v0.4: protocol, voices, cue volume ----------
const SCRIPT_NAME = { h2023: 'Horowitz 2023', v1: 'v0.3' };
// The protocol sessions run under now: the active study's, else what a new study would get.
const currentProtocol = () => (activeStudy() ? studyProtocol(activeStudy()) : newStudyProtocol(S.settings));
const studyTargets = (study) => (study ? [target(study.targetIds.A), target(study.targetIds.B)].filter(Boolean) : S.targets);
// Every recordable line the active study uses (or a new study would use).
function voiceRows(study = activeStudy()) {
  return voiceChecklist({ protocol: study ? studyProtocol(study) : newStudyProtocol(S.settings), kind: study ? studyKind(study) : 'steer', targets: studyTargets(study), settings: S.settings });
}
// Emotion is scored only when the study asks for it and the target has a feeling.
const emotionScored = (study, T) => !!(studyProtocol(study).script === 'h2023' && studyProtocol(study).emotionScores && String(T?.dims?.emotion || '').trim());
// The cue volume a session would play at. v1 studies keep the fixed v0.3 volume.
function sessionCueVolume(protocol = currentProtocol()) {
  const st = S.settings;
  if (!st.adaptiveVolume || protocol.script !== 'h2023') return { volume: st.cueVolume, adaptive: false, history: [] };
  const r = nextCueVolume(S.sessions, { start: st.cueVolume, min: 0.1, max: st.cueVolumeMax });
  return { volume: r.volume, adaptive: true, history: r.history };
}
// Resolve a session's lines to { text, blob }; a missing recording means TTS for that line only.
async function loadLines(spec) {
  const out = {};
  for (const k of LINE_KEYS) {
    const l = spec[k];
    out[k] = l ? { text: l.text, blob: l.voiceId ? await db.getBlob(l.voiceId) : null } : null;
  }
  return out;
}

function go(view, extra = {}) {
  Object.assign(ui, extra, { view });
  render();
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast ${kind} show`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function seg(name, options, value) {
  return `<div class="seg" role="radiogroup">${options.map((o) => `<label><input type="radio" name="${name}" value="${esc(o.v)}" ${String(value) === String(o.v) ? 'checked' : ''}><span>${esc(o.l)}</span></label>`).join('')}</div>`;
}

const COND_TAG = {
  A: ['a', 'A'], B: ['b', 'B'], control: ['c', 'control'],
  SA: ['a', 'A · nap'], SB: ['b', 'B · nap'], WA: ['a w', 'A · awake'], WB: ['b w', 'B · awake'], plain: ['c', 'plain nap'],
};
const tag = (c) => { const [cls, label] = COND_TAG[c] || ['c', c]; return `<span class="tag ${cls}">${esc(label)}</span>`; };

// ---------- views ----------
const VIEWS = {};

function checkinCard() {
  if (todayCheckin()) return `<section class="banner row between"><span>Checked in today.</span><button class="btn ghost" data-act="nav" data-view="checkin">Edit</button></section>`;
  return `<section class="banner info row between"><span>Daily check-in: sleep, mood and sharpness. About a minute, and needed before a nap.</span><button class="btn primary" data-act="nav" data-view="checkin">Check in</button></section>`;
}

VIEWS.checkin = () => {
  const c = todayCheckin() || {};
  return `
  <header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>Daily check-in</h1></header>
  <section class="stack">
    <p class="lede">Context for your data, and an early-warning check. Answer for the last 24 hours.</p>
    <label class="field"><span>Hours slept last night</span><input type="number" name="sleepHours" min="0" max="16" step="0.5" inputmode="decimal" value="${esc(c.sleepHours ?? '')}"></label>
    <span class="label">Sleep quality last night</span>${seg('sleepQuality', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['very poor', 'poor', 'ok', 'good', 'very good'][v] })), c.sleepQuality)}
    <span class="label">Mood right now</span>${seg('mood', [-2, -1, 0, 1, 2].map((v) => ({ v, l: ['very low', 'low', 'neutral', 'good', 'very good'][v + 2] })), c.mood)}
    <span class="label">Mental sharpness yesterday: focus, learning, memory</span>${seg('sharpness', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['very poor', 'poor', 'usual', 'good', 'excellent'][v] })), c.sharpness)}
    <span class="label">Did things feel unreal, dreamlike or detached?</span>${seg('unreal', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['not at all', 'briefly', 'sometimes', 'often', 'constantly'][v] })), c.unreal)}
    <label class="check"><input type="checkbox" name="confusion" ${c.confusion ? 'checked' : ''}><span>I mixed up a dream memory with something that really happened</span></label>
    <label class="check"><input type="checkbox" name="substances" ${c.substances ? 'checked' : ''}><span>I took something that affects sleep, dreams or mind (alcohol, cannabis, sleep aids, or supplements such as mugwort or galantamine)</span></label>
    <label class="field"><span>Note <em>optional</em></span><input name="note" value="${esc(c.note ?? '')}" maxlength="200"></label>
    <p class="fine">Feeling unreal often (${UNREAL_PAUSE}+) or confusing a dream with reality pauses the study automatically. Tell your trusted person if it happens.</p>
    <button class="btn primary big" data-act="save-checkin">Save check-in</button>
  </section>`;
};

VIEWS.learn = () => {
  const L = ui.learn;
  const n = L.themed ? L.sets.A.length + L.sets.B.length : L.pairs.length;
  return `
  <section class="stack center learn" id="learn">
    <p class="eyebrow">${L.themed ? `Learn two sets · ${n} pairs` : `Learn these pairs · ${n} pairs, ${Math.round((n * PAIR_MS) / 1000)} s`}</p>
    <p class="theme-head" id="learn-head"></p>
    <p class="muted small" id="pair-count"></p>
    <div class="pair"><span id="pair-cue"></span><span class="pair-sep">—</span><span id="pair-answer"></span></div>
    <p class="fine" id="learn-note">Picture the two things together. You’ll be tested now and again after the ${L.themed ? 'session' : 'nap'}.</p>
  </section>`;
};

VIEWS.memtest = () => {
  const T = ui.test;
  const item = T.items[T.i];
  const study = T.sessionId ? studyById(S.sessions.find((x) => x.id === T.sessionId)?.studyId) : activeStudy();
  const when = T.phase === 'immediate' ? (T.themed ? 'Before the session' : 'Before the nap') : T.themed ? 'After the session' : 'After the nap';
  return `
  <section class="stack center memtest">
    <p class="eyebrow">${when} · ${T.i + 1} of ${T.items.length}</p>
    ${T.themed ? `<p class="theme-head">${tag(item.theme)} ${esc(themeLabel(item.theme, study))}</p>` : ''}
    <p class="cue-word">${esc(item.cue)}</p>
    <p class="muted small">Which word was paired with it?</p>
    <div class="options">${item.options.map((o) => `<button class="btn ghost option" data-act="answer" data-word="${esc(o)}">${esc(o)}</button>`).join('')}</div>
  </section>`;
};

VIEWS.memReady = () => {
  const P = ui.pendingMemory;
  if (P?.themed) {
    const study = activeStudy();
    const b = P.immediate.byTheme;
    return `
    <header class="top"><h1>Baseline saved</h1></header>
    <section class="stack">
      <p class="lede">Straight after learning: ${tag('A')} ${esc(themeLabel('A', study))} ${b.A.correct}/${b.A.n} · ${tag('B')} ${esc(themeLabel('B', study))} ${b.B.correct}/${b.B.n}. You’ll retest both sets afterwards.</p>
      <p>When you press start, the session type is drawn: a nap with one theme’s cue, staying awake through the same cues, or an ordinary nap with no cues. The screen tells you which.</p>
      ${needsBinding(studyProtocol(study), 'SA') ? `<p>Unless it’s a plain nap, ${BIND_SEC / 60} minutes of binding come first: picture the theme while its lines play, then rate it.</p>` : ''}
      <p>Lie down, or sit up if it turns out to be a stay-awake session. You have ${S.settings.lieDownSec} seconds to settle.</p>
      <button class="btn primary big" data-act="start-session">Start session</button>
      <button class="btn ghost" data-act="cancel-memory">Cancel</button>
    </section>`;
  }
  const m = P?.immediate;
  return `
  <header class="top"><h1>Baseline saved</h1></header>
  <section class="stack">
    <p class="lede">You got ${m?.correct}/${m?.n} straight after learning. You’ll take the same test after the nap.</p>
    <p>${needsBinding(currentProtocol(), 'A') ? `After you press start: ${BIND_SEC / 60} minutes of binding and a quick rating, then lie down. You have ${S.settings.lieDownSec} seconds to settle.` : `Now lie down. After you press start you have ${S.settings.lieDownSec} seconds to settle.`}</p>
    <button class="btn primary big" data-act="start-session">Start session</button>
    <button class="btn ghost" data-act="cancel-memory">Cancel</button>
  </section>`;
};

const WAKE_TEXT = 'Stay-awake session. Sit up, keep your eyes closed and stay awake the whole time. When you hear the cue, think about it. When the prompt asks, say what you were thinking.';
const PLAIN_TEXT = 'Ordinary nap. No cues and no wake-ups until the end. Just sleep.';

VIEWS.aut = () => {
  const A = ui.aut;
  return `
  <section class="stack aut">
    <p class="eyebrow">Creative uses · ${A.n} of 2</p>
    <h1>${esc(A.object)}</h1>
    <p class="lede">List all the creative, alternative uses you can think of for <b>${esc(A.object)}</b>. Be creative. One use per line.</p>
    <p class="aut-clock" id="aut-clock"></p>
    <textarea id="aut-text" rows="9" placeholder="one use per line" autocomplete="off" autocapitalize="sentences"></textarea>
    <button class="btn primary big" data-act="aut-done">Done</button>
    <p class="fine">You have ${AUT_SEC / 60} minutes. It saves itself when time runs out. Try to keep going until then.</p>
  </section>`;
};

function phaseTwoCard() {
  const p1 = phaseTwoParent();
  if (!p1) return '';
  return `
  <section class="card stack phase2">
    <p class="eyebrow">Next: Phase 2</p>
    <h2>Does engineered dreaming help?</h2>
    <p>Phase 1 tested whether the cue steers your dreams. Phase 2 tests whether steered dreams improve memory or creativity <b>beyond normal sleep</b>. Its controls are built so that only the dreaming differs.</p>
    <button class="btn primary" data-act="nav" data-view="benefitSetup">Set up Phase 2</button>
  </section>`;
}

VIEWS.benefitSetup = () => {
  const p1 = phaseTwoParent();
  if (!p1) return `<header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>Phase 2</h1></header><p class="muted">Finish Phase 1 first.</p>`;
  const r = analyzeStudy(p1, S.sessions, S.targets, { source: 'blind' });
  const A = target(p1.targetIds.A), B = target(p1.targetIds.B);
  const d = ui.draft;
  const supported = r.ready && r.primary.effect > 0 && r.primary.p < 0.05;
  // Prefer the target's own related words (usually concrete) over its whole lexicon, which includes moods.
  const hint = (t) => `e.g. ${(parseObjects(t.related).length >= 2 ? parseObjects(t.related) : t.lexicon.map((x) => x.word)).slice(0, 4).join(', ')}`;
  const n = S.settings.pairsPerTheme;
  return `
  <header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>Set up Phase 2</h1></header>
  <section class="stack">
    <p class="lede">Phase 1 asked whether the cue steers your dreams. Phase 2 asks whether steered dreams do anything for you that normal sleep doesn’t.</p>
    <article class="card stack tight">
      <h2>Phase 1 result</h2>
      <p class="small">Blind incorporation effect <b>${num(r.primary.effect)}</b>, p ${pval(r.primary.p)} (n = ${r.primary.nA} A, ${r.primary.nB} B)${r.ready ? '' : ', provisional'}.</p>
      ${supported ? '<p class="small">Your dreams followed the cue. Phase 2 can test what that does for you.</p>' : '<p class="warn-text">Phase 1 didn’t show reliable steering. Phase 2 can still run, but if the cue doesn’t reach your dreams, it can’t show that dreams help. Consider re-running Phase 1 with more distinct targets or different timing first.</p>'}
    </article>
    <h2>Every session</h2>
    <ol class="steps">
      <li><b>Before:</b> learn two sets of ${n} word pairs, one per theme. Each set starts with that theme’s cue, so the cue becomes a reminder of the set. Then a quick test.</li>
      <li><b>The session</b> is randomly one of five:
        <ul>
          <li>${tag('SA')} ${tag('SB')} a nap with theme A’s or B’s cue (as in Phase 1)</li>
          <li>${tag('WA')} ${tag('WB')} stay awake, eyes closed, through the <b>same cues and prompts</b>. This separates dreaming from just hearing the cue.</li>
          <li>${tag('plain')} an ordinary nap of the same length with no cues and no wake-ups. This is <b>normal sleep</b>.</li>
        </ul></li>
      <li><b>After:</b> your report, a retest of both sets, and a 3-minute creative-uses task for one object from each theme.</li>
    </ol>
    <p class="small">Both themes are measured after every session, so the cued theme minus the uncued theme holds sleep, wake-ups, voice and timing constant. The only thing that differs is what the cue, and so the dream, was aimed at.</p>
    <span class="label">Primary outcome (locked once created)</span>
    ${seg('b-primary', [{ v: 'creativity', l: 'Creativity' }, { v: 'memory', l: 'Memory' }], d.bPrimary || 'creativity')}
    <p class="fine"><b>Creativity</b> repeats the one published benefit of sleep-onset incubation: more creative uses for the incubated theme (Horowitz et al. 2023). <b>Memory</b> is closer to your learning goal, but no study has shown it for sleep-onset incubation yet. Whichever you pick, the other is still measured as a secondary outcome.</p>
    <label class="field"><span>${tag('A')} Objects from “${esc(A?.label)}” <em>${MIN_OBJECTS}+, comma-separated</em></span><input data-draft="objA" value="${esc(d.objA || '')}" placeholder="${esc(hint(A))}"></label>
    <label class="field"><span>${tag('B')} Objects from “${esc(B?.label)}” <em>${MIN_OBJECTS}+, comma-separated</em></span><input data-draft="objB" value="${esc(d.objB || '')}" placeholder="${esc(hint(B))}"></label>
    <p class="fine">Concrete things you could find in each theme (e.g. tree, moss, owl). Each session asks for uses of the next object in the list, so you don’t repeat the same one.</p>
    <label class="field"><span>Blocks of 5 sessions</span><input type="number" min="1" max="40" data-draft="bBlocks" value="${esc(d.bBlocks || 6)}"></label>
    <p class="fine">6 blocks = 30 sessions, 6 of each kind. Results stay provisional until at least ${BENEFIT_READY.sleep} cued naps, ${BENEFIT_READY.wake} stay-awake sessions and ${BENEFIT_READY.plain} plain naps have outcomes.</p>
    ${protocolNote()}
    <button class="btn primary big" data-act="create-benefit">Lock the design and create Phase 2</button>
  </section>`;
};

VIEWS.charter = () => {
  const items = S.consent?.items || {};
  return `
  <section class="stack">
    <p class="eyebrow">Dream Engine · V0</p>
    <h1>Dream charter</h1>
    <p class="lede">Before anything plays in your ear while you sleep, here is what this tool will and won’t do.</p>
    <ol class="charter">
      <li><b>You set the intention.</b> It only steers toward experiences you define, and it optimises for your stated goals. It never optimises for engagement, streaks or anyone else’s interests.</li>
      <li><b>Consent per intervention.</b> Each kind of intervention below needs its own yes. You can withdraw any of them in Settings.</li>
      <li><b>Local only.</b> Reports, recordings and ratings stay in this browser on this device. There are no accounts, uploads or analytics, and the page’s security policy blocks outbound requests.</li>
      <li><b>Sleep comes first.</b> V0 runs only for daytime naps (${SAFETY.hardWindow.start}–${SAFETY.hardWindow.end}), wakes you at most ${LIMITS.maxRounds} times, and pauses itself if your ratings show disrupted sleep or distressing dreams.</li>
      <li><b>Sound only.</b> No electrical, magnetic or ultrasonic brain stimulation.</li>
      <li><b>Honest measurement.</b> Conditions are randomised and scored blind. Results stay provisional until there is enough data.</li>
    </ol>
    <h2>Consent</h2>
    <div class="stack tight">
      ${CONSENT_ITEMS.map((c) => `<label class="check"><input type="checkbox" name="consent" value="${c.key}" ${items[c.key] ? 'checked' : ''}><span>${esc(c.text)}</span></label>`).join('')}
    </div>
    <p class="fine">Not a medical device. If you have a diagnosed sleep disorder, epilepsy, trauma-related nightmares, or are pregnant, talk to a clinician before experimenting with sleep interruption.</p>
    <button class="btn primary big" data-act="accept-consent">I agree, continue</button>
  </section>`;
};

function ownVoiceBanner(study) {
  if (S.settings.voiceMode !== 'own' || !study) return '';
  const rows = voiceRows(study);
  const missing = rows.filter((r) => !r.voiceId).length;
  if (!missing) return '';
  return `<section class="banner warn row between" id="voice-banner"><span>Own voice: ${missing} of ${rows.length} lines this study uses aren’t recorded yet. Those lines play in the device voice.</span><button class="btn ghost" data-act="nav" data-view="settings">Record</button></section>`;
}

function sessionBanners(study) {
  const ps = pauseState(study, S.sessions, S.checkins);
  const pending = S.sessions.filter((s) => s.studyId === study.id && s.status !== 'running' && !s.rehearsal && !s.morning && (s.rounds?.length || s.status === 'complete'));
  const post = S.sessions.filter((s) => s.studyId === study.id && !s.rehearsal && nextPostTask(s));
  const queue = blindQueue(S.sessions, S.studies);
  const cq = creativityQueue(S.sessions, S.studies);
  return `
  ${ownVoiceBanner(study)}
  ${ps.paused ? `<section class="banner danger stack tight">
      <b>Study paused for your wellbeing</b>
      <span>${ps.reasons.map(esc).join(' ')}</span>
      <span>Take at least a day. Ask yourself whether this target or the timing is right for you before you go on.</span>
      <label class="check"><input type="checkbox" id="ack-check"><span>I’ve reflected and want to continue the study.</span></label>
      <button class="btn ghost" data-act="ack-pause">Resume study</button>
    </section>` : ''}
  ${pending.map((s) => `<section class="banner info row between"><span>Your session from ${esc(when(s.startedAt))} needs its report.</span><button class="btn primary" data-act="open-report" data-id="${s.id}">Write report</button></section>`).join('')}
  ${post.map((s) => `<section class="banner info row between"><span>Your session from ${esc(when(s.startedAt))} still needs its after-session tests.</span><button class="btn primary" data-act="resume-post" data-id="${s.id}">Continue</button></section>`).join('')}
  ${queue.length ? `<section class="banner row between"><span>${queue.length} report${queue.length > 1 ? 's' : ''} waiting for blind scoring.</span><button class="btn ghost" data-act="nav" data-view="score">Score</button></section>` : ''}
  ${cq.length ? `<section class="banner row between"><span>${cq.length} creative-uses list${cq.length > 1 ? 's' : ''} waiting for a blind rating.</span><button class="btn ghost" data-act="nav" data-view="score">Rate</button></section>` : ''}
  ${checkinCard()}`;
}

function learningEngineCard() {
  const onset = onsetEstimate(S.sessions);
  const win = onsetWindow(onset.estimate);
  const arms = armStats(S.sessions);
  return `
  <section class="card stack">
    <h2>Learning engine</h2>
    <dl class="kv">
      <dt>First cue</dt><dd>${num(win.minMin, 1)}–${num(win.maxMin, 1)} min after you settle <span class="muted">(estimate ${num(onset.estimate, 0)} min from ${onset.history.length} rated nap${onset.history.length === 1 ? '' : 's'})</span></dd>
      ${ARMS.map((a) => `<dt>${esc(a.id)}</dt><dd>${esc(a.label)} · caught you drifting ${arms[a.id].successes}/${arms[a.id].n} times</dd>`).join('')}
    </dl>
    <p class="fine">The timing profile for each nap is picked by Thompson sampling. It favours whichever profile most often wakes you while you’re drifting (hypnagogia) in rounds 2 and later. Only cued naps teach it; stay-awake sessions and plain naps don’t.</p>
  </section>`;
}

function benefitHome(study) {
  const alloc = nextAllocation(study, S.sessions);
  const used = allocatedSessions(study, S.sessions).length;
  const check = canStartSession({ state: S, study, speed: SPEED });
  return `
  <header class="top"><div><p class="eyebrow">Dream Engine · Phase 2</p><h1>Does engineered dreaming help?</h1></div></header>
  ${sessionBanners(study)}
  <section class="card stack">
    <div class="row between"><h2>Phase 2 study</h2><span class="muted">${used}/${study.schedule.length} sessions</span></div>
    <div class="pairs">
      <div>${tag('SA')} ${tag('SB')} nap with ${esc(themeLabel('A', study))} or ${esc(themeLabel('B', study))} cues</div>
      <div>${tag('WA')} ${tag('WB')} awake, same cues and prompts</div>
      <div>${tag('plain')} <span class="muted">ordinary nap, no cues (normal sleep)</span></div>
    </div>
    <p class="small">Primary outcome: <b>${esc(OUTCOMES[study.primary].label)}</b> (${esc(OUTCOMES[study.primary].desc)}).</p>
    <div class="bar"><span style="width:${(100 * used) / study.schedule.length}%"></span></div>
    ${alloc ? `
      ${check.ok ? '' : `<ul class="reasons">${check.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`}
      <button class="btn primary big" data-act="nav" data-view="preflight" ${check.ok ? '' : 'disabled'}>Start a session</button>
      <p class="fine">You learn both word-pair sets first. The session type is drawn from the locked sequence when you press start.</p>`
    : `<p><b>All ${study.schedule.length} sessions are done.</b> Finish the blind ratings, then read your results.</p>
      <div class="row"><button class="btn ghost" data-act="extend-study">Add 15 more sessions</button><button class="btn ghost" data-act="close-study">Close study</button></div>`}
  </section>
  ${learningEngineCard()}`;
}

VIEWS.home = () => {
  const study = activeStudy();
  if (study && studyKind(study) === 'benefit') return benefitHome(study);
  const head = `<header class="top"><div><p class="eyebrow">Dream Engine · ${phaseTwoParent() ? 'Phase 1 complete' : 'Phase 1: dream steering'}</p><h1>Engineer a dream theme</h1></div></header>`;
  if (!study) {
    const n = S.targets.length;
    return `${head}
    ${checkinCard()}
    ${phaseTwoCard()}
    <section class="card stack">
      <h2>Set up your first study</h2>
      <p>The study compares two dream targets you choose (A and B) with a no-target control. Each nap is randomly assigned one of the three. Afterwards you score your reports without knowing which cue you heard.</p>
      <ol class="steps">
        <li class="${n >= 2 ? 'done' : ''}"><b>Write two targets</b> <span class="muted">(${Math.min(n, 2)}/2)</span><br><span class="muted">Make them clearly different, e.g. a purple forest vs. an ocean of light.</span></li>
        <li><b>Create the study</b><br><span class="muted">This locks the targets and the randomised sequence (pre-registration).</span></li>
      </ol>
      <div class="row">
        <button class="btn ${n >= 2 ? 'ghost' : 'primary'}" data-act="nav" data-view="targets">Targets</button>
        <button class="btn ${n >= 2 ? 'primary' : 'ghost'}" data-act="nav" data-view="study" ${n >= 2 ? '' : 'disabled'}>Create study</button>
      </div>
    </section>
    <section class="card stack">
      <h2>Try the flow first</h2>
      <p>Rehearsal runs a 2-round session at ${REHEARSAL_SPEED}× speed with the ${currentProtocol().script === 'h2023' ? 'control lines (“Observe your thoughts.”)' : 'neutral cue'}, so you can check volume, voice and microphone while awake. Nothing is saved.</p>
      <button class="btn ghost" data-act="rehearse">Rehearse (about 2 min)</button>
    </section>`;
  }
  const A = target(study.targetIds.A), B = target(study.targetIds.B);
  const alloc = nextAllocation(study, S.sessions);
  const used = allocatedSessions(study, S.sessions).length;
  const check = canStartSession({ state: S, study, speed: SPEED });
  return `${head}
  ${sessionBanners(study)}
  ${phaseTwoCard()}
  <section class="card stack">
    <div class="row between"><h2>Current study</h2><span class="muted">${used}/${study.schedule.length} naps</span></div>
    <div class="pairs">
      <div>${tag('A')} ${esc(A?.label)}</div>
      <div>${tag('B')} ${esc(B?.label)}</div>
      <div>${tag('control')} <span class="muted">${studyProtocol(study).script === 'h2023' ? 'no target, “observe your thoughts”' : 'no target, neutral cue'}</span></div>
    </div>
    <div class="bar"><span style="width:${(100 * used) / study.schedule.length}%"></span></div>
    ${alloc ? `
      ${check.ok ? '' : `<ul class="reasons">${check.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`}
      <button class="btn primary big" data-act="nav" data-view="preflight" ${check.ok ? '' : 'disabled'}>Start a nap session</button>
      <p class="fine">Which condition you get is drawn from the locked sequence when you press start, not before.</p>`
    : `<p><b>All ${study.schedule.length} sessions are done.</b> Score the remaining reports, then read your results.</p>
      <div class="row"><button class="btn ghost" data-act="extend-study">Add 9 more naps</button><button class="btn ghost" data-act="close-study">Close study</button></div>`}
    <button class="btn ghost" data-act="rehearse">Rehearse at ${REHEARSAL_SPEED}× speed</button>
  </section>
  ${learningEngineCard()}`;
};

VIEWS.targets = () => {
  const locked = lockedTargetIds();
  const rec = ui.recording;
  return `
  <header class="top row between"><h1>Targets</h1><button class="btn primary" data-act="new-target">New target</button></header>
  <p class="lede">A target is the dream you want to have. The compiler turns it into a short spoken cue, a sound motif and a word list.</p>
  ${S.targets.length ? '' : '<p class="muted">No targets yet.</p>'}
  ${S.targets.map((t) => `
    <article class="card stack tight">
      <div class="row between"><h3>${esc(t.label)}</h3>${locked.has(t.id) ? '<span class="pill">locked by study</span>' : ''}</div>
      <p class="small muted">Start line: “${esc(startPhraseOf(t))}”</p>
      <p class="cue">“${esc(t.cuePhrase)}”</p>
      ${t.visualization ? `<p class="muted small">${esc(t.visualization)}</p>` : ''}
      <div class="chips">${t.lexicon.map((x) => `<span class="chip">${esc(x.word)}</span>`).join('')}</div>
      <div class="row wrap">
        <button class="btn ghost" data-act="hear-target" data-id="${t.id}">Hear cue</button>
        <button class="btn ghost ${rec?.kind === 'target' && rec?.id === t.id ? 'recording' : ''}" data-act="record-voice" data-kind="target" data-id="${t.id}">${rec?.kind === 'target' && rec?.id === t.id ? '● Stop recording' : t.voiceId ? 'Re-record cue' : 'Record cue in my voice'}</button>
        ${t.voiceId ? `<button class="btn ghost" data-act="play-voice" data-blob="${t.voiceId}">Play my recording</button>` : ''}
        ${locked.has(t.id) ? '' : `<button class="btn ghost" data-act="edit-target" data-id="${t.id}">Edit</button><button class="btn ghost danger" data-act="delete-target" data-id="${t.id}">Delete</button>`}
      </div>
    </article>`).join('')}
  ${S.targets.length >= 2 && !activeStudy() ? `<button class="btn primary big" data-act="nav" data-view="study">Create study from two targets</button>` : ''}`;
};

function targetPreview() {
  const r = compileTarget(ui.draft);
  if (!r.ok) return `<p class="muted">${esc(r.errors.join(' '))}</p>`;
  const t = r.target;
  return `
    <p class="eyebrow">Start line <span class="muted">(Horowitz script, once after you settle)</span></p>
    <p class="cue" id="pv-start">“${esc(t.startPhrase)}”</p>
    <p class="eyebrow">Cue <span class="muted">(at sleep onset and after each report)</span></p>
    <p class="cue" id="pv-cue">“${esc(t.cuePhrase)}”</p>
    ${t.dims.emotion ? `<p class="fine">The feeling (${esc(t.dims.emotion)}) isn’t in the cue. The pre-sleep binding step carries it.</p>` : ''}
    ${t.visualization ? `<p class="eyebrow">Pre-sleep visualisation</p><p class="small">${esc(t.visualization)}</p>` : ''}
    <p class="eyebrow">Words the lexical cross-check looks for</p>
    <div class="chips">${t.lexicon.map((x) => `<span class="chip">${esc(x.word)}</span>`).join('') || '<span class="muted">none</span>'}</div>
    ${r.warnings.map((w) => `<p class="warn-text">${esc(w)}</p>`).join('')}
    <button class="btn ghost" data-act="preview-cue">Hear it</button>`;
}

VIEWS.targetEdit = () => {
  const d = ui.draft;
  const sugg = compileTarget({ ...d, cuePhrase: '' }).target.cuePhrase;
  return `
  <header class="top"><button class="link" data-act="nav" data-view="targets">← Targets</button><h1>${ui.editTargetId ? 'Edit target' : 'New target'}</h1></header>
  <section class="stack">
    <label class="field"><span>Name</span><input data-draft="label" value="${esc(d.label)}" placeholder="purple forest" maxlength="60"></label>
    ${DIMENSIONS.map((x) => `<label class="field"><span>${x.label}</span><input data-draft="${x.key}" value="${esc(d[x.key])}" placeholder="${esc(x.hint)}"></label>`).join('')}
    <label class="field"><span>Awareness</span><select data-draft="awareness">${AWARENESS.map((a) => `<option value="${a.value}" ${d.awareness === a.value ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
    <label class="field"><span>Related words <em>optional, used only for the cross-check</em></span><input data-draft="related" value="${esc(d.related)}" placeholder="violet, trees, woods, moss"></label>
    <label class="field"><span>Cue phrase <em>optional override</em></span><input data-draft="cuePhrase" value="${esc(d.cuePhrase)}" placeholder="${esc(sugg || 'Remember to think of …')}"></label>
    <div class="card preview stack tight" id="preview">${targetPreview()}</div>
    <button class="btn primary big" data-act="save-target">Save target</button>
  </section>`;
};

function protocolLabel(p) {
  return `${SCRIPT_NAME[p.script] || p.script} script${p.script === 'h2023' ? (p.binding ? ', pre-sleep binding step' : ', no binding step') : ''}${p.emotionScores ? ', idea and emotion scores' : ''}`;
}
function protocolNote() {
  return `<p class="fine" id="protocol-note">Protocol (locked with the study): <b>${esc(protocolLabel(newStudyProtocol(S.settings)))}</b>. Change it in Settings before you create the study.</p>`;
}

VIEWS.study = () => {
  const ts = S.targets;
  const a = ui.draft.studyA || ts[0]?.id, b = ui.draft.studyB || ts[1]?.id;
  const ta = target(a), tb = target(b);
  const cmp = ta && tb ? compareTargets(ta, tb) : null;
  const opts = (sel) => ts.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  return `
  <header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>Create study</h1></header>
  <section class="stack">
    <p class="lede">Pick two targets. Each block of three naps contains A, B and control in a random order. The whole sequence is fixed now and revealed one nap at a time.</p>
    <label class="field"><span>${tag('A')} Target A</span><select data-draft="studyA">${opts(a)}</select></label>
    <label class="field"><span>${tag('B')} Target B</span><select data-draft="studyB">${opts(b)}</select></label>
    <label class="field"><span>Blocks of 3 naps</span><input type="number" min="2" max="40" data-draft="blocks" value="${esc(ui.draft.blocks || 8)}"></label>
    <p class="fine">8 blocks = 24 naps. Results are labelled provisional until at least ${READY_PER_ARM} A naps and ${READY_PER_ARM} B naps are scored.</p>
    ${protocolNote()}
    ${cmp ? cmp.warnings.map((w) => `<p class="warn-text">${esc(w)}</p>`).join('') : ''}
    <button class="btn primary big" data-act="create-study" ${cmp?.ok ? '' : 'disabled'}>Lock targets and create study</button>
  </section>`;
};

function durationRange() {
  const st = S.settings;
  const win = onsetWindow(st.adaptiveTiming ? onsetEstimate(S.sessions).estimate : ONSET.defaultMin);
  const proto = currentProtocol();
  const h = proto.script === 'h2023';
  const base = { rounds: st.rounds, recordSec: st.recordSec, lieDownSec: st.lieDownSec, preSleepCue: h ? false : st.preSleepCue, ...(h ? { script: 'h2023', state: 'sleep' } : {}) };
  const bind = needsBinding(proto, 'A') ? BIND_SEC : 0;
  const lo = bind + planDurationSec(buildPlan({ ...base, ...(st.adaptiveTiming ? ARMS[0] : ARMS[1]), onsetMin: win.minMin }));
  const hi = bind + planDurationSec(buildPlan({ ...base, ...(st.adaptiveTiming ? ARMS[2] : ARMS[1]), onsetMin: win.maxMin }));
  return { lo: Math.round(lo / 60), hi: Math.round(hi / 60), win, proto, bind: bind > 0 };
}

// Preflight lines that are new in v0.4 (Horowitz script, binding, tapping).
function v04Checklist(d) {
  const h = d.proto.script === 'h2023';
  return `
      ${d.bind ? `<li>Right after you press start, before you settle: ${BIND_SEC / 60} minutes of <b>binding</b>. Picture the target and let yourself feel its emotion while the start line and cue play, then give one or two quick ratings.</li>` : ''}
      ${h ? '<li>After each report you’ll be asked whether you were asleep. Answer out loud: awake, halfway or asleep.</li>' : ''}
      ${h ? '<li><b>If a cue wakes you, tap the screen once.</b> Anywhere on the black screen is fine.</li>' : ''}`;
}
function cueVolumeKv() {
  const v = sessionCueVolume();
  return `<dt>Cue volume</dt><dd>${pct(v.volume)} <span class="muted">${v.adaptive ? `adaptive, max ${pct(S.settings.cueVolumeMax)}` : 'fixed'}</span></dd>`;
}

VIEWS.preflight = () => {
  const st = S.settings;
  const d = durationRange();
  const study = activeStudy();
  if (studyKind(study) === 'benefit') {
    const nPairs = 2 * st.pairsPerTheme;
    return `
  <header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>Before the session</h1></header>
  <section class="stack">
    <ul class="checklist">
      <li>Phone on charge, within earshot, with the screen facing away from you. Turn on <b>Do Not Disturb</b>.</li>
      <li>First you learn two sets of word pairs, one per theme, about ${Math.round((nPairs * PAIR_MS) / 60000 + 1)} min with the cues and the test.</li>
      <li>Then the session type is drawn: a <b>nap with one theme’s cue</b>, <b>staying awake</b> (sitting up, eyes closed) through the same cues, or an <b>ordinary nap</b> with no cues. The screen tells you which.</li>
      <li>Afterwards: your report, a retest of both sets, and two 3-minute creative-uses tasks. Allow about 10 minutes.</li>
      ${v04Checklist(d)}
    </ul>
    <div class="row wrap"><button class="btn ghost" data-act="test-cue">Test cue volume</button><button class="btn ghost" data-act="test-wake">Test wake prompt</button></div>
    <dl class="kv">
      <dt>Word pairs</dt><dd>${st.pairsPerTheme} for ${esc(themeLabel('A', study))}, ${st.pairsPerTheme} for ${esc(themeLabel('B', study))}</dd>
      <dt>Session</dt><dd>about ${d.lo}–${d.hi} min, ${st.rounds} prompts (cued sessions) or one at the end (plain nap)</dd>
      <dt>Timing</dt><dd>${st.adaptiveTiming ? 'chosen by the learning engine at start (within Dormio’s options)' : 'fixed: 2 min hypnagogia, 5 min between'}</dd>
      ${cueVolumeKv()}
    </dl>
    <button class="btn primary big" data-act="begin-session">Learn both sets, then start</button>
  </section>`;
  }
  return `
  <header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>Before you lie down</h1></header>
  <section class="stack">
    <ul class="checklist">
      <li>Phone on charge, within earshot, with the screen facing away from you. The screen stays on but black.</li>
      <li>Turn on <b>Do Not Disturb</b>. A notification mid-nap ruins the protocol.</li>
      <li>Set the volume so the cue is clearly audible but soft. Test it below.</li>
      <li>After you press start you have ${st.lieDownSec} seconds to settle. Read the visualisation, then close your eyes and hold the intention.</li>
      ${v04Checklist(d)}
    </ul>
    <div class="row wrap"><button class="btn ghost" data-act="test-cue">Test cue volume</button><button class="btn ghost" data-act="test-wake">Test wake prompt</button></div>
    <dl class="kv">
      <dt>Rounds</dt><dd>${st.rounds} wake-ups, ${st.recordSec} s to speak each time</dd>
      <dt>First cue</dt><dd>${num(d.win.minMin, 1)}–${num(d.win.maxMin, 1)} min after settling (learned)</dd>
      <dt>Timing</dt><dd>${st.adaptiveTiming ? 'chosen by the learning engine at start (within Dormio’s options)' : 'fixed: 2 min hypnagogia, 5 min between'}</dd>
      <dt>Length</dt><dd>about ${d.lo}–${d.hi} min</dd>
      ${cueVolumeKv()}
      <dt>Script</dt><dd>${esc(protocolLabel(d.proto))}</dd>
      ${st.memoryTask ? `<dt>Memory task</dt><dd>${st.memoryPairs} word pairs before and after (about ${Math.round((st.memoryPairs * PAIR_MS) / 60000 + 1.5)} min)</dd>` : ''}
      ${st.cueMotif || (st.preSleepCue && d.proto.script !== 'h2023') ? `<dt>Experimental</dt><dd>${[st.cueMotif && 'sound motif', st.preSleepCue && d.proto.script !== 'h2023' && 'pre-sleep cue'].filter(Boolean).join(', ')}</dd>` : ''}
    </dl>
    <p class="fine">At each wake-up, just say what was going through your mind, even if it was fragments. Then let yourself drift back.</p>
    <button class="btn primary big" data-act="begin-session">${st.memoryTask ? 'Learn the word pairs, then start' : 'Start session'}</button>
  </section>`;
};

VIEWS.session = () => {
  const n = ui.night || {};
  // The whole black screen is a tap target ("if a cue wakes you, tap once"); the End button keeps its own action.
  return `
  <section class="night" id="night" data-act="night-tap">
    <p class="n-phase" id="n-phase">Starting…</p>
    <p class="n-round" id="n-round"></p>
    <p class="n-clock" id="n-clock"></p>
    <p class="n-vis" id="n-vis">${esc(n.visualization || '')}</p>
    ${n.tapHint ? '<p class="n-hint" id="n-hint">If a cue wakes you, tap the screen once.</p>' : ''}
    <p class="n-rec" id="n-rec" hidden>● listening</p>
    <p class="n-ack" id="n-ack" aria-live="polite"></p>
    <button class="n-end" data-act="end-session" id="n-end">End session</button>
  </section>`;
};

// Item 4: the pre-sleep binding step, before the nap runner starts.
VIEWS.binding = () => {
  const B = ui.binding;
  if (!B) return '<p class="muted">Nothing to do here.</p>';
  if (B.stage === 'listen') {
    return `
  <section class="bind stack center" id="bind" data-stage="listen">
    <p class="eyebrow">${B.variant === 'control' ? 'Before the session' : 'Binding'} · ${Math.round(BIND_SEC / 60)} min</p>
    <p class="bind-text" id="bind-text">${esc(B.text)}</p>
    <p class="bind-clock" id="b-clock">${mmss(B.endsAt - Date.now())}</p>
    <p class="fine">Close your eyes and listen. ${B.variant === 'control' ? 'The rating comes after.' : 'The ratings come after.'}</p>
    <button class="n-end" data-act="end-binding" id="bind-end">End session</button>
  </section>`;
  }
  return `
  <section class="bind stack" id="bind" data-stage="rate">
    <p class="eyebrow">${B.questions.length > 1 ? 'Two quick ratings' : 'One quick rating'}</p>
    <p class="bind-text small-text" id="bind-text">${esc(B.text)}</p>
    ${B.questions.map((q) => `
      <div class="field bind-q">
        <span>${esc(q.label)} <em id="bv-${q.key}">${B.values[q.key] ?? 'not set'}</em></span>
        <input type="range" min="0" max="10" step="1" data-bind="${q.key}" value="${B.values[q.key] ?? 5}" aria-label="${esc(q.label)}">
        <span class="scale-ends"><span>0 not at all</span><span>10 extremely</span></span>
      </div>`).join('')}
    <button class="btn primary big" data-act="save-binding" id="bind-save">${B.rehearsal ? 'Save and continue the rehearsal' : 'Save and start'}</button>
    <button class="btn ghost" data-act="end-binding" id="bind-end">End session</button>
  </section>`;
};

const AWAKE_PHASES = ['onset', 'hypnagogia', 'between', 'return', 'pre-sleep', 'start'];

function updateNight(step) {
  const n = ui.night;
  if (!n || ui.view !== 'session') return;
  const ph = document.getElementById('n-phase');
  if (!ph) return;
  let text = PHASE_TEXT[step.phase] || step.phase;
  if (n.state === 'wake' && AWAKE_PHASES.includes(step.phase)) text = step.kind === 'cue' ? 'Cue' : 'Stay awake, eyes closed';
  if (n.state === 'wake' && step.phase === 'wake') text = 'Prompt';
  ph.textContent = text;
  document.getElementById('n-round').textContent = step.round ? `Round ${step.round} of ${n.rounds}` : '';
  document.getElementById('n-clock').textContent = step.endsAt ? mmss(step.endsAt - Date.now()) : '';
  document.getElementById('n-rec').hidden = !step.recording;
  const pre = step.phase === 'settle' || step.phase === 'pre-sleep' || step.phase === 'start';
  document.getElementById('n-vis').hidden = !pre;
  const hint = document.getElementById('n-hint');
  if (hint) hint.hidden = !pre;
}

// A small, dim acknowledgement so you know the tap counted, without lighting the screen.
let ackTimer = null;
function ackTap() {
  const el = document.getElementById('n-ack');
  if (!el) return;
  el.textContent = 'tap noted';
  el.classList.add('show');
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 1500);
}

// Rounds of a sleep session that had an in-sleep cue get "did the cue wake you?".
const askCueWoke = (s, info, round) => s.params?.protocol?.script === 'h2023' && info.state === 'sleep' && !info.plain && (s.events || []).some((e) => e.type === 'cue' && e.phase === 'hypnagogia' && e.round === round);
const CUE_WOKE = [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }, { v: 'unsure', l: 'Not sure' }];

VIEWS.report = () => {
  const s = S.sessions.find((x) => x.id === ui.reportId);
  if (!s) return '<p>Session not found.</p>';
  const m = s.morning || {};
  const rounds = [...(s.rounds || [])].sort((a, b) => a.round - b.round);
  const info = conditionInfo(s.condition);
  const awake = info.state === 'wake';
  return `
  <header class="top"><button class="link" data-act="nav" data-view="home">← Home</button><h1>${awake ? 'Session report' : 'Nap report'}</h1><p class="muted">${esc(when(s.startedAt))}${s.status === 'aborted' ? ' · ended early' : ''}</p></header>
  <section class="stack">
    <p class="lede">${awake ? 'Write down what went through your mind at each prompt.' : 'Write it down while it’s fresh. Describe, don’t interpret.'} Don’t try to work out which cue you heard.</p>
    ${rounds.length ? '' : '<p class="muted">No wake-up rounds were reached.</p>'}
    ${rounds.map((r) => `
      <article class="card stack tight">
        <h3>Wake-up ${r.round}</h3>
        ${r.audioId ? `<audio controls preload="none" data-blob="${r.audioId}"></audio>` : '<p class="muted small">No recording (microphone unavailable).</p>'}
        <label class="field"><span>What you said or experienced</span><textarea rows="3" name="t-${r.round}">${esc(r.transcript)}</textarea></label>
        ${r.stateAudioId ? `<span class="label">Your spoken answer: awake, halfway or asleep?</span><audio controls preload="none" data-blob="${r.stateAudioId}"></audio>` : ''}
        <span class="label">When the prompt came, you were…</span>
        ${seg(`st-${r.round}`, STATES.map((x) => ({ v: x.value, l: x.label })), r.state)}
        ${askCueWoke(s, info, r.round) ? `<span class="label">Did the cue before this wake-up wake you?</span>${seg(`cw-${r.round}`, CUE_WOKE, r.cueWoke)}` : ''}
      </article>`).join('')}
    <label class="field"><span>Anything else you remember from the ${awake ? 'session' : 'nap'}</span><textarea rows="5" name="report">${esc(m.report)}</textarea></label>
    <span class="label">Vividness</span>${seg('vividness', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['none', 'faint', 'some', 'vivid', 'very vivid'][v] })), m.vividness)}
    <span class="label">Emotional tone</span>${seg('valence', [-2, -1, 0, 1, 2].map((v) => ({ v, l: ['very negative', 'negative', 'neutral', 'positive', 'very positive'][v + 2] })), m.valence)}
    <span class="label">Emotional intensity</span>${seg('intensity', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['none', 'mild', 'moderate', 'strong', 'overwhelming'][v] })), m.intensity)}
    <span class="label">Immersion: how real did it feel while it lasted?</span>${seg('immersion', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['not at all', 'a little', 'somewhat', 'very', 'like waking life'][v] })), m.immersion)}
    <span class="label">Bizarreness</span>${seg('bizarreness', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['ordinary', 'slightly odd', 'odd', 'very strange', 'impossible'][v] })), m.bizarreness)}
    <span class="label">Lucidity</span>${seg('lucidity', [0, 1, 2, 3].map((v) => ({ v, l: ['none', 'a flicker', 'knew I was dreaming', 'had some control'][v] })), m.lucidity)}
    ${awake ? '' : `<span class="label">How much did the wake-up${info.plain ? '' : 's'} disrupt your rest?</span>${seg('disruption', [0, 1, 2, 3, 4].map((v) => ({ v, l: ['not at all', 'a little', 'moderately', 'a lot', 'badly'][v] })), m.disruption)}`}
    <label class="check"><input type="checkbox" name="distressing" ${m.distressing ? 'checked' : ''}><span>Something in this nap was distressing</span></label>
    <button class="btn primary big" data-act="save-report" data-id="${s.id}">Save report</button>
  </section>`;
};

function creativityBlock() {
  if (!S.studies.some((x) => studyKind(x) === 'benefit')) return '';
  const cq = creativityQueue(S.sessions, S.studies);
  const c = cq[0];
  const v = ui.scoreDraft.aut;
  return `
  <section class="card stack">
    <h2>Creativity ratings</h2>
    <p class="small">Rate how creative each list of uses is, 1–5, as the raters in Horowitz et al. 2023 did. You won’t see the date or which theme was cued. Rating your own lists is only partly blind; an independent rater using the packet below is better.</p>
    ${c ? `
    <article class="stack tight">
      <div class="row between"><span class="eyebrow">List ${esc(c.code)}</span><span class="muted">${cq.length} left</span></div>
      <p class="small">Uses for <b>${esc(c.object)}</b></p>
      <blockquote class="report">${esc(c.text || '(nothing written)').replace(/\n/g, '<br>')}</blockquote>
      <div class="seg rubric">${AUT_SCALE.map((r) => `<label><input type="radio" name="aut-rating" value="${r.score}" ${v === r.score ? 'checked' : ''}><span><b>${r.score}</b> ${esc(r.label)}</span></label>`).join('')}</div>
      <details class="small"><summary>Scale</summary><ul>${AUT_SCALE.map((r) => `<li><b>${r.score} ${esc(r.label)}</b>: ${esc(r.desc)}</li>`).join('')}</ul></details>
      <button class="btn primary big" data-act="save-creativity" data-code="${esc(c.code)}">Save and next</button>
    </article>` : '<p class="muted">Nothing to rate right now.</p>'}
    <div class="row wrap">
      <button class="btn ghost" data-act="export-creativity">Export creativity packet (CSV)</button>
      <label class="btn ghost file">Import ratings<input type="file" accept=".csv,text/csv" data-file="import-creativity" hidden></label>
    </div>
  </section>`;
}

VIEWS.score = () => {
  if (!S.studies.length) return `<header class="top"><h1>Blind scoring</h1></header><p class="muted">Create a study first.</p>`;
  const queue = blindQueue(S.sessions, S.studies);
  const s = queue[0];
  const study = s ? studyById(s.studyId) : null;
  const A = study && target(study.targetIds.A), B = study && target(study.targetIds.B);
  const d = ui.scoreDraft;
  const ideaRubric = rubricFor(study ? studyProtocol(study) : null);
  const isH = !!study && studyProtocol(study).script === 'h2023';
  const scale = (key, rubric = ideaRubric) => `<div class="seg rubric" data-scale="${key}">${rubric.map((r) => `<label><input type="radio" name="score-${key}" value="${r.score}" ${d[key] === r.score ? 'checked' : ''}><span><b>${r.score}</b> ${esc(r.label)}</span></label>`).join('')}</div>`;
  const anyEmo = s && (emotionScored(study, A) || emotionScored(study, B));
  // Per target: the idea scale, and the emotion scale when this target's feeling is scored.
  const block = (T, key) => `
      <div class="stack tight score-target">
        <span class="label">${tag(key)} ${esc(T?.label)}${anyEmo ? ' <span class="muted">· idea</span>' : ''}</span>${scale(key)}
        ${emotionScored(study, T) ? `<span class="label">${tag(key)} Feeling: ${esc(T.dims.emotion)}</span>${scale(`emo${key}`, EMOTION_RUBRIC)}` : ''}
      </div>`;
  return `
  <header class="top"><h1>Blind scoring</h1></header>
  <section class="stack">
    <p class="lede">Rate every report for both targets. Reports come in a scrambled order with no dates, phases or conditions. Only what you reported while drifting or asleep is shown; wake-ups you rated “still awake” are left out. Scoring works best a day or more after the session.</p>
    ${s ? `
    <article class="card stack">
      <div class="row between"><span class="eyebrow">Report ${esc(blindCode(s.id, study.seed))}</span><span class="muted">${queue.length} left</span></div>
      <blockquote class="report">${esc(scoringText(s)).replace(/\n/g, '<br>')}</blockquote>
      ${(s.rounds || []).filter((r) => r.audioId && (conditionInfo(s.condition).state === 'wake' || r.state !== 'awake')).map((r) => `<audio controls preload="none" data-blob="${r.audioId}"></audio>`).join('')}
      ${block(A, 'A')}
      ${block(B, 'B')}
      <details class="small"><summary>Rubric</summary>
        ${isH ? '<p><b>Idea</b>: the content of the theme (places, objects, events, sensations).</p>' : ''}
        <ul>${ideaRubric.map((r) => `<li><b>${r.score} ${esc(r.label)}</b>: ${esc(r.desc)}</li>`).join('')}</ul>
        ${anyEmo ? `<p><b>Feeling</b>: how strongly the report carries this target’s feeling, whatever the content.</p><ul>${EMOTION_RUBRIC.map((r) => `<li><b>${r.score} ${esc(r.label)}</b>: ${esc(r.desc)}</li>`).join('')}</ul>` : ''}
      </details>
      <button class="btn primary big" data-act="save-score" data-id="${s.id}">Save and next</button>
    </article>` : '<p class="muted">Nothing to score right now.</p>'}
    <section class="card stack tight">
      <h2>Independent rater</h2>
      <p class="small">For stronger blinding, export a packet with reports only (no dates, no conditions). Someone else fills in idea_A and idea_B, plus emotion_A and emotion_B where a target has a feeling, and you import it back. Imported scores replace your own.</p>
      <div class="row wrap">
        <button class="btn ghost" data-act="export-packet">Export blind packet (CSV)</button>
        <label class="btn ghost file">Import scores<input type="file" accept=".csv,text/csv" data-file="import-scores" hidden></label>
      </div>
    </section>
    ${creativityBlock()}
  </section>`;
};

function benefitResults(study) {
  const r = analyzeBenefit(study, S.sessions, S.targets);
  const P = r.outcomes[r.primary];
  const O = OUTCOMES[r.primary];
  const eff = (x, k) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${OUTCOMES[k].fmt(Math.abs(x))}` : '–');
  const share = (c) => (r.dreamShare[c].n ? `${r.dreamShare[c].k}/${r.dreamShare[c].n}` : '–');
  const secondary = Object.keys(OUTCOMES).filter((k) => k !== r.primary);
  return `
  <header class="top"><p class="eyebrow">Phase 2</p><h1>Does engineered dreaming help?</h1><p class="muted">${esc(r.labels.A)} vs ${esc(r.labels.B)}</p></header>
  ${r.ready ? '' : `<section class="banner warn">Provisional: fewer than ${BENEFIT_READY.sleep} cued naps, ${BENEFIT_READY.wake} stay-awake sessions and ${BENEFIT_READY.plain} plain naps with outcomes. Don’t change anything or stop because of these numbers.</section>`}
  <section class="card">
    <dl class="kv">
      <dt>Sessions</dt><dd>${['SA', 'SB', 'WA', 'WB', 'plain'].map((c) => `${tag(c)} ${r.counts[c]}`).join(' · ')}${r.aborted ? ` · ${r.aborted} ended early` : ''}</dd>
      <dt>Primary outcome</dt><dd>${esc(O.label)}: ${esc(O.desc)} <span class="muted">(locked)</span></dd>
    </dl>
  </section>
  <article class="card stack tight">
    <h2>Primary: ${esc(O.label)}</h2>
    <dl class="kv">
      <dt>Beyond normal sleep?</dt><dd><b>${eff(P.beyond.effect, r.primary)}</b> <span class="muted">cued theme after an incubation nap minus a plain nap · p ${pval(P.beyond.p)}, Holm ${pval(P.beyond.pHolm)} · n = ${P.n.sleep} vs ${P.n.plain}</span></dd>
      <dt>Is it the dreaming?</dt><dd><b>${eff(P.dreaming.effect, r.primary)}</b> <span class="muted">(cued − uncued theme) asleep minus awake · p ${pval(P.dreaming.p)}, Holm ${pval(P.dreaming.pHolm)} · n = ${P.n.sleep} vs ${P.n.wake}</span></dd>
      <dt>Cued vs uncued</dt><dd>${eff(P.cuedVsUncued.effect, r.primary)} <span class="muted">after the same nap · sign-flip p ${pval(P.cuedVsUncued.p)}</span></dd>
      <dt>Cost of wake-ups</dt><dd>${eff(P.cost.effect, r.primary)} <span class="muted">uncued theme after an incubation nap minus a plain nap (descriptive)</span></dd>
    </dl>
    <p class="fine">Both questions are one-sided permutation tests on ${esc(O.unit)}, Holm-corrected as a pair. A benefit counts only if the cued theme beats normal sleep <b>and</b> the cued-minus-uncued gap is bigger asleep than awake.</p>
  </article>
  <article class="card stack tight">
    <h2>Secondary outcomes</h2>
    <table class="data"><thead><tr><th>Outcome</th><th>vs plain nap</th><th>asleep − awake</th><th>cued − uncued</th></tr></thead><tbody>
      ${secondary.map((k) => { const x = r.outcomes[k]; return `<tr><td>${esc(OUTCOMES[k].label)}</td><td>${eff(x.beyond.effect, k)} <span class="muted">p ${pval(x.beyond.p)}</span></td><td>${eff(x.dreaming.effect, k)} <span class="muted">p ${pval(x.dreaming.p)}</span></td><td>${eff(x.cuedVsUncued.effect, k)} <span class="muted">p ${pval(x.cuedVsUncued.p)}</span></td></tr>`; }).join('')}
    </tbody></table>
  </article>
  <article class="card stack tight">
    <h2>Did the cue reach the dream?</h2>
    <dl class="kv">
      <dt>Incorporation</dt><dd>cued minus uncued theme, blind 0–3: asleep <b>${num(r.incorporation.sleep)}</b> <span class="muted">(n ${r.incorporation.nSleep})</span> · awake ${num(r.incorporation.wake)} <span class="muted">(n ${r.incorporation.nWake})</span></dd>
      <dt>Drifting or asleep</dt><dd>${tag('SA')} ${share('SA')} · ${tag('SB')} ${share('SB')} · ${tag('WA')} ${share('WA')} · ${tag('WB')} ${share('WB')} · ${tag('plain')} ${share('plain')} <span class="muted">prompts</span></dd>
      <dt>Dream → benefit</dt><dd>ρ ${r.mediation.n < 5 ? '<span class="muted">n &lt; 5</span>' : num(r.mediation.rho)} <span class="muted">between how much more the cued theme showed up in the dream and how much more it improved (exploratory, n ${r.mediation.n})</span></dd>
    </dl>
    <p class="fine">Stay-awake sessions should have almost no “drifting or asleep” prompts. If they have many, you were dozing, and the awake control is weaker.</p>
  </article>`;
}

function analysisBlock(r, title) {
  const cell = (c) => `${c.k}/${c.n} <span class="muted">${pct(c.p)}</span>`;
  return `
  <article class="card stack tight">
    <h2>${title}</h2>
    <dl class="kv">
      <dt>Effect</dt><dd><b>${num(r.primary.effect)}</b> <span class="muted">mean(A−B score) after A cues minus after B cues · range −6 to +6</span></dd>
      <dt>p (one-sided)</dt><dd>${pval(r.primary.p)} <span class="muted">${r.primary.method} permutation · n = ${r.primary.nA} A, ${r.primary.nB} B</span></dd>
      <dt>Cued beat uncued</dt><dd>${r.specificity.decisive
        ? `${r.specificity.hits}/${r.specificity.decisive} <span class="muted">(${r.specificity.ties} ties) · ${pct(r.specificity.rate)} · 95% CI ${pct(r.specificity.lo)}–${pct(r.specificity.hi)} · sign test p ${pval(r.specificity.p)}</span>`
        : `<span class="muted">no decisive naps yet${r.specificity.ties ? ` (${r.specificity.ties} ties)` : ''}</span>`}</dd>
    </dl>
    <table class="data">
      <thead><tr><th>Clearly present (≥2)</th><th>after A</th><th>after B</th><th>control</th></tr></thead>
      <tbody>
        <tr><td>${tag('A')} ${esc(r.labels.A)}</td><td>${cell(r.table.A.A)}</td><td>${cell(r.table.A.B)}</td><td>${cell(r.table.A.control)}</td></tr>
        <tr><td>${tag('B')} ${esc(r.labels.B)}</td><td>${cell(r.table.B.A)}</td><td>${cell(r.table.B.B)}</td><td>${cell(r.table.B.control)}</td></tr>
      </tbody>
    </table>
  </article>`;
}

function dataBlock() {
  return `
  <section class="card stack tight">
    <h2>Your data</h2>
    <p class="small">For fitting models. The <b>trial table</b> has one row per wake-up: what played and when, your state, the report, ratings, memory scores, check-ins and imported metrics. The <b>session table</b> has one row per nap.</p>
    <div class="row wrap">
      <button class="btn ghost" data-act="export-trials">Trial table (CSV)</button>
      <button class="btn ghost" data-act="export-sessions">Session table (CSV)</button>
      <label class="btn ghost file">Import daily metrics<input type="file" accept=".csv,text/csv" data-file="import-metrics" hidden></label>
    </div>
    <p class="fine">Metrics CSV columns: <code>date,metric,value</code>, e.g. <code>2026-11-26,anki_retention,0.91</code>. Each metric becomes a column joined by date. ${S.metrics.length ? `${S.metrics.length} values imported.` : ''}</p>
  </section>`;
}

function learningBlock() {
  const rows = sessionRows(S).filter((r) => r.analyzable === 1);
  const memRows = rows.filter((r) => r.mem_delayed !== null);
  const avg = (k, rs = rows) => mean(rs.map((r) => r[k]).filter((v) => v !== null && v !== undefined));
  const assoc = associations(sessionRows(S));
  const checks = S.checkins;
  return `
  <section class="card stack tight">
    <h2>Learning and experience</h2>
    <dl class="kv">
      <dt>Phase 1 word pairs</dt><dd>${memRows.length ? `${pct(avg('mem_immediate', memRows))} before → ${pct(avg('mem_delayed', memRows))} after the nap <span class="muted">(change ${num(avg('mem_change', memRows) * 100, 0)} pts, ${memRows.length} naps)</span>` : '<span class="muted">no completed memory tests yet</span>'}</dd>
      <dt>Dreams</dt><dd>${rows.length ? `vividness ${num(avg('vividness'), 1)}/4 · immersion ${num(avg('immersion'), 1)}/4 · intensity ${num(avg('intensity'), 1)}/4 · bizarreness ${num(avg('bizarreness'), 1)}/4 · lucidity ${num(avg('lucidity'), 1)}/3` : '<span class="muted">no rated naps yet</span>'}</dd>
      <dt>Check-ins</dt><dd>${checks.length ? `${checks.length} days · sleep ${num(mean(checks.map((c) => c.sleepHours).filter((v) => v !== null)), 1)} h · mood ${num(mean(checks.map((c) => c.mood).filter((v) => v !== null)), 1)} · unreality ${num(mean(checks.map((c) => c.unreal).filter((v) => v !== null)), 1)}/4` : '<span class="muted">none yet</span>'}</dd>
    </dl>
    <table class="data"><thead><tr><th>Exploratory link</th><th>n</th><th>ρ</th></tr></thead><tbody>
      ${assoc.map((a) => `<tr><td>${esc(a.label)}</td><td>${a.n}</td><td>${a.n < 5 ? '<span class="muted">n &lt; 5</span>' : Number.isFinite(a.rho) ? num(a.rho) : '<span class="muted">no variation</span>'}</td></tr>`).join('')}
    </tbody></table>
    <p class="fine">Spearman rank correlations across naps. These are for spotting patterns to test later, not conclusions. With a few dozen naps most will be noise.</p>
  </section>
  ${dataBlock()}`;
}

VIEWS.results = () => {
  const p1 = steerStudy(), p2 = benefitStudy();
  if (!p1 && !p2) return `<header class="top"><h1>Results</h1></header><p class="muted">No study yet.</p>${learningBlock()}`;
  const arms = armStats(S.sessions);
  const onset = onsetEstimate(S.sessions);
  const ids = new Set([p1?.id, p2?.id].filter(Boolean));
  const log = S.sessions.filter((s) => ids.has(s.studyId) && !s.rehearsal).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const blind = p1 ? analyzeStudy(p1, S.sessions, S.targets, { source: 'blind' }) : null;
  return `
  ${p2 ? benefitResults(p2) : ''}
  ${p1 ? steerResults(p1, blind) : ''}
  <section class="card stack tight">
    <h2>Learning engine</h2>
    <table class="data"><thead><tr><th>Timing profile</th><th>drifting</th><th>posterior</th></tr></thead><tbody>
      ${ARMS.map((a) => `<tr><td>${esc(a.label)}</td><td>${arms[a.id].successes}/${arms[a.id].n}</td><td>${pct(arms[a.id].mean)}</td></tr>`).join('')}
    </tbody></table>
    <p class="small">First-cue estimate: <b>${num(onset.estimate, 0)} min</b>${onset.history.length ? ` · last moves: ${onset.history.slice(-5).map((h) => `${h.state} → ${h.after}`).join(', ')}` : ''}</p>
  </section>
  ${cueVolumeCard()}
  ${learningBlock()}
  ${blind ? `<section class="card">
    <h2>Wellbeing</h2>
    <dl class="kv">
      <dt>Disruption</dt><dd>${num(blind.safety.meanDisruption, 1)}/4 average over ${blind.safety.n} Phase 1 naps</dd>
      <dt>Distressing</dt><dd>${blind.safety.distressing}</dd>
      <dt>Lucid moments</dt><dd>${blind.safety.lucid}</dd>
    </dl>
  </section>` : ''}
  <details class="card"><summary>Session log (shows conditions)</summary>
    <table class="data"><thead><tr><th>When</th><th>Cond.</th><th>Status</th><th>Scored</th></tr></thead><tbody>
    ${log.map((s) => `<tr><td>${esc(when(s.startedAt))}${s.params?.speed !== 1 ? ` ×${s.params?.speed}` : ''}</td><td>${tag(s.condition)}</td><td>${esc(s.status)}</td><td>${s.blind ? `${s.blind.A}/${s.blind.B}` : '–'}</td></tr>`).join('')}
    </tbody></table>
  </details>`;
};

// Item 2: per-cue arousal and the volume staircase.
function cueVolumeCard() {
  const rows = volumeTable(S.sessions);
  const v = sessionCueVolume();
  return `
  <section class="card stack tight" id="cue-volume">
    <h2>Cue volume</h2>
    ${rows.length ? `<table class="data"><thead><tr><th>Volume</th><th>Cues</th><th>Woke you</th><th>Unknown</th><th>Wake rate</th><th>Motion</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${pct(r.volume)}</td><td>${r.cues}</td><td>${r.woke}</td><td>${r.unknown}</td><td>${pct(r.wakeRate)}</td><td>${r.motion}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted small">No in-sleep cues from real-speed naps yet.</p>'}
    <p class="small">Next nap: <b id="next-volume">${pct(v.volume)}</b> <span class="muted">${v.adaptive ? `adaptive, max ${pct(S.settings.cueVolumeMax)}, from ${v.history.length} cue${v.history.length === 1 ? '' : 's'}` : S.settings.adaptiveVolume ? 'fixed (this study uses the v0.3 script)' : 'fixed (adaptive volume is off)'}</span></p>
    <p class="fine">A cue counts as having woken you if you tapped the screen within a minute of it, or answered yes in the report. It counts as not waking you only if you answered no. With no tap and an answer of “not sure” or none, the cue is unknown: it is listed here but ignored by the staircase and by the wake rate. Motion is shown but not counted: a phone on the mattress can’t yet tell turning over from waking up. The staircase uses only adaptive-volume naps (not v0.3-script ones) and steps down 8 points after a cue that woke you and up 2 points after one that didn’t, so it settles where about 1 cue in 5 wakes you.</p>
  </section>`;
}

// Item 3: emotion scores and the exploratory idea/feeling link (Phase 1, blind source).
function emotionBlocks(r) {
  const e = r.emotion, L = r.link;
  return `
  <article class="card stack tight" id="emotion-block">
    <h2>Secondary: blind emotion scores</h2>
    <dl class="kv">
      <dt>Effect</dt><dd><b>${num(e.primary.effect)}</b> <span class="muted">mean(A−B feeling score) after A cues minus after B cues · range −6 to +6</span></dd>
      <dt>p (one-sided)</dt><dd>${pval(e.primary.p)} <span class="muted">${esc(e.primary.method)} permutation · n = ${e.primary.nA} A, ${e.primary.nB} B</span></dd>
      <dt>Cued feeling stronger</dt><dd>${e.specificity.decisive
        ? `${e.specificity.hits}/${e.specificity.decisive} <span class="muted">(${e.specificity.ties} ties) · ${pct(e.specificity.rate)} · 95% CI ${pct(e.specificity.lo)}–${pct(e.specificity.hi)} · sign test p ${pval(e.specificity.p)}</span>`
        : `<span class="muted">no decisive naps yet${e.specificity.ties ? ` (${e.specificity.ties} ties)` : ''}</span>`}</dd>
    </dl>
    <p class="fine">Scored separately from the idea: how strongly each report carries each target’s feeling, whatever the content. ${e.n} cued nap${e.n === 1 ? '' : 's'} have both feeling scores.</p>
  </article>
  <article class="card stack tight" id="link-block">
    <h2>Exploratory: does the idea come in with the feeling?</h2>
    <table class="data"><thead><tr><th>Cued target</th><th>feeling landed</th><th>feeling didn’t</th></tr></thead><tbody>
      <tr><td>idea landed</td><td>${L.bothLanded}</td><td>${L.ideaOnly}</td></tr>
      <tr><td>idea didn’t</td><td>${L.emotionOnly}</td><td>${L.neither}</td></tr>
    </tbody></table>
    <p class="small">Mean idea score when the feeling landed <b>${num(L.meanIdeaWhenEmotion)}</b> · when it didn’t <b>${num(L.meanIdeaWhenNoEmotion)}</b> <span class="muted">(${L.n} cued nap${L.n === 1 ? '' : 's'} with both scores)</span></p>
    <p class="fine">“Landed” means a blind score of 2 or more for the cued target. Descriptive only, not a test.</p>
  </article>`;
}

function steerResults(study, blind) {
  const lex = analyzeStudy(study, S.sessions, S.targets, { source: 'lexical' });
  const share = (c) => (blind.dreamShare[c].n ? pct(blind.dreamShare[c].k / blind.dreamShare[c].n) : '–');
  return `
  <header class="top"><p class="eyebrow">Phase 1</p><h1>Does the cue steer my dreams?</h1><p class="muted">${esc(blind.labels.A)} vs ${esc(blind.labels.B)}</p></header>
  ${blind.ready ? '' : `<section class="banner warn">Provisional: fewer than ${READY_PER_ARM} scored naps in each of A and B. Don’t change targets, timing or stop the study because of these numbers.</section>`}
  <section class="card">
    <dl class="kv">
      <dt>Naps</dt><dd>${tag('A')} ${blind.counts.A} · ${tag('B')} ${blind.counts.B} · ${tag('control')} ${blind.counts.control}${blind.aborted ? ` · ${blind.aborted} ended early` : ''}</dd>
      <dt>Scored</dt><dd>${blind.scored} blind${blind.unscored ? ` · ${blind.unscored} waiting` : ''}</dd>
      <dt>Dreaming</dt><dd>wake-ups drifting or asleep: ${tag('A')} ${share('A')} · ${tag('B')} ${share('B')} · ${tag('control')} ${share('control')}</dd>
      <dt>No dream report</dt><dd>${tag('A')} ${blind.noDream.A} · ${tag('B')} ${blind.noDream.B} · ${tag('control')} ${blind.noDream.control} <span class="muted">naps (every wake-up “still awake”)</span></dd>
    </dl>
    <p class="fine">Only dream reports are scored. If one condition keeps you awake more often, that shows up here.</p>
  </section>
  ${analysisBlock(blind, 'Primary: blind scores')}
  ${studyProtocol(study).emotionScores ? emotionBlocks(blind) : ''}
  ${analysisBlock(lex, 'Cross-check: lexical scorer')}
  <p class="fine">The lexical scorer counts target words in the dream reports. It can’t be biased by remembering the cue, but it misses paraphrase. If it agrees with your blind scores, that’s reassuring.</p>`;
}

VIEWS.settings = () => {
  const st = S.settings;
  const vs = audio.voices();
  const rec = ui.recording;
  const study = activeStudy();
  const proto = currentProtocol();
  const rows = voiceRows();
  const done = rows.filter((r) => r.voiceId).length;
  const isRec = (r) => rec && rec.kind === r.rec.kind && String(rec.id ?? '') === String(r.rec.id ?? '');
  const vol = sessionCueVolume(proto);
  return `
  <header class="top"><h1>Settings</h1></header>
  <section class="card stack">
    <h2>Voice</h2>
    ${seg('set-voiceMode', [{ v: 'tts', l: 'Device voice' }, { v: 'own', l: 'My own recordings' }], st.voiceMode)}
    <p class="fine">Dormio and Horowitz et al. used the sleeper’s own voice. In own-voice mode every line you’ve recorded plays from your recording; any line you haven’t recorded plays in the device voice, line by line.</p>
    <label class="field"><span>Device voice</span><select data-set="ttsVoiceURI"><option value="">Default</option>${vs.map((v) => `<option value="${esc(v.voiceURI)}" ${st.ttsVoiceURI === v.voiceURI ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})${v.localService ? '' : ' · network'}</option>`).join('')}</select></label>
    ${vs.some((v) => !v.localService) ? '<p class="fine">Voices marked “network” are synthesised by the browser vendor’s servers. Pick an on-device voice to keep cue text local.</p>' : ''}
    <label class="field"><span>Speaking rate <em>${num(st.ttsRate, 2)}</em></span><input type="range" min="0.6" max="1.1" step="0.05" data-set="ttsRate" value="${st.ttsRate}"></label>
    <div class="stack tight" id="voice-checklist">
      <div class="row between"><h3>Own-voice checklist</h3><span class="muted small" id="voice-count">${done}/${rows.length} recorded</span></div>
      <p class="fine">${study ? 'Every line your current study plays' : 'Every line a new study will play'} (${esc(SCRIPT_NAME[proto.script])} script). Say each one slowly and softly.</p>
      <ul class="vlist">
        ${rows.map((r) => `
        <li class="vrow" data-line="${esc(r.id)}">
          <span class="vmark ${r.voiceId ? 'ok' : 'no'}" title="${r.voiceId ? 'recorded' : 'not recorded'}">${r.voiceId ? '✓' : '✗'}</span>
          <div class="vtext"><span class="label">${esc(r.label)}</span><span class="small">“${esc(r.text)}”</span></div>
          <div class="row wrap vbtns">
            <button class="btn ghost ${isRec(r) ? 'recording' : ''}" data-act="record-voice" data-kind="${r.rec.kind}" data-id="${esc(r.rec.id)}">${isRec(r) ? '● Stop' : r.voiceId ? 'Re-record' : 'Record'}</button>
            ${r.voiceId ? `<button class="btn ghost" data-act="play-voice" data-blob="${r.voiceId}">Play</button>` : ''}
          </div>
        </li>`).join('')}
      </ul>
    </div>
  </section>
  <section class="card stack">
    <h2>Volume</h2>
    <label class="field"><span>${st.adaptiveVolume ? 'Starting cue volume' : 'Cue volume'} <em>${pct(st.cueVolume)}</em></span><input type="range" min="0.05" max="1" step="0.05" data-set="cueVolume" value="${st.cueVolume}"></label>
    <label class="field"><span>Wake prompt volume <em>${pct(st.wakeVolume)}</em></span><input type="range" min="0.05" max="1" step="0.05" data-set="wakeVolume" value="${st.wakeVolume}"></label>
    <label class="check"><input type="checkbox" data-set="adaptiveVolume" ${st.adaptiveVolume ? 'checked' : ''}><span>Adaptive cue volume: a little softer after a cue that woke you, a little louder after one that didn’t. It aims for about 1 cue in 5 waking you.</span></label>
    <label class="field"><span>Maximum cue volume <em>${pct(st.cueVolumeMax)}</em></span><input type="range" min="0.1" max="1" step="0.05" data-set="cueVolumeMax" value="${st.cueVolumeMax}"></label>
    <p class="small">Next nap: <b id="next-volume">${pct(vol.volume)}</b> <span class="muted">${vol.adaptive ? 'adaptive' : 'fixed'}</span></p>
    <p class="fine">Adaptive volume applies to Horowitz-script studies. Studies on the v0.3 script keep the fixed cue volume.</p>
    <div class="row wrap"><button class="btn ghost" data-act="test-cue">Test cue</button><button class="btn ghost" data-act="test-wake">Test wake</button></div>
  </section>
  <section class="card stack" id="script-settings">
    <h2>Script for new studies</h2>
    ${seg('set-scriptVersion', [{ v: 'h2023', l: 'Horowitz 2023' }, { v: 'v1', l: 'v0.3 (Dormio wording)' }], st.scriptVersion)}
    <label class="check"><input type="checkbox" data-set="bindingStep" ${st.bindingStep ? 'checked' : ''}><span>Pre-sleep binding step: ${BIND_SEC / 60} minutes picturing the target and its feeling before each session (Horowitz script only)</span></label>
    <p class="fine"><b>Only affects studies you create from now on.</b> A study keeps the protocol it was created with${study ? `; your current study uses: ${esc(protocolLabel(studyProtocol(study)))}` : ''}. The Horowitz 2023 script says “Think of …” after you settle, “Remember to think of …” as the cue, and asks “were you asleep?” after each report.</p>
  </section>
  <section class="card stack">
    <h2>Protocol</h2>
    <label class="field"><span>Wake-ups per nap</span><select data-set="rounds">${[1, 2, 3, 4, 5].map((n) => `<option ${st.rounds === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>Report window</span><select data-set="recordSec">${[30, 60, 90].map((n) => `<option value="${n}" ${st.recordSec === n ? 'selected' : ''}>${n} seconds</option>`).join('')}</select></label>
    <label class="field"><span>Settle time</span><select data-set="lieDownSec">${[30, 60, 90, 120].map((n) => `<option value="${n}" ${st.lieDownSec === n ? 'selected' : ''}>${n} seconds</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" data-set="memoryTask" ${st.memoryTask ? 'checked' : ''}><span>Phase 1: untargeted word-pair test before and after each nap</span></label>
    <p class="fine">Off by default. These pairs aren’t linked to the dream cue, so they can’t show a dream effect. Phase 2 uses theme-bound pairs instead.</p>
    <label class="field"><span>Phase 1 word pairs per nap</span><select data-set="memoryPairs">${[8, 12, 16, 20, 24].map((n) => `<option value="${n}" ${st.memoryPairs === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>Phase 2 word pairs per theme</span><select data-set="pairsPerTheme">${[6, 8, 10, 12].map((n) => `<option value="${n}" ${st.pairsPerTheme === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <div class="row">
      <label class="field grow"><span>Naps from</span><input type="time" data-set="window.start" value="${esc(st.window.start)}"></label>
      <label class="field grow"><span>until</span><input type="time" data-set="window.end" value="${esc(st.window.end)}"></label>
    </div>
    <p class="fine">Always clamped to ${SAFETY.hardWindow.start}–${SAFETY.hardWindow.end}. At most ${SAFETY.maxSessionsPerDay} naps a day, ${SAFETY.minGapHours} h apart. Changing the protocol mid-study adds noise. Keep it fixed once you start.</p>
  </section>
  <section class="card stack">
    <h2>Experimental</h2>
    <p class="small">These are my additions to the published Dormio protocol. They are untested, and turning them on means your naps no longer follow the validated method.</p>
    <label class="check"><input type="checkbox" data-set="cueMotif" ${st.cueMotif ? 'checked' : ''}><span>Play a 3-note sound motif before each cue (meant to pair a sound with each target for future REM cueing)</span></label>
    <label class="check"><input type="checkbox" data-set="preSleepCue" ${st.preSleepCue ? 'checked' : ''}><span>Play the cue once right after settling (v0.3 script only; the Horowitz script has its own start line)</span></label>
    <label class="check"><input type="checkbox" data-set="adaptiveTiming" ${st.adaptiveTiming ? 'checked' : ''}><span>Adaptive timing: the learning engine varies timing among Dormio’s own options (1/2/3 min, 3/5/7 min) and learns your sleep onset. Off = fixed 2/5 min and a 7.5–12.5 min first cue.</span></label>
  </section>
  <section class="card stack">
    <h2>Your data</h2>
    <p class="small">Everything is stored in this browser only. Export regularly. Clearing site data or uninstalling the browser deletes it.</p>
    <div class="row wrap">
      <button class="btn ghost" data-act="export-data">Export data (JSON)</button>
      <button class="btn ghost" data-act="export-full">Full backup with audio</button>
      <label class="btn ghost file">Import backup<input type="file" accept=".json,application/json" data-file="import-data" hidden></label>
    </div>
    <button class="btn ghost danger" data-act="delete-all">Delete everything</button>
  </section>
  <section class="card stack tight">
    <h2>Charter</h2>
    <p class="small">Consent given ${esc(when(S.consent?.at))}.</p>
    <div class="row wrap"><button class="btn ghost" data-act="nav" data-view="charter">Read charter</button><button class="btn ghost danger" data-act="revoke-consent">Withdraw consent</button></div>
  </section>
  <p class="fine center">Dream Engine ${APP_VERSION} · local-only · no network</p>`;
};

VIEWS.rehearsalDone = () => {
  const r = ui.rehearsal || { clips: [] };
  return `
  <header class="top"><h1>Rehearsal finished</h1></header>
  <section class="stack">
    <p class="lede">${r.status === 'aborted' ? 'You ended the rehearsal early.' : 'That’s the whole flow: settle, cue, drift, wake prompt, report, cue, drift back.'}</p>
    ${r.clips.length ? r.clips.map((c) => `<div class="stack tight"><span class="label">${c.phase === 'state' ? `Answer to “were you asleep?”, round ${c.round}` : `Report window ${c.round}`}</span><audio controls src="${c.url}"></audio></div>`).join('') : '<p class="warn-text">No audio was captured. Check the microphone permission for this site.</p>'}
    <p class="fine">Check you can hear yourself clearly. These clips are not saved.</p>
    <button class="btn primary" data-act="nav" data-view="home">Done</button>
  </section>`;
};

// ---------- rendering ----------
function renderNav() {
  const hide = ['session', 'learn', 'memtest', 'aut', 'binding'].includes(ui.view) || !consentValid(S.consent);
  $nav.hidden = hide;
  if (hide) return;
  const tabs = [['home', 'Home'], ['targets', 'Targets'], ['score', 'Score'], ['results', 'Results'], ['settings', 'Settings']];
  const map = { targetEdit: 'targets', study: 'home', preflight: 'home', report: 'home', rehearsalDone: 'home', charter: 'settings', checkin: 'home', memReady: 'home', benefitSetup: 'home' };
  const cur = map[ui.view] || ui.view;
  $nav.innerHTML = tabs.map(([v, l]) => `<button class="tab ${cur === v ? 'active' : ''}" data-act="nav" data-view="${v}" ${cur === v ? 'aria-current="page"' : ''}>${l}</button>`).join('');
}

async function hydrateAudio() {
  for (const el of $app.querySelectorAll('audio[data-blob]')) {
    const blob = await db.getBlob(el.dataset.blob);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    objectURLs.push(url);
    el.src = url;
  }
}

function render() {
  if (!consentValid(S.consent) && ui.view !== 'charter') ui.view = 'charter';
  objectURLs.forEach((u) => URL.revokeObjectURL(u));
  objectURLs = [];
  document.body.dataset.view = ui.view;
  const banner = SPEED > 1 && ui.view !== 'session' ? `<div class="banner warn">Speed ×${SPEED}. Sessions run fast and are excluded from analysis.</div>` : '';
  $app.innerHTML = banner + (VIEWS[ui.view] || VIEWS.home)();
  renderNav();
  hydrateAudio();
  if (ui.view === 'learn') startLearn();
  if (ui.view === 'aut') startAutTimer();
}

// ---------- sessions ----------
async function runSession({ rehearsal }) {
  // Must run before the first await so it stays inside the Start tap (iOS).
  // v1 sessions behave as v0.3: no motion permission, no tap/motion logging.
  const arousalLogging = currentProtocol().script === 'h2023';
  const motionPermission = arousalLogging ? requestMotionPermission() : Promise.resolve('not-needed');
  const study = activeStudy();
  const st = S.settings;
  audio.audioContext(); // unlock audio inside the user gesture
  const micOk = await audio.micAvailable();
  if (!micOk && !confirm('The microphone is unavailable, so reports won’t be recorded. Continue and type your reports afterwards?')) return;

  let condition = 'control', index = -1, t = null, arm, onsetMin, win, p;
  const speed = rehearsal ? REHEARSAL_SPEED * SPEED : SPEED;
  const rng = mulberry32(newSeed());
  const benefit = !rehearsal && studyKind(study) === 'benefit';
  // The study's locked protocol; a rehearsal previews the current one.
  const protocol = rehearsal ? currentProtocol() : studyProtocol(study);
  const h2023 = protocol.script === 'h2023';
  if (rehearsal) {
    arm = ARMS[1];
    win = { minMin: 10, maxMin: 10 };
    onsetMin = 10;
    p = { rounds: 2, hypnaMin: arm.hypnaMin, betweenMin: arm.betweenMin, onsetMin, recordSec: 60, lieDownSec: 60, preSleepCue: st.preSleepCue };
  } else {
    const check = canStartSession({ state: S, study, speed: SPEED });
    if (!check.ok) { toast(check.reasons[0], 'danger'); return; }
    if (benefit && !ui.pendingMemory?.themed) { toast('Learn both word-pair sets first.', 'danger'); go('preflight'); return; }
    if (SPEED === 1) {
      const al = nextAllocation(study, S.sessions);
      condition = al.condition; index = al.index;
    } else {
      const options = conditionsOf(study);
      condition = options.includes(FORCE_COND) ? FORCE_COND : options[Math.floor(rng() * options.length)];
    }
    t = target(cuedTargetId(study, condition));
    arm = st.adaptiveTiming ? chooseArm(armStats(S.sessions), rng) : ARMS[1];
    win = onsetWindow(st.adaptiveTiming ? onsetEstimate(S.sessions).estimate : ONSET.defaultMin);
    onsetMin = drawOnsetMin(win, rng);
    p = { rounds: st.rounds, hypnaMin: arm.hypnaMin, betweenMin: arm.betweenMin, onsetMin, recordSec: st.recordSec, lieDownSec: st.lieDownSec, preSleepCue: st.preSleepCue };
  }
  const info = conditionInfo(condition);
  // h2023: start line instead of the pre-sleep cue, "were you asleep?" after each report (sleep only), "fall back asleep".
  if (h2023) Object.assign(p, { script: 'h2023', state: info.state, preSleepCue: false });
  // A plain nap lasts as long as the incubation nap these parameters would give, without cues or mid-nap wake-ups.
  const steps = info.plain ? buildPlainPlan(p) : buildPlan(p);
  const vol = sessionCueVolume(protocol);
  const session = {
    id: newId('s'), studyId: rehearsal ? null : study.id, index, condition, targetId: t?.id || null, rehearsal: !!rehearsal,
    params: {
      ...p, armId: arm.id, onsetWindow: win, speed, adaptive: !!st.adaptiveTiming,
      ...(info.plain ? { rounds: 1, preSleepCue: false, plainSleepSec: steps.find((x) => x.phase === 'sleep').sec } : {}),
      protocol: { ...protocol },
      // Snapshot of exactly how cues sounded, so later settings changes can't rewrite history.
      audio: { voiceMode: st.voiceMode, ttsVoiceURI: st.ttsVoiceURI, ttsRate: st.ttsRate, cueVolume: vol.volume, wakeVolume: st.wakeVolume, motif: !!st.cueMotif, adaptiveVolume: vol.adaptive, ...(vol.adaptive ? { cueVolumeMax: st.cueVolumeMax, cueVolumeStart: st.cueVolume } : {}) },
    },
    status: 'running', startedAt: new Date().toISOString(), endedAt: null, events: [], rounds: [], morning: null, blind: null,
    memory: rehearsal || benefit ? null : ui.pendingMemory,
    themed: benefit ? ui.pendingMemory : null,
  };
  if (!rehearsal) ui.pendingMemory = null;
  if (!rehearsal) { S.sessions.push(session); await save(); } // allocation is consumed from here on

  // Each line plays from its own recording if there is one, else the device voice.
  const lines = await loadLines(sessionLines({ protocol, condition, target: t, settings: st, own: st.voiceMode === 'own' }));

  if (needsBinding(protocol, condition)) {
    if (!rehearsal) { session.stage = 'binding'; await save(); }
    const b = await runBinding({ target: t, lines, speed, cueVolume: vol.volume, rehearsal });
    if (b.aborted) {
      if (rehearsal) { go('home'); return; }
      const now = new Date().toISOString();
      Object.assign(session, { status: 'aborted', abortedAt: 'binding', endedAt: now, events: [{ t: now, type: 'abort', phase: 'binding' }] });
      delete session.stage;
      await save();
      toast('Session ended before the nap. Its allocation stays used.');
      go('home');
      return;
    }
    if (!rehearsal) { session.binding = b.binding; delete session.stage; await save(); }
  }

  const clips = [];
  ui.night = {
    state: info.state,
    visualization: info.state === 'wake' ? WAKE_TEXT : info.plain ? PLAIN_TEXT : t ? t.visualization || t.cuePhrase : h2023 ? SCRIPT_H2023.controlStart : 'Let your mind wander wherever it goes.',
    rounds: info.plain ? 1 : p.rounds,
    // Only naps with in-sleep cues ask you to tap when a cue wakes you.
    tapHint: h2023 && info.state === 'sleep' && !info.plain,
  };
  go('session', { endArmed: false });

  const runner = new SessionRunner({
    steps, speed, lines,
    motif: st.cueMotif ? (t ? t.motif : NEUTRAL.motif) : null,
    cueVolume: vol.volume,
    settings: st,
    motionPermission,
    arousalLogging: h2023,
    onPhase: updateNight,
    onRecording: async ({ round, phase, blob, wokeAt }) => {
      if (rehearsal) { if (blob) clips.push({ url: URL.createObjectURL(blob), round, phase }); return; }
      let audioId = null;
      if (blob) { audioId = newId('a'); await db.putBlob(audioId, blob); }
      if (phase === 'state') {
        // The spoken answer to "were you asleep?" belongs to the round it follows.
        const r = session.rounds.find((x) => x.round === round);
        if (r) r.stateAudioId = audioId;
      } else {
        session.rounds.push({ round, audioId, wokeAt, transcript: '', state: '' });
      }
      await save();
    },
  });
  ui.runner = runner;
  // Saved with every report, so a session closed mid-way keeps what happened so far.
  if (!rehearsal) session.events = runner.events;
  const res = await runner.run();
  ui.runner = null;
  if (rehearsal) {
    ui.rehearsal = { status: res.status, clips };
    go('rehearsalDone');
    return;
  }
  session.events = res.events;
  session.status = res.status;
  session.endedAt = new Date().toISOString();
  await save();
  go('report', { reportId: session.id });
}

// ---------- binding step (item 4) ----------
// Shows the binding screen, plays the start line at 0 s and the cue at 40 s and
// 80 s (÷ speed), then asks the ratings. Resolves { binding } or { aborted: true }.
function runBinding({ target: t, lines, speed, cueVolume, rehearsal }) {
  return new Promise((resolve) => {
    const scr = bindingScreen(t);
    const t0 = Date.now();
    const B = { ...scr, speed, rehearsal: !!rehearsal, t0, endsAt: t0 + (BIND_SEC * 1000) / speed, stage: 'listen', plays: [], values: {}, ctrl: new AbortController(), endArmed: false, listenedSec: null, wakeLock: null };
    // Your eyes are closed for 2 minutes: keep the screen (and so the timed lines) from sleeping.
    const lock = () => navigator.wakeLock?.request('screen').then((l) => {
      // Binding may have ended before the request resolved: don't hold the lock.
      if (B.done) { try { l.release().catch(() => {}); } catch {} return; }
      B.wakeLock = l;
    }, () => {});
    const onVisible = () => { if (document.visibilityState === 'visible' && !B.done) lock(); };
    lock();
    document.addEventListener('visibilitychange', onVisible);
    B.finish = (result) => {
      if (B.done) return;
      B.done = true;
      B.ctrl.abort();
      try { speechSynthesis.cancel(); } catch {}
      document.removeEventListener('visibilitychange', onVisible);
      B.wakeLock?.release().catch(() => {});
      ui.binding = null;
      resolve(result);
    };
    ui.binding = B;
    go('binding');
    bindingTimeline(B, lines, cueVolume);
  });
}

async function bindingTimeline(B, lines, volume) {
  const st = S.settings;
  const signal = B.ctrl.signal;
  const clock = setInterval(() => {
    const el = document.getElementById('b-clock');
    if (el) el.textContent = mmss(B.endsAt - Date.now());
  }, 250);
  try {
    for (const pl of BIND_PLAYS) {
      await audio.waitMs(Math.max(0, B.t0 + (pl.at * 1000) / B.speed - Date.now()), signal);
      if (signal.aborted) return;
      const line = lines[pl.line];
      const at = new Date().toISOString();
      const r = await audio.sayLine(line, { volume, voiceURI: st.ttsVoiceURI, rate: st.ttsRate });
      if (signal.aborted) return;
      B.plays.push({ line: pl.line, at, text: line?.text ?? '', voice: r.voice || 'tts', volume, played: r.played });
    }
    await audio.waitMs(Math.max(0, B.endsAt - Date.now()), signal);
    if (signal.aborted) return;
    B.listenedSec = Math.round((Date.now() - B.t0) / 100) / 10;
    B.stage = 'rate';
    if (ui.binding === B && ui.view === 'binding') render();
  } finally {
    clearInterval(clock);
  }
}

function setBindValue(el) {
  const B = ui.binding;
  if (!B || !el?.dataset?.bind) return;
  B.values[el.dataset.bind] = Number(el.value);
  const em = document.getElementById(`bv-${el.dataset.bind}`);
  if (em) em.textContent = el.value;
}

// ---------- memory task ----------
let learnRun = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The cue exactly as the session would play it, used to bind each Phase 2 set to its theme.
async function playSessionCue(t) {
  const st = S.settings;
  const volume = sessionCueVolume().volume;
  if (st.cueMotif) await audio.playMotif(t.motif, volume);
  const blob = st.voiceMode === 'own' && t.voiceId ? await db.getBlob(t.voiceId) : null;
  if (blob) return audio.playBlob(blob, volume);
  return audio.speak(t.cuePhrase, { voiceURI: st.ttsVoiceURI, rate: st.ttsRate, volume });
}

async function startLearn() {
  const run = ++learnRun;
  const L = ui.learn;
  const alive = () => run === learnRun && ui.view === 'learn';
  const $ = (id) => document.getElementById(id);
  const step = Math.max(150, PAIR_MS / SPEED);
  const study = activeStudy();
  const segments = L.themed ? L.order.map((th) => ({ th, pairs: L.sets[th] })) : [{ th: null, pairs: L.pairs }];
  L.conditioning = {};
  for (const seg of segments) {
    if (seg.th) {
      const t = target(study.targetIds[seg.th]);
      $('learn').dataset.theme = seg.th.toLowerCase();
      $('learn-head').innerHTML = `${tag(seg.th)} ${esc(t.label)}`;
      $('pair-cue').textContent = '';
      $('pair-answer').textContent = '';
      $('pair-count').textContent = 'Listen to this theme’s cue';
      $('learn-note').textContent = 'These pairs belong to this theme. Picture each pair inside it.';
      const at = new Date().toISOString();
      const played = await playSessionCue(t);
      L.conditioning[seg.th] = { at, played };
      await pause(Math.max(200, 1500 / SPEED));
      if (!alive()) return;
    }
    for (let i = 0; i < seg.pairs.length; i++) {
      if (!alive()) return;
      $('pair-cue').textContent = seg.pairs[i].cue;
      $('pair-answer').textContent = seg.pairs[i].answer;
      $('pair-count').textContent = `${i + 1} / ${seg.pairs.length}`;
      await pause(step);
    }
  }
  if (!alive()) return;
  if (L.themed) beginThemedTest('immediate', { seed: L.seed, sets: L.sets, order: L.order, conditioning: L.conditioning });
  else beginTest('immediate', { seed: L.seed, pairs: L.pairs });
}

function beginThemedTest(phase, mem, sessionId = null) {
  const seed = (mem.seed + (phase === 'immediate' ? 11 : 12)) >>> 0;
  ui.test = { phase, themed: true, mem, sessionId, items: makeThemedTest(mem.sets, seed), i: 0, responses: [], shownAt: Date.now() };
  go('memtest');
}

// After the report: retest both sets, then one creative-uses task per theme.
async function continuePost(s) {
  const next = nextPostTask(s);
  if (!next) {
    const r = themedRetention(s.themed);
    const study = studyById(s.studyId);
    const f = (x) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`;
    toast(r ? `Done. Word-pair change: ${themeLabel('A', study)} ${f(r.A)} pts, ${themeLabel('B', study)} ${f(r.B)} pts.` : 'Session complete.');
    go('home');
    return;
  }
  if (next.kind === 'delayed') {
    toast('Report saved. Now retest both word-pair sets.');
    beginThemedTest('delayed', s.themed, s.id);
    return;
  }
  const order = s.themed.autOrder || ['A', 'B'];
  ui.aut = { sessionId: s.id, theme: next.theme, n: order.indexOf(next.theme) + 1, object: autObject(studyById(s.studyId), s.index, next.theme), startedAt: Date.now() };
  go('aut');
}

let autTimer = null;
function startAutTimer() {
  clearInterval(autTimer);
  const A = ui.aut;
  if (!A) return;
  const endsAt = A.startedAt + (AUT_SEC * 1000) / SPEED;
  const tick = () => {
    if (ui.view !== 'aut' || ui.aut !== A) { clearInterval(autTimer); return; }
    const left = endsAt - Date.now();
    const el = document.getElementById('aut-clock');
    if (el) el.textContent = mmss(left);
    if (left <= 0) { clearInterval(autTimer); finishAut(true); }
  };
  tick();
  autTimer = setInterval(tick, 250);
}

async function finishAut(timedOut = false) {
  const A = ui.aut;
  if (!A) return;
  clearInterval(autTimer);
  ui.aut = null;
  const text = document.getElementById('aut-text')?.value || '';
  const s = S.sessions.find((x) => x.id === A.sessionId);
  s.aut = { ...(s.aut || {}), [A.theme]: { object: A.object, text, fluency: fluency(text), sec: Math.round((Date.now() - A.startedAt) / 1000), timedOut, at: new Date().toISOString() } };
  await save();
  continuePost(s);
}

function beginTest(phase, mem, sessionId = null) {
  // A different item order and option layout for each test, from the same pairs.
  const seed = (mem.seed + (phase === 'immediate' ? 1 : 2)) >>> 0;
  ui.test = { phase, mem, sessionId, items: makeTest(mem.pairs, seed), i: 0, responses: [], shownAt: Date.now() };
  go('memtest');
}

async function finishTest() {
  const T = ui.test;
  if (T.themed) {
    ui.test = null;
    const res = { at: new Date().toISOString(), byTheme: scoreThemed(T.responses), items: T.responses };
    if (T.phase === 'immediate') {
      const m = T.mem;
      ui.pendingMemory = { themed: true, seed: m.seed, sets: m.sets, order: m.order, conditioning: m.conditioning, autOrder: autOrder(m.seed), immediate: res, delayed: null };
      go('memReady');
      return;
    }
    const s = S.sessions.find((x) => x.id === T.sessionId);
    s.themed.delayed = res;
    await save();
    continuePost(s);
    return;
  }
  const result = { at: new Date().toISOString(), ...scoreResponses(T.responses), items: T.responses };
  delete result.acc;
  ui.test = null;
  if (T.phase === 'immediate') {
    ui.pendingMemory = { seed: T.mem.seed, pairs: T.mem.pairs, immediate: result, delayed: null };
    go('memReady');
    return;
  }
  const s = S.sessions.find((x) => x.id === T.sessionId);
  s.memory.delayed = result;
  await save();
  const sum = memorySummary(s.memory);
  const delta = Math.round(sum.change * 100);
  toast(`Memory after the nap: ${result.correct}/${result.n}, before: ${s.memory.immediate.correct}/${s.memory.immediate.n} (${delta >= 0 ? '+' : ''}${delta} pts).`);
  go('home');
}

// ---------- voice recordings ----------
// Where each recordable line lives: a target's cue / start line, a v0.3 setting, or a script line.
function voiceSlot(kind, id) {
  const st = S.settings;
  if (kind === 'target' || kind === 'target-start') {
    const t = target(id);
    const field = kind === 'target' ? 'voiceId' : 'startVoiceId';
    return { get: () => t?.[field] || null, set: (v) => { t[field] = v; }, phrase: kind === 'target' ? t?.cuePhrase : startPhraseOf(t) };
  }
  if (kind === 'neutral' || kind === 'wake') {
    const key = kind === 'neutral' ? 'neutralVoiceId' : 'wakeVoiceId';
    return { get: () => st[key] || null, set: (v) => { st[key] = v; }, phrase: kind === 'neutral' ? NEUTRAL.cuePhrase : NEUTRAL.wakePhrase };
  }
  if (kind === 'script' && Object.hasOwn(SCRIPT_H2023, id)) {
    return { get: () => st.scriptVoiceIds?.[id] || null, set: (v) => { st.scriptVoiceIds = { ...(st.scriptVoiceIds || {}), [id]: v }; }, phrase: SCRIPT_H2023[id] };
  }
  return null;
}

async function toggleRecording(kind, id) {
  if (ui.recording) {
    const r = ui.recording;
    ui.recording = null;
    const blob = await r.handle.stop();
    if (!blob) { toast('Nothing was recorded.', 'danger'); render(); return; }
    const slot = voiceSlot(r.kind, r.id);
    if (!slot) { render(); return; }
    const blobId = newId('v');
    await db.putBlob(blobId, blob);
    if (slot.get()) await db.deleteBlob(slot.get());
    slot.set(blobId);
    await save();
    toast('Recording saved.');
    render();
    return;
  }
  const slot = voiceSlot(kind, id);
  if (!slot) return;
  try {
    const handle = await audio.startRecording();
    ui.recording = { kind, id, handle };
    const phrase = slot.phrase;
    toast(`Recording. Say slowly and softly: “${phrase}”, then tap stop.`);
    render();
  } catch {
    toast('Microphone permission is needed to record your voice.', 'danger');
  }
}

async function playCuePreview(motif, phrase, voiceId, volume = S.settings.cueVolume) {
  const st = S.settings;
  await audio.playMotif(motif, volume);
  const blob = voiceId ? await db.getBlob(voiceId) : null;
  if (blob) await audio.playBlob(blob, volume);
  else await audio.speak(phrase, { voiceURI: st.ttsVoiceURI, rate: st.ttsRate, volume });
}

// The control lines of the current protocol, as a session would play them (test buttons).
const previewLines = () => sessionLines({ protocol: currentProtocol(), condition: 'control', target: null, settings: S.settings, own: S.settings.voiceMode === 'own' });

// ---------- actions ----------
const ACTIONS = {
  nav: (el) => {
    if (el.dataset.view === 'study' || el.dataset.view === 'benefitSetup') ui.draft = {};
    go(el.dataset.view);
  },
  'accept-consent': async () => {
    const boxes = [...$app.querySelectorAll('input[name=consent]')];
    if (!boxes.every((b) => b.checked)) { toast('Each item needs its own yes. Tick all of them to continue.', 'danger'); return; }
    S.consent = { version: CONSENT_VERSION, at: new Date().toISOString(), items: Object.fromEntries(boxes.map((b) => [b.value, true])) };
    await save();
    db.requestPersistence();
    go('home');
  },
  'revoke-consent': async () => {
    if (!confirm('Withdraw consent? Nothing will play until you accept the charter again. Your data is kept.')) return;
    S.consent = null;
    await save();
    go('charter');
  },
  'new-target': () => go('targetEdit', { draft: { awareness: 'none' }, editTargetId: null }),
  'edit-target': (el) => {
    const t = target(el.dataset.id);
    // Keep the cue as an override only if you wrote it yourself. An auto-generated
    // cue (v0.4 form, or v0.3 form with ", and feel …") is regenerated on save.
    const auto = compileTarget({ label: t.label, ...t.dims, related: t.related, cuePhrase: '' }).target.cuePhrase;
    const autoV03 = t.dims?.emotion ? auto.replace(/^(Remember to think of .+?)(\. Notice that you are dreaming)?\.$/, `$1, and feel ${t.dims.emotion}$2.`) : auto;
    const override = t.cuePhrase && t.cuePhrase !== auto && t.cuePhrase !== autoV03 ? t.cuePhrase : '';
    go('targetEdit', { editTargetId: t.id, draft: { label: t.label, ...t.dims, related: t.related, cuePhrase: override } });
  },
  'save-target': async () => {
    const r = compileTarget(ui.draft);
    if (!r.ok) { toast(r.errors.join(' '), 'danger'); return; }
    if (ui.editTargetId) {
      const t = target(ui.editTargetId);
      if (lockedTargetIds().has(t.id)) { toast('This target is locked by a study.', 'danger'); return; }
      Object.assign(t, r.target, { updatedAt: new Date().toISOString() });
    } else {
      S.targets.push({ id: newId('t'), createdAt: new Date().toISOString(), voiceId: null, startVoiceId: null, ...r.target });
    }
    await save();
    go('targets', { draft: {}, editTargetId: null });
  },
  'delete-target': async (el) => {
    const t = target(el.dataset.id);
    if (lockedTargetIds().has(t.id)) return;
    if (!confirm(`Delete “${t.label}”?`)) return;
    if (t.voiceId) await db.deleteBlob(t.voiceId);
    if (t.startVoiceId) await db.deleteBlob(t.startVoiceId);
    S.targets = S.targets.filter((x) => x.id !== t.id);
    await save();
    render();
  },
  'preview-cue': () => {
    const r = compileTarget(ui.draft);
    if (r.ok) playCuePreview(r.target.motif, r.target.cuePhrase, null);
  },
  'hear-target': (el) => {
    const t = target(el.dataset.id);
    playCuePreview(t.motif, t.cuePhrase, S.settings.voiceMode === 'own' ? t.voiceId : null);
  },
  'record-voice': (el) => toggleRecording(el.dataset.kind, el.dataset.id),
  'play-voice': async (el) => audio.playBlob(await db.getBlob(el.dataset.blob), S.settings.cueVolume),
  'create-study': async () => {
    const ts = S.targets;
    const a = ui.draft.studyA || ts[0]?.id, b = ui.draft.studyB || ts[1]?.id;
    const cmp = compareTargets(target(a), target(b));
    if (!cmp.ok) { toast(cmp.warnings[0], 'danger'); return; }
    const blocks = Math.round(Number(ui.draft.blocks || 8));
    try {
      const study = createStudy({ targetAId: a, targetBId: b, blocks, protocol: newStudyProtocol(S.settings) });
      S.studies.push(study);
      S.activeStudyId = study.id;
      await save();
      toast(`Study created: ${study.schedule.length} naps, sequence locked.`);
      go('home', { draft: {} });
    } catch (e) {
      toast(e.message, 'danger');
    }
  },
  'ack-pause': async () => {
    if (!document.getElementById('ack-check')?.checked) { toast('Tick the box to confirm you’ve reflected first.', 'danger'); return; }
    const study = activeStudy();
    study.acks.push({ at: new Date().toISOString(), reasons: pauseState(study, S.sessions).reasons });
    await save();
    render();
  },
  'extend-study': async () => {
    const i = S.studies.findIndex((s) => s.id === S.activeStudyId);
    S.studies[i] = extendStudy(S.studies[i], 3); // 9 Phase 1 naps or 15 Phase 2 sessions
    await save();
    render();
  },
  'close-study': async () => {
    if (!confirm('Close this study? Its data and results stay available, and its targets stay locked.')) return;
    activeStudy().status = 'closed';
    S.activeStudyId = null;
    await save();
    go('home');
  },
  // Both tests play the current protocol's control lines at the volume the next session would use.
  'test-cue': () => {
    const l = previewLines().cue;
    return playCuePreview(NEUTRAL.motif, l.text, l.voiceId, sessionCueVolume().volume);
  },
  'test-wake': async () => {
    const st = S.settings;
    const l = previewLines().alert;
    await audio.chime(st.wakeVolume);
    const blob = l.voiceId ? await db.getBlob(l.voiceId) : null;
    await audio.sayLine({ text: l.text, blob }, { volume: st.wakeVolume, voiceURI: st.ttsVoiceURI, rate: st.ttsRate });
  },
  'start-session': () => runSession({ rehearsal: false }),
  rehearse: () => runSession({ rehearsal: true }),
  'end-session': (el) => {
    if (!ui.runner) return;
    if (!ui.endArmed) {
      ui.endArmed = true;
      el.textContent = 'Tap again to end';
      el.classList.add('armed');
      setTimeout(() => { ui.endArmed = false; if (el.isConnected) { el.textContent = 'End session'; el.classList.remove('armed'); } }, 4000);
      return;
    }
    ui.runner.abort();
  },
  'night-tap': () => {
    if (ui.runner?.tap()) ackTap();
  },
  'end-binding': (el) => {
    const B = ui.binding;
    if (!B) return;
    if (!B.endArmed) {
      B.endArmed = true;
      el.textContent = 'Tap again to end';
      el.classList.add('armed');
      setTimeout(() => { B.endArmed = false; if (el.isConnected) { el.textContent = 'End session'; el.classList.remove('armed'); } }, 4000);
      return;
    }
    B.finish({ aborted: true });
  },
  'save-binding': () => {
    const B = ui.binding;
    if (!B || B.stage !== 'rate') return;
    const missing = B.questions.filter((q) => !Number.isInteger(B.values[q.key]));
    if (missing.length) { toast(B.questions.length > 1 ? 'Set both sliders to your answer (tap a slider if it’s already right).' : 'Set the slider to your answer (tap it if it’s already right).', 'danger'); return; }
    const binding = { sec: B.listenedSec, speed: B.speed, startedAt: new Date(B.t0).toISOString(), plays: B.plays, at: new Date().toISOString() };
    for (const q of B.questions) binding[q.key] = B.values[q.key];
    B.finish({ binding });
  },
  'open-report': (el) => go('report', { reportId: el.dataset.id }),
  'save-report': async (el) => {
    const s = S.sessions.find((x) => x.id === el.dataset.id);
    const val = (name) => $app.querySelector(`[name="${name}"]:checked`)?.value;
    const numOr = (name) => (val(name) === undefined ? null : Number(val(name)));
    const info = conditionInfo(s.condition);
    for (const r of s.rounds) {
      r.transcript = $app.querySelector(`[name="t-${r.round}"]`)?.value || '';
      r.state = val(`st-${r.round}`) || '';
      if (askCueWoke(s, info, r.round)) r.cueWoke = val(`cw-${r.round}`) || null;
    }
    const morning = {
      at: new Date().toISOString(),
      report: $app.querySelector('[name=report]').value,
      vividness: numOr('vividness'), valence: numOr('valence'), intensity: numOr('intensity'), immersion: numOr('immersion'), bizarreness: numOr('bizarreness'), lucidity: numOr('lucidity'), disruption: numOr('disruption'),
      distressing: $app.querySelector('[name=distressing]').checked,
    };
    const awake = info.state === 'wake';
    if (morning.disruption === null && !awake) { toast('Please rate how much the wake-ups disrupted your rest. The safety pause depends on it.', 'danger'); return; }
    s.morning = morning;
    await save();
    if (nextPostTask(s)) { continuePost(s); return; }
    const study = S.studies.find((x) => x.id === s.studyId);
    const ps = study ? pauseState(study, S.sessions, S.checkins) : { paused: false };
    if (s.memory?.immediate && !s.memory.delayed) {
      toast('Report saved. Now the same word-pair test as before the nap.');
      beginTest('delayed', s.memory, s.id);
      return;
    }
    toast(ps.paused ? 'Saved. The study has paused itself; see Home.' : 'Report saved.', ps.paused ? 'danger' : 'info');
    go('home');
  },
  'begin-session': () => {
    const study = activeStudy();
    const check = canStartSession({ state: S, study, speed: SPEED });
    if (!check.ok) { toast(check.reasons[0], 'danger'); return; }
    if (studyKind(study) === 'benefit') {
      const seed = newSeed();
      const sets = makeThemedSets(seed, S.settings.pairsPerTheme, excludedStems());
      ui.learn = { seed, themed: true, sets, order: sets.order };
      go('learn');
      return;
    }
    if (!S.settings.memoryTask) return runSession({ rehearsal: false });
    const seed = newSeed();
    ui.learn = { seed, pairs: makePairs(seed, S.settings.memoryPairs, excludedStems()), i: 0 };
    go('learn');
  },
  answer: (el) => {
    const T = ui.test;
    const item = T.items[T.i];
    T.responses.push({ ...(item.theme ? { theme: item.theme } : {}), cue: item.cue, chosen: el.dataset.word, correct: el.dataset.word === item.answer, rtMs: Date.now() - T.shownAt });
    T.i++;
    if (T.i < T.items.length) { T.shownAt = Date.now(); render(); return; }
    finishTest();
  },
  'cancel-memory': () => { ui.pendingMemory = null; go('home'); },
  'resume-post': (el) => continuePost(S.sessions.find((x) => x.id === el.dataset.id)),
  'aut-done': () => finishAut(false),
  'create-benefit': async () => {
    const parent = phaseTwoParent();
    if (!parent) { toast('Finish Phase 1 first.', 'danger'); return; }
    try {
      const study = createBenefitStudy({
        parent,
        primary: ui.draft.bPrimary || 'creativity',
        objects: { A: parseObjects(ui.draft.objA), B: parseObjects(ui.draft.objB) },
        blocks: Math.round(Number(ui.draft.bBlocks || 6)),
        protocol: newStudyProtocol(S.settings),
      });
      parent.status = 'closed';
      S.studies.push(study);
      S.activeStudyId = study.id;
      await save();
      toast(`Phase 2 created: ${study.schedule.length} sessions, sequence locked.`);
      go('home', { draft: {} });
    } catch (e) {
      toast(e.message, 'danger');
    }
  },
  'save-creativity': async (el) => {
    const v = ui.scoreDraft.aut;
    if (!Number.isInteger(v)) { toast('Pick a rating from 1 to 5.', 'danger'); return; }
    const item = creativityQueue(S.sessions, S.studies).find((x) => x.code === el.dataset.code);
    if (!item) return;
    item.s.autBlind = { ...(item.s.autBlind || {}), [item.theme]: v, rater: 'self', at: new Date().toISOString() };
    ui.scoreDraft = {};
    await save();
    render();
  },
  'export-creativity': () => download(`dream-creativity-packet-${localDate(new Date())}.csv`, creativityPacketCSV(S.sessions, S.studies), 'text/csv'),
  'save-checkin': async () => {
    const val = (name) => $app.querySelector(`[name="${name}"]:checked`)?.value;
    const n = (name) => (val(name) === undefined ? null : Number(val(name)));
    const hours = $app.querySelector('[name=sleepHours]').value;
    const c = {
      date: localDate(new Date()),
      at: new Date().toISOString(),
      sleepHours: hours === '' ? null : Number(hours),
      sleepQuality: n('sleepQuality'), mood: n('mood'), sharpness: n('sharpness'), unreal: n('unreal'),
      confusion: $app.querySelector('[name=confusion]').checked,
      substances: $app.querySelector('[name=substances]').checked,
      note: $app.querySelector('[name=note]').value.trim(),
    };
    if (c.unreal === null || c.mood === null) { toast('Please answer the mood and unreality questions. The safety check depends on them.', 'danger'); return; }
    S.checkins = S.checkins.filter((x) => x.date !== c.date).concat(c);
    await save();
    const study = activeStudy();
    const paused = study && pauseState(study, S.sessions, S.checkins).paused;
    toast(paused ? 'Saved. Based on this check-in the study has paused itself. See Home.' : c.substances ? 'Saved. Today’s nap will be flagged as substance-affected in your data.' : 'Check-in saved.', paused ? 'danger' : 'info');
    go('home');
  },
  'export-trials': () => download(`dream-engine-trials-${localDate(new Date())}.csv`, rowsToCSV(trialRows(S)), 'text/csv'),
  'export-sessions': () => download(`dream-engine-sessions-${localDate(new Date())}.csv`, rowsToCSV(sessionRows(S)), 'text/csv'),
  'save-score': async (el) => {
    const d = ui.scoreDraft;
    const s = S.sessions.find((x) => x.id === el.dataset.id);
    const study = studyById(s.studyId);
    const eA = emotionScored(study, target(study.targetIds.A)), eB = emotionScored(study, target(study.targetIds.B));
    const need = ['A', 'B', ...(eA ? ['emoA'] : []), ...(eB ? ['emoB'] : [])];
    if (!need.every((k) => Number.isInteger(d[k]))) { toast(eA || eB ? 'Score both targets: the idea and the feeling.' : 'Score both targets.', 'danger'); return; }
    s.blind = { A: d.A, B: d.B, emoA: eA ? d.emoA : null, emoB: eB ? d.emoB : null, at: new Date().toISOString(), rater: 'self' };
    ui.scoreDraft = {};
    await save();
    render();
  },
  'export-packet': () => download(`dream-blind-packet-${new Date().toISOString().slice(0, 10)}.csv`, blindPacketCSV(S.sessions, S.studies, S.targets), 'text/csv'),
  'export-data': () => {
    download(`dream-engine-data-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'dream-engine', exportedAt: new Date().toISOString(), state: S }, null, 2), 'application/json');
  },
  'export-full': async () => {
    const blobs = {};
    for (const k of await db.blobKeys()) blobs[k] = await audio.blobToDataURL(await db.getBlob(k));
    download(`dream-engine-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'dream-engine', exportedAt: new Date().toISOString(), state: S, blobs }), 'application/json');
  },
  'delete-all': async () => {
    const typed = prompt('This permanently deletes every target, study, report and recording on this device. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    await db.clearAll();
    S = emptyState();
    await save();
    go('charter');
  },
};

const FILES = {
  'import-metrics': async (file) => {
    const res = parseMetricsCSV(await file.text());
    S.metrics = mergeMetrics(S.metrics, res.items);
    await save();
    toast(`Imported ${res.items.length} metric value${res.items.length === 1 ? '' : 's'}${res.errors.length ? `; ${res.errors.length} skipped (${res.errors[0]})` : ''}.`, res.errors.length ? 'danger' : 'info');
    render();
  },
  'import-creativity': async (file) => {
    const res = parseCreativityCSV(await file.text(), S.sessions, S.studies);
    for (const u of res.updates) {
      const s = S.sessions.find((x) => x.id === u.sessionId);
      s.autBlind = { ...(s.autBlind || {}), [u.theme]: u.rating, rater: 'external', at: new Date().toISOString() };
    }
    await save();
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    toast(`Imported ${plural(res.updates.length, 'rating')}${res.errors.length ? `; ${plural(res.errors.length, 'row')} skipped (${res.errors[0]})` : ''}.`, res.errors.length ? 'danger' : 'info');
    render();
  },
  'import-scores': async (file) => {
    const res = parseScoresCSV(await file.text(), S.sessions, S.studies);
    for (const u of res.updates) {
      const s = S.sessions.find((x) => x.id === u.sessionId);
      const study = studyById(s.studyId);
      // Emotion columns only count where the study scores emotion and the target has one.
      const eA = emotionScored(study, target(study.targetIds.A)), eB = emotionScored(study, target(study.targetIds.B));
      s.blind = { A: u.A, B: u.B, emoA: eA ? u.emoA : null, emoB: eB ? u.emoB : null, at: new Date().toISOString(), rater: 'external' };
    }
    await save();
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    toast(`Imported ${plural(res.updates.length, 'score')}${res.errors.length ? `; ${plural(res.errors.length, 'row')} skipped (${res.errors[0]})` : ''}.`, res.errors.length ? 'danger' : 'info');
    render();
  },
  'import-data': async (file) => {
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', 'danger'); return; }
    const res = validateImport(obj);
    if (!res.ok) { toast(res.errors.join(' '), 'danger'); return; }
    if (!confirm('Replace everything on this device with this backup?')) return;
    await db.clearAll();
    if (res.blobs) for (const [k, v] of Object.entries(res.blobs)) await db.putBlob(k, audio.dataURLToBlob(v));
    S = res.state;
    await save();
    toast('Backup restored.');
    go('home');
  },
};

function setSetting(path, raw, el) {
  const st = S.settings;
  let v = raw;
  if (el.type === 'checkbox') v = el.checked;
  else if (['rounds', 'recordSec', 'lieDownSec', 'memoryPairs', 'pairsPerTheme'].includes(path)) v = Number(raw);
  else if (['ttsRate', 'cueVolume', 'wakeVolume', 'cueVolumeMax'].includes(path)) v = Number(raw);
  if (path.startsWith('window.')) st.window[path.slice(7)] = v;
  else st[path] = v;
  save();
  if (['cueVolume', 'cueVolumeMax', 'adaptiveVolume'].includes(path)) {
    const el2 = document.getElementById('next-volume');
    if (el2) el2.textContent = pct(sessionCueVolume().volume);
  }
}

document.addEventListener('click', (e) => {
  // Tapping a binding slider at its current value still counts as an answer.
  if (e.target.matches?.('input[data-bind]')) { setBindValue(e.target); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  const fn = ACTIONS[el.dataset.act];
  if (fn) Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(err.message || String(err), 'danger'); });
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.draft) {
    ui.draft[el.dataset.draft] = el.value;
    if (ui.view === 'targetEdit') {
      const pv = document.getElementById('preview');
      if (pv) pv.innerHTML = targetPreview();
    }
  }
  if (el.dataset.bind) { setBindValue(el); return; }
  if (el.dataset.set && el.type === 'range') {
    setSetting(el.dataset.set, el.value, el);
    const em = el.closest('.field')?.querySelector('em');
    if (em) em.textContent = el.dataset.set === 'ttsRate' ? num(Number(el.value), 2) : pct(Number(el.value));
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.draft && (ui.view === 'study')) { ui.draft[el.dataset.draft] = el.value; render(); return; }
  if (el.dataset.set && el.type !== 'range') { setSetting(el.dataset.set, el.value, el); return; }
  if (el.dataset.bind) { setBindValue(el); return; }
  if (el.name === 'set-voiceMode') { S.settings.voiceMode = el.value; save(); return; }
  if (el.name === 'set-scriptVersion') { S.settings.scriptVersion = el.value === 'v1' ? 'v1' : 'h2023'; save(); render(); return; }
  if (/^score-(A|B|emoA|emoB)$/.test(el.name)) { ui.scoreDraft[el.name.slice(6)] = Number(el.value); return; }
  if (el.name === 'aut-rating') { ui.scoreDraft.aut = Number(el.value); return; }
  if (el.name === 'b-primary') { ui.draft.bPrimary = el.value; return; }
  if (el.dataset.file && el.files?.[0]) {
    const f = el.files[0];
    el.value = '';
    FILES[el.dataset.file](f).catch((err) => toast(err.message || String(err), 'danger'));
  }
});

window.addEventListener('beforeunload', (e) => {
  if (ui.runner || ui.binding) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- boot ----------
async function boot() {
  const stored = await db.loadState();
  S = migrate(stored || emptyState());
  let changed = !stored;
  for (const s of S.sessions) {
    if (s.status === 'running') {
      // The page was closed mid-session. The allocation stays consumed.
      s.status = 'aborted';
      if (s.stage === 'binding') s.abortedAt = 'binding';
      delete s.stage;
      s.endedAt = s.endedAt || new Date().toISOString();
      s.events = [...(s.events || []), { t: new Date().toISOString(), type: 'interrupted' }];
      changed = true;
    }
  }
  if (changed) await save();
  ui.view = consentValid(S.consent) ? 'home' : 'charter';
  render();
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { if (ui.view === 'settings') render(); };
  if ('serviceWorker' in navigator && !params.has('nosw')) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__dreamEngine = { get state() { return S; }, ui, version: APP_VERSION };
}

boot().catch((e) => {
  $app.innerHTML = `<section class="banner danger">Could not start: ${esc(e.message || e)}</section>`;
});
