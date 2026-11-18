import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { GhRunner } from "./gh.ts";
import { mergeEvidenceBlock } from "./merge-eligibility.ts";
import { MERGE_QUERY, readMergeEvidence } from "./merge-evidence.ts";
import { loadMergePolicy } from "./merge-policy.ts";
import { renderMergePreview } from "./preview.ts";
import { Store } from "../store/store.ts";

// Synthetic field shapes for reducer and pagination tests. Replace/add agreement captures from the sandbox.
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/merge-evidence.synthetic.json", import.meta.url), "utf8"));
const repo = "example/sandbox";
const unattended = loadMergePolicy({});

function github(data = fixture(), options: { protectionError?: string; rulesError?: string; graphql?: GhRunner } = {}): GhRunner {
  return async (args) => {
    assert.equal(args[0], "api");
    if (args[1] === "graphql") return options.graphql?.(args) ?? JSON.stringify(data.graphql);
    assert.deepEqual(args.slice(1, 5), ["--method", "GET", "-H", "X-GitHub-Api-Version: 2022-11-28"]);
    switch (args.at(-1)) {
      case `repos/${repo}/pulls/5`: return JSON.stringify(data.pull);
      case `repos/${repo}`: return JSON.stringify(data.repository);
      case `repos/${repo}/branches/main/protection`:
        if (options.protectionError) throw new Error(options.protectionError);
        return JSON.stringify(data.protection);
      case `repos/${repo}/rules/branches/main?per_page=100`:
        assert.deepEqual(args.slice(5, 7), ["--paginate", "--slurp"]);
        if (options.rulesError) throw new Error(options.rulesError);
        return JSON.stringify(data.rules);
      case `repos/${repo}/collaborators/reviewer/permission`: return JSON.stringify({ permission: "write" });
      default: assert.fail(`unexpected REST request: ${args.join(" ")}`);
    }
  };
}

const pr = (data: ReturnType<typeof fixture>) => data.graphql.data.repository.pullRequest;
const commit = (data: ReturnType<typeof fixture>) => pr(data).commits.nodes[0].commit;
const block = async (data: ReturnType<typeof fixture>, gh = github(data)) =>
  mergeEvidenceBlock(await readMergeEvidence(gh, repo, 5, unattended), unattended);

function page<T>(nodes: T[], endCursor: string, hasNextPage = false) {
  return { nodes, pageInfo: { endCursor, hasNextPage } };
}

function argumentsOf(args: readonly string[]) {
  assert.equal(args[1], "graphql");
  const result = new Map<string, string>();
  for (let offset = 2; offset < args.length; offset += 2) {
    const field = args[offset + 1]!;
    const equals = field.indexOf("=");
    result.set(field.slice(0, equals), field.slice(equals + 1));
  }
  return result;
}

test("merge evidence reads unequal GraphQL connections to completion with exact deduplicated results", async () => {
  const first = fixture(), second = fixture(), third = fixture();
  const review = pr(first).reviews.nodes[0], thread = pr(first).reviewThreads.nodes[0];
  const check = commit(first).statusCheckRollup.contexts.nodes[0], suite = commit(first).checkSuites.nodes[0];
  const status = { __typename: "StatusContext", id: "status-1", context: "external", state: "SUCCESS", creator: { login: "ci" } };
  const queued = { ...suite, id: "suite-2", status: "QUEUED", conclusion: null, workflowRun: null };
  pr(first).reviews = page([review], "r1", true);
  commit(first).statusCheckRollup.contexts = page([check], "c1", true);
  commit(first).checkSuites = page([suite], "s1", true);
  pr(second).reviews = page([review, { ...review, id: "review-2", state: "COMMENTED" }], "r2");
  delete pr(second).reviewThreads;
  commit(second).statusCheckRollup.contexts = page([check, status], "c2", true);
  commit(second).checkSuites = page([queued, suite], "s2");
  delete pr(third).reviews;
  delete pr(third).reviewThreads;
  delete commit(third).checkSuites;
  commit(third).statusCheckRollup.contexts = page([status, { ...status, id: "status-2" }], "c3");

  const responses = [first, second, third];
  const expected = [
    { readReviews: "true", readThreads: "true", readContexts: "true", readSuites: "true" },
    { readReviews: "true", reviews: "r1", readThreads: "false", readContexts: "true", contexts: "c1", readSuites: "true", suites: "s1" },
    { readReviews: "false", readThreads: "false", readContexts: "true", contexts: "c2", readSuites: "false" },
  ];
  let calls = 0;
  const gh = github(first, { graphql: async (args) => {
    const fields = argumentsOf(args);
    assert.deepEqual(Object.fromEntries(fields), { query: MERGE_QUERY, owner: "example", name: "sandbox", number: "5", ...expected[calls] });
    const response = responses[calls++];
    assert.ok(response, "an extra request would restart an exhausted connection");
    return JSON.stringify(response.graphql);
  } });
  const evidence = await readMergeEvidence(gh, repo, 5, unattended);
  assert.equal(calls, 3);
  assert.deepEqual(evidence.reviews.map(({ id }) => id), ["review-1", "review-2"]);
  assert.deepEqual(evidence.threads, [{ id: thread.id, resolved: true }]);
  assert.deepEqual(evidence.contexts, [
    { id: "check-1", kind: "check", name: "test", status: "COMPLETED", conclusion: "SUCCESS", suite: "suite-1", app: 15368 },
    { id: "status-1", kind: "status", name: "external", state: "SUCCESS", creator: "ci" },
    { id: "status-2", kind: "status", name: "external", state: "SUCCESS", creator: "ci" },
  ]);
  assert.deepEqual(evidence.suites.map(({ id, matches, status }) => [id, matches, status]), [
    ["suite-1", true, "COMPLETED"], ["suite-2", true, "QUEUED"],
  ]);
  assert.equal(mergeEvidenceBlock(evidence, unattended), null);
});

