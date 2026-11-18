# The Watchdog and scripted stall

Milestone 1 step 6 (`docs/direction.md`). The daemon runs the Watchdog after follow-up routing and before the Router pass. The developer command `ostromd dev watchdog` runs one pass.

## Signal

The Watchdog makes one deterministic Semon read:

```sh
semon query stalls --idle-minutes <OSTROM_STALL_MINUTES> --since 1d --json
```

Semon reports native sessions waiting on a question, whose process has gone, or which produce no output. A Worker is matched by its worktree branch, `ostrom/ticket-<ticket>-<assignment>`. A failed Semon read makes the pass fail and does not clear an existing episode.

Workers are driven turn by turn, so Semon's verdicts are read against the turn. Between turns no process runs and a Worker that waits for review produces no output, so only an unanswered question counts. During a turn, a verdict counts only once the turn itself has run for `OSTROM_STALL_MINUTES`, because Semon's idle clock starts at the session's last write, which may predate the turn.

Observed in the sandbox: Semon reports a completed Codex exec turn as `ended`, even when the Worker's final answer says it is waiting for an answer. That completed turn does not reliably produce a `waiting-question` stall. The scripted exercise therefore uses an actual running `sleep 3600` command to produce a no-output stall.

## Episodes and recovery

A stall opens one `stall` row and remains one episode until Semon no longer reports it. The deterministic ladder makes at most two silent recovery attempts on the same assignment, then asks the Worker for one public stuck reply and pauses the ticket. Attempts are persisted on the assignment: Semon clearing one episode and later opening another does not grant another two attempts. A human follow-up resets the counter, and a reply after public escalation clears the stuck state and resumes the ticket. Ending an assignment also resets its counter.

Workers pass an abort signal to every session turn. Before a recovery, public stuck reply, graceful stop, or issue-close cleanup turn, Ostrom cancels the assignment's active turn and waits for the SDK to release it before sending the next turn. This replacement cancellation does not become a terminal assignment outcome. Ordinary follow-ups still queue at a turn boundary.

## Scripted stall

Use a dedicated sandbox issue, a throwaway database, and the normal daemon configuration from `docs/running.md`. This exercise posts the public stuck reply and updates the issue's status card and labels.

```sh
export OSTROM_REPO=onsager-ai/ostrom-sandbox OSTROM_ALLOWLIST=<login> OSTROM_DB=/tmp/ostrom-stall.sqlite
export OSTROM_WORKER_REPO=<sandbox-checkout> OSTROM_WORKER_BASE=main OSTROM_STALL_MINUTES=2
export OSTROM_WORKER_HARNESS=codex OSTROM_WORKER_MODEL=gpt-6-luna
node src/watchdog/scripted-stall.ts <sandbox-issue-number>
node src/ostromd/main.ts run --interval 30
```

The script only seeds an accepted ticket whose brief requests the foreground `sleep 3600` stall. It prints the ticket ID and creates no assignment, worktree, or SDK session. `ostromd` dispatches the accepted ticket normally and owns its turn throughout detection, two recovery attempts, and the public reply. Each recovery sleeps again; the public-reply and graceful-stop prompts take precedence over sleeping.

Use `ostrom show <ticket> --json` to read the assignment's native session ID, branch, worktree, and recovery counter; inspect that session with Semon. Confirm that two recoveries lead to exactly one public stuck reply, the ticket is paused, and a human reply resumes the same assignment with its counter reset. Stop the daemon and remove the exercise's worktree and branch after ending the ticket.
