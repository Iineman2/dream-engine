// Audio I/O: synthesised motifs and chimes (Web Audio), speech (on-device
// speechSynthesis or your own recorded voice), and microphone recording that
// is open only for the report window.

let ctx = null;
let keepAlive = null;

export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// A near-silent tone keeps mobile browsers from suspending the audio context
// during long waits, so cues fire on time.
export function startKeepAlive() {
  const c = audioContext();
  if (keepAlive) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  g.gain.value = 0.00001;
  osc.frequency.value = 40;
  osc.connect(g).connect(c.destination);
  osc.start();
  keepAlive = osc;
}

export function stopKeepAlive() {
  try { keepAlive?.stop(); } catch {}
  keepAlive = null;
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function playMotif(notes, volume = 0.5) {
  const c = audioContext();
  const t0 = c.currentTime + 0.05;
  const step = 0.42, dur = 0.38;
  notes.forEach((m, i) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiHz(m);
    const t = t0 + i * step;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35 * volume, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  });
  await sleep((notes.length * step + 0.3) * 1000);
}

export async function chime(volume = 0.6, low = false) {
  const c = audioContext();
  const t = c.currentTime + 0.05;
  const base = low ? 392 : 523.25;
  for (const [mult, amp] of [[1, 0.3], [2.01, 0.12], [3.02, 0.05]]) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = base * mult;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp * volume, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + 1.9);
  }
  await sleep(1300);
}

export function voices() {
  try { return window.speechSynthesis ? speechSynthesis.getVoices() : []; } catch { return []; }
}

export function speak(text, { voiceURI = '', rate = 0.85, volume = 0.8 } = {}) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !text) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    const v = voices().find((x) => x.voiceURI === voiceURI);
    if (v) u.voice = v;
    u.rate = rate;
    u.volume = Math.max(0, Math.min(1, volume));
    // Some Android builds never fire onend; fall back to an estimate.
    const words = text.split(/\s+/).length;
    const fallback = setTimeout(() => resolve(false), (words * 0.55 / rate + 2) * 1000);
    u.onend = () => { clearTimeout(fallback); resolve(true); };
    u.onerror = () => { clearTimeout(fallback); resolve(false); };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

export function playBlob(blob, volume = 0.8) {
  return new Promise((resolve) => {
    if (!blob) return resolve(false);
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, volume));
    let done = false;
    const finish = (ok) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(ok); };
    a.onended = () => finish(true);
    a.onerror = () => finish(false);
    setTimeout(() => finish(false), 30000);
    a.play().catch(() => finish(false));
  });
}

// One spoken line: your recording when there is one, else the device voice.
// line = { text, blob }. Returns { voice: 'own' | 'tts' | null, played }.
export async function sayLine(line, { volume = 0.8, voiceURI = '', rate = 0.85 } = {}) {
  if (!line || !line.text) return { voice: null, played: false };
  if (line.blob) return { voice: 'own', played: await playBlob(line.blob, volume) };
  return { voice: 'tts', played: await speak(line.text, { voiceURI, rate, volume }) };
}

function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export async function micAvailable() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

// Starts recording; returns { stop(): Promise<Blob|null> }.
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(1000);
  return {
    stop: () => new Promise((resolve) => {
      const finish = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }) : null);
      };
      if (rec.state === 'inactive') return finish();
      rec.onstop = finish;
      try { rec.stop(); } catch { finish(); }
    }),
  };
}

export async function recordFor(ms, signal) {
  let handle;
  try {
    handle = await startRecording();
  } catch {
    await waitMs(ms, signal);
    return null;
  }
  await waitMs(ms, signal);
  return handle.stop();
}

// Abortable wait measured against the wall clock, robust to timer throttling.
export function waitMs(ms, signal, onTick) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      const left = end - Date.now();
      onTick?.(Math.max(0, left));
      if (left <= 0 || signal?.aborted) { clearInterval(id); resolve(); }
    };
    const id = setInterval(tick, 250);
    signal?.addEventListener('abort', tick, { once: true });
    tick();
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function dataURLToBlob(dataURL) {
  const [head, b64] = String(dataURL).split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