test("reads matching PR pages on the suite and consults the test merge rollup for required checks", async () => {
  const data = fixture();
  data.pull.merge_commit_sha = "test-merge-sha";
  data.protection.required_status_checks = { strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] };
  const suite = commit(data).checkSuites.nodes[0];
  suite.matchingPullRequests = page([{ id: "other-pr" }], "match-1", true);
  const check = commit(data).statusCheckRollup.contexts.nodes[0];
  const testChecks = page([{ ...check, conclusion: "FAILURE" }], "test-end");
  const gh = github(data, { graphql: async (args) => {
    const fields = argumentsOf(args);
    if (fields.get("query") === MERGE_QUERY) return JSON.stringify(data.graphql);
    if (fields.get("query")?.startsWith("query SuitePullRequests")) {
      assert.equal(fields.get("id"), "suite-1");
      assert.equal(fields.get("after"), "match-1");
      return JSON.stringify({ data: { node: { matchingPullRequests: page([{ id: "pr-5" }], "match-2") } } });
    }
    assert.match(fields.get("query")!, /query TestMergeEvidence/);
    assert.equal(fields.get("oid"), "test-merge-sha");
    return JSON.stringify({ data: { repository: { object: {
      oid: "test-merge-sha", statusCheckRollup: { state: "FAILURE", contexts: testChecks },
    } } } });
  } });
  assert.match((await block(data, gh))!, /required check test.*not passing/);
});

test("non-advancing pagination fails instead of looping", async () => {
  const data = fixture();
  pr(data).reviewThreads.pageInfo = { hasNextPage: true, endCursor: "repeated" };
  let calls = 0;
  const gh = github(data, { graphql: async () => {
    assert.ok(++calls <= 2);
    return JSON.stringify(data.graphql);
  } });
  await assert.rejects(readMergeEvidence(gh, repo, 5, unattended), /pagination did not advance/);
});

test("protection denial, ambiguous 404, malformed rules, and denied rules all block", async () => {
  const data = fixture();
  assert.equal(await block(data), null);
  assert.match((await block(data, github(data, { protectionError: `gh: ${data.denied.message} (HTTP 403)` })))!, /unreadable.*403/);
  assert.match((await block(data, github(data, { protectionError: "gh: Not Found (HTTP 404)" })))!, /unreadable.*404/);
  assert.equal(await block(data, github(data, { protectionError: "gh: Branch not protected (HTTP 404)" })), null);
  assert.match((await block(data, github(data, { rulesError: "gh: Forbidden (HTTP 403)" })))!, /unreadable.*403/);
  const deniedBody = fixture();
  deniedBody.protection = deniedBody.denied;
  assert.match((await block(deniedBody))!, /unreadable/);
  data.rules = [[{ type: "required_status_checks", parameters: {} }]];
  assert.match((await block(data))!, /unreadable/);
});

test("forks block before CI and workflow provenance must match the PR and head", async () => {
  const data = fixture();
  const suite = commit(data).checkSuites.nodes[0];
  data.pull.head.repo.full_name = "other/fork";
  commit(data).statusCheckRollup.state = "FAILURE";
  assert.match((await block(data))!, /fork/);
  data.pull.head.repo.full_name = repo;
  commit(data).statusCheckRollup.state = "SUCCESS";
  suite.status = "QUEUED";
  suite.conclusion = null;
  assert.match((await block(data))!, /workflow suite is incomplete/);
  suite.status = "COMPLETED";
  suite.conclusion = "SUCCESS";
  suite.workflowRun.event = "push";
  assert.match((await block(data))!, /no completed successful pull_request/);
  suite.workflowRun.event = "pull_request";
  suite.matchingPullRequests.nodes = [{ id: "another-pr" }];
  assert.match((await block(data))!, /no completed successful pull_request/);
  suite.matchingPullRequests.nodes = [{ id: "pr-5" }];
  const rerun = { ...suite, id: "rerun", conclusion: "FAILURE", workflowRun: { ...suite.workflowRun, runAttempt: 2 } };
  commit(data).checkSuites.nodes = [rerun, suite];
  assert.match((await block(data))!, /latest pull_request workflow suite did not pass/);
  commit(data).oid = "different-sha";
  await assert.rejects(block(data), /head or base changed/);
});

