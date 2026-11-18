import type { GhRunner } from "./gh.ts";
import type { MergePolicy } from "./merge-policy.ts";

const PAGE = "pageInfo { hasNextPage endCursor }";
const MATCHES = `${PAGE} nodes { id }`;
const CONTEXTS = `${PAGE} nodes {
  __typename
  ... on CheckRun { id name status conclusion checkSuite { id app { databaseId } } }
  ... on StatusContext { id context state creator { login } }
}`;

export const MERGE_QUERY = `query MergeEvidence(
  $owner: String!, $name: String!, $number: Int!,
  $reviews: String, $threads: String, $contexts: String, $suites: String,
  $readReviews: Boolean!, $readThreads: Boolean!, $readContexts: Boolean!, $readSuites: Boolean!
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid baseRefOid mergeable mergeStateStatus reviewDecision
      reviews(first: 100, after: $reviews) @include(if: $readReviews) {
        ${PAGE} nodes { id state submittedAt commit { oid } author { __typename login ... on User { id } } }
      }
      reviewThreads(first: 100, after: $threads) @include(if: $readThreads) {
        ${PAGE} nodes { id isResolved }
      }
      commits(last: 1) { nodes { commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100, after: $contexts) @include(if: $readContexts) { ${CONTEXTS} }
        }
        checkSuites(first: 100, after: $suites) @include(if: $readSuites) {
          ${PAGE} nodes {
            id status conclusion repository { nameWithOwner }
            workflowRun { id event runNumber runAttempt workflow { id } }
            matchingPullRequests(first: 100) { ${MATCHES} }
          }
        }
      } } }
    }
  }
}`;

const MATCH_QUERY = `query SuitePullRequests($id: ID!, $after: String!) {
  node(id: $id) { ... on CheckSuite { matchingPullRequests(first: 100, after: $after) { ${MATCHES} } } }
}`;
const TEST_MERGE_QUERY = `query TestMergeEvidence($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    oid statusCheckRollup { state contexts(first: 100, after: $after) { ${CONTEXTS} } }
  } } }
}`;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a GitHub object");
  return value as ObjectValue;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected a GitHub list");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("expected a non-empty GitHub string");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expected a GitHub integer");
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("expected a GitHub boolean");
  return value;
}
function oneOf<const T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error(`unexpected GitHub enum value ${JSON.stringify(value)}`);
  return value as T;
}
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

const STATUS = ["COMPLETED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"] as const;
const CONCLUSION = ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "NEUTRAL", "SKIPPED", "STALE", "STARTUP_FAILURE", "SUCCESS", "TIMED_OUT"] as const;
const ROLLUP = ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"] as const;

