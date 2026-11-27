// Executes a session plan in real time: waits are measured against the wall
// clock, the screen is kept awake (black), and every step is logged.
//
// v0.4: each spoken line plays from your recording when there is one, else
// the device voice, and is logged with voice 'own' | 'tts'. Cues play at the
// session's cue volume (fixed or from the staircase). Taps on the night
// screen and phone motion during waits are logged for per-cue arousal.

import { playMotif, chime, sayLine, recordFor, waitMs, startKeepAlive, stopKeepAlive, audioContext } from './audio.js';
import { motionDetector, MOTION_WAIT_MS } from './core/runtime.js';

// iOS asks for motion access; it must be called inside the Start tap.
export function requestMotionPermission() {
  try {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') return DME.requestPermission().then((r) => r, () => 'denied');
  } catch {
    return Promise.resolve('denied');
  }
  return Promise.resolve('not-needed');
}

export class SessionRunner {
  // lines: { start, cue, alert, stateAsk, back }, each { text, blob } or null.
  constructor({ steps, speed = 1, lines, motif = null, cueVolume, settings, motionPermission, arousalLogging = true, onPhase, onEvent, onRecording }) {
    this.arousalLogging = arousalLogging;
    this.steps = steps;
    this.speed = speed;
    this.lines = lines || {};
    this.motif = motif;
    this.settings = settings;
    this.cueVolume = typeof cueVolume === 'number' ? cueVolume : settings.cueVolume;
    this.motionPermission = motionPermission || Promise.resolve('not-needed');
    this.onPhase = onPhase || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onRecording = onRecording || (async () => {});
    this.ctrl = new AbortController();
    this.wakeLock = null;
    this.events = [];
    this.step = null;
    this.running = false;
  }

  log(type, extra = {}) {
    const e = { t: new Date().toISOString(), type, ...extra };
    this.events.push(e);
    this.onEvent(e);
    return e;
  }

  async lockScreen() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  onVisibility = () => {
    if (document.visibilityState === 'visible' && !this.ctrl.signal.aborted) this.lockScreen();
  };

  abort() {
    this.log('abort');
    this.ctrl.abort();
    try { speechSynthesis.cancel(); } catch {}
  }

  // A tap anywhere on the night screen ("if a cue wakes you, tap once").
  tap() {
    if (!this.arousalLogging || !this.running || this.ctrl.signal.aborted) return null;
    return this.log('tap', { phase: this.step?.phase ?? null, round: this.step?.round });
  }