test("required checks distinguish app identity and branch rules can block squash", async () => {
  const data = fixture();
  data.protection.required_status_checks = { strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 42 }] };
  assert.match((await block(data))!, /required check test.*app/);
  commit(data).statusCheckRollup.contexts.nodes[0].checkSuite.app.databaseId = 42;
  assert.equal(await block(data), null);
  data.rules = [[{ type: "merge_queue" }]];
  assert.match((await block(data))!, /unsupported.*merge_queue/);
});

test("policy parsing and approval reduction require distinct eligible people on this head", async () => {
  const env = { OSTROM_MERGE_STRATEGY: "approvals", OSTROM_MERGE_APPROVALS: "1", OSTROM_MERGE_APPROVERS: " REVIEWER " };
  const policy = loadMergePolicy(env);
  assert.deepEqual(policy, { strategy: "approvals", count: 1, approvers: ["reviewer"] });
  assert.deepEqual(loadMergePolicy({ OSTROM_MERGE_STRATEGY: "human" }), { strategy: "human" });
  for (const invalid of [
    { OSTROM_MERGE_STRATEGY: "anything" }, { OSTROM_MERGE_APPROVALS: "1" },
    { ...env, OSTROM_MERGE_APPROVALS: "0" }, { ...env, OSTROM_MERGE_APPROVALS: "9007199254740993" },
    { ...env, OSTROM_MERGE_APPROVERS: "reviewer," }, { ...env, OSTROM_MERGE_APPROVERS: "Reviewer,reviewer" },
  ]) assert.throws(() => loadMergePolicy(invalid), /OSTROM_MERGE/);
  const data = fixture();
  const decide = async () => mergeEvidenceBlock(await readMergeEvidence(github(data), repo, 5, policy), policy);
  assert.equal(await decide(), null);
  const review = pr(data).reviews.nodes[0];
  pr(data).reviews.nodes.push({ ...review, id: "comment", state: "COMMENTED", submittedAt: "2026-11-10T00:00:00Z" });
  assert.equal(await decide(), null);
  review.commit.oid = "old-head";
  assert.match((await decide())!, /requires 1 eligible approvals/);
  review.state = "CHANGES_REQUESTED";
  assert.equal(await decide(), "changes requested");
  review.state = "DISMISSED";
  pr(data).reviewThreads.nodes[0].isResolved = false;
  assert.equal(await decide(), "unresolved review threads");
  const evidence = await readMergeEvidence(github(data), repo, 5, unattended);
  assert.match(mergeEvidenceBlock(evidence, { strategy: "human" })!, /human merge/);
});

// The report uses actual ticket state and does not create a candidate or change a ticket.
test("merge preview includes paused and exhausted tickets and labels untracked conditions", async () => {
  const store = Store.open(":memory:", { now: () => new Date("2000-01-01T00:00:00Z") });
  try {
    const source = store.ensureSource("github", repo);
    const issue = store.ensureThread({ sourceId: source.id, kind: "issue", number: 4, url: "https://example.com/4" });
    const pull = store.ensureThread({ sourceId: source.id, kind: "pull_request", number: 5, url: "https://example.com/5" });
    const { ticketId } = store.recordDecision({ threadId: issue, verdict: "accept", reason: "Work requested", triggerIds: [] });
    assert.ok(ticketId);
    const assignment = store.createAssignment(ticketId);
    store.configureNativeAssignment(assignment, { harness: "codex", model: "test", worktree: "test", branch: "ostrom/ticket-3-3", machine: "test" });
    store.startNativeAssignment(assignment, "test");
    store.subscribe(ticketId, pull);
    store.pauseTicket(ticketId);
    const before = store.operatorTicket(ticketId);
    const report = await renderMergePreview(store, github(), repo, "main", unattended);
    assert.match(report, /PR #5.*ticket is paused.*budget reached \(time\)/);
    assert.match(report, /Issue state, stop state, quiet window and idle state: not yet tracked/);
    assert.deepEqual(store.operatorTicket(ticketId), before);
  } finally {
    store.close();
  }
});
