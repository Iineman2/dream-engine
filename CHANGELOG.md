# Changelog

All notable changes to the Dream Engine, the app of The Dream Engineering
Project. Dates are when each version was built and verified in headless Chrome.
None of these versions has been used in real sleep yet; see the status section
of the [README](README.md).

## [0.4.0] - 2026-11-26

Specification: [docs/SPEC-v0.4.md](docs/SPEC-v0.4.md). Schema version 3 to 4.

### Added

- **Locked protocol per study.** A study's script, binding step and emotion
  scoring are fixed when it is created. Studies from v0.3 migrate to the `v1`
  protocol and behave exactly as before.
- **Horowitz 2023 script**, following the wording of the published protocol:
  "Think of X." after settling, "Remember to think of X." as the cue,
  an alert at each wake-up, "And were you asleep?" with 8 s more recording, and
  "You can fall back asleep now." Control and stay-awake variants included.
- **Own voice, line by line.** A settings checklist lists every line a study
  plays, with record and play. A missing recording falls back to the device
  voice for that line only; Home shows a banner while lines are missing. Every
  played line is logged as `own` or `tts`.
- **Per-cue wake tracking and cue-volume staircase.** Tap the black screen if a
  cue wakes you; phone motion is logged during waits (recorded, not used). The
  report asks whether each cue woke you. An up-down staircase, capped by a
  maximum cue volume, sets the next nap's volume, and Results shows the table.
- **Idea and emotion scored separately**, both blind 0-3, with a secondary
  emotion analysis and an exploratory "does the idea come in with the feeling?"
  table. The rater CSV packet gains emotion columns.
- **Pre-sleep emotion binding step.** Two minutes of picturing the target and
  its feeling while the start line and cue play, then 0-10 ratings.
- New trial CSV columns (`cue_volume`, `cue_woke`, `cue_tap`, `cue_motion`,
  `cue_arousal`, `has_state_audio`, `state_audio_bytes`) and session CSV columns
  (`script`, `adaptive_volume`, `blind_emo_A`, `blind_emo_B`, `bind_feel`,
  `bind_vivid`, `bind_calm`).

### Verified

- 71 unit tests pass (`npm test`).
- Headless-Chrome QA passes at 360 and 390 px with no console errors and no CSP
  violations (`npm run qa`).

## [0.3.0] - 2026-11-25

### Added

- **Phase 2: does steered dreaming help, beyond normal sleep?** Five randomised
  conditions (cued nap A or B, stay awake through the same cues A or B, plain
  nap), theme-bound word-pair sets conditioned to each theme's cue, and a themed
  Alternative Uses Task rated blind 1-5 after every session. Two pre-registered
  questions, Holm-corrected.
- Rater packet for the creativity ratings, with a round-trip import.
- Wake-ups rated "awake" are excluded from Phase 1 scoring; untargeted memory
  testing is off by default.

### Verified

- 48 unit tests and 122 headless-Chrome checks passed at the time.

## [0.2.0] - 2026-11-25

### Added

- **Outcome data.** A 16-pair word memory test before and after each nap,
  import of a daily metric (for example flashcard retention) joined by date,
  dream-experience ratings (vividness, emotional tone, immersion, bizarreness,
  lucidity, disruption) and a daily check-in (sleep, mood, sharpness,
  unreality, dream/reality confusion, substances).
- **Predictive-map data layer.** A trial table (one row per wake-up, with the
  exact cues played, state, report, ratings and check-ins) and a session table
  (one row per nap), both exportable as CSV, plus exploratory Spearman
  correlations.
- Published-protocol defaults: 5 cues, no sound motif, no extra settling cue.

### Verified

- 33 unit tests and 62 headless-Chrome checks passed at the time.

## [0.1.0] - 2026-11-24

First working version: a phone-first, offline web app that runs Dormio-style
targeted dream incubation during naps, inside a randomised, blind-scored n-of-1
study.

### Added

- Dream compiler: a target (environment, emotion, narrative, sensation,
  awareness) becomes a cue phrase, a pre-sleep visualisation and a word list.
- Session runner on wall-clock timers with a screen wake lock and a black
  screen: settle, cue, hypnagogia wait, wake prompt, recorded report, cue,
  drift back. Rehearsal mode at 20x speed.
- Learning engine: an onset staircase learned from your wake-up ratings and
  Thompson sampling over three timing profiles.
- Measurement: blocked A/B/control randomisation, blind 0-3 scoring, a CSV
  packet for an independent rater, permutation and sign tests, and a lexical
  cross-check.
- Ethics and safety: consent per intervention, a daytime-only window, caps on
  wake-ups and naps, automatic pauses, local-only data, and a content security
  policy that blocks outbound requests.
- Installable offline through a service worker; backup and restore of all data.

### Verified

- Core-logic unit tests and a full headless-Chrome run at 60x speed, including
  an offline reload and no horizontal overflow at 360 and 390 px.
