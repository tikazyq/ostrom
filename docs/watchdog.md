# The Watchdog and scripted stall

Milestone 1 step 6 (`docs/direction.md`). `ostromd watchdog` checks every running native Worker once; `ostromd tick` runs it after follow-up routing and before the Router pass.

## Signal

The Watchdog makes one deterministic Semon read:

```sh
semon query stalls --idle-minutes <OSTROM_STALL_MINUTES> --since 1d --json
```

Semon reports native sessions waiting on a question, whose process has gone, or which produce no output. A Worker is matched by both its native session ID and its worktree branch, `ostrom/ticket-<ticket>-<assignment>`.
The Watchdog queries at an earlier threshold when needed to catch a ticket's idle budget warning.
The configured stall threshold still controls recovery. A failed Semon read makes the pass fail and
keeps existing episodes. Cumulative budget checks and native turn failures use the local store.

## Episodes and recovery

A Semon stall or failed native turn opens one episode. The Watchdog drives up to two recovery turns
on the same session. If a turn is still active when it stalls, the Watchdog asks the SDK to cancel
it before sending the next turn. The card shows Recovering. A clean Semon read can close the episode
after the observation window has elapsed. This gives Semon time to report a new stall after each
attempt.

If the episode persists, Ostrom validates and queues one blocking public reply. The second recovery
turn can supply the template fields. If those are unavailable or invalid, Ostrom describes the
observed stall and says it could not verify a checkpoint. The card stays Stuck until a human
follow-up is delivered. That clears the episode and suppresses its unsent reply.

Limits take precedence over recovery. Wall time is elapsed time across native turns, including an
interrupted turn through the time it is detected at restart. The Watchdog samples running turn
wall time and Semon's no-output idle time. Turn and token limits are checked at turn boundaries.
The single budget checkpoint is recorded before sending. If interrupted by a daemon restart, the
ticket stays paused with the checkpoint attempt recorded.

## Scripted stall

Use a throwaway database and never run `ostromd send` against it.

```sh
export OSTROM_REPO=onsager-ai/ostrom OSTROM_ALLOWLIST=<login> OSTROM_DB=/tmp/ostrom-stall/ostrom.sqlite
export OSTROM_WORKER_REPO=<main-checkout> OSTROM_WORKER_BASE=main OSTROM_STALL_MINUTES=2
node src/watchdog/scripted-stall.ts <issue-number>
# wait OSTROM_STALL_MINUTES
node src/ostromd/main.ts watchdog
# Repeat after each observation window.
node src/cli/main.ts preview
```

The script starts a Codex `gpt-6-luna` session in a scratch Git worktree on `ostrom/ticket-<t>-<a>` and asks one question. It prints the ticket, assignment, native session ID, branch and worktree. Remove that worktree and branch after the exercise.
