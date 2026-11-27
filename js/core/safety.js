// Guardrails. V0 is a nap protocol: it never runs during night-time sleep,
// caps how often it can wake you, and pauses itself when your own ratings say
// sleep or mood are suffering.

import { nextPostTask } from './benefit.js';
import { studyProtocol } from './study.js';

export const SAFETY = {
  hardWindow: { start: '06:00', end: '22:00' },
  maxSessionsPerDay: 2,
  minGapHours: 2,
  disruptionPause: 3, // mean of last 3 sessions on a 0–4 scale
  disruptionLookback: 3,
};

export const CONSENT_VERSION = 1;
export const CONSENT_ITEMS = [
  { key: 'cues', text: 'Play audio cues (a short sound motif and a spoken phrase) while I fall asleep.' },
  { key: 'wakeups', text: 'Wake me with a spoken prompt a few times per nap (never more than 5).' },
  { key: 'mic', text: 'Record my voice only during the report window after each wake-up.' },
  { key: 'local', text: 'All data stays on this device. Nothing is uploaded, and I am responsible for exporting backups.' },
  { key: 'stop', text: 'I will pause or stop if my sleep, mood or daytime functioning gets worse.' },
];

export function consentValid(consent) {
  return !!consent && consent.version === CONSENT_VERSION && CONSENT_ITEMS.every((c) => consent.items?.[c.key] === true);
}

export const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
};

// The user's window, clamped inside the hard daytime window.
export function effectiveWindow(win) {
  const hs = toMinutes(SAFETY.hardWindow.start), he = toMinutes(SAFETY.hardWindow.end);
  let s = toMinutes(win?.start), e = toMinutes(win?.end);
  if (!Number.isFinite(s)) s = hs;
  if (!Number.isFinite(e)) e = he;
  s = Math.max(hs, Math.min(he, s));
  e = Math.max(hs, Math.min(he, e));
  return { startMin: s, endMin: e };
}

const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const realSession = (s) => !s.rehearsal && s.params?.speed === 1;

export const UNREAL_PAUSE = 3; // 0–4: "often" or "constantly"

export function pauseState(study, sessions, checkins = []) {
  const lastAck = (study?.acks || []).reduce((t, a) => (a.at > t ? a.at : t), '');
  const done = sessions
    .filter((s) => s.studyId === study?.id && realSession(s) && s.morning)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const reasons = [];
  const recentChecks = checkins.filter((c) => c.at > lastAck);
  if (recentChecks.some((c) => c.confusion)) reasons.push('A check-in reported mixing up a dream with something that really happened.');
  if (recentChecks.some((c) => Number(c.unreal) >= UNREAL_PAUSE)) reasons.push('A check-in reported things often feeling unreal or detached.');
  const distress = done.filter((s) => s.morning.distressing && s.morning.at > lastAck);
  if (distress.length) reasons.push('A recent session was marked distressing.');
  // Stay-awake sessions have no disruption rating, so they don't dilute the average.
  const rated = done.filter((s) => s.morning.disruption !== null && s.morning.disruption !== undefined);
  const recent = rated.slice(-SAFETY.disruptionLookback);
  if (recent.length === SAFETY.disruptionLookback && recent[recent.length - 1].morning.at > lastAck) {
    const m = recent.reduce((t, s) => t + (Number(s.morning.disruption) || 0), 0) / recent.length;
    if (m >= SAFETY.disruptionPause) reasons.push(`Sleep disruption averaged ${m.toFixed(1)}/4 over your last ${recent.length} sessions.`);
  }
  return { paused: reasons.length > 0, reasons };
}

export function canStartSession({ now = new Date(), state, study, speed = 1 }) {
  const reasons = [];
  if (!consentValid(state.consent)) reasons.push('Review and accept the dream charter first.');
  if (!study) reasons.push('Create a study with two targets first.');
  const sessions = state.sessions || [];
  if (study) {
    const ps = pauseState(study, sessions, state.checkins || []);
    if (ps.paused) reasons.push('The study is paused for safety: ' + ps.reasons.join(' '));
    const pending = sessions.find((s) => s.studyId === study.id && realSession(s) && s.status === 'complete' && !s.morning);
    if (pending && speed === 1) reasons.push('Finish the report for your last session first.');
    const unfinished = sessions.find((s) => s.studyId === study.id && realSession(s) && nextPostTask(s));
    if (unfinished && speed === 1) reasons.push('Finish the after-session tests for your last session first.');
  }
  if (speed === 1 && !(state.checkins || []).some((c) => sameLocalDay(new Date(c.at), now))) {
    reasons.push('Do today’s check-in first (about a minute).');
  }
  // v1 studies keep the v0.3 rule. Horowitz-script studies fall back to the
  // device voice line by line, and Home lists the missing recordings instead.
  if (state.settings?.voiceMode === 'own' && study && studyProtocol(study).script !== 'h2023') {
    const t = state.targets || [];
    const A = t.find((x) => x.id === study.targetIds.A), B = t.find((x) => x.id === study.targetIds.B);
    if (!A?.voiceId || !B?.voiceId || !state.settings.neutralVoiceId || !state.settings.wakeVoiceId)
      reasons.push('Own-voice mode needs recordings for both targets, the neutral cue and the wake prompt.');
  }
  if (speed === 1) {
    const w = effectiveWindow(state.settings?.window);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < w.startMin || nowMin >= w.endMin) {
      const f = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      reasons.push(`Nap sessions run between ${f(w.startMin)} and ${f(w.endMin)}. V0 never wakes you during night-time sleep.`);
    }
    const real = sessions.filter(realSession);
    const today = real.filter((s) => sameLocalDay(new Date(s.startedAt), now));
    if (today.length >= SAFETY.maxSessionsPerDay) reasons.push(`At most ${SAFETY.maxSessionsPerDay} sessions per day.`);
    const lastEnd = real.map((s) => s.endedAt || s.startedAt).sort().pop();
    if (lastEnd) {
      const gapH = (now - new Date(lastEnd)) / 36e5;
      if (gapH < SAFETY.minGapHours) reasons.push(`Leave at least ${SAFETY.minGapHours} h between sessions (${Math.ceil((SAFETY.minGapHours - gapH) * 60)} min to go).`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
