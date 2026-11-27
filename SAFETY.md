# Safety

The Dream Engine plays sound while you fall asleep and wakes you a few times
during a nap. That is a real intervention in your sleep, so this document says
what the project will and will not do, what the app enforces in code, and who
should not use it.

**This is research software, not a medical device.** It does not diagnose,
treat, cure or prevent any condition, and nothing in this repository is medical
advice. If you are unsure whether it is suitable for you, ask a clinician first.

## Who should not use it

Do not use the app, and talk to a clinician before using any sleep-interruption
protocol, if any of these apply to you:

- a diagnosed sleep disorder (insomnia, narcolepsy, sleep apnoea, parasomnias,
  REM sleep behaviour disorder, and similar);
- epilepsy or a history of seizures, since sleep deprivation and interrupted
  sleep can lower seizure thresholds;
- a psychiatric condition, in particular psychosis, schizophrenia-spectrum
  conditions, bipolar disorder, dissociative disorders or PTSD;
- trauma-related nightmares;
- pregnancy;
- a job or situation where being short of sleep is dangerous (driving,
  machinery, safety-critical work);
- being under 18.

The app's own charter repeats the clinician warning, but it cannot check any of
this for you. Responsibility for deciding to take part rests with you.

## What the project will and will not do

**Positive or neutral content only (project policy).**
Targets are for pleasant or neutral themes: a place, a sensation, a calm or
positive feeling. The project will not provide, accept contributions for, or
document targets built around fear, threat, violence, self-harm, harassment of
a real person, or anything designed to distress. The app does not currently
screen the text you type, so this is a rule you are asked to follow rather than
one the code enforces. A content guard is on the roadmap (see the README).

**Sound only.**
No electrical, magnetic, ultrasonic or other brain stimulation. Contributions
that add such channels will not be accepted.

**Daytime naps only.**
Sessions can only start between 06:00 and 22:00.

**Your sleep comes first.**
The study is designed so that its measurement never outranks your wellbeing,
and any setting or result that conflicts with that should lose.

**Your data stays with you.**
Everything is stored in your browser on your device. There are no accounts,
uploads or analytics, and the page's content security policy blocks outbound
requests. During a nap, the microphone records only after each wake-up (your
report and your "were you asleep?" answer). Outside naps it records only when
you choose to record your own cue lines.

## Limits enforced by the app

| Rule | Value |
|---|---|
| Session window | Sessions can start only between 06:00 and 22:00 local time |
| Wake-ups per nap | at most 5 |
| Sessions per day | at most 2 |
| Gap between sessions | at least 2 hours |
| Check-in | a daily check-in is required before any session |
| Report | a new session cannot start until the previous report and after-session tests are done |
| Consent | one explicit yes per intervention, withdrawable in Settings |

## Automatic pauses

The study pauses itself, and will not start another session, when any of these
is true:

- a session was marked distressing;
- sleep disruption averaged 3 out of 4 or more over your last three rated
  sessions;
- a check-in says things often feel unreal or detached (3 out of 4 or more);
- a check-in says you mixed up a dream with something that really happened.

Resuming requires an explicit acknowledgement. The reason for the pause is
shown on screen. The last two rules exist because deliberate lucid-dream
induction has been linked to increases in dissociation and schizotypy in one
longitudinal study (Aviram and Soffer-Dudek, 2018; see
[docs/SCIENCE.md](docs/SCIENCE.md)). This app does not try to induce lucid
dreaming, but the check-ins are there in case dream and waking experience start
to blur.

## Stop rules for you

Stop using the app, and speak to a clinician if the problem continues, if you
notice any of the following:

- you feel more tired, low, anxious or irritable during the day than before you
  started;
- your night-time sleep gets worse;
- dreams become frightening or distressing;
- you feel detached from reality, or find it hard to tell dreams from memories;
- anything else that makes you uneasy. You do not need a reason to stop.

Pausing and quitting are always a valid, complete outcome of the study.

## Practical precautions

- Use the app only when it is safe to be asleep: not while driving, not near
  water, not responsible for anyone.
- Turn on Do Not Disturb and put the phone on charge before a nap.
- Keep the volume low. The app lowers the volume after a cue wakes you and
  raises it slightly after cues that don't, up to the cap you set, but you
  should still check it while awake first (use Rehearse).
- Do not combine it with alcohol, sedatives or other substances that affect
  sleep. The check-in asks about substances so your own data can show it.

## Reporting a safety concern

If you find a way the app could harm someone, such as a bug that lets a safety
limit be bypassed, please open an issue labelled `safety`. If the issue is
sensitive, use the private maintainer contact on the repository profile instead
of a public issue. Safety fixes take priority over all other work.
