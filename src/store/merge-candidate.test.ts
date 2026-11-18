import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrations } from "./migrations.ts";
import { Store } from "./store.ts";

test("merge-candidate migration upgrades an existing store and preserves ownership/outbox", () => {
  const db = new DatabaseSync(":memory:");
  // Establish the shipped schema, then let Store apply only the new forward migration.
  db.exec("PRAGMA foreign_keys = OFF");
  for (const sql of migrations.slice(0, -1)) db.exec(sql);
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO schema_version VALUES (?, ?)").run(migrations.length - 1, "2026-11-10T12:00:00Z");
  db.exec(`
    INSERT INTO source(id, kind, name) VALUES (1, 'github', 'sandbox/repo');
    INSERT INTO thread(id, source_id, kind, number, url) VALUES (1, 1, 'issue', 1, 'issue');
    INSERT INTO decision(id, thread_id, verdict, reason, decided_at) VALUES (1, 1, 'accept', 'work', 'now');
    INSERT INTO ticket(id, decision_id, state, opened_at) VALUES (1, 1, 'open', 'now');
    INSERT INTO assignment(id, ticket_id, state, created_at) VALUES (1, 1, 'pending', 'now');
    INSERT INTO subscription VALUES (1, 1, 'now');
    INSERT INTO outbox(id, thread_id, body, enqueued_at, next_attempt_at) VALUES ('ready', 1, 'ready', 'now', 'now');
  `);
  db.exec("PRAGMA foreign_keys = ON");
  const store = new Store(db);
  try {
    assert.equal(store.getAssignment(1).ticketId, 1);
    assert.equal(store.ticketsForThread(1)[0]?.id, 1);
    assert.equal(store.pendingReplies()[0]?.id, "ready");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM merge_candidate").get()!["n"], 0);
    const insert = db.prepare(`INSERT INTO merge_candidate (
      assignment_id, repository, pull_request, head_repository, head_ref, base_ref, head_sha, base_sha,
      policy_snapshot, discovered_at, observed_at, ready_reply_id
    ) VALUES (?, 'sandbox/repo', 12, 'sandbox/repo', 'worker', 'main', 'head', 'base',
      '{"strategy":"unattended"}', 'now', 'now', 'ready')`);
    insert.run(1);
    assert.throws(() => insert.run(1), /UNIQUE/);
    assert.throws(() => insert.run(999), /FOREIGN KEY/);
    const row = db.prepare("SELECT * FROM merge_candidate").get()!;
    assert.equal(row["ready_sent_at"], null);
    assert.equal(row["quiet_deadline"], null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { store.close(); }
});
