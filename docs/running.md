# Running Ostrom

`ostromd` is a user service. Install the two commands from a checkout with `npm link`
(they run their TypeScript directly on Node 24). Put the runtime configuration in
`~/.config/ostrom/env` (including `OSTROM_REPO`, `OSTROM_ALLOWLIST`, `OSTROM_DB`,
worker, router, and Watchdog variables). It must also set `PATH`: systemd starts user services
with a minimal one, and the daemon and its Workers need `node`, `ostromd`, `git`, `gh`, `semon`,
`codex` and `claude`. Copy your shell's value, for example with
`echo "PATH=$PATH" >> ~/.config/ostrom/env`. Then install the checked-in unit:

```sh
mkdir -p ~/.config/systemd/user
cp contrib/systemd/ostromd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ostromd
```

The daemon runs `ostromd run --interval 60`, restarts after failures, and writes
logs to the user journal. Inspect it with `journalctl --user -u ostromd`.

The operator uses `ostrom status`, `tickets`, `show`, `pause`, `resume`, `stop`,
`extend`, and `preview`. They use the daemon's Unix socket at
`$XDG_RUNTIME_DIR/ostrom/ostromd.sock`, or
`~/.local/state/ostrom/ostromd.sock` when `XDG_RUNTIME_DIR` is not set. The
read-only commands can inspect `OSTROM_DB` directly while the daemon is down;
mutating controls require the daemon.

Developer-only one-shot passes remain available as `ostromd dev <pass>`:
`poll`, `send`, `dispatch <ticket>`, `observe`, `commands`, `route`, `watchdog`,
`route-candidates`, and `tick`. They are retained for their existing tests and
for controlled sandbox diagnosis.

While the daemon is running, `ostrom preview` also reads merge evidence from GitHub for
running Worker branches. It reports ticket pause and budget state, and explicitly marks issue
state, stop state, the quiet window and Worker idle state as not yet tracked. A passing GitHub
report does not establish permission to merge. No merge calls or merge tick pass exist yet.
The offline preview continues to show only the local outbox.

`OSTROM_MERGE_STRATEGY` selects `unattended` (default), `human`, or `approvals` for this
repository's read-only report. `approvals` requires a positive `OSTROM_MERGE_APPROVALS` count
and accepts an optional comma-separated `OSTROM_MERGE_APPROVERS` login list. Logins are
case-insensitive; duplicate/empty entries, impossible allowlist counts, unknown strategies and
approval fields on other strategies fail startup. These variables do not enable merging.
Protection or active-rules reads denied by GitHub block the report; even an ambiguous protection
404 is not treated as an unprotected branch. Code-owner and last-push approval requirements,
merge queues and unsupported enforced rules also block until their evidence is implemented.

The merge contract fixtures in `src/github/fixtures/merge-evidence.json` are synthetic trimmed
examples, not sandbox recordings. A permitted capture at REST version `2022-11-28`, including
the GraphQL query and workflow re-request transitions, is still required before enabling merges.
Tests and typecheck run only in CI.

Set `OSTROM_WORKER_RULES_FILE` to a file of the machine's house rules (for example its heat
limits, and that tests run in CI rather than locally). Its text closes every Worker's brief.
