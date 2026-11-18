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
`extend`, and `preview`. Run `ostrom dashboard` to open the read-only local dashboard while
ostromd is running; it prints a private loopback URL and stays attached until interrupted. The local operator API also serves `GET /v1/intake?limit=50` with recent
observed events, Router decisions and excluded newly opened issues. The CLI and dashboard clients use
the daemon's Unix socket at
`$XDG_RUNTIME_DIR/ostrom/ostromd.sock`, or
`~/.local/state/ostrom/ostromd.sock` when `XDG_RUNTIME_DIR` is not set. The
read-only commands can inspect `OSTROM_DB` directly while the daemon is down;
mutating controls require the daemon.

Developer-only one-shot passes remain available as `ostromd dev <pass>`:
`poll`, `send`, `dispatch <ticket>`, `observe`, `commands`, `route`, `watchdog`,
`merge`, `route-candidates`, and `tick`. They are retained for their existing tests and
for controlled sandbox diagnosis.

Merging is unattended by default. Set `OSTROM_MERGE_STRATEGY=human` to wait for an external
merge (by a person or another tool), or set `OSTROM_MERGE_STRATEGY=approvals` together with a positive
`OSTROM_MERGE_APPROVALS` and optional comma-separated `OSTROM_MERGE_APPROVERS`. Before an
unattended squash merge, Ostrom performs fresh GitHub evidence reads, requires the ready reply
actually to have posted, and waits ten quiet minutes. It sends only SHA-guarded squash merges;
it never uses bypass, auto-merge, another method, or branch deletion. GitHub changes can still
race the final request, so repositories requiring deliberate timing should use the human policy.

A first merge-enabled restart gives existing Worker PRs a new ready notice and quiet window;
previous green status does not make them immediately mergeable. The window restarts for stored
human issue/PR triggers, completed Worker turns, review submissions, review-thread resolution
changes, head/base changes, and policy changes. GitHub does not expose a reliable timestamp for
review-thread resolution, so observing that change restarts the window at observation time.
Direct comment/body edits also restart the window when observed; marked Ostrom replies/cards and
CI progress do not. Unobserved activity that is undone between reads and invisible pending review
drafts cannot be detected. Changing from human to automatic policy resets the window but updates
the card rather than posting another opened reply.

The final send refreshes intake/controls, issue state, comments, PR/check/review/thread evidence and
branch requirements. A failed prerequisite pass suppresses sends while reconciliation continues.
Only a confirmed GitHub merge ends work. Definite HTTP 4xx refusals back off (408 and 429 are treated
as ambiguous); transport errors and 5xx keep the request unresolved until a fresh GitHub read.
A lost response records unknown origin when GitHub names the shared operator login. With App
configuration, the resolved App bot's numeric user ID establishes Ostrom attribution.

This implementation blocks code-owner selection, last-push approval, merge queues and unsupported
active rules rather than guessing. A suite with more than 100 matching PRs blocks; its nested list
is not paginated yet. Required checks found only on GitHub's test-merge commit also block because
this reader evaluates the head rollup only. The classic-protection endpoint's HTTP 404 with exact
message `Branch not protected` means no classic protection; active rules and all other merge
requirements still apply. Other 404s, any 403 and all other protection-read errors block.
The sandbox matrix in `merging.md` remains a separate, unperformed verification step.

Set `OSTROM_WORKER_RULES_FILE` to a file of the machine's house rules (for example its heat
limits, and that tests run in CI rather than locally). Its text closes every Worker's brief.

## Model discovery and selections

`ostromd` discovers the models offered by both harnesses in the background at startup. Claude uses
its Agent SDK's `supportedModels()` call; Codex uses the SDK-pinned CLI's app-server over stdio,
including initialization and every `model/list` page. Each discovery has a 30-second timeout.
Discovery uses the same `OSTROM_CLAUDE_AUTH` and `OSTROM_CODEX_PROVIDER` settings as sessions.
A successful refresh stores that harness's complete catalog and timestamp in SQLite. A failure
is logged and retains its last good catalog; a startup failure makes the daemon's eventual exit
non-zero without stopping intake. Explicit refresh failures return non-zero immediately.

```sh
ostrom models
ostrom models refresh
ostrom models allow codex/gpt-6.1-sol
ostrom models set codex/gpt-6.1-sol --efforts low,high --approval true --cost 3 --note "Use for Rust changes"
ostrom models objective cost
ostrom models remove codex/gpt-6.1-sol
ostrom models export > models.json
ostrom models import models.json
```

