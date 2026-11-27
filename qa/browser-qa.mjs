// End-to-end browser QA in a throwaway headless Chrome profile with a fake
// microphone. Drives the real UI: charter -> check-in -> targets -> study ->
// own-voice checklist -> learn word pairs -> pre-nap test -> binding step ->
// full session at 60x with an injected tap and motion -> report with
// "did the cue wake you?" -> post-nap test -> rehearsal -> binding abort and
// interrupted sessions -> backup import -> blind idea + emotion scoring ->
// rater packet round trip -> results (cue volume, emotion, link) + exports ->
// metrics import -> offline reload -> layout -> v3 backup with a v1 study ->
// Phase 2 (qa/phase2-qa.mjs) -> delete everything.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileTarget, NEUTRAL } from '../js/core/compiler.js';
import { createStudy } from '../js/core/study.js';
import { SCRIPT_H2023 } from '../js/core/protocol.js';
import { CONSENT_ITEMS, CONSENT_VERSION } from '../js/core/safety.js';
import { emptyState, DEFAULT_SETTINGS } from '../js/core/schema.js';
import { parseCSV, toCSV } from '../js/core/scoring.js';
import { phaseTwoQA } from './phase2-qa.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + 'qa/out/';
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`); };

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const consent = () => ({ version: CONSENT_VERSION, at: new Date().toISOString(), items: Object.fromEntries(CONSENT_ITEMS.map((c) => [c.key, true])) });

// ---------- fixture: 12 real-speed naps, 9 blind-scored (idea + emotion), with memory, check-ins, cue events, taps and binding ----------
function fixture() {
  const now = new Date().toISOString();
  const A = { id: 't_fixA', createdAt: now, voiceId: null, ...compileTarget({ label: 'purple forest', environment: 'a purple forest', emotion: 'awe', related: 'violet, trees, woods, moss' }).target };
  const B = { id: 't_fixB', createdAt: now, voiceId: null, ...compileTarget({ label: 'ocean of light', environment: 'an ocean of light', sensation: 'floating', emotion: 'peace', related: 'water, waves, glowing' }).target };
  const study = createStudy({ targetAId: A.id, targetBId: B.id, blocks: 8, seed: 777 });
  const text = { A: 'walking among violet trees with moss underfoot', B: 'floating on warm glowing water', control: 'an old school corridor and a bus' };
  const checkins = [];
  const sessions = study.schedule.slice(0, 12).map((condition, i) => {
    const t = new Date(2026, 10, 1 + i, 14, 0).toISOString();
    const later = new Date(2026, 10, 1 + i, 14, 50).toISOString();
    const at = (min, sec = 0) => new Date(2026, 10, 1 + i, 14, min, sec).toISOString();
    const pad = (n) => String(n).padStart(2, '0');
    checkins.push({ date: `2026-11-${pad(1 + i)}`, at: new Date(2026, 10, 1 + i, 8).toISOString(), sleepHours: 6 + (i % 3), sleepQuality: 2 + (i % 2), mood: (i % 3) - 1, sharpness: 2 + (i % 3), unreal: i % 2, confusion: false, substances: false, note: '' });
    const scored = i < 9;
    const volume = i < 6 ? 0.6 : 0.55;
    // One in-sleep cue per round; a tap after some of them, motion after others.
    const events = [{ t: at(0), type: 'start', speed: 1 }];
    for (const round of [1, 2, 3]) {
      const m = 10 + (round - 1) * 8;
      events.push({ t: at(m), type: 'cue', phase: 'hypnagogia', round, text: 'cue', voice: 'tts', motif: false, volume, played: true });
      if ((i + round) % 4 === 0) events.push({ t: at(m, 20), type: 'tap', phase: 'hypnagogia', round });
      if ((i + round) % 5 === 0) events.push({ t: at(m, 30), type: 'motion', phase: 'hypnagogia', round, mag: 2.2 });
      events.push({ t: at(m + 2), type: 'wake', round, text: SCRIPT_H2023.alert, voice: 'tts', volume: 0.85, played: true });
    }
    const emo = condition === 'A' ? { emoA: i % 2 ? 2 : 1, emoB: 0 } : condition === 'B' ? { emoA: 0, emoB: 2 } : { emoA: 0, emoB: 0 };
    return {
      id: `s_fix${i}`, studyId: study.id, index: i, condition, targetId: condition === 'control' ? null : study.targetIds[condition], rehearsal: false,
      params: { rounds: 3, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: false, script: 'h2023', state: 'sleep', armId: ['short', 'mid', 'long'][i % 3], adaptive: true, onsetWindow: { minMin: 7.5, maxMin: 12.5 }, speed: 1,
        protocol: { ...study.protocol },
        audio: { voiceMode: 'tts', cueVolume: volume, wakeVolume: 0.85, ttsRate: 0.85, motif: false, adaptiveVolume: true } },
      status: 'complete', startedAt: t, endedAt: t, events,
      rounds: [1, 2, 3].map((round) => ({ round, audioId: null, wokeAt: t, transcript: round === 2 ? text[condition] : 'drifting images', state: round === 1 ? 'drifting' : ['awake', 'drifting', 'asleep'][(i + round) % 3], cueWoke: (i + round) % 3 === 0 ? 'yes' : 'no' })),
      morning: { at: t, report: '', vividness: 2 + (i % 2), valence: 1, intensity: 1 + (i % 3), immersion: 2, bizarreness: i % 4, lucidity: i % 2, disruption: i % 3, distressing: false },
      blind: scored ? { A: condition === 'A' ? 2 : 0, B: condition === 'B' ? 2 : 0, ...emo, at: t, rater: 'self' } : null,
      binding: condition === 'control' ? { sec: 120, plays: [], calm: 5 + (i % 3), at: t } : { sec: 120, plays: [], feel: 4 + (i % 5), vivid: 6, at: t },
      memory: { seed: i, pairs: [], immediate: { at: t, correct: 10, n: 16 }, delayed: { at: later, correct: 10 + (i % 4), n: 16 } },
    };
  });
  const state = { ...emptyState(), consent: consent(), targets: [A, B], studies: [study], sessions, checkins, activeStudyId: study.id };
  return { app: 'dream-engine', exportedAt: now, state };
}
await writeFile(out + 'fixture-backup.json', JSON.stringify(fixture()));

// ---------- fixture: a v0.3 (schema v3) export, as saved before v0.4 ----------
const V3_CUE = 'Remember to think of a purple forest, and feel awe.';
function fixtureV3() {
  const now = new Date().toISOString();
  const v03 = (id, input, cuePhrase) => {
    const t = { id, createdAt: now, voiceId: null, ...compileTarget(input).target, cuePhrase };
    delete t.startPhrase;
    return t;
  };
  const A = v03('t_v3A', { label: 'purple forest', environment: 'a purple forest', emotion: 'awe', related: 'violet, trees, woods, moss' }, V3_CUE);
  const B = v03('t_v3B', { label: 'ocean of light', environment: 'an ocean of light', sensation: 'floating', related: 'water, waves, glowing' }, 'Remember to think of an ocean of light.');
  const study = createStudy({ targetAId: A.id, targetBId: B.id, blocks: 4, seed: 99 });
  delete study.protocol;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), cueVolume: 0.55, memoryTask: false };
  for (const k of ['scriptVersion', 'bindingStep', 'adaptiveVolume', 'cueVolumeMax', 'scriptVoiceIds']) delete settings[k];
  const sessions = study.schedule.slice(0, 3).map((condition, i) => {
    const t = new Date(2026, 9, 10 + i, 14, 0).toISOString();
    return {
      id: `s_v3_${i}`, studyId: study.id, index: i, condition, targetId: condition === 'control' ? null : study.targetIds[condition], rehearsal: false,
      params: { rounds: 3, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: false, armId: 'mid', adaptive: true, speed: 1, audio: { voiceMode: 'tts', cueVolume: 0.55, wakeVolume: 0.85, ttsRate: 0.85, motif: false } },
      status: 'complete', startedAt: t, endedAt: t, events: [],
      rounds: [1, 2, 3].map((round) => ({ round, audioId: null, wokeAt: t, transcript: 'violet trees', state: 'drifting' })),
      morning: { at: t, report: '', vividness: 2, valence: 1, intensity: 1, immersion: 2, bizarreness: 1, lucidity: 0, disruption: 1, distressing: false },
      blind: i < 2 ? { A: 2, B: 0, at: t, rater: 'self' } : null,
      memory: null,
    };
  });
  const state = { version: 3, createdAt: now, consent: consent(), settings, targets: [A, B], studies: [study], sessions, checkins: [], metrics: [], activeStudyId: study.id };
  return { app: 'dream-engine', exportedAt: now, state };
}
await writeFile(out + 'fixture-v3.json', JSON.stringify(fixtureV3()));

// ---------- server + browser ----------
const server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  // --mute-audio silences Web Audio and <audio>. Speech synthesis goes through the OS
  // voice engine and is not covered by it, so it is also stubbed below.
  args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
await ctx.grantPermissions(['microphone'], { origin: BASE });
// Silence OS text-to-speech: every utterance is spoken at volume 0.
await ctx.addInitScript(() => {
  if (!window.speechSynthesis) return;
  const speak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (u) => { try { u.volume = 0; } catch {} return speak(u); };
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'DELETE' : undefined));
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const shot = (name, full = false) => page.screenshot({ path: `${out}${name}.png`, fullPage: full });
// Element screenshot without the toast or the fixed nav bar on top of it.
const elShot = async (sel, name) => {
  await page.evaluate((s) => { document.getElementById('toast')?.classList.remove('show'); document.querySelector(s)?.scrollIntoView({ block: 'center' }); }, sel);
  await page.waitForTimeout(250);
  await page.locator(sel).screenshot({ path: `${out}${name}.png` });
};
const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__dreamEngine.state)));
const toastText = async () => (await page.locator('#toast').textContent().catch(() => '')) || '';
const pick = (name, value) => page.click(`label:has(input[name="${name}"][value="${value}"])`);
const setRange = (sel, v) => page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const download = async (act, file) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-act=${act}]`)]);
  await dl.saveAs(out + file);
  return readFile(out + file, 'utf8');
};
// Answers the memory test: the first `nRight` items correctly, the rest wrong.
async function takeTest(nRight, shotName) {
  await page.locator('.memtest').waitFor();
  const total = await page.evaluate(() => window.__dreamEngine.ui.test.items.length);
  for (let i = 0; i < total; i++) {
    if (i === 0 && shotName) await shot(shotName);
    const { answer, options } = await page.evaluate(() => { const T = window.__dreamEngine.ui.test; return T.items[T.i]; });
    const choice = i < nRight ? answer : options.find((o) => o !== answer);
    await page.click(`[data-act=answer][data-word="${choice}"]`);
  }
  return total;
}
// Binding step: wait for the ratings, answer them, save. values = { feel, vivid } or { calm }.
async function bindAndSave(values, { shotListen, shotRate, expectText } = {}) {
  await page.locator('#bind').waitFor({ timeout: 30000 });
  if (expectText) {
    const txt = await page.locator('#bind-text').textContent();
    check(`binding text: ${expectText}`, txt === expectText, txt);
  }
  if (shotListen && (await page.locator('#bind[data-stage=listen]').count())) await shot(shotListen);
  await page.locator('#bind[data-stage=rate]').waitFor({ timeout: 60000 });
  if (shotRate) await shot(shotRate);
  for (const [k, v] of Object.entries(values)) await setRange(`[data-bind=${k}]`, v);
  await page.click('[data-act=save-binding]');
}

