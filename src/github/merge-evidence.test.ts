import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { GhRunner } from "./gh.ts";
import { MERGE_API_VERSION, MERGE_QUERY, readMergeEvidence, readMergeGraph, type MergeEvidence } from "./merge-evidence.ts";
import { mergeEligibility } from "./merge-eligibility.ts";
import { loadMergePolicy } from "./merge-policy.ts";

function fixture() { return JSON.parse(readFileSync(new URL("./fixtures/merge-evidence.json", import.meta.url), "utf8")); }
const identity = { branch: "ostrom/ticket-1-1", base: "main" };
const unattended = { strategy: "unattended" } as const;

function reader(f = fixture()) {
  const calls: (readonly string[])[] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === "graphql") {
      assert.ok(args.includes(`query=${MERGE_QUERY}`));
      return JSON.stringify(f.graph);
    }
    assert.ok(args.includes(`X-GitHub-Api-Version: ${MERGE_API_VERSION}`));
    assert.equal(args[2], "GET");
    const path = args.at(-1)!;
    if (path === `repos/${f.repo}/pulls/${f.number}`) return JSON.stringify(f.pr);
    if (path === `repos/${f.repo}`) return JSON.stringify(f.repository);
    if (path.endsWith("/protection")) return JSON.stringify(f.protection);
    if (path.includes("/rules/branches/")) return JSON.stringify(f.rules);
    if (path.includes("/reviews?")) return JSON.stringify(f.reviews);
    if (path.endsWith("/permission")) return JSON.stringify({ permission: "write" });
    throw new Error(`unexpected path ${path}`);
  };
  return { gh, calls };
}

async function evidence(): Promise<MergeEvidence> {
  return readMergeEvidence(reader().gh, fixture().repo, 12);
}

test("merge reader pins REST and reduces the shared GraphQL head evidence", async () => {
  const e = await evidence();
  assert.equal(e.commitOid, "head-sha");
  assert.deepEqual(e.contexts.map((context) => context["id"]), ["CR_1"]);
  assert.deepEqual(e.suites.map((suite) => suite["id"]), ["CS_1"]);
  assert.deepEqual(mergeEligibility(e, unattended, identity), { eligible: true, blockers: [] });
});