All commands accept a final `--json`. Listing shows discovered names, descriptions, supported and
default efforts, allowed status and settings, plus each catalog's last successful timestamp.
Models that are still selected but no longer offered are marked unavailable; changed effort lists
are flagged too. Newly discovered models are never allowed automatically. `allow` defaults to all
discovered efforts, no approval, relative cost 1 and an empty note. Repeated `allow` preserves existing
settings. `set` requires an allowed model; efforts must be a nonempty subset of discovered efforts
(or an empty list for a model without effort controls). Approval takes `true` or `false`, cost must
be positive, and note is free text. `objective` takes `cost` (the default), `balanced` or `quality`.

Listing and export read the cached store when the daemon is down. Changes, import and refresh
require the daemon and go through its Unix socket. JSON export contains `{ "objective": "cost",
"selections": [...] }`; each selection has `harness`, `modelId`, `efforts`, `approval`, `cost` and
`note`. Import replaces all selections and the objective atomically, validating every entry against
the destination machine's cached catalog first. Refresh the destination before importing; an unknown
model or unsupported effort rejects the entire import.

The API provides `GET /v1/models`, `GET /v1/models/export`, `POST /v1/models` for allow/remove/set/objective
changes, `POST /v1/models/import`, and `POST /v1/models/refresh`. These settings are stored for the
next model-selection step: Worker and Router model choices still use the existing environment
configuration; approval flags and cost weights do not affect execution yet.

## GitHub App identity

Set both `OSTROM_GITHUB_APP_ID=4544316` and `OSTROM_GITHUB_APP_KEY_FILE=/absolute/path/to/key.pem`
for the daemon and CLI. Keep the PEM readable only by the service user. Never put its contents or
an installation token in the environment file, repository, logs or brief. Setting just one variable
fails startup; setting neither retains ambient `gh` authentication. The App's name can change:
only its ID is configured. Startup looks up `GET /app` and `GET /users/{slug}[bot]` to resolve the
current bot author/committer name and noreply email.

Install the App on `OSTROM_REPO` (the current App is installed on the organization's repositories).
Ostrom discovers that repository's installation with an App JWT at
`GET /repos/{owner}/{repo}/installation`, then exchanges it for an installation token. The App
needs Contents, Issues and Pull requests write, and Actions, Checks and Commit statuses read.
**Administration: read is also needed for classic branch-protection reads.** Without it, automatic
merge may block on an inaccessible protection response. Installation/settings changes remain an
operator action. Reserve this App's credential for Ostrom so its bot ID proves merge attribution.

Daemon/CLI `gh` children receive `GH_TOKEN` in their environment, never argv; the daemon caches
it in memory until three minutes before expiry. JWTs use RS256 with 60 seconds of clock skew and
a ten-minute maximum claim window. Keys are read only to sign; keys and tokens are never logged
or saved. Authentication errors omit API bodies and credential values.

Workers inherit temporary executable helpers on PATH and Git's process-scoped credential settings.
Every wrapped `gh` invocation and every Git HTTPS credential request mints a fresh installation token, so
turns longer than an hour keep working. The configured repository's common SSH URLs are rewritten
to HTTPS in that process environment. Git credential requests are restricted to that repository;
ambient Git helpers are cleared. No token is written to the helper files. Worker commits inherit
both author and committer as the resolved App bot. Helpers are removed when the command/daemon
finishes, after its Workers drain. Workers also receive `GH_CONFIG_DIR` pointing at an empty,
private directory alongside the helpers, and ambient `GH_TOKEN`/`GITHUB_TOKEN` are removed.
The wrapper supplies a fresh `GH_TOKEN` to its own child; GitHub CLI gives that token precedence
over stored credentials (`gh help environment`). If a shell reorders PATH or uses an absolute
`gh` path, the unwrapped CLI has no saved login and fails authentication instead of acting as the
operator. This configuration isolation applies only to Workers; the daemon's runner is unchanged.
In App mode, Codex sessions disable login shells (`allow_login_shell=false`) and shell snapshots
(`features.shell_snapshot=false`) so login profiles cannot put the operator's `gh` ahead of the
helper. Non-App sessions retain their existing shell behavior; Claude shell behavior is unchanged.

This mechanism requires Workers to preserve PATH and Git's inherited environment and use normal
`gh`/Git commands. An absolute `gh` path, overridden credentials, `git -c credential.helper=...`,
or another SSH URL can bypass it; it is identity plumbing for trusted Workers, not a sandbox.
Each command starts with a fresh token, but a single Git/gh transfer that lasts longer than the
token lifetime can fail and must be retried explicitly. Minting on demand also costs API calls and
requires the key file and the Ostrom checkout to remain available throughout the turn. Live proof
of an App-authored sandbox PR, operator approval and App merge remains to be run by the operator.
