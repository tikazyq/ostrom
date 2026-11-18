# The Watchdog and scripted stall

Milestone 1 step 6 (`docs/direction.md`). `ostromd dev watchdog` checks running native Workers once;
`ostromd tick` runs it after follow-up routing and before the Router pass.

## Signal

The Watchdog makes one deterministic Semon read:

```sh
semon query stalls --idle-minutes <OSTROM_STALL_MINUTES> --since 1d --json
```

Semon reports native sessions waiting on a question, whose process has gone, or which produce no
output. A Worker is matched by its worktree branch. A failed Semon read makes the pass fail and does
not clear an existing episode.

Workers are driven turn by turn. Between turns no process runs and a Worker waiting for review
produces no output, so only an unanswered question counts. During a turn, a verdict counts only once
the turn itself has run for `OSTROM_STALL_MINUTES`, because Semon's idle clock may predate the turn.
Two consecutive turn errors also count as a stall.

## Budgets are pauses

Time or idle exhaustion pauses an open ticket with `budget reached: time` or `budget reached: idle`,
queues the budget cleanup turn to push work in progress and wait, and cancels an active turn. Turn,
token and escalation limits are evaluated after a turn finishes. Every budget pause appears on the
status card. Exhaustion never opens a stall episode or starts recovery/public escalation, even if
Semon reports a stall at the same time. The Watchdog leaves paused tickets alone.

`ostrom extend` reopens only a budget pause whose limits are all clear after the increase. An
insufficient extension, an extension of the wrong limit, or a different exhausted limit leaves it
paused. Operator pauses stay paused. Wall-clock accounting still starts at ticket creation and
includes review waits and pauses; extending does not reset it. A review wait that reaches its time
budget can therefore pause, receive a sufficient extension, and merge without a human comment.

## Episodes and recovery

A stall opens one `stall` row. The deterministic ladder attempts recovery on the same session twice,
then queues one public stuck reply and pauses with `stuck turn reported by the Watchdog`. Public
stalls remain until a trusted reply or operator resume clears them; a quiet Semon read alone cannot
clear a public stall. Paused tickets do not advance the ladder.

Operator resume and comments or PR reviews from `OSTROM_ALLOWLIST` clear the ticket's open stall
records and reset recovery attempts. A reply resumes only a pause imposed by the stuck ladder;
operator and budget pauses remain. Already-open tickets do not undergo another resume transition.
Ended tickets can have their stale stalls cleared without delivering work. Replies from authors
outside the allowlist never clear stalls or resume pauses.

## Scripted stall

The old hung-turn exercise used a short idle budget to drive the stuck ladder. That exercises a
budget pause now, not a stall: idle time measures how long a running turn has gone without finishing,
and reaching it queues cleanup once. To verify that budget path with a throwaway database, start the
daemon first and then seed the ticket:

```sh
export OSTROM_REPO=onsager-ai/ostrom OSTROM_ALLOWLIST=<login> OSTROM_DB=/tmp/ostrom-stall/ostrom.sqlite
export OSTROM_WORKER_REPO=<main-checkout> OSTROM_WORKER_BASE=main OSTROM_STALL_MINUTES=2
node src/ostromd/main.ts run --interval 15
# in another terminal, with the same environment:
OSTROM_BUDGET_IDLE_MIN=3 node src/watchdog/scripted-stall.ts <issue-number>
```

The daemon owns the Worker turn and cancellation. Expect a budget pause and no public stuck reply.
The deterministic stall-ladder tests inject actual stall episodes separately. The seed brief repeats
`sleep 3600` after interruption, so cleanup may itself hang; stop the daemon and remove the scratch
worktree and branch after the exercise. Never use a live daemon store for this throwaway exercise.