test("GraphQL connections finish independently over two and three pages with exact deduplication", async () => {
  const f = fixture();
  const context = f.graph.data.repository.pullRequest.headRef.target.statusCheckRollup.contexts.nodes[0];
  const suite = f.graph.data.repository.pullRequest.headRef.target.checkSuites.nodes[0];
  const reviews = [1, 2, 3].map((id) => ({ id: `R${id}`, databaseId: id, state: "COMMENTED", submittedAt: "2026-11-10T12:00:00Z", author: { login: "reviewer" }, commit: { oid: "head-sha" } }));
  const thread = (id: number) => ({ id: `T${id}`, isResolved: true, isOutdated: false });
  const page = (nodes: unknown[], more: boolean, cursor: string | null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
  const seen: Record<string, string>[] = [];
  const gh: GhRunner = async (args) => {
    const vars = Object.fromEntries(args.filter((arg) => /^(reviews|threads|contexts|suites|readReviews|readThreads|readContexts|readSuites)=/.test(arg)).map((arg) => arg.split("=")));
    seen.push(vars);
    const round = seen.length;
    assert.ok(round <= 3, "pagination must terminate");
    const response = structuredClone(f.graph);
    const pr = response.data.repository.pullRequest;
    const commit = pr.headRef.target;
    if (round === 1) {
      pr.reviews = page([reviews[0]], true, "r1");
      pr.reviewThreads = page([thread(1)], true, "t1");
      commit.statusCheckRollup.contexts = page([context], true, "c1");
      commit.checkSuites = page([suite], false, "s-end");
    } else if (round === 2) {
      assert.deepEqual(vars, { reviews: "r1", readReviews: "true", threads: "t1", readThreads: "true", contexts: "c1", readContexts: "true", suites: "s-end", readSuites: "false" });
      pr.reviews = page([reviews[0], reviews[1]], false, "r-end");
      pr.reviewThreads = page([thread(1), thread(2)], true, "t2");
      commit.statusCheckRollup.contexts = page([context, { ...context, id: "CR_2", databaseId: 102 }], true, "c2");
      delete commit.checkSuites;
    } else {
      assert.equal(vars["reviews"], "r-end");
      assert.equal(vars["readReviews"], "false");
      assert.equal(vars["threads"], "t2");
      assert.equal(vars["contexts"], "c2");
      assert.equal(vars["suites"], "s-end");
      delete pr.reviews;
      delete commit.checkSuites;
      pr.reviewThreads = page([thread(2), thread(3)], false, "t-end");
      commit.statusCheckRollup.contexts = page([{ ...context, id: "CR_2", databaseId: 102 }, { ...context, id: "CR_3", databaseId: 103 }], false, "c-end");
    }
    return JSON.stringify(response);
  };
  const result = await readMergeGraph(gh, f.repo, 12);
  assert.equal(seen.length, 3);
  assert.deepEqual(result.reviews.map((row) => row["id"]), ["R1", "R2"]);
  assert.deepEqual(result.threads.map((row) => row["id"]), ["T1", "T2", "T3"]);
  assert.deepEqual(result.contexts.map((row) => row["id"]), ["CR_1", "CR_2", "CR_3"]);
  assert.deepEqual(result.suites.map((row) => row["id"]), ["CS_1"]);
});

test("GraphQL rejects non-advancing cursors, errors, missing fields and unknown enums", async () => {
  for (const mutate of [
    (f: any) => { f.graph.errors = [{ message: "denied" }]; },
    (f: any) => { delete f.graph.data.repository.pullRequest.headRefOid; },
    (f: any) => { f.graph.data.repository.pullRequest.mergeStateStatus = "NEW_STATE"; },
    (f: any) => { f.graph.data.repository.pullRequest.reviews.pageInfo = { hasNextPage: true, endCursor: "same" }; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readMergeGraph(reader(f).gh, f.repo, 12));
  }
});

test("head or base movement during the evidence read is rejected", async () => {
  const f = fixture();
  f.pr.base.sha = "new-base";
  await assert.rejects(readMergeEvidence(reader(f).gh, f.repo, 12), /head\/base changed/);
});

test("denied protection bodies and failed protection/rules requests block", async () => {
  const f = fixture();
  f.protection = f.deniedProtection;
  const deniedBody = await readMergeEvidence(reader(f).gh, f.repo, 12);
  assert.match(mergeEligibility(deniedBody, unattended, identity).blockers.join(";"), /classic protection unsupported/);
  for (const path of ["/protection", "/rules/branches/"]) {
    const fake = reader();
    const gh: GhRunner = (args) => args.at(-1)!.includes(path) ? Promise.reject(new Error("HTTP 403 denied")) : fake.gh(args);
    const e = await readMergeEvidence(gh, f.repo, 12);
    assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /unreadable.*403/);
  }
});

test("fork heads block before any CI is considered", async () => {
  const e = await evidence();
  (e.pr["head"] as any).repo.full_name = "fork/ostrom-sandbox";
  e.contexts = []; e.suites = []; e.rollupState = null;
  assert.deepEqual(mergeEligibility(e, unattended, identity).blockers, ["head and base repositories differ or are unavailable"]);
});

test("only a successful PR workflow on the head satisfies CI", async () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const e = await evidence();
    (e.suites[0]!["workflowRun"] as any).event = event;
    assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /no successful pull_request/);
  }
  const wrongPr = await evidence();
  (wrongPr.suites[0]!["matchingPullRequests"] as any).nodes = [{ number: 99 }];
  assert.equal(mergeEligibility(wrongPr, unattended, identity).eligible, false);
  const wrongHead = await evidence(); wrongHead.commitOid = "test-merge-sha";
  assert.match(mergeEligibility(wrongHead, unattended, identity).blockers.join(";"), /captured head/);
});

