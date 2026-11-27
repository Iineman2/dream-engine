# Dream Engine v0.4 — build spec (items 1–4)

Diff base: the v0.3 release. Baseline: `npm test` → 48/48 pass.
No real study data exists yet (never run on the phone), but migration must still load v3 state/exports without loss.

Evidence base for item 1: the supplementary information of Horowitz et al. 2023, Sci Rep (Supplementary 1.1–1.2), [doi:10.1038/s41598-023-31361-w](https://doi.org/10.1038/s41598-023-31361-w). The supplement is not redistributed here; see the paper.

## Versioning rule (applies to everything)
- A study's protocol is fixed when the study is created: `study.protocol = { script: 'h2023' | 'v1', binding: boolean, emotionScores: boolean }`.
- Studies without `protocol` (created before v0.4) migrate to `{ script: 'v1', binding: false, emotionScores: false }` and must behave **exactly as v0.3**.
- New studies take `{ script: settings.scriptVersion, binding: settings.bindingStep, emotionScores: true }`.
- Every session snapshots `params.protocol` (copy of study.protocol) and `params.audio.cueVolume` (the volume actually used).
- Schema version 3 → 4 (`js/core/schema.js`), with migration + `validateImport` accepting v3 and v4.

## Item 1 — Horowitz 2023 script, own voice
Script `h2023` lines (verbatim wording from the supplement; `{X}` = target core, e.g. "a tree"):
| key | text | when |
|---|---|---|
| `start` (target) | `Think of {X}.` | at session start, after settle wait (replaces the optional pre-sleep cue for h2023) |
| `cue` (target) | `Remember to think of {X}.` | in-sleep cue at hypnagogia start (existing Dormio timer step) and after each report |
| `alert` | `You're falling asleep. Please tell me, what's going through your mind?` | wake step (after chime) |
| `stateAsk` | `And were you asleep? Awake, halfway, or asleep?` | right after the report recording; then record 8 s more so the spoken answer is captured (append to same round as `stateAudioId`) |
| `back` | `You can fall back asleep now.` | after the return cue, every round except the last |
| `controlStart` | `Observe your thoughts.` | control condition, instead of `start` |
| `controlCue` | `Remember to observe your thoughts.` | control condition, instead of `cue` |
Wake-state sessions (Phase 2 WA/WB): `alert` becomes `Please tell me what's going through your mind.` (no "falling asleep", no `stateAsk`); cue/return as above, no `back`.
- Target cue phrase: compiler's suggested `cuePhrase` becomes `Remember to think of {core}.` with **no** ", and feel {emotion}" (emotion is carried by item 4's binding, not the cue). Add `startPhrase: 'Think of {core}.'`. A user override of cuePhrase still wins. Old targets lacking `startPhrase` derive it at runtime.
- In-app state rating labels: `drifting` relabelled "Halfway (drifting)" to match the spoken question; stored values unchanged.
- Own voice: every line above is recordable (Settings → Voice). Per-target recordings: `voiceId` (cue, existing) and new `startVoiceId`. Protocol lines: `settings.scriptVoiceIds = { alert, alertWake, stateAsk, back, controlStart, controlCue }`. Any missing recording falls back to TTS **per line**; each played line is logged with `voice: 'own'|'tts'`.
- Settings shows an "Own-voice checklist": each line, recorded ✓/✗, record/play buttons. Home shows a banner when voiceMode is `own` and lines are missing for the active study.
- v1 studies keep the old wake phrase / neutral cue / pre-sleep cue behaviour.

## Item 2 — per-cue arousal logging + volume staircase
Signals (all logged into `session.events` by the runner, timestamps ISO):
- `tap`: the black night screen logs a `tap` event for any tap outside existing controls. Pre-nap instruction: "If a cue wakes you, tap the screen once."
- `motion`: `devicemotion` magnitude of (accelerationIncludingGravity − low-pass gravity) above `MOTION_THRESHOLD` (start 1.5 m/s²), throttled to ≤1 event / 2 s, only during `wait` steps. Request `DeviceMotionEvent.requestPermission` on the Start tap if it exists. Log `motion-unavailable` once if no events arrive.
- `cueWoke` per round on the report screen: "Did the cue before this wake-up wake you?" yes / no / not sure → `round.cueWoke`.
Pure module `js/core/arousal.js`:
- `cueArousals(session)` → one row per **in-sleep** cue (`type:'cue'`, `phase:'hypnagogia'`): `{ sessionId, round, t, volume, tap, motion, answer, woke }` where `tap`/`motion` = any such event within `AROUSAL_WINDOW_SEC = 60` after the cue (and before the next wake event), `answer` = round.cueWoke, `woke = tap || answer === 'yes'`. Motion is recorded and shown but **not** used for `woke` (phone-on-mattress motion is unvalidated).
- `volumeTable(sessions)` → rows by volume rounded to 0.05: `{ volume, cues, woke, wakeRate, motion }`, analyzable non-rehearsal speed-1 sleep sessions only.
- `nextCueVolume(sessions, { start, min = 0.1, max })` → weighted up-down staircase over chronological in-sleep cues: woke → −0.08, not woke → +0.02, clamp to [min, max]. Converges near a 20 % wake rate (up/(up+down)). Returns `{ volume, history }`.
- Settings: `adaptiveVolume: true`, `cueVolumeMax: 0.8` (user cap). When on, session start uses `nextCueVolume(...)`; the runner must play cues at that session volume (not `settings.cueVolume`) and log it in each cue event.
- Results page: "Cue volume" card with the table (Volume · Cues · Woke you · Wake rate · Motion) and current next volume. Trial CSV export gains `cue_volume, cue_woke, cue_tap, cue_motion`.

