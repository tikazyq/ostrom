# The Watchdog

`ostromd tick` runs the Watchdog after follow-up routing and before the Router pass. It checks running Workers on open tickets.

## Stall signals

The Watchdog makes one deterministic Semon read:

```sh
semon query stalls --idle-minutes <OSTROM_STALL_MINUTES> --since 1d --json
```

Semon reports sessions waiting on a question, whose process has gone, or which produce no output. The Watchdog matches the session to its Worker by worktree branch. A verdict during a turn counts after the turn itself has run for `OSTROM_STALL_MINUTES`, because Semon's clock can predate that turn. Between turns, only an unanswered question counts. A Worker waiting for review is expected to produce no output. Two consecutive occurrences of the same turn error can also open a stall.

A stall records one episode. A successful Semon read can clear a silent episode when the signal disappears. The recovery ladder can try up to two recoveries on the same Worker session before pausing the ticket and queuing one public stuck reply. The Router can also judge an open episode with `wait` or `stop`.

`ostrom resume` and replies from authors on `OSTROM_ALLOWLIST` can clear a public stall. An issue comment or submitted PR review reopens the ticket only when the stall caused the pause. Other pauses are preserved. Clearing a stall on an ended ticket starts no Worker turn.

## Budget pauses

The Watchdog checks wall-clock and idle limits even when the Semon read fails. Wall-clock time runs from ticket opening, including time waiting for review or paused. Idle time counts only during a running turn. The Worker checks turn and token limits after each turn.

A reached limit pauses the ticket as `budget reached: <limit>`. The Watchdog cancels any in-flight turn and queues a cleanup turn on the same session to save work. The status card shows the reason. Budget exhaustion never starts recovery or a public stuck reply. On upgrade, old budget stalls are cleared and pauses they caused keep their budget reason.

`ostrom extend` raises the given limits. It reopens a budget pause only when the extension clears every remaining reached limit. After an idle pause, the idle clock clears when cleanup finishes. Use `ostrom resume` to continue after cleanup.

## Exercise the idle budget

Codex polls a long-running command about once a minute, so Semon can see it as active. Use the existing `scripted-stall.ts` seed to verify that an idle budget still pauses a hung turn. Use a throwaway database and a sandbox issue. Start the daemon first so it dispatches and owns the turn.

```sh
export OSTROM_REPO=<sandbox-repo> OSTROM_ALLOWLIST=<login> OSTROM_DB=/tmp/ostrom-stall/ostrom.sqlite
export OSTROM_WORKER_REPO=<sandbox-checkout> OSTROM_WORKER_BASE=main OSTROM_STALL_MINUTES=2
node src/ostromd/main.ts run --interval 15
# in another terminal, with the same environment:
OSTROM_BUDGET_IDLE_MIN=3 node src/watchdog/scripted-stall.ts <issue-number>
```

The Worker runs `sleep 3600` and makes no edits. Verify that the card shows `Paused: budget reached: idle`, that the cleanup turn finishes, and that no public stuck reply is queued. Stop the daemon and remove its scratch worktree and branch after the exercise.