  // Listens without waiting for the permission answer: a pending prompt must
  // never hold up the session, and a "denied" answer is only recorded as the
  // reason if no readings arrive.
  startMotion() {
    if (!this.arousalLogging) return () => {};
    if (typeof window.DeviceMotionEvent === 'undefined') { this.log('motion-unavailable', { reason: 'unsupported' }); return () => {}; }
    let perm = 'pending';
    let timer = null;
    let readings = 0;
    // "motion-unavailable" is only logged once the permission question is settled
    // and no readings arrive within MOTION_WAIT_MS after that.
    const arm = () => {
      timer = setTimeout(() => { if (!readings && this.running) this.log('motion-unavailable', { reason: perm === 'denied' ? 'denied' : 'no-readings', permission: perm }); }, MOTION_WAIT_MS);
    };
    const needsPermission = typeof window.DeviceMotionEvent.requestPermission === 'function';
    if (needsPermission) {
      // Nothing is logged while the prompt is pending; the 5 s clock starts when it resolves.
      Promise.resolve(this.motionPermission).then((p) => { perm = p; arm(); }, () => { perm = 'denied'; arm(); });
    } else {
      Promise.resolve(this.motionPermission).then((p) => { perm = p; }, () => { perm = 'denied'; });
      arm();
    }
    const detect = motionDetector();
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return;
      readings++;
      const step = this.step;
      const m = detect(a, Date.now(), this.running && step?.kind === 'wait');
      if (m !== null) this.log('motion', { phase: step.phase, round: step.round, mag: Math.round(m * 100) / 100 });
    };
    window.addEventListener('devicemotion', onMotion);
    return () => { clearTimeout(timer); window.removeEventListener('devicemotion', onMotion); };
  }

  async say(line, volume) {
    const s = this.settings;
    return sayLine(line, { volume, voiceURI: s.ttsVoiceURI, rate: s.ttsRate });
  }

  // Returns whether the spoken part actually played (false = TTS/audio failed or timed out).
  async playCue() {
    if (this.motif) await playMotif(this.motif, this.cueVolume);
    if (this.ctrl.signal.aborted) return false;
    return (await this.say(this.lines.cue, this.cueVolume)).played;
  }

  async playWake() {
    const s = this.settings;
    await chime(s.wakeVolume);
    if (this.ctrl.signal.aborted) return false;
    return (await this.say(this.lines.alert, s.wakeVolume)).played;
  }

  // Exactly what was played, so every cue is a self-contained stimulus record.
  cueMeta() {
    const l = this.lines.cue;
    return { text: l?.text ?? '', voice: l?.blob ? 'own' : 'tts', motif: !!this.motif, volume: this.cueVolume };
  }

  async run() {
    const signal = this.ctrl.signal;
    audioContext();
    startKeepAlive();
    await this.lockScreen();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.running = true;
    this.log('start', { speed: this.speed });
    const stopMotion = this.startMotion();
    try {
      for (const step of this.steps) {
        if (signal.aborted) break;
        this.step = step;
        let ms = step.sec ? (step.sec * 1000) / this.speed : 0;
        // A sped-up rehearsal still needs a usable mic-check clip.
        if (step.kind === 'record') ms = Math.max(ms, 3000);
        if (step.kind === 'wait') {
          const endsAt = Date.now() + ms;
          this.onPhase({ ...step, endsAt });
          await waitMs(ms, signal, (left) => this.onPhase({ ...step, endsAt, left }));
        } else if (step.kind === 'cue') {
          this.onPhase({ ...step });
          const ev = this.log('cue', { phase: step.phase, round: step.round, ...this.cueMeta() });
          ev.played = await this.playCue();
        } else if (step.kind === 'say') {
          // h2023 lines: start (after settling), stateAsk (after the report), back (after the return cue).
          this.onPhase({ ...step });
          const line = this.lines[step.line] || null;
          const volume = step.line === 'stateAsk' ? this.settings.wakeVolume : this.cueVolume;
          const ev = this.log('say', { phase: step.phase, round: step.round, line: step.line, text: line?.text ?? '', voice: line?.blob ? 'own' : 'tts', volume });
          ev.played = line ? (await this.say(line, volume)).played : false;
        } else if (step.kind === 'wake') {
          this.onPhase({ ...step });
          const l = this.lines.alert;
          const ev = this.log('wake', { round: step.round, text: l?.text ?? '', voice: l?.blob ? 'own' : 'tts', volume: this.settings.wakeVolume });
          ev.played = await this.playWake();
        } else if (step.kind === 'record') {
          const endsAt = Date.now() + ms;
          this.onPhase({ ...step, endsAt, recording: true });
          this.log('record-start', { round: step.round, phase: step.phase });
          const wokeAt = new Date().toISOString();
          const blob = await recordFor(ms, signal);
          this.log('record-stop', { round: step.round, phase: step.phase, bytes: blob ? blob.size : 0 });
          await this.onRecording({ round: step.round, phase: step.phase, blob, wokeAt });
        } else if (step.kind === 'chime') {
          this.onPhase({ ...step });
          this.log('end-chime');
          await chime(this.settings.wakeVolume, true);
        }
      }
    } finally {
      this.running = false;
      this.step = null;
      stopMotion();
      document.removeEventListener('visibilitychange', this.onVisibility);
      stopKeepAlive();
      try { await this.wakeLock?.release(); } catch {}
    }
    const status = signal.aborted ? 'aborted' : 'complete';
    this.log(status);
    return { status, events: this.events };
  }
}
