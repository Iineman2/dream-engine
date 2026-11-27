// Phase 2 part of the browser QA: setup from a finished Phase 1, themed
// learning with cues, a cued nap / stay-awake / plain nap at 60x, retest,
// creative-uses tasks, resume after a reload, creativity rating round trip,
// and the Phase 2 results.
import { writeFile } from 'node:fs/promises';
import { compileTarget } from '../js/core/compiler.js';
import { createStudy, createBenefitStudy, conditionInfo } from '../js/core/study.js';
import { SCRIPT_H2023 } from '../js/core/protocol.js';
import { CONSENT_ITEMS, CONSENT_VERSION } from '../js/core/safety.js';
import { emptyState } from '../js/core/schema.js';
import { parseCSV, toCSV } from '../js/core/scoring.js';

const audioParams = { voiceMode: 'tts', cueVolume: 0.6, wakeVolume: 0.85, ttsRate: 0.85, motif: false };

export function phaseOneComplete() {
  const now = new Date().toISOString();
  const A = { id: 't_fixA', createdAt: now, voiceId: null, ...compileTarget({ label: 'purple forest', environment: 'a purple forest', emotion: 'awe', related: 'violet, trees, woods, moss' }).target };
  const B = { id: 't_fixB', createdAt: now, voiceId: null, ...compileTarget({ label: 'ocean of light', environment: 'an ocean of light', sensation: 'floating', related: 'water, waves, glowing' }).target };
  const study = createStudy({ targetAId: A.id, targetBId: B.id, blocks: 8, seed: 777 });
  const text = { A: 'walking among violet trees', B: 'floating on glowing water', control: 'a bus stop' };
  const sessions = study.schedule.map((condition, i) => {
    const t = new Date(2026, 9, 1 + i, 14, 0).toISOString();
    return {
      id: `s_p1_${i}`, studyId: study.id, index: i, condition, targetId: condition === 'control' ? null : study.targetIds[condition], rehearsal: false,
      params: { rounds: 3, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: false, armId: 'mid', adaptive: true, speed: 1, audio: audioParams },
      status: 'complete', startedAt: t, endedAt: t, events: [],
      rounds: [1, 2, 3].map((round) => ({ round, audioId: null, wokeAt: t, transcript: round === 2 ? text[condition] : 'drifting images', state: 'drifting' })),
      morning: { at: t, report: '', vividness: 2, valence: 1, intensity: 1, immersion: 2, bizarreness: 1, lucidity: 0, disruption: 1, distressing: false },
      blind: { A: condition === 'A' ? 2 : 0, B: condition === 'B' ? 2 : 0, at: t, rater: 'self' },
      memory: null,
    };
  });
  const state = { ...emptyState(), consent: { version: CONSENT_VERSION, at: now, items: Object.fromEntries(CONSENT_ITEMS.map((c) => [c.key, true])) }, targets: [A, B], studies: [study], sessions, checkins: [], activeStudyId: study.id };
  return { app: 'dream-engine', exportedAt: now, state };
}