try {
  // 1. charter + consent
  await page.goto(`${BASE}/?speed=60`);
  await page.getByRole('heading', { name: 'Dream charter' }).waitFor();
  check('charter shown on first run', true);
  await shot('01-charter', true);
  await page.click('[data-act=accept-consent]');
  check('consent requires every item', (await toastText()).includes('own yes'));
  for (const box of await page.locator('input[name=consent]').all()) await box.check();
  await page.click('[data-act=accept-consent]');
  await page.getByText('Set up your first study').waitFor();
  check('consent accepted -> home', true);
  await shot('02-home-empty', true);

  // 2. daily check-in
  await page.click('main [data-view=checkin]');
  await page.getByRole('heading', { name: 'Daily check-in' }).waitFor();
  await page.click('[data-act=save-checkin]');
  check('check-in requires the safety questions', (await toastText()).includes('unreality'));
  await page.fill('[name=sleepHours]', '7.5');
  await pick('sleepQuality', '3'); await pick('mood', '1'); await pick('sharpness', '3'); await pick('unreal', '0');
  await shot('02b-checkin', true);
  await page.click('[data-act=save-checkin]');
  await page.getByText('Checked in today.').waitFor();
  const ci = (await state()).checkins[0];
  check('check-in saved', ci?.sleepHours === 7.5 && ci.mood === 1 && ci.unreal === 0 && ci.confusion === false, JSON.stringify(ci));

  // 3. targets via the compiler UI: start line + cue (no emotion clause in the cue)
  const addTarget = async (fields, expectCue, expectStart) => {
    await page.click('#nav [data-view=targets]');
    await page.click('[data-act=new-target]');
    for (const [k, v] of Object.entries(fields)) await page.fill(`[data-draft=${k}]`, v);
    const cue = await page.locator('#pv-cue').textContent();
    const start = await page.locator('#pv-start').textContent();
    check(`compiler preview: ${fields.label}`, cue.includes(expectCue) && start.includes(expectStart), `${start} | ${cue}`);
    if (fields.label === 'purple forest') await shot('03-target-edit', true);
    await page.click('[data-act=save-target]');
    await page.getByRole('heading', { name: 'Targets' }).waitFor();
  };
  await addTarget({ label: 'purple forest', environment: 'a purple forest', emotion: 'awe', related: 'violet, trees, woods, moss' }, 'Remember to think of a purple forest.', 'Think of a purple forest.');
  await addTarget({ label: 'ocean of light', environment: 'an ocean of light', sensation: 'floating', emotion: 'peace', related: 'water, waves, glowing' }, 'Remember to think of an ocean of light.', 'Think of an ocean of light.');
  const tg = (await state()).targets;
  check('two targets saved with start phrases', tg.length === 2 && tg[0].startPhrase === 'Think of a purple forest.' && tg[0].cuePhrase === 'Remember to think of a purple forest.');
  await shot('04-targets', true);

  // 4. study (protocol locked from Settings: Horowitz 2023 + binding + emotion scores)
  await page.click('#nav [data-view=home]');
  await page.click('main [data-view=study]');
  check('create-study shows the protocol it will lock', (await page.locator('#protocol-note').textContent()).includes('Horowitz 2023 script, pre-sleep binding step, idea and emotion scores'));
  check('create-study enabled for distinct targets', await page.locator('[data-act=create-study]').isEnabled());
  await page.click('[data-act=create-study]');
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  const st1 = await state();
  check('study locked with 24-nap balanced schedule', st1.studies[0].schedule.length === 24 && ['A', 'B', 'control'].every((c) => st1.studies[0].schedule.filter((x) => x === c).length === 8));
  check('study stores the v0.4 protocol', JSON.stringify(st1.studies[0].protocol) === JSON.stringify({ script: 'h2023', binding: true, emotionScores: true }), JSON.stringify(st1.studies[0].protocol));
  check('home describes the h2023 control condition', (await page.locator('main .pairs').textContent()).includes('observe your thoughts'));
  await shot('06-home-study', true);

  // 4b. own-voice checklist: record one line, own-voice mode, home banner; cap the cue volume
  await page.click('#nav [data-view=settings]');
  const rowsBefore = await page.locator('#voice-checklist .vrow').count();
  const marksBefore = await page.locator('#voice-checklist .vmark.no').count();
  check('own-voice checklist lists every line of the study (5 script + 2 per target), none recorded', rowsBefore === 9 && marksBefore === 9, `${rowsBefore} rows, ${marksBefore} missing`);
  await page.click('[data-line="script:alert"] [data-act=record-voice]');
  await page.locator('[data-line="script:alert"] .btn.recording').waitFor();
  await page.waitForTimeout(1500);
  await page.click('[data-line="script:alert"] [data-act=record-voice]');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Recording saved'));
  await page.locator('[data-line="script:alert"] .vmark.ok').waitFor();
  const stv = await state();
  check('recorded wake prompt is stored as scriptVoiceIds.alert and shows ✓', !!stv.settings.scriptVoiceIds.alert && (await page.locator('#voice-count').textContent()).includes('1/9'));
  check('recorded line can be played back', await page.locator('[data-line="script:alert"] [data-act=play-voice]').isVisible());
  await pick('set-voiceMode', 'own');
  await setRange('[data-set=cueVolumeMax]', '0.5');
  check('adaptive volume on by default; cap lowers the next volume', (await page.locator('[data-set=adaptiveVolume]').isChecked()) && (await page.locator('#next-volume').textContent()) === '50%', await page.locator('#next-volume').textContent());
  check('script selector says it only affects new studies', (await page.locator('#script-settings').textContent()).includes('Only affects studies you create from now on'));
  await shot('21-settings-voice-checklist', true);
  await page.click('#nav [data-view=home]');
  const vb = await page.locator('#voice-banner').textContent();
  check('home banner lists missing own-voice lines', vb.includes('8 of 9 lines'), vb.trim());
  check('missing recordings no longer block a Horowitz-script session', await page.locator('main [data-view=preflight]').isEnabled());
  await shot('21b-home-voice-banner', true);

  // 5. learn pairs -> immediate test -> binding -> session at 60x (condition A forced; speeded runs only)
  // The untargeted memory test is off by default now; turn it on to keep testing that path.
  await page.click('#nav [data-view=settings]');
  check('untargeted Phase 1 memory test is off by default', !(await page.locator('[data-set=memoryTask]').isChecked()));
  await page.locator('[data-set=memoryTask]').check();
  await page.goto(`${BASE}/?speed=60&cond=A`);
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  await page.click('main [data-view=preflight]');
  await page.getByRole('heading', { name: 'Before you lie down' }).waitFor();
  const pre = await page.locator('main').textContent();
  check('preflight leads with the memory task', (await page.locator('[data-act=begin-session]').textContent()).includes('Learn the word pairs'));
  check('preflight: tap instruction, binding step, state question, cue volume', pre.includes('If a cue wakes you, tap the screen once.') && pre.includes('binding') && pre.includes('awake, halfway or asleep') && /Cue volume\s*50%/.test(pre));
  await shot('07-preflight', true);
  await page.click('[data-act=begin-session]');
  await page.locator('.learn').waitFor();
  await page.waitForTimeout(200);
  await shot('07b-learn');
  const pairs = await page.evaluate(() => window.__dreamEngine.ui.learn.pairs);
  const lex = st1.targets.flatMap((t) => t.lexicon.map((x) => x.word));
  check('16 word pairs, none overlapping target words', pairs.length === 16 && !pairs.some((p) => lex.includes(p.cue) || lex.includes(p.answer)));
  const nImm = await takeTest(12, '07c-memtest');
  await page.getByRole('heading', { name: 'Baseline saved' }).waitFor();
  check('immediate test scored', (await page.locator('main').textContent()).includes(`12/${nImm}`));
  await shot('07d-memready');
  const t0 = Date.now();
  await page.click('[data-act=start-session]');
  // Binding: the session record (allocation) exists before binding starts.
  await page.locator('#bind').waitFor();
  const sb = (await state()).sessions;
  check('session record is created before the binding step', sb.length === 1 && sb[0].status === 'running' && sb[0].stage === 'binding');
  const bo = await overflow();
  check('no horizontal overflow on the binding screen', bo <= 0, `overflow ${bo}px`);
  await page.locator('#bind[data-stage=rate]').waitFor({ timeout: 60000 });
  await page.click('[data-act=save-binding]');
  check('binding save requires both ratings', (await toastText()).includes('both sliders'), await toastText());
  await setRange('[data-bind=feel]', 7);
  await setRange('[data-bind=vivid]', 6);
  check('binding sliders show the chosen values', (await page.locator('#bv-feel').textContent()) === '7' && (await page.locator('#bv-vivid').textContent()) === '6');
  await shot('22b-binding-rate', true);
  await page.click('[data-act=save-binding]');
  await page.locator('#night').waitFor();
  check('night screen shows the tap instruction while settling', await page.locator('#n-hint').isVisible());
  // Feed steady phone readings so motion is "available", then a kick during the onset wait.
  await page.evaluate(() => {
    const fire = (x) => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x, y: 0.2, z: 9.8 } }));
    window.__motionFeed = setInterval(() => fire(0), 100);
    window.__kick = () => fire(5);
  });
  await page.waitForTimeout(800);
  await shot('08-night-settle');
  check('no toasts on the black sleep screen', await page.evaluate(() => { const t = document.getElementById('toast'); return !t || getComputedStyle(t).display === 'none'; }));
  await page.waitForFunction(() => document.getElementById('n-phase')?.textContent === 'Falling asleep', null, { timeout: 60000 });
  await page.evaluate(() => window.__kick());
  await page.waitForFunction(() => document.getElementById('n-phase')?.textContent === 'Hypnagogia', null, { timeout: 120000 });
  await page.locator('#night').click({ position: { x: 40, y: 140 } });
  await page.locator('#n-ack.show').waitFor({ timeout: 3000 });
  check('tap on the black screen is acknowledged, dimly', (await page.locator('#n-ack').textContent()) === 'tap noted' && await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)'));
  await shot('22c-night-tap');
  await page.locator('#n-rec:not([hidden])').waitFor({ timeout: 120000 });
  await shot('08b-night-recording');
  await page.getByRole('heading', { name: 'Nap report' }).waitFor({ timeout: 300000 });
  await page.evaluate(() => clearInterval(window.__motionFeed));
  const sessSec = Math.round((Date.now() - t0) / 1000);
  let s = (await state()).sessions[0];
  check('session ran to completion', s.status === 'complete', `${sessSec}s wall-clock at 60x, arm=${s.params.armId}, onset=${s.params.onsetMin}min, condition=${s.condition}`);
  const ev = s.events.map((e) => e.type);
  check('published protocol by default: 5 cues, no pre-sleep cue, no motif', ev.filter((x) => x === 'cue').length === 5 && s.events.filter((e) => e.type === 'cue').every((e) => e.motif === false) && s.params.preSleepCue === false, ev.join(','));
  check('cue order matches Dormio', JSON.stringify(s.events.filter((e) => e.type === 'cue').map((e) => e.phase)) === JSON.stringify(['hypnagogia', 'return', 'hypnagogia', 'return', 'hypnagogia']));
  const cue0 = s.events.find((e) => e.type === 'cue');
  check('each cue logged as a full stimulus record at the session volume', cue0.text === 'Remember to think of a purple forest.' && cue0.voice === 'tts' && cue0.volume === 0.5 && 'played' in cue0, JSON.stringify(cue0));
  check('every cue logs the capped adaptive volume', s.events.filter((e) => e.type === 'cue').every((e) => e.volume === 0.5));
  const says = s.events.filter((e) => e.type === 'say');
  check('h2023 lines: start, stateAsk x3, back x2, in order', JSON.stringify(says.map((e) => e.line)) === JSON.stringify(['start', 'stateAsk', 'back', 'stateAsk', 'back', 'stateAsk']) && says[0].text === 'Think of a purple forest.' && says[1].text === SCRIPT_H2023.stateAsk && says[2].text === SCRIPT_H2023.back, says.map((e) => `${e.line}:${e.voice}`).join(','));
  const wakes = s.events.filter((e) => e.type === 'wake');
  check('wake prompt plays the recorded line (own), other lines fall back to TTS', wakes.length === 3 && wakes.every((e) => e.text === SCRIPT_H2023.alert && e.voice === 'own') && says.every((e) => e.voice === 'tts'), wakes.map((e) => `${e.voice}/${e.played}`).join(','));
  check('session snapshots protocol and audio', JSON.stringify(s.params.protocol) === JSON.stringify({ script: 'h2023', binding: true, emotionScores: true }) && s.params.audio?.cueVolume === 0.5 && s.params.audio.adaptiveVolume === true && s.params.audio.motif === false && s.params.adaptive === true);
  check('binding saved on the session', s.binding?.feel === 7 && s.binding.vivid === 6 && JSON.stringify(s.binding.plays.map((x) => x.line)) === JSON.stringify(['start', 'cue', 'cue']) && s.binding.plays[0].text === 'Think of a purple forest.' && s.binding.sec > 0 && !('stage' in s), JSON.stringify({ ...s.binding, plays: s.binding?.plays?.length }));
  const taps = s.events.filter((e) => e.type === 'tap');
  check('one tap event logged, during hypnagogia', taps.length === 1 && taps[0].phase === 'hypnagogia', JSON.stringify(taps));
  const mot = s.events.filter((e) => e.type === 'motion');
  check('injected motion logged once, during the onset wait; no motion-unavailable', mot.length === 1 && mot[0].phase === 'onset' && mot[0].mag > 1.5 && !ev.includes('motion-unavailable'), JSON.stringify(mot));
  check('memory baseline attached to the session', s.memory?.immediate?.correct === 12 && s.memory.pairs.length === 16);
  const rep = s.events.filter((e) => e.type === 'record-stop' && e.phase === 'report').map((e) => e.bytes);
  const stt = s.events.filter((e) => e.type === 'record-stop' && e.phase === 'state').map((e) => e.bytes);
  check('fake-mic reports and state answers recorded (bytes > 0)', rep.length === 3 && rep.every((b) => b > 0) && stt.length === 3 && stt.every((b) => b > 0), `${rep.join(',')} | ${stt.join(',')}`);
  check('state answer stored on the same round', s.rounds.length === 3 && s.rounds.every((r) => r.audioId && r.stateAudioId && r.stateAudioId !== r.audioId));
  await page.waitForFunction(() => [...document.querySelectorAll('audio[data-blob]')].every((a) => a.src.startsWith('blob:')));
  check('report shows 3 report + 3 state recordings', (await page.locator('audio[data-blob]').count()) === 6);

  // 6. report form (cueWoke per round) -> delayed memory test
  check('report asks "did the cue wake you?" for each round', (await page.getByText('Did the cue before this wake-up wake you?').count()) === 3);
  check('state label reads "Halfway (drifting)"', (await page.getByText('Halfway (drifting)').count()) === 3);
  await page.fill('[name=t-1]', 'colours, a corridor');
  await page.fill('[name=t-2]', 'something about trees');
  await page.fill('[name=t-3]', 'warm water');
  await pick('st-1', 'awake'); await pick('st-2', 'drifting'); await pick('st-3', 'asleep');
  await pick('cw-1', 'yes'); await pick('cw-2', 'no'); await pick('cw-3', 'unsure');
  await page.fill('[name=report]', 'Short nap, fragments only.');
  await pick('vividness', '2'); await pick('valence', '1'); await pick('intensity', '2'); await pick('immersion', '3'); await pick('bizarreness', '1'); await pick('lucidity', '0');
  await page.click('[data-act=save-report]');
  check('report requires the disruption rating (safety input)', (await toastText()).includes('disrupted'));
  await pick('disruption', '1');
  await shot('09-report', true);
  await page.locator('article.card', { hasText: 'Wake-up 1' }).evaluate((el) => el.setAttribute('id', 'qa-round1'));
  await elShot('#qa-round1', '22d-report-cuewoke');
  await page.click('[data-act=save-report]');
  await takeTest(14);
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  s = (await state()).sessions[0];
  check('post-nap memory test saved', s.memory.delayed?.correct === 14 && (await toastText()).includes('14/16') && (await toastText()).includes('+13 pts'), await toastText());
  check('report saved with experience ratings', s.morning?.immersion === 3 && s.morning.intensity === 2 && s.rounds.map((r) => r.state).join() === 'awake,drifting,asleep');
  check('cueWoke saved per round', s.rounds.map((r) => r.cueWoke).join() === 'yes,no,unsure');
  await page.click('#nav [data-view=score]');
  check('speeded session excluded from blind scoring', await page.getByText('Nothing to score right now.').isVisible());

  // 7. rehearsal (control binding at 1200x, then 2 rounds: 2 reports + 2 state answers)
  await page.click('#nav [data-view=home]');
  await page.click('main [data-act=rehearse]');
  await bindAndSave({ calm: 8 }, { expectText: 'Observe your thoughts.' });
  await page.getByRole('heading', { name: 'Rehearsal finished' }).waitFor({ timeout: 180000 });
  check('rehearsal returns 4 mic-check clips (2 reports, 2 state answers)', (await page.locator('audio[src^="blob:"]').count()) === 4 && (await page.getByText('Answer to “were you asleep?”').count()) === 2);
  check('rehearsal not saved as a session', (await state()).sessions.length === 1);

  // 8. binding abort, close during binding, close mid-nap: all kept as aborted
  await page.click('#nav [data-view=settings]');
  check('experimental additions are off by default', !(await page.locator('[data-set=cueMotif]').isChecked()) && !(await page.locator('[data-set=preSleepCue]').isChecked()));
  await shot('14-settings', true);
  await page.locator('[data-set=memoryTask]').uncheck();
  await page.click('#nav [data-view=home]');
  await page.click('main [data-view=preflight]');
  check('memory task can be turned off', (await page.locator('[data-act=begin-session]').textContent()).trim() === 'Start session');
  await page.click('[data-act=begin-session]');
  await page.locator('#bind[data-stage=listen]').waitFor();
  check('binding text for target A', (await page.locator('#bind-text').textContent()) === 'Picture a purple forest. Let yourself feel awe.');
  await shot('22-binding-listen');
  await page.click('#bind-end');
  check('ending the binding step needs a second tap', (await page.locator('#bind-end').textContent()) === 'Tap again to end');
  await page.click('#bind-end');
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  let ab = (await state()).sessions[1];
  check('ending during binding -> aborted at binding, allocation record kept', ab?.status === 'aborted' && ab.abortedAt === 'binding' && !ab.binding && ab.events.some((e) => e.type === 'abort' && e.phase === 'binding') && !('stage' in ab), JSON.stringify({ status: ab?.status, abortedAt: ab?.abortedAt }));
  check('binding abort reported to you', (await toastText()).includes('ended before the nap'));
  await page.click('main [data-view=preflight]');
  await page.click('[data-act=begin-session]');
  await page.locator('#bind').waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  ab = (await state()).sessions[2];
  check('closing the app during binding -> aborted at binding', ab?.status === 'aborted' && ab.abortedAt === 'binding' && ab.events.some((e) => e.type === 'interrupted'));
  await page.click('main [data-view=preflight]');
  await page.click('[data-act=begin-session]');
  await bindAndSave({ feel: 3, vivid: 4 });
  await page.locator('#night').waitFor();
  await page.waitForTimeout(2500);
  await page.reload();
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  ab = (await state()).sessions[3];
  check('closing mid-session -> marked aborted, kept', ab?.status === 'aborted' && ab.events.some((e) => e.type === 'interrupted') && ab.memory === null && ab.binding?.feel === 3 && ab.abortedAt === undefined);

  // 9. import a realistic backup
  await page.click('#nav [data-view=settings]');
  await page.setInputFiles('[data-file=import-data]', out + 'fixture-backup.json');
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  check('backup import replaces state', (await state()).sessions.length === 12);

  // 10. blind scoring: idea and emotion per target
  await page.click('#nav [data-view=score]');
  check('blind queue holds the 3 unscored naps', await page.getByText('3 left').isVisible());
  check('scoring card hides date and condition', !/2026|control|Condition/i.test(await page.locator('article.card').first().textContent()));
  check('emotion scales labelled with each target’s feeling', (await page.getByText('Feeling: awe').count()) === 1 && (await page.getByText('Feeling: peace').count()) === 1 && (await page.locator('[data-scale=emoA] input').count()) === 4);
  await page.click('[data-act=save-score]');
  check('save requires both scores', (await toastText()).includes('Score both'));
  await pick('score-A', '2'); await pick('score-B', '0');
  await page.click('[data-act=save-score]');
  check('save requires the emotion scores too', (await toastText()).includes('the feeling'), await toastText());
  await pick('score-emoA', '3'); await pick('score-emoB', '0');
  await shot('23-score-emotion', true);
  await page.click('[data-act=save-score]');
  await page.getByText('2 left').waitFor();
  const sc = (await state()).sessions.find((x) => x.blind?.emoA === 3);
  check('score saved with idea and emotion, queue advanced', sc && sc.blind.A === 2 && sc.blind.B === 0 && sc.blind.emoB === 0 && sc.blind.rater === 'self', JSON.stringify(sc?.blind));

  // 11. independent-rater packet round trip (idea + emotion columns)
  const packet = await download('export-packet', 'packet.csv');
  const rows = parseCSV(packet);
  check('packet: 12 report rows, no dates/conditions/ids', rows.length === 13 && !/2026-|control|s_fix/.test(packet), `${rows.length - 1} rows`);
  check('packet columns: idea and emotion per target', rows[0].join() === 'code,target_A,target_B,emotion_A_target,emotion_B_target,report,idea_A,idea_B,emotion_A,emotion_B' && rows[1][3] === 'awe' && rows[1][4] === 'peace', rows[0].join());
  // A rater who scores by content: forest -> A, glowing water -> B.
  // The first row leaves emotion_B blank (stored as null).
  rows.slice(1).forEach((r, k) => {
    const a = /violet|moss/.test(r[5]), b = /glowing|floating/.test(r[5]);
    r[6] = a ? '2' : '0'; r[7] = b ? '2' : '0'; r[8] = a ? '2' : '0'; r[9] = k === 0 ? '' : b ? '1' : '0';
  });
  rows.push(['BOGUS1', '', '', '', '', '', '2', '2', '', '']);
  await writeFile(out + 'packet-scored.csv', toCSV(rows));
  await page.setInputFiles('[data-file=import-scores]', out + 'packet-scored.csv');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Imported'));
  check('rater import applies scores and reports bad rows', (await toastText()).includes('Imported 12 scores') && (await toastText()).includes('1 row skipped'), await toastText());
  const imp = (await state()).sessions.filter((x) => x.blind?.rater === 'external');
  check('imported emotion scores kept, blanks stored as null', imp.length === 12 && imp.some((x) => x.blind.emoB === 1) && imp.some((x) => x.blind.emoB === null) && imp.every((x) => x.blind.emoA === 0 || x.blind.emoA === 2));

  // 12. results, learning data, exports, metrics import
  await page.click('#nav [data-view=results]');
  await page.getByRole('heading', { name: 'Primary: blind scores' }).waitFor();
  check('results render with provisional banner', await page.getByText('Provisional').isVisible());
  const volRows = await page.locator('#cue-volume tbody tr').allTextContents();
  check('cue volume card: table by volume with cues, woke, wake rate, motion', volRows.length === 2 && /^55%18\d+\d+%\d+$/.test(volRows[0].replace(/\s+/g, '')) && /^60%18/.test(volRows[1].replace(/\s+/g, '')), volRows.join(' | '));
  const nextVol = await page.locator('#next-volume').textContent();
  check('cue volume card shows the next (adaptive, capped) volume', /^\d+%$/.test(nextVol) && (await page.locator('#cue-volume').textContent()).includes('adaptive'), nextVol);
  await elShot('#cue-volume', '24-results-cue-volume');
  const emoTxt = (await page.locator('#emotion-block').textContent()).replace(/\s+/g, ' ');
  check('emotion block: effect, p and n from blind emotion scores', /Effect\s*-?\d\.\d\d/.test(emoTxt) && /n = \d+ A, \d+ B/.test(emoTxt), emoTxt.slice(0, 200));
  const linkTxt = (await page.locator('#link-block').textContent()).replace(/\s+/g, ' ');
  const linkCells = await page.locator('#link-block tbody td').allTextContents();
  check('exploratory link block labelled and filled', linkTxt.includes('Exploratory: does the idea come in with the feeling?') && linkCells.length === 6 && [1, 2, 4, 5].every((i) => /^\d+$/.test(linkCells[i].trim())) && /cued naps? with both scores/.test(linkTxt), linkCells.join(' | '));
  await elShot('#emotion-block', '24b-results-emotion');
  await elShot('#link-block', '24c-results-link');
  const learnTxt = await page.locator('section.card', { hasText: 'Learning and experience' }).textContent();
  check('learning summary shows before/after memory', /63% before → 72% after the nap/.test(learnTxt), learnTxt.slice(0, 160));
  const rhoCells = await page.locator('section.card', { hasText: 'Exploratory link' }).locator('tbody tr td:nth-child(3)').allTextContents();
  check('exploratory correlations computed at n=12', rhoCells.filter((x) => /^-?\d\.\d\d$/.test(x.trim())).length >= 4, rhoCells.join(' | '));
  const trials = parseCSV(await download('export-trials', 'trials.csv'));
  const head = trials[0];
  check('trial table: 36 rows, stimulus + outcome + context + arousal columns', trials.length === 37 && ['state_at_wake', 'cues_in_round', 'mem_change', 'immersion', 'sleep_hours_last_night', 'next_day_mood', 'blind_cued', 'lex_cued', 'cue_volume', 'cue_woke', 'cue_tap', 'cue_motion'].every((c) => head.includes(c)), `${trials.length - 1} rows, ${head.length} cols`);
  const col = (name) => trials.slice(1).map((r) => r[head.indexOf(name)]);
  check('trial arousal columns carry values', col('cue_tap').includes('1') && col('cue_tap').includes('0') && col('cue_motion').includes('1') && col('cue_woke').includes('yes') && col('cue_volume').includes('0.55'), `taps ${col('cue_tap').filter((x) => x === '1').length}, motion ${col('cue_motion').filter((x) => x === '1').length}`);
  const sessCsv = parseCSV(await download('export-sessions', 'sessions.csv'));
  check('session table: one row per nap, binding + emotion columns', sessCsv.length === 13 && ['bind_feel', 'bind_vivid', 'bind_calm', 'blind_emo_A', 'script'].every((c) => sessCsv[0].includes(c)) && sessCsv.slice(1).some((r) => r[sessCsv[0].indexOf('bind_calm')] !== ''), sessCsv[0].filter((c) => /bind|emo|script/.test(c)).join(','));
  await writeFile(out + 'metrics.csv', 'date,metric,value\r\n2026-11-02,anki_retention,0.88\r\n2026-11-03,anki_retention,0.93\r\nbad-date,anki_retention,1\r\n');
  await page.setInputFiles('[data-file=import-metrics]', out + 'metrics.csv');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('metric'));
  check('metrics import merges valid rows, reports bad ones', (await toastText()).includes('Imported 2 metric values; 1 skipped'), await toastText());
  const trials2 = parseCSV(await download('export-trials', 'trials2.csv'));
  check('imported metric becomes a joined column', trials2[0].includes('m_anki_retention') && trials2.slice(1).some((r) => r[trials2[0].indexOf('m_anki_retention')] === '0.88'));
  await shot('13-results', true);

  // 13. offline reload via service worker
  await page.goto(`${BASE}/?speed=60`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => {});
  check('service worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
  await ctx.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'Engineer a dream theme' }).waitFor({ timeout: 15000 });
  check('app loads offline from cache with data intact', (await state()).sessions.length === 12);
  await ctx.setOffline(false);

  // 14. layout: no horizontal scroll at phone widths
  for (const w of [360, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    for (const v of ['home', 'targets', 'score', 'results', 'settings']) {
      await page.click(`#nav [data-view=${v}]`);
      const over = await overflow();
      check(`no horizontal overflow ${v} @${w}px`, over <= 0, `overflow ${over}px`);
    }
    await page.click('#nav [data-view=home]');
    await page.click('main [data-view=checkin]');
    const over = await overflow();
    check(`no horizontal overflow checkin @${w}px`, over <= 0, `overflow ${over}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // 14b. a v0.3 backup (schema v3): loads without loss, and its study runs exactly as v0.3
  await page.goto(`${BASE}/?speed=60&cond=A`);
  await page.click('#nav [data-view=settings]');
  await page.setInputFiles('[data-file=import-data]', out + 'fixture-v3.json');
  await page.getByRole('heading', { name: 'Current study' }).waitFor();
  const v3 = await state();
  check('v3 import migrates to v4: study on the v1 protocol, blind scores intact', v3.version === 4 && JSON.stringify(v3.studies[0].protocol) === JSON.stringify({ script: 'v1', binding: false, emotionScores: false }) && v3.sessions.length === 3 && v3.sessions[0].blind.A === 2 && v3.sessions[0].blind.B === 0 && v3.settings.cueVolume === 0.55 && !!v3.settings.scriptVoiceIds, JSON.stringify(v3.studies[0].protocol));
  await page.click('#nav [data-view=score]');
  check('v1 study: idea scales only, no emotion scales', (await page.getByText('1 left').isVisible()) && (await page.locator('[data-scale=emoA]').count()) === 0 && (await page.getByText('Feeling:').count()) === 0);
  await page.click('#nav [data-view=results]');
  await page.getByRole('heading', { name: 'Primary: blind scores' }).waitFor();
  check('v1 study: no emotion/link blocks on results', (await page.locator('#emotion-block').count()) === 0 && (await page.locator('#link-block').count()) === 0);
  await page.click('#nav [data-view=home]');
  check('v1 home keeps the v0.3 control description', (await page.locator('main .pairs').textContent()).includes('neutral cue'));
  await page.click('main [data-view=preflight]');
  const preV3 = await page.locator('main').textContent();
  check('v1 preflight: no binding, no state question, fixed volume, v0.3 script', !preV3.includes('binding') && !preV3.includes('awake, halfway or asleep') && /Cue volume\s*55%\s*fixed/.test(preV3) && preV3.includes('v0.3 script'), preV3.slice(preV3.indexOf('Rounds'), preV3.indexOf('Rounds') + 220));
  check('v1 preflight: no tap instruction', !preV3.includes('tap the screen'));
  await page.click('[data-act=begin-session]');
  await page.locator('#night').waitFor({ timeout: 15000 });
  check('v1 study goes straight to the night screen (no binding)', (await page.locator('#bind').count()) === 0);
  check('v1 night screen: no tap hint', (await page.locator('#n-hint').count()) === 0);
  await page.waitForTimeout(1200);
  await shot('25-v3-night');
  await page.getByRole('heading', { name: 'Nap report' }).waitFor({ timeout: 300000 });
  const s3 = (await state()).sessions.find((x) => x.params?.speed === 60);
  const ev3 = s3.events;
  const cues3 = ev3.filter((e) => e.type === 'cue');
  check('v1 run: 5 cues with the v0.3 cue phrase at the fixed volume', cues3.length === 5 && cues3.every((e) => e.text === V3_CUE && e.volume === 0.55 && e.voice === 'tts'), cues3.map((e) => `${e.phase}:${e.volume}`).join(','));
  check('v1 run: v0.3 wake prompt, no new lines, no state recordings, no binding', ev3.filter((e) => e.type === 'wake').every((e) => e.text === NEUTRAL.wakePhrase) && !ev3.some((e) => e.type === 'say') && ev3.filter((e) => e.type === 'record-stop').length === 3 && ev3.filter((e) => e.type === 'record-stop').every((e) => e.phase === 'report') && s3.rounds.every((r) => !r.stateAudioId) && !s3.binding);
  check('v1 run: params as v0.3 plus the protocol snapshot', JSON.stringify(s3.params.protocol) === JSON.stringify({ script: 'v1', binding: false, emotionScores: false }) && s3.params.script === undefined && s3.params.audio.cueVolume === 0.55 && s3.params.audio.adaptiveVolume === false);
  check('v1 run behaves as v0.3: no motion, motion-unavailable or tap events logged', !ev3.some((e) => ['motion', 'motion-unavailable', 'tap'].includes(e.type)), JSON.stringify(ev3.filter((e) => ['motion', 'motion-unavailable', 'tap'].includes(e.type))));
  check('v1 report: state label relabelled, no cue-wake question', (await page.getByText('Halfway (drifting)').count()) === 3 && (await page.getByText('Did the cue before this wake-up wake you?').count()) === 0);
  await shot('25b-v3-report', true);

  // 15. Phase 2
  await page.goto(`${BASE}/?speed=60`);
  await phaseTwoQA({ page, BASE, out, check, shot, state, toastText, pick, download, takeTest, bindAndSave, overflow });

  // 16. delete everything
  await page.click('#nav [data-view=settings]');
  await page.click('[data-act=delete-all]');
  await page.getByRole('heading', { name: 'Dream charter' }).waitFor();
  check('delete everything wipes state', (await state()).sessions.length === 0);

  const csp = await page.evaluate(() => window.__csp);
  check('no CSP violations (no outbound requests)', csp.length === 0, csp.join(' | '));
} catch (e) {
  check('QA run completed without exceptions', false, e.stack || String(e));
  await shot('zz-failure', true).catch(() => {});
} finally {
  check('no console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await writeFile(out + 'results.json', JSON.stringify({ at: new Date().toISOString(), results, errors }, null, 2));
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