## Item 3 — separate idea and emotion blind scores
- `session.blind = { A, B, emoA, emoB, at, rater }`; `A`/`B` are **idea** scores (0–3), `emoA`/`emoB` **emotion** scores (0–3) or `null` when that target has no emotion or the study has `emotionScores:false`.
- Rubrics (`js/core/scoring.js`): `RUBRIC` (idea) text: 0 Absent / 1 Faint / 2 Clear / 3 Central — "content of the theme: places, objects, events, sensations. Ignore the feeling." New `EMOTION_RUBRIC`: 0 Absent / 1 Faint / 2 Clear / 3 Dominant — "how strongly the report carries this target's feeling, whatever the content."
- Score view: per target, idea scale + (if applicable) emotion scale labelled with the target's emotion word. Both required before Save when applicable.
- Blind packet CSV: `code, target_A, target_B, emotion_A_target, emotion_B_target, report, idea_A, idea_B, emotion_A, emotion_B`. Parser accepts old `score_A/score_B` as aliases for `idea_A/idea_B`; emotion columns optional; blank → null; integers 0–3 only.
- `analyzeStudy` (unchanged primary, still on idea A/B) adds `emotion`: same primary-style permutation on `emoA − emoB`, specificity, and `link` (exploratory): over cued A/B sessions with both cued scores, 2×2 counts `{ bothLanded, ideaOnly, emotionOnly, neither }` (landed = score ≥ 2) and `meanIdeaWhenEmotion`, `meanIdeaWhenNoEmotion`. Results page shows it labelled "Exploratory: does the idea come in with the feeling?"
- `compareTargets` warns when a target has no emotion or both emotions are the same (stemmed) word: "Emotion scores can't tell A from B."

## Item 4 — pre-sleep emotion binding
- When `study.protocol.binding` is true, every incubation session (sleep and wake states; not `plain`, not v1) starts with a **binding screen** before the runner starts:
  - Cued target: text "Picture {X}. Let yourself feel {emotion}." (no emotion → "Picture {X}."). Audio: `start` line at 0 s, `cue` line at 40 s and 80 s; step lasts `BIND_SEC = 120` (÷ speed in rehearsal). Then two 0–10 sliders: "How strongly did you feel {emotion}?" (only if emotion) and "How vivid was {X}?". Save → `session.binding = { sec, plays, feel, vivid, at }` then the nap runner starts.
  - Control: same length, `controlStart` / `controlCue` lines, text "Observe your thoughts.", one slider "How calm do you feel?" → `binding.calm`.
- Binding ratings go into the session CSV (`bind_feel, bind_vivid, bind_calm`).
- Allocation must still be consumed exactly once (session record is created before binding, as now before the runner). Aborting during binding marks the session `aborted` with `abortedAt: 'binding'`.

## Checks required
- `npm test` all pass, including new tests in `tests/v04.test.mjs` covering: migration v3→v4 (old study → protocol v1; blind {A,B} survives), script line selection per condition/state/protocol, compiler cue/start phrases, `cueArousals`/`volumeTable`/`nextCueVolume` (incl. convergence and clamp), CSV round-trip with and without emotion columns, `analyzeStudy` emotion + link blocks, `compareTargets` emotion warnings.
- Browser QA (`qa/browser-qa.mjs`, `qa/phase2-qa.mjs`, Playwright headless) updated to walk: own-voice checklist, binding screen (sped-up), a sped-up nap with a tap event, report with cueWoke, scoring with emotion scales, results with volume table + emotion/link blocks; screenshots in `qa/out/`; zero console errors.