// 30 finished Phase 2 sessions with a planted dream effect on creativity and
// memory, two reports unscored and two sessions' creative-uses lists unrated.
export function phaseTwoComplete() {
  const base = phaseOneComplete();
  const st = base.state;
  const p1 = { ...st.studies[0], status: 'closed' };
  const b = createBenefitStudy({ parent: p1, objects: { A: ['tree', 'moss', 'owl'], B: ['wave', 'shell', 'pearl'] }, blocks: 6, seed: 4242 });
  const uses = (k) => Array.from({ length: k }, (_, j) => `use number ${j + 1}`).join('\n');
  const sessions = b.schedule.map((condition, i) => {
    const info = conditionInfo(condition);
    const t = new Date(2026, 10, 1 + i, 13, 0).toISOString();
    const v = { A: 2 + (i % 2), B: 2 + ((i + 1) % 2) };
    if (info.cued && info.state === 'sleep') v[info.cued] = Math.min(5, v[info.cued] + 2);
    return {
      id: `s_p2_${i}`, studyId: b.id, index: i, condition, targetId: info.cued ? b.targetIds[info.cued] : null, rehearsal: false,
      params: { rounds: info.plain ? 1 : 3, hypnaMin: 2, betweenMin: 5, onsetMin: 10, recordSec: 60, lieDownSec: 60, preSleepCue: false, armId: 'mid', adaptive: true, speed: 1, audio: audioParams },
      status: 'complete', startedAt: t, endedAt: t, events: [],
      rounds: (info.plain ? [1] : [1, 2, 3]).map((round) => ({ round, audioId: null, wokeAt: t, transcript: info.cued ? (info.cued === 'A' ? 'violet trees' : 'glowing water') : 'a corridor', state: info.state === 'wake' ? 'awake' : 'drifting' })),
      morning: { at: t, report: '', vividness: 2, valence: 1, intensity: 1, immersion: 2, bizarreness: 1, lucidity: 0, disruption: info.state === 'wake' ? null : 1, distressing: false },
      blind: i < 2 ? null : info.cued ? { [info.cued]: info.state === 'sleep' ? 2 : 1, [info.cued === 'A' ? 'B' : 'A']: 0, at: t, rater: 'self' } : { A: 0, B: 0, at: t, rater: 'self' },
      themed: { seed: i, autOrder: ['A', 'B'], immediate: { at: t, byTheme: { A: { correct: 5, n: 10 }, B: { correct: 5, n: 10 } } }, delayed: { at: t, byTheme: { A: { correct: 4 + v.A, n: 10 }, B: { correct: 4 + v.B, n: 10 } } } },
      aut: { A: { object: b.objects.A[i % 3], text: uses(v.A + 1), at: t }, B: { object: b.objects.B[i % 3], text: uses(v.B + 1), at: t } },
      autBlind: i < 2 ? null : { A: v.A, B: v.B, rater: 'self', at: t },
    };
  });
  return { ...base, state: { ...st, studies: [p1, b], sessions: st.sessions.concat(sessions), activeStudyId: b.id } };
}