function readContext(value: unknown) {
  const row = object(value);
  const id = text(row.id);
  if (row.__typename === "StatusContext") {
    return { id, kind: "status" as const, name: text(row.context), state: oneOf(row.state, ROLLUP),
      creator: nullable(row.creator, (actor) => text(object(actor).login)) };
  }
  oneOf(row.__typename, ["CheckRun"]);
  const suite = object(row.checkSuite);
  return { id, kind: "check" as const, name: text(row.name), status: oneOf(row.status, STATUS),
    conclusion: nullable(row.conclusion, (state) => oneOf(state, CONCLUSION)),
    suite: text(suite.id), app: nullable(suite.app, (app) => nullable(object(app).databaseId, integer)) };
}
function readReview(value: unknown) {
  const row = object(value);
  return { id: text(row.id), state: oneOf(row.state, ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    submittedAt: nullable(row.submittedAt, text), commit: nullable(row.commit, (commit) => text(object(commit).oid)),
    author: nullable(row.author, (value) => {
      const actor = object(value);
      return { login: text(actor.login), userId: actor.__typename === "User" ? text(actor.id) : null };
    }) };
}
function readThread(value: unknown) {
  const row = object(value);
  return { id: text(row.id), resolved: flag(row.isResolved) };
}
function readSuite(value: unknown) {
  const row = object(value);
  const matches = connection((node) => ({ id: text(object(node).id) }));
  append(matches, row.matchingPullRequests);
  return { id: text(row.id), status: oneOf(row.status, STATUS),
    repo: nullable(row.repository, (repo) => text(object(repo).nameWithOwner)),
    conclusion: nullable(row.conclusion, (state) => oneOf(state, CONCLUSION)), matches,
    workflow: nullable(row.workflowRun, (value) => {
      const run = object(value);
      return { id: text(run.id), event: text(run.event), runNumber: integer(run.runNumber),
        attempt: integer(run.runAttempt), workflowId: text(object(run.workflow).id) };
    }) };
}

interface Connection<T> {
  cursor: string | null;
  done: boolean;
  seenCursors: Set<string>;
  nodes: Map<string, T>;
  read: (value: unknown) => T;
}
function connection<T extends { id: string }>(read: (value: unknown) => T): Connection<T> {
  return { cursor: null, done: false, seenCursors: new Set(), nodes: new Map(), read };
}
function append<T extends { id: string }>(target: Connection<T>, value: unknown): void {
  const page = object(value);
  for (const node of list(page.nodes)) {
    const parsed = target.read(node);
    target.nodes.set(parsed.id, parsed);
  }
  const info = object(page.pageInfo);
  target.done = !flag(info.hasNextPage);
  target.cursor = nullable(info.endCursor, text);
  if (!target.done) {
    if (target.cursor === null || target.seenCursors.has(target.cursor)) throw new Error("GitHub pagination did not advance");
    target.seenCursors.add(target.cursor);
  }
}

const REST_VERSION = "X-GitHub-Api-Version: 2022-11-28";
async function rest(gh: GhRunner, path: string, paginated = false): Promise<unknown> {
  return JSON.parse(await gh(["api", "--method", "GET", "-H", REST_VERSION,
    ...(paginated ? ["--paginate", "--slurp"] : []), path]));
}
async function graphql(gh: GhRunner, query: string, fields: string[]): Promise<ObjectValue> {
  const result = object(JSON.parse(await gh(["api", "graphql", "-f", `query=${query}`, ...fields])));
  if (result.errors !== undefined && list(result.errors).length > 0) {
    throw new Error(`GitHub GraphQL: ${list(result.errors).map((error) => text(object(error).message)).join("; ")}`);
  }
  return object(result.data);
}
function pull(value: unknown) {
  const row = object(value);
  function ref(value: unknown) {
    const ref = object(value);
    return { name: text(ref.ref), sha: text(ref.sha), repo: nullable(ref.repo, (repo) => text(object(repo).full_name)) };
  }
  return { number: integer(row.number), state: oneOf(row.state, ["open", "closed"]), draft: flag(row.draft),
    mergeable: nullable(row.mergeable, flag), head: ref(row.head), base: ref(row.base),
    author: nullable(row.user, (user) => ({ id: text(object(user).node_id), login: text(object(user).login) })),
    mergedAt: nullable(row.merged_at, text),
    mergedBy: nullable(row.merged_by, (user) => ({ id: integer(object(user).id), login: text(object(user).login) })),
    mergeCommit: nullable(row.merge_commit_sha, text) };
}

export interface Requirements {
  checks: { name: string; app: number | null }[];
  approvals: number;
  strict: boolean;
  unsupported: string[];
}

function classic(value: unknown, requirements: Requirements): void {
  const row = object(value);
  text(row.url);
  // A successful classic-protection response omits disabled sections.
  if (row.required_status_checks != null) {
    const settings = object(row.required_status_checks);
    requirements.strict ||= flag(settings.strict);
    const checks = list(settings.checks);
    for (const check of checks) {
      const entry = object(check);
      requirements.checks.push({ name: text(entry.context), app: entry.app_id === -1 ? null : nullable(entry.app_id, integer) });
    }
    for (const context of list(settings.contexts).map(text)) {
      if (!requirements.checks.some((check) => check.name === context)) requirements.checks.push({ name: context, app: null });
    }
  }
  if (row.required_pull_request_reviews != null) {
    const review = object(row.required_pull_request_reviews);
    requirements.approvals = integer(review.required_approving_review_count);
    if (flag(review.require_code_owner_reviews) || flag(review.dismiss_stale_reviews) || flag(review.require_last_push_approval)) {
      requirements.unsupported.push("classic protection requires code-owner, stale-review, or last-push checks");
    }
  }
  if (row.restrictions != null) requirements.unsupported.push("classic protection restricts pushes");
  for (const feature of ["required_signatures", "lock_branch", "required_deployments"]) {
    if (row[feature] != null && flag(object(row[feature]).enabled)) requirements.unsupported.push(feature);
  }
}

function activeRule(value: unknown, requirements: Requirements): void {
  const rule = object(value);
  const type = text(rule.type);
  if (type === "required_status_checks") {
    const settings = object(rule.parameters);
    requirements.strict ||= flag(settings.strict_required_status_checks_policy);
    for (const check of list(settings.required_status_checks).map(object)) {
      requirements.checks.push({ name: text(check.context), app: check.integration_id === undefined ? null : integer(check.integration_id) });
    }
  } else if (type === "pull_request") {
    const review = object(rule.parameters);
    requirements.approvals = Math.max(requirements.approvals, integer(review.required_approving_review_count));
    if (flag(review.require_code_owner_review) || flag(review.dismiss_stale_reviews_on_push) || flag(review.require_last_push_approval)) {
      requirements.unsupported.push("rules require code-owner, stale-review, or last-push checks");
    }
    if (review.allowed_merge_methods !== undefined && !list(review.allowed_merge_methods).map(text).includes("squash")) {
      requirements.unsupported.push("rules disallow squash merging");
    }
  } else if (!["creation", "deletion", "non_fast_forward", "required_linear_history"].includes(type)) {
    requirements.unsupported.push(type);
  }
}

async function branchRequirements(gh: GhRunner, repo: string, branch: string) {
  const requirements: Requirements = { checks: [], approvals: 0, strict: false, unsupported: [] };
  try {
    const protection = await rest(gh, `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`)
      .then(object).catch((error: unknown) => {
        // GitHub specifically reports this message for an unprotected branch. A generic 404 can hide denied access.
        if (error instanceof Error && /(?:^|: )gh: Branch not protected \(HTTP 404\)$/.test(error.message)) return null;
        throw error;
      });
    if (protection !== null) classic(protection, requirements);
    const rules = list(await rest(gh, `repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, true));
    for (const page of rules) for (const rule of list(page)) activeRule(rule, requirements);
    return { requirements, error: null };
  } catch (error) {
    return { requirements: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function effectiveReviews(reviews: readonly ReturnType<typeof readReview>[]) {
  const decisive = new Map<string, ReturnType<typeof readReview>>();
  for (const review of [...reviews].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    const key = review.author?.userId ?? review.author?.login.toLowerCase() ?? review.id;
    if (review.state === "DISMISSED") decisive.delete(key);
    else decisive.set(key, review);
  }
  return [...decisive.values()];
}

async function reviewerPermissions(gh: GhRunner, repo: string, pr: ReturnType<typeof pull>,
  reviews: readonly ReturnType<typeof readReview>[], policy: MergePolicy, required: number) {
  const writable: string[] = [];
  if (policy.strategy !== "approvals" && required === 0) return writable;
  for (const review of effectiveReviews(reviews)) {
    if (review.state !== "APPROVED" || review.commit !== pr.head.sha || review.submittedAt === null ||
        review.author === null || review.author.userId === null || pr.author === null) continue;
    const { login } = review.author;
    if (review.author.userId === pr.author.id || login.toLowerCase() === pr.author.login.toLowerCase()) continue;
    // A policy allowlist limits policy approvals only. GitHub's required review count is separate.
    if (required === 0 && policy.strategy === "approvals" && policy.approvers.length > 0 && !policy.approvers.includes(login.toLowerCase())) continue;
    const permission = object(await rest(gh, `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`));
    if (["write", "maintain", "admin"].includes(text(permission.permission))) writable.push(review.author.userId);
  }
  return writable;
}

async function testMergeRollup(gh: GhRunner, repoFields: string[], oid: string) {
  const contexts = connection(readContext);
  let state: (typeof ROLLUP)[number] | null;
  do {
    const data = await graphql(gh, TEST_MERGE_QUERY, [...repoFields, "-f", `oid=${oid}`,
      ...(contexts.cursor === null ? [] : ["-f", `after=${contexts.cursor}`])]);
    const commit = object(object(data.repository).object);
    if (text(commit.oid) !== oid) throw new Error("test merge commit changed while reading checks");
    if (commit.statusCheckRollup === null) {
      if (contexts.cursor !== null) throw new Error("test merge check rollup disappeared during pagination");
      return null;
    }
    const rollup = object(commit.statusCheckRollup);
    state = oneOf(rollup.state, ROLLUP);
    append(contexts, rollup.contexts);
  } while (!contexts.done);
  return { state, contexts: [...contexts.nodes.values()] };
}

/** A fresh read of a single PR. REST supplies branch requirements, never CI. */
export async function readMergeEvidence(gh: GhRunner, repo: string, number: number, policy: MergePolicy) {
  const pr = pull(await rest(gh, `repos/${repo}/pulls/${number}`));
  if (pr.number !== number || pr.base.repo?.toLowerCase() !== repo.toLowerCase()) throw new Error("GitHub returned a different pull request");
  const settings = object(await rest(gh, `repos/${repo}`));
  const squashAllowed = flag(settings.allow_squash_merge);
  const [owner, name] = repo.split("/");
  const repoFields = ["-f", `owner=${owner}`, "-f", `name=${name}`];
  const reviews = connection(readReview), threads = connection(readThread);
  const contexts = connection(readContext), suites = connection(readSuite);
  const pages = { Reviews: reviews, Threads: threads, Contexts: contexts, Suites: suites };
  let snapshot;
  do {
    const fields = [...repoFields, "-F", `number=${number}`];
    for (const [key, page] of Object.entries(pages)) {
      fields.push("-F", `read${key}=${!page.done}`);
      if (!page.done && page.cursor !== null) fields.push("-f", `${key.toLowerCase()}=${page.cursor}`);
    }
    const data = await graphql(gh, MERGE_QUERY, fields);
    const gql = object(object(data.repository).pullRequest);
    const commit = object(object(list(object(gql.commits).nodes)[0]).commit);
    if (text(gql.headRefOid) !== pr.head.sha || text(gql.baseRefOid) !== pr.base.sha || text(commit.oid) !== pr.head.sha) {
      throw new Error("pull request head or base changed while reading merge evidence");
    }
    const rollup = nullable(commit.statusCheckRollup, object);
    const current = {
      id: text(gql.id), mergeable: oneOf(gql.mergeable, ["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
      mergeState: oneOf(gql.mergeStateStatus, ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"]),
      reviewDecision: nullable(gql.reviewDecision, (state) => oneOf(state, ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])),
      rollupState: rollup === null ? null : oneOf(rollup.state, ROLLUP),
    };
    if (snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(current)) {
      throw new Error("pull request merge, review or check state changed during pagination");
    }
    snapshot = current;
    if (!reviews.done) append(reviews, gql.reviews);
    if (!threads.done) append(threads, gql.reviewThreads);
    if (!suites.done) append(suites, commit.checkSuites);
    if (rollup === null) contexts.done = true;
    else if (!contexts.done) append(contexts, rollup.contexts);
  } while (Object.values(pages).some((page) => !page.done));

  const workflows = [];
  for (const { matches, ...suite } of suites.nodes.values()) {
    while (!matches.done && suite.workflow !== null) {
      const data = await graphql(gh, MATCH_QUERY, ["-f", `id=${suite.id}`, "-f", `after=${matches.cursor}`]);
      append(matches, object(data.node).matchingPullRequests);
    }
    workflows.push({ ...suite, matches: matches.nodes.has(snapshot.id) });
  }
  const protection = await branchRequirements(gh, repo, pr.base.name);
  const required = protection.requirements?.approvals ?? 0;
  const checkedReviews = [...reviews.nodes.values()];
  const writableReviewers = await reviewerPermissions(gh, repo, pr, checkedReviews, policy, required);
  // A test merge commit can carry the required status. Read it when branch settings require checks.
  const testMerge = pr.state === "open" && pr.mergeable === true && pr.mergeCommit !== null && pr.mergeCommit !== pr.head.sha &&
    (protection.requirements?.checks.length ?? 0) > 0 ? await testMergeRollup(gh, repoFields, pr.mergeCommit) : null;
  return { pr, ...snapshot, squashAllowed, protection, testMerge, writableReviewers,
    reviews: checkedReviews, threads: [...threads.nodes.values()], contexts: [...contexts.nodes.values()], suites: workflows };
}

export type MergeEvidence = Awaited<ReturnType<typeof readMergeEvidence>>;