test("latest suite cannot borrow an older successful check and ambiguous attempt ordering blocks", async () => {
  const e = await evidence();
  const latest = structuredClone(e.suites[0]!);
  latest["id"] = "CS_latest";
  (latest["workflowRun"] as any).runNumber = 11;
  e.suites.push(latest);
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /no successful pull_request/);
  e.contexts.push({ ...e.contexts[0], id: "CR_latest", checkSuite: { ...(e.contexts[0]!["checkSuite"] as any), id: "CS_latest" } });
  assert.equal(mergeEligibility(e, unattended, identity).eligible, true);
  e.suites.push({ ...latest, id: "CS_ambiguous" });
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /ambiguous workflow/);
});

test("workflow-bound queued suite blocks green contexts; suites without runs are ignored", async () => {
  const e = await evidence();
  e.suites.push({ id: "CS_unused", status: "QUEUED", conclusion: null, app: null, workflowRun: null });
  assert.equal(mergeEligibility(e, unattended, identity).eligible, true);
  const rerun = structuredClone(e.suites[0]!);
  rerun["id"] = "CS_rerun"; rerun["status"] = "QUEUED"; rerun["conclusion"] = null;
  (rerun["workflowRun"] as any).runAttempt = 2;
  e.suites.push(rerun);
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /workflow suite is incomplete/);
  rerun["status"] = "COMPLETED"; rerun["conclusion"] = "FAILURE";
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /latest workflow suite is not successful/);
});

test("empty rollups, failed statuses, wrong-app checks and unresolved outdated threads block", async () => {
  const cases: ((e: MergeEvidence) => void)[] = [
    (e) => { e.contexts = []; e.rollupState = null; },
    (e) => { e.contexts.push({ __typename: "StatusContext", context: "external", state: "PENDING" }); },
    (e) => { (e.contexts[0]!["checkSuite"] as any).app.databaseId = 42; },
    (e) => { e.threads.push({ id: "thread", isResolved: false, isOutdated: true }); },
    (e) => { e.pr["mergeable"] = null; },
    (e) => { e.rules = { readable: true, value: [{ type: "merge_queue" }] }; },
  ];
  for (const change of cases) { const e = await evidence(); change(e); assert.equal(mergeEligibility(e, unattended, identity).eligible, false); }
  const e = await evidence();
  e.contexts.push({ ...e.contexts[0], id: "neutral", name: "optional", conclusion: "NEUTRAL" });
  e.contexts.push({ ...e.contexts[0], id: "skipped", name: "skipped", conclusion: "SKIPPED" });
  assert.equal(mergeEligibility(e, unattended, identity).eligible, true);
});

function review(id: number, state: string, commit = "head-sha", userId = 2) {
  return { id, state, commit_id: commit, submitted_at: `2026-11-10T12:0${id}:00Z`, user: { id: userId, login: `reviewer${userId}`, type: "User" } };
}

test("decisive reviews persist through comments; approval or dismissal clears changes requested", async () => {
  const e = await evidence();
  e.reviews = [review(1, "CHANGES_REQUESTED"), review(2, "COMMENTED")];
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /outstanding changes requested/);
  e.reviews.push(review(3, "APPROVED"));
  assert.equal(mergeEligibility(e, unattended, identity).eligible, true);
  e.reviews = [review(1, "DISMISSED"), review(2, "COMMENTED")];
  assert.equal(mergeEligibility(e, unattended, identity).eligible, true);
  e.reviews.push({ ...review(3, "APPROVED"), user: null });
  assert.equal(mergeEligibility(e, unattended, identity).eligible, false);
});

test("approval policy counts distinct eligible current-head people, excludes author/bots and respects allowlist", async () => {
  const e = await evidence();
  const policy = loadMergePolicy({ OSTROM_MERGE_STRATEGY: "approvals", OSTROM_MERGE_APPROVALS: "1", OSTROM_MERGE_APPROVERS: "Reviewer2" });
  e.reviewerPermissions = { reviewer2: "write", reviewer3: "admin", reviewer1: "admin" };
  e.reviews = [review(1, "APPROVED", "old-head"), review(2, "APPROVED", "head-sha", 3), review(3, "APPROVED", "head-sha", 1)];
  assert.equal(mergeEligibility(e, policy, identity).eligible, false);
  e.reviews.push(review(4, "APPROVED"), review(5, "COMMENTED"));
  assert.equal(mergeEligibility(e, policy, identity).eligible, true);
  e.reviews[3] = { ...review(4, "APPROVED"), user: { id: 2, login: "reviewer2", type: "Bot" } };
  assert.equal(mergeEligibility(e, policy, identity).eligible, false);
  e.reviews[3] = review(4, "APPROVED"); e.reviewerPermissions["reviewer2"] = "read";
  assert.equal(mergeEligibility(e, policy, identity).eligible, false);
});

