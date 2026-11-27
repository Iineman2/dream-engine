# Protocol: dream engineering, n-of-1, in two phases

Written before any data is collected. Changing the targets, the timing rules or
the analysis after sessions have started weakens what the results can tell you.

The study runs in two phases, in order:

1. **Phase 1: does the cue steer my dreams?** This studies dream engineering
   directly. The outcome is what you dreamed, nothing else.
2. **Phase 2: does steered dreaming help, beyond normal sleep?** Every control
   is built so that the only thing that differs is the dreaming.

Phase 2 unlocks once Phase 1 has used up its sequence or been closed. If
Phase 1 shows no reliable steering, Phase 2 can still run, but it can't test
whether dreams help if the cue never reaches them.

---

## Phase 1: steering

### Question

Can I reliably steer the **theme** of my sleep-onset dreams with a spoken cue?
This is the project's first milestone: repeatable, measurable control over
dream themes.

### Design

- **Conditions:**
  - **A and B:** a nap cued with target A or target B.
  - **Control:** a nap with the neutral cue "Relax, and let your mind wander."
  - All three get the same wake prompt ("Tell me what you're thinking about."),
    the same number of cues and the same timing rules. Only the content differs.
- **Allocation:** blocked randomisation in blocks of 3, from a seed fixed when the
  study is created. The default is 8 blocks, or 24 naps. The condition is
  revealed only when a session starts. A revealed allocation is used up even if
  the nap is abandoned (intention-to-treat).
- **Targets:**
  - They must share no content words (the app enforces this).
  - Either both include the lucidity cue or neither does.

### Session (adapted from MIT Dormio's timer protocol)

| Step | Default | Source |
|---|---|---|
| Settle, reading the visualisation | 60 s | Dormio: 60 s before the timer |
| Sleep-onset wait | drawn from the learned window, starting at 7.5–12.5 min | Dormio: random within your 5–25 min range |
| Cue, then hypnagogia wait | 1, 2 or 3 min (timing profile) | Dormio "hypna latency" options |
| Wake prompt and recorded report | 60 s | Dormio: 30, 60 or 90 s |
| Cue, then fall back asleep | 3, 5 or 7 min (timing profile) | Dormio "time between sleeps" options |
| Rounds | 3 | Dormio: 1–5 |
| Report form | — | Outcome measures |

**Experimental additions (off by default, Settings → Experimental):**
- a 3-note sound motif before each cue;
- an extra cue right after settling.

Neither comes from published targeted dream incubation (TDI) work.

### Outcomes

- **Primary:** a blind 0–3 incorporation score for **both** targets
  (0 absent, 1 faint, 2 clear, 3 central), scored on **dream reports only**:
  - What counts: every wake-up you rated "drifting" or "asleep", plus your
    free recall of the nap.
  - What's left out: wake-ups you rated "still awake". Those are waking
    thoughts about the cue, not dreams.
  - Scoring conditions: reports are scored in a scrambled order, with no
    dates, phases or conditions, ideally a day or more later or by someone else
    (CSV packet).
  - *Amended 2026-11-25, before any real nap.* v0.2 scored every wake-up.