export async function phaseTwoQA({ page, BASE, out, check, shot, state, toastText, pick, download, takeTest, bindAndSave }) {
  await writeFile(out + 'fixture-phase1-complete.json', JSON.stringify(phaseOneComplete()));
  await writeFile(out + 'fixture-phase2.json', JSON.stringify(phaseTwoComplete()));
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const widths = async (label) => {
    for (const w of [360, 390]) {
      await page.setViewportSize({ width: w, height: 800 });
      const o = await overflow();
      check(`no horizontal overflow ${label} @${w}px`, o <= 0, `overflow ${o}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  };

  // ---------- setup from a finished Phase 1 ----------
  await page.click('#nav [data-view=settings]');
  await page.setInputFiles('[data-file=import-data]', out + 'fixture-phase1-complete.json');
  await page.getByText('Set up Phase 2').waitFor();
  check('finished Phase 1 offers Phase 2', true);
  await shot('15-home-phase1-done', true);
  await page.click('[data-act=nav][data-view=benefitSetup]');
  await page.getByRole('heading', { name: 'Set up Phase 2' }).waitFor();
  check('setup shows the Phase 1 result as supportive', await page.getByText('Your dreams followed the cue').isVisible());
  await widths('benefitSetup');
  await shot('15b-benefit-setup', true);
  await page.click('[data-act=create-benefit]');
  check('setup requires objects for both themes', (await toastText()).includes('at least 3'), await toastText());
  await page.fill('[data-draft=objA]', 'tree, moss, owl, mushroom');
  await page.fill('[data-draft=objB]', 'wave, shell, pearl, Tree');
  await page.click('[data-act=create-benefit]');
  check('an object can belong to one theme only', (await toastText()).includes('one theme only'), await toastText());
  await page.fill('[data-draft=objB]', 'wave, shell, pearl, lighthouse');
  await page.click('[data-act=create-benefit]');
  await page.getByRole('heading', { name: 'Phase 2 study' }).waitFor();
  const st2 = await state();
  const b = st2.studies.find((x) => x.kind === 'benefit');
  const counts = Object.fromEntries(['SA', 'SB', 'WA', 'WB', 'plain'].map((c) => [c, b?.schedule.filter((x) => x === c).length]));
  check('Phase 2 locked: 30 sessions, 6 of each kind, creativity primary, Phase 1 closed', b?.schedule.length === 30 && Object.values(counts).every((v) => v === 6) && b.primary === 'creativity' && st2.studies[0].status === 'closed' && st2.activeStudyId === b.id, JSON.stringify(counts));
  check('Phase 2 takes the new-study protocol from Settings', JSON.stringify(b?.protocol) === JSON.stringify({ script: 'h2023', binding: true, emotionScores: true }), JSON.stringify(b?.protocol));
  check('objects saved per theme', JSON.stringify(b.objects) === JSON.stringify({ A: ['tree', 'moss', 'owl', 'mushroom'], B: ['wave', 'shell', 'pearl', 'lighthouse'] }));
  await shot('15c-home-phase2', true);
  const A = st2.targets.find((t) => t.id === b.targetIds.A);

  // ---------- one live session per kind at 60x ----------
  async function session(cond, { reloadAtAut = false } = {}) {
    await page.goto(`${BASE}/?speed=60&cond=${cond}`);
    await page.getByRole('heading', { name: 'Phase 2 study' }).waitFor();
    await page.click('main [data-view=preflight]');
    check(`[${cond}] preflight starts with learning both sets`, (await page.locator('[data-act=begin-session]').textContent()).includes('Learn both sets'));
    await page.click('[data-act=begin-session]');
    await page.locator('.learn').waitFor();
    await page.waitForFunction(() => document.querySelector('#pair-cue')?.textContent, null, { timeout: 60000 });
    if (cond === 'SA') {
      const head = await page.locator('#learn-head').textContent();
      await shot('16-learn-themed');
      check('learning shows which theme a set belongs to', /purple forest|ocean of light/.test(head), head);
    }
    const L = await page.evaluate(() => window.__dreamEngine.ui.learn);
    check(`[${cond}] two disjoint sets of 10 pairs`, L.sets.A.length === 10 && L.sets.B.length === 10 && new Set([...L.sets.A, ...L.sets.B].flatMap((p) => [p.cue, p.answer])).size === 40);
    await page.locator('.memtest').waitFor({ timeout: 90000 });
    if (cond === 'SA') await shot('16b-memtest-themed');
    await takeTest(14);
    await page.getByRole('heading', { name: 'Baseline saved' }).waitFor();
    const pm = await page.evaluate(() => window.__dreamEngine.ui.pendingMemory);
    check(`[${cond}] baseline scored per theme; both cues played during learning`, pm.immediate.byTheme.A.n === 10 && pm.immediate.byTheme.B.n === 10 && pm.immediate.byTheme.A.correct + pm.immediate.byTheme.B.correct === 14 && !!pm.conditioning.A?.at && !!pm.conditioning.B?.at, JSON.stringify(pm.conditioning));
    if (cond === 'SA') await shot('16c-memready-themed');
    await page.click('[data-act=start-session]');
    // Binding precedes every incubation session (asleep and awake), never a plain nap.
    if (cond === 'plain') {
      await page.locator('#night').waitFor();
      check('plain nap skips the binding step', (await page.locator('#bind').count()) === 0);
    } else {
      await bindAndSave({ feel: 5, vivid: 8 }, { expectText: 'Picture a purple forest. Let yourself feel awe.', shotListen: cond === 'WA' ? '26-binding-awake' : null });
      await page.locator('#night').waitFor();
    }
    const hint = await page.locator('#n-hint').count();
    check(`[${cond}] tap hint ${cond === 'SA' ? 'shown' : 'not shown'} on the night screen`, hint === (cond === 'SA' ? 1 : 0), `${hint}`);
    if (cond === 'WA') {
      const vis = await page.locator('#n-vis').textContent();
      check('stay-awake session says so on screen', vis.includes('Stay-awake session'), vis);
      await page.waitForFunction(() => document.getElementById('n-phase')?.textContent === 'Stay awake, eyes closed', null, { timeout: 120000 });
      await shot('17-night-awake');
      check('stay-awake phase text replaces sleep wording', true);
    }
    if (cond === 'plain') check('plain nap says so on screen', (await page.locator('#n-vis').textContent()).includes('Ordinary nap'));
    await page.getByRole('heading', { name: /report/ }).waitFor({ timeout: 400000 });
    let ss = (await state()).sessions;
    let s = ss[ss.length - 1];
    const cues = s.events.filter((e) => e.type === 'cue');
    const wakes = s.events.filter((e) => e.type === 'wake').length;
    if (cond === 'plain') check('plain nap: no cues, one wake-up at the end, length matched', cues.length === 0 && wakes === 1 && s.params.plainSleepSec > 0 && s.params.rounds === 1, `sleep ${s.params.plainSleepSec}s`);
    else check(`[${cond}] 5 cues of theme A’s phrase, 3 wake-ups`, cues.length === 5 && cues.every((c) => c.text === A.cuePhrase) && wakes === 3, cues.map((c) => c.text).join(' | '));
    check(`[${cond}] session stored with its condition and themed baseline`, s.condition === cond && !!s.themed?.immediate && s.status === 'complete' && s.params.speed === 60);
    const wakeTexts = s.events.filter((e) => e.type === 'wake').map((e) => e.text);
    const sayLines = s.events.filter((e) => e.type === 'say').map((e) => e.line);
    if (cond === 'SA') check('[SA] asleep: h2023 wake prompt, state question each round, start + back lines', wakeTexts.every((x) => x === SCRIPT_H2023.alert) && sayLines.filter((x) => x === 'stateAsk').length === 3 && sayLines.filter((x) => x === 'back').length === 2 && sayLines[0] === 'start' && s.rounds.every((r) => r.stateAudioId), sayLines.join(','));
    if (cond === 'WA') check('[WA] awake: awake wake prompt, no state question, no back line', wakeTexts.every((x) => x === SCRIPT_H2023.alertWake) && JSON.stringify(sayLines) === JSON.stringify(['start']) && s.rounds.every((r) => !r.stateAudioId), sayLines.join(','));
    if (cond === 'plain') check('[plain] one h2023 wake prompt, no other lines', wakeTexts.length === 1 && wakeTexts[0] === SCRIPT_H2023.alert && sayLines.length === 0);
    check(`[${cond}] binding ${cond === 'plain' ? 'absent' : 'saved (feel 5, vivid 8)'}`, cond === 'plain' ? !s.binding : s.binding?.feel === 5 && s.binding.vivid === 8 && s.binding.plays.length === 3);
    const cw = await page.getByText('Did the cue before this wake-up wake you?').count();
    check(`[${cond}] "did the cue wake you?" ${cond === 'SA' ? 'asked each round' : 'not asked'}`, cw === (cond === 'SA' ? 3 : 0), `${cw}`);
    for (const r of s.rounds) {
      await page.fill(`[name=t-${r.round}]`, cond === 'WA' ? 'thinking about the forest' : 'violet trees');
      await pick(`st-${r.round}`, cond === 'WA' ? 'awake' : 'drifting');
      if (cond === 'SA') await pick(`cw-${r.round}`, 'no');
    }
    await pick('vividness', '2');
    const hasDisruption = (await page.locator('input[name=disruption]').count()) > 0;
    check(`[${cond}] disruption question ${cond === 'WA' ? 'hidden' : 'shown'}`, hasDisruption === (cond !== 'WA'));
    if (hasDisruption) await pick('disruption', '1');
    if (cond === 'WA') {
      check('stay-awake report is titled as a session', await page.getByRole('heading', { name: 'Session report' }).isVisible());
      await shot('17b-report-awake', true);
    }
    await page.click('[data-act=save-report]');
    await takeTest(16);
    await page.locator('.aut').waitFor();
    const first = await page.evaluate(() => window.__dreamEngine.ui.aut);
    check(`[${cond}] first creative-uses task uses the session’s object`, b.objects[first.theme][0] === first.object, `${first.theme}: ${first.object}`);
    if (cond === 'SA') await widths('aut');
    if (reloadAtAut) {
      await page.reload();
      await page.getByText('still needs its after-session tests').waitFor();
      check('closing the app mid-tasks leaves a resume banner', true);
      await shot('18-resume-banner', true);
      await page.click('[data-act=resume-post]');
      await page.locator('.aut').waitFor();
    }
    await page.fill('#aut-text', 'a ladder for squirrels\na drum\n- a bookshelf');
    if (cond === 'SA') await shot('16d-aut', true);
    await page.click('[data-act=aut-done]');
    // The second task saves itself when its time runs out (3 s at 60x).
    await page.getByRole('heading', { name: 'Phase 2 study' }).waitFor({ timeout: 30000 });
    ss = (await state()).sessions;
    s = ss[ss.length - 1];
    const second = first.theme === 'A' ? 'B' : 'A';
    check(`[${cond}] retest, both creative-uses tasks saved, nothing pending`, s.themed.delayed?.byTheme?.A?.n === 10 && s.aut?.[first.theme]?.fluency === 3 && s.aut?.[second]?.timedOut === true && !(await page.getByText('still needs its after-session tests').count()), JSON.stringify(s.aut));
    return s;
  }
  await session('SA');
  await session('WA');
  await session('plain', { reloadAtAut: true });
  check('speeded Phase 2 sessions never consume the locked sequence', (await page.locator('main').textContent()).includes('0/30 sessions'));

  // ---------- a finished Phase 2: blind ratings and results ----------
  await page.goto(`${BASE}/?speed=60`);
  await page.click('#nav [data-view=settings]');
  await page.setInputFiles('[data-file=import-data]', out + 'fixture-phase2.json');
  await page.getByRole('heading', { name: 'Phase 2 study' }).waitFor();
  check('home flags unrated creative-uses lists', await page.getByText('creative-uses lists waiting for a blind rating').isVisible());
  await page.click('#nav [data-view=score]');
  const incorp = await page.locator('main article.card').first().textContent();
  check('incorporation queue spans phases (2 unscored)', incorp.includes('2 left'), incorp.slice(0, 80));
  const crea = page.locator('section.card', { hasText: 'Creativity ratings' });
  check('creativity queue holds the 4 unrated lists', (await crea.textContent()).includes('4 left'));
  check('creativity card hides date, condition and phase', !/2026|nap|awake|plain|Phase/i.test(await crea.locator('article').textContent()));
  await page.click('[data-act=save-creativity]');
  check('creativity save requires a rating', (await toastText()).includes('1 to 5'));
  await pick('aut-rating', '4');
  await shot('19-score-creativity', true);
  await page.click('[data-act=save-creativity]');
  await crea.getByText('3 left').waitFor();
  check('creativity rating saved, queue advanced', true);
  const cp = parseCSV(await download('export-creativity', 'creativity-packet.csv'));
  // Codes are random base-36, so only the non-code fields are checked for condition names.
  const leaks = cp.slice(1).filter((r) => /\b(SA|SB|WA|WB|plain|awake|nap)\b|2026-|s_p\d/.test(r.slice(1).join(' ')) || /2026-|s_p\d/.test(r[0]));
  check('creativity packet: 60 lists, only code/object/uses/rating, no dates/conditions/ids', cp.length === 61 && cp[0].join() === 'code,object,uses,rating_1_to_5' && cp.every((r) => r.length === 4) && leaks.length === 0, `${cp.length - 1} rows, ${leaks.length} leaks`);
  for (const r of cp.slice(1)) r[3] = '3';
  cp.push(['BADCODE', 'x', 'y', '3']);
  await writeFile(out + 'creativity-scored.csv', toCSV(cp));
  await page.setInputFiles('[data-file=import-creativity]', out + 'creativity-scored.csv');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('rating'));
  check('creativity import applies ratings and reports bad rows', (await toastText()).includes('Imported 60 ratings') && (await toastText()).includes('1 row skipped'), await toastText());

  // Reload the fixture so the results reflect its planted effect.
  await page.click('#nav [data-view=settings]');
  await page.setInputFiles('[data-file=import-data]', out + 'fixture-phase2.json');
  await page.getByRole('heading', { name: 'Phase 2 study' }).waitFor();
  await page.click('#nav [data-view=results]');
  await page.getByRole('heading', { name: 'Does engineered dreaming help?' }).waitFor();
  const prim = (await page.locator('article.card', { hasText: 'Primary: Creativity' }).textContent()).replace(/\s+/g, ' ');
  check('Phase 2 results: both pre-registered questions, effects positive, Holm-corrected', /Beyond normal sleep\?\s*\+\d/.test(prim) && /Is it the dreaming\?\s*\+\d/.test(prim) && (prim.match(/Holm/g) || []).length >= 2, prim.slice(0, 240));
  check('Phase 2 results show manipulation checks', await page.getByText('Did the cue reach the dream?').isVisible());
  check('Phase 1 results still shown below', await page.getByRole('heading', { name: 'Does the cue steer my dreams?' }).isVisible());
  await shot('20-results-phase2', true);
  for (const v of ['results', 'score', 'home']) {
    await page.click(`#nav [data-view=${v}]`);
    await widths(`Phase 2 ${v}`);
  }
  await page.click('#nav [data-view=results]');
  const sess2 = parseCSV(await download('export-sessions', 'sessions-phase2.csv'));
  const h2 = sess2[0];
  check('session table has Phase 2 outcome columns', ['phase', 'state', 'cued_theme', 'mem_cued_retention', 'aut_cued_rating', 'aut_uncued_fluency', 'blind_uncued'].every((c) => h2.includes(c)) && sess2.length === 55, `${sess2.length - 1} rows`);
}