test("reader preserves REST review order, stable identities and permissions", async () => {
  const f = fixture();
  f.reviews = [review(1, "CHANGES_REQUESTED"), review(2, "APPROVED")];
  f.graph.data.repository.pullRequest.reviews.nodes = f.reviews.map((r: ReturnType<typeof review>) => ({
    id: `R${r.id}`, databaseId: r.id, state: r.state, submittedAt: r.submitted_at,
    author: { login: r.user.login }, commit: { oid: r.commit_id },
  }));
  const e = await readMergeEvidence(reader(f).gh, f.repo, 12);
  assert.deepEqual(e.reviews.map((r) => r["id"]), [1, 2]);
  assert.deepEqual(e.reviewerPermissions, { reviewer2: "write" });
  assert.equal(mergeEligibility(e, { strategy: "approvals", approvals: 1, approvers: [] }, identity).eligible, true);
  f.graph.data.repository.pullRequest.reviews.nodes[1].state = "DISMISSED";
  await assert.rejects(readMergeEvidence(reader(f).gh, f.repo, 12), /review evidence changed/);
});

test("active inherited rules enforce app identity, approval counts and supported merge methods", async () => {
  const e = await evidence();
  e.rules = { readable: true, value: [
    { type: "required_status_checks", ruleset_id: 8, ruleset_source_type: "Organization", ruleset_source: "onsager-ai", parameters: {
      strict_required_status_checks_policy: true, required_status_checks: [{ context: "check", integration_id: 15368 }],
    } },
    { type: "pull_request", parameters: {
      required_approving_review_count: 1, dismiss_stale_reviews_on_push: true,
      required_review_thread_resolution: true, require_code_owner_review: false,
      require_last_push_approval: false, allowed_merge_methods: ["squash"],
    } },
  ] };
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /approvals 0\/1/);
  e.reviews = [review(1, "APPROVED")]; e.reviewerPermissions = { reviewer2: "write" };
  assert.equal(mergeEligibility(e, unattended, identity).eligible, true);
  if (!e.rules.readable) throw new Error("expected readable rules");
  (e.rules.value as any)[1].parameters.allowed_merge_methods = ["rebase"];
  assert.match(mergeEligibility(e, unattended, identity).blockers.join(";"), /does not allow squash/);
});

test("merge policy defaults and invalid startup combinations", () => {
  assert.deepEqual(loadMergePolicy({}), unattended);
  assert.deepEqual(loadMergePolicy({ OSTROM_MERGE_STRATEGY: "human" }), { strategy: "human" });
  for (const env of [
    { OSTROM_MERGE_STRATEGY: "unknown" },
    { OSTROM_MERGE_APPROVALS: "1" },
    { OSTROM_MERGE_STRATEGY: "human", OSTROM_MERGE_APPROVERS: "a" },
    { OSTROM_MERGE_STRATEGY: "approvals" },
    { OSTROM_MERGE_STRATEGY: "approvals", OSTROM_MERGE_APPROVALS: "0" },
    { OSTROM_MERGE_STRATEGY: "approvals", OSTROM_MERGE_APPROVALS: "9007199254740992" },
    { OSTROM_MERGE_STRATEGY: "approvals", OSTROM_MERGE_APPROVALS: "1", OSTROM_MERGE_APPROVERS: "a,A" },
    { OSTROM_MERGE_STRATEGY: "approvals", OSTROM_MERGE_APPROVALS: "1", OSTROM_MERGE_APPROVERS: "a," },
  ]) assert.throws(() => loadMergePolicy(env));
});