- **Manipulation checks:**
  - the share of wake-ups rated drifting or asleep in each condition;
  - the number of naps with no dream report at all (every wake-up "still
    awake").

  If one condition keeps you awake more, these show it.
- **Secondary:**
  - the cued-beats-uncued sign test;
  - the rate of clear incorporation (≥2) per target per condition;
  - lucidity, vividness and emotional tone;
  - sleep disruption (a safety outcome).
- **Cross-check:** the same analysis run on a lexical scorer that counts target
  words in the dream reports. It is blind by construction but misses paraphrase.
- **Untargeted memory test (off by default):** word pairs before and after the
  nap. They aren't linked to the cue, so they can't show a dream effect.
  Phase 2 replaces this with theme-bound pairs.

### Analysis

For each A-cued or B-cued nap, d = score(A) − score(B).

H1 is that d is larger after A cues than after B cues. It is tested with a
one-sided permutation test of mean(d | A) − mean(d | B). The test is exact when
there are 200,000 or fewer permutations, and otherwise uses 20,000 seeded Monte
Carlo draws. Control naps give the base rate at which each theme turns up uncued.

Results are labelled **provisional** until at least 8 A naps and 8 B naps are
scored.

---

## Phase 2: benefit beyond normal sleep

### Question

Does dreaming about something, steered by the cue, improve creativity or memory
for that thing more than:
- normal sleep does, and
- simply hearing the cue while awake does?

### Why this design

Earlier work could only show that people who *happened* to dream about a task
improved more (Wamsley et al. 2010), which is confounded with motivation and
interest. Konkoly et al. 2025 point this out, and fix it by cueing one of two
pre-sleep tasks at random. Phase 2 uses the same idea and adds the two controls
their follow-up lacked: no no-cue baseline and no wake comparison
(Konkoly et al. 2026).

### Every session has the same tasks

1. **Before:** learn two word-pair sets (10 pairs each by default), one bound to
   each theme.
   - The theme's cue is played as its set begins, so the cue becomes a reminder
     of that set. This is the conditioning step of targeted memory reactivation
     (TMR): Konkoly et al. 2025 paired each pre-sleep task with its own sound.
   - Both sets and both cues are presented before every session, whatever the
     condition. The set order is random.
   - Then an immediate test of both sets: 4-choice associative recognition,
     where the wrong options come from the same theme's set.
2. **The session**, drawn at random (see below).
3. **After:**
   - the report form;
   - a retest of both sets;
   - a 3-minute Alternative Uses Task (AUT) for one object from each theme, in
     random order. Horowitz et al. 2023 used a "tree" AUT after "tree"
     incubation. The objects rotate through the lists you set at creation.

### Conditions (blocked randomisation, blocks of 5; the default is 6 blocks, 30 sessions)

| Code | What happens | What it controls for |
|---|---|---|
| SA, SB | Nap with theme A's or B's cue: the Phase 1 protocol | The intervention |
| WA, WB | Stay awake, sitting up with eyes closed, through the **identical** cues, prompts and timing | Hearing the cue without dreaming (Horowitz et al. 2023's wake-incubation group) |
| plain | Ordinary nap of the same length, with no cues and no mid-nap wake-ups. One prompt at the end collects any dream recall. | **Normal sleep** |

Because both themes are measured after the same session, the difference
"cued theme − uncued theme" holds constant:
- the sleep;
- the wake-ups;
- the voice;
- the timing;
- how you felt that day.

Only what the cue, and so the dream, was aimed at differs.

### Outcomes

The primary outcome is chosen and locked when Phase 2 is created. Default: creativity.

- **Creativity:**
  - What it is: a blind 1–5 rating of each AUT list, scored in a scrambled order
    without the date, condition or phase. An independent rater can use the CSV
    packet.
  - Why it's the default: it is the one published benefit of sleep-onset TDI
    (Horowitz et al. 2023).
- **Memory:** retention of each theme's set, as retest accuracy minus baseline
  accuracy. It is closer to the "learning in sleep" goal. No study has shown it
  yet for sleep-onset incubation.
- **Fluency:** the number of distinct uses listed. It is objective and needs no
  rater.

### Analysis (both questions on the primary outcome, one-sided, Holm-corrected as a pair)

- **Q1, beyond normal sleep:** the cued theme's score after SA or SB, compared
  with the mean of both themes after plain naps. Tested with a permutation test.
- **Q2, is it the dreaming:** (cued − uncued) in SA/SB compared with (cued −
  uncued) in WA/WB. Tested with a permutation test.
  - Q2 also cancels expectation effects. You know which cue you heard in both
    the awake and asleep sessions, so trying harder on the cued theme affects
    both sides equally.
- **A benefit is claimed only if both hold.**
- **Secondary:**
  - cued vs uncued after the same nap (sign-flip test, as in Konkoly et al.);
  - the cost of the wake-ups: the uncued theme after SA/SB minus a plain nap
    (descriptive);
  - Q1 and Q2 repeated for the other two outcomes.
- **Manipulation checks:**
  - Incorporation of the cued minus the uncued theme, asleep vs awake.
  - The share of prompts rated drifting or asleep in each condition. Stay-awake
    sessions should be near zero; if they aren't, you were dozing and the wake
    control is weaker.
- **Exploratory mediation:** the Spearman ρ between how much more the cued theme
  showed up in the dream and how much more it improved. Konkoly et al. 2026
  found that conceptual dream incorporation predicted solving.

Results are labelled **provisional** until there are outcomes from at least
8 cued naps, 8 stay-awake sessions and 4 plain naps.

### Phase 2 limitations

- **Self-rated creativity is only partly blind.** You may recognise your own
  lists. Use the rater packet if you can.
- **The retest is short.** It happens about 30–40 minutes after learning. A
  next-day retest would show longer-term consolidation, but Phase 2 doesn't
  include one yet.
- **Only sleep-onset dreams are tested,** not REM. Konkoly et al. cued during
  REM, so REM cueing needs a sleep sensor (V2).
- **The stay-awake control can blur.** You might doze. The state ratings show
  whether you did.
- **Plain naps have no mid-nap wake-ups,** so they also give less dream recall.
  That is the point (normal sleep), but it means a plain nap's dream content
  can't be compared with an incubation nap's.

---

## Learning engine (never changes a comparison)

- **Onset staircase:** your round-1 state moves the first-cue estimate.
  "Still awake" moves it 2 min later, and "asleep" moves it 2 min earlier. It is
  clamped to 4–25 min.
- **Timing bandit:** Thompson sampling over the three timing profiles. A
  profile is rewarded when a wake-up in round 2 or later catches you "drifting".
- **Independent of condition:** timing is chosen without regard to the
  condition. Only cued naps teach the engine; stay-awake sessions and plain naps
  don't.

## Safety rules (enforced by the app)

- Daytime sessions only, between 06:00 and 22:00. No night-time use.
- At most 5 wake-ups per nap, 2 sessions a day, and 2 h between sessions.
- The study pauses automatically when:
  - a session is marked distressing;
  - sleep disruption averages 3/4 or more over the last 3 rated sessions
    (stay-awake sessions have no disruption rating and are skipped);
  - a check-in reports things often feeling unreal (3/4 or more), or reports
    mixing up a dream with reality. Deliberate lucid-dream induction has been
    linked to increases in dissociation and schizotypy (Aviram & Soffer-Dudek
    2018).
- Resuming requires an explicit acknowledgement. Acknowledgements carry over
  into Phase 2.
- A daily check-in is required before any session. A new session can't start
  until the previous session's report and after-session tests are done.
- Sound only. No electrical, magnetic or ultrasonic stimulation.

## Known limitations (both phases)

- **Self-scoring is only partly blind,** because you hear the cue. An external
  rater using the CSV packets fixes this.
- **Sleep onset is estimated with a timer,** not measured. V1 adds a wearable to
  detect it.
- **The results are n-of-1.** They describe your brain, not people in general.

## References

- Horowitz AH, Esfahany K, Gálvez TV, Maes P, Stickgold R (2023). Targeted dream
  incubation at sleep onset increases post-sleep creative performance.
  *Scientific Reports*. doi:10.1038/s41598-023-31361-w
- Konkoly KR, Morris DJ, Cho M, Hurka K, Torres-Platas SG, Baehr L, Paller KA
  (2025). Investigating dreams by strategically presenting sounds during REM
  sleep to reactivate waking experiences. *Neuropsychologia* 217:109229.
- Konkoly KR, Morris DJ, Hurka K, Martinez AM, Sanders KEG, Paller KA (2026).
  Creative problem-solving after experimentally provoking dreams of unsolved
  puzzles during REM sleep. *Neuroscience of Consciousness* niaf067.
- Wamsley EJ, Tucker M, Payne JD, Benavides JA, Stickgold R (2010). Dreaming of
  a learning task is associated with enhanced sleep-dependent memory
  consolidation. *Current Biology* 20:850–855.
- Aviram L, Soffer-Dudek N (2018). Lucid dreaming: intensity, but not frequency,
  is inversely related to psychopathology. *Frontiers in Psychology* 9:384.
  Deliberate induction predicted increases in dissociation and schizotypy over
  2 months.
