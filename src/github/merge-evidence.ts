// Read-only GitHub contract for docs/merging.md. No Actions/REST CI reader: rollup and suite
// provenance are read together. A denied requirements read stays a block, never an empty policy.
import type { GhRunner } from "./gh.ts";

export const MERGE_API_VERSION = "2022-11-28";
export const MERGE_QUERY = `query OstromMergeEvidence($owner: String!, $name: String!, $number: Int!,
  $reviews: String, $threads: String, $contexts: String, $suites: String,
  $readReviews: Boolean!, $readThreads: Boolean!, $readContexts: Boolean!, $readSuites: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid baseRefOid mergeStateStatus reviewDecision
      reviews(first: 100, after: $reviews) @include(if: $readReviews) {
        nodes { id databaseId state submittedAt author { login } commit { oid } }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: 100, after: $threads) @include(if: $readThreads) {
        nodes { id isResolved isOutdated }
        pageInfo { hasNextPage endCursor }
      }
      headRef { target { ... on Commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100, after: $contexts) @include(if: $readContexts) {
            nodes {
              __typename
              ... on CheckRun { id databaseId name status conclusion checkSuite { id app { databaseId slug } } }
              ... on StatusContext { id context state creator { login } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        checkSuites(first: 100, after: $suites) @include(if: $readSuites) {
          nodes {
            id status conclusion app { databaseId slug }
            matchingPullRequests(first: 100) { nodes { number } pageInfo { hasNextPage endCursor } }
            workflowRun { databaseId event runNumber runAttempt workflow { databaseId name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      } } }
    }
  }
}`;

export type ObjectValue = Record<string, unknown>;
export type ReadAnswer = { readable: true; value: unknown } | { readable: false; error: string };
export interface MergeEvidence {
  repo: string;
  number: number;
  pr: ObjectValue;
  repository: ObjectValue;
  mergeState: string;
  reviewDecision: string | null;
  commitOid: string;
  rollupState: string | null;
  contexts: ObjectValue[];
  suites: ObjectValue[];
  threads: ObjectValue[];
  reviews: ObjectValue[];
  protection: ReadAnswer;
  rules: ReadAnswer;
  reviewerPermissions: Record<string, string>;
}

export async function mergeRest(gh: GhRunner, path: string): Promise<unknown> {
  return JSON.parse(await gh(["api", "--method", "GET", "-H", `X-GitHub-Api-Version: ${MERGE_API_VERSION}`, path]));
}

export async function readMergeEvidence(gh: GhRunner, repo: string, number: number): Promise<MergeEvidence> {
  const pr = object(await mergeRest(gh, `repos/${repo}/pulls/${number}`));
  validatePullRequest(pr);
  if (pr["number"] !== number) throw new Error("merge evidence PR number mismatch");
  const repository = object(await mergeRest(gh, `repos/${repo}`));
  boolean(repository, "allow_squash_merge");
  if (text(repository, "full_name").toLowerCase() !== repo.toLowerCase()) throw new Error("merge evidence repository mismatch");
  const base = object(pr["base"]);
  const branch = encodeURIComponent(text(base, "ref"));
  const protection = await answer(() => mergeRest(gh, `repos/${repo}/branches/${branch}/protection`));
  const rules = await answer(() => restPages(gh, `repos/${repo}/rules/branches/${branch}`));
  const graph = await readMergeGraph(gh, repo, number);
  if (graph.head !== text(object(pr["head"]), "sha") || graph.base !== text(base, "sha") || graph.commitOid !== graph.head) {
    throw new Error("merge evidence head/base changed during read");
  }
  // REST preserves submitted review order and exposes stable user IDs and deleted users.
  const reviews = await restPages(gh, `repos/${repo}/pulls/${number}/reviews`);
  for (const review of reviews) validateReview(review);
  const graphReviews = new Map(graph.reviews.map((review) => [String(review["databaseId"]), review]));
  for (const review of reviews) {
    const other = graphReviews.get(String(review["id"]));
    if (other === undefined || other["state"] !== review["state"] ||
        (other["commit"] === null ? null : text(object(other["commit"]), "oid")) !== review["commit_id"]) {
      throw new Error("review evidence changed during read");
    }
  }
  const restIds = new Set(reviews.map((review) => String(review["id"])));
  if (graph.reviews.some((review) => !restIds.has(String(review["databaseId"])))) throw new Error("review evidence changed during read");
  const reviewerPermissions: Record<string, string> = {};
  for (const review of reviews) {
    if (review["state"] !== "APPROVED" || review["user"] === null) continue;
    const user = object(review["user"]);
    const login = text(user, "login").toLowerCase();
    if (reviewerPermissions[login] !== undefined) continue;
    const permission = await answer(() => mergeRest(gh, `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`));
    reviewerPermissions[login] = permission.readable ? text(object(permission.value), "permission") : "unreadable";
  }
  return { repo, number, pr, repository, protection, rules, reviews, reviewerPermissions,
    mergeState: graph.mergeState, reviewDecision: graph.reviewDecision, commitOid: graph.commitOid,
    rollupState: graph.rollupState, contexts: graph.contexts, suites: graph.suites, threads: graph.threads };
}

const CONNECTIONS = ["reviews", "threads", "contexts", "suites"] as const;
type ConnectionName = (typeof CONNECTIONS)[number];
interface ConnectionState { cursor: string | null; done: boolean; seen: Set<string>; nodes: Map<string, ObjectValue> }

/** Every connection retains its terminal cursor and stops being requested once exhausted. */
export async function readMergeGraph(gh: GhRunner, repo: string, number: number) {
  const [owner, name] = repo.split("/");
  const connections = Object.fromEntries(CONNECTIONS.map((key) => [key, {
    cursor: null, done: false, seen: new Set<string>(), nodes: new Map<string, ObjectValue>(),
  }])) as Record<ConnectionName, ConnectionState>;
  let snapshot: { head: string; base: string; mergeState: string; reviewDecision: string | null; commitOid: string; rollupState: string | null } | undefined;
  while (CONNECTIONS.some((key) => !connections[key].done)) {
    const variables: ObjectValue = { owner, name, number };
    for (const key of CONNECTIONS) {
      variables[key] = connections[key].cursor;
      variables[`read${key[0]!.toUpperCase()}${key.slice(1)}`] = !connections[key].done;
    }
    const response = object(JSON.parse(await gh(["api", "graphql", "-f", `query=${MERGE_QUERY}`].concat(
      // gh's typed fields preserve booleans, integers and explicit null cursors.
      Object.entries(variables).flatMap(([key, value]) => [typeof value === "string" ? "-f" : "-F", `${key}=${value}`]),
    ))));
    if (response["errors"] !== undefined) throw new Error(`merge GraphQL errors: ${JSON.stringify(response["errors"])}`);
    const pr = object(object(object(response["data"])["repository"])["pullRequest"]);
    const commit = object(object(pr["headRef"])["target"]);
    const rollup = commit["statusCheckRollup"] === null ? null : object(commit["statusCheckRollup"]);
    const current = {
      head: text(pr, "headRefOid"), base: text(pr, "baseRefOid"),
      mergeState: enumValue(pr, "mergeStateStatus", ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"]),
      reviewDecision: nullableEnum(pr, "reviewDecision", ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
      commitOid: text(commit, "oid"),
      rollupState: rollup === null ? null : enumValue(rollup, "state", ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
    };
    if (snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(current)) throw new Error("merge GraphQL evidence changed during pagination");
    snapshot = current;
    for (const key of CONNECTIONS) {
      if (connections[key].done) continue;
      if (key === "contexts" && rollup === null) { connections[key].done = true; continue; }
      const raw = key === "contexts" ? rollup!["contexts"] : key === "suites" ? commit["checkSuites"] : pr[key === "threads" ? "reviewThreads" : "reviews"];
      collect(connections[key], raw, key);
    }
  }
  return { ...snapshot!, ...Object.fromEntries(CONNECTIONS.map((key) => [key, [...connections[key].nodes.values()]])) as Record<ConnectionName, ObjectValue[]> };
}

function collect(state: ConnectionState, raw: unknown, name: ConnectionName): void {
  const connection = object(raw);
  for (const node of objects(connection["nodes"])) {
    validateNode(name, node);
    const id = text(node, "id");
    const previous = state.nodes.get(id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(node)) throw new Error(`${name} evidence changed during pagination`);
    state.nodes.set(id, node);
  }
  const page = object(connection["pageInfo"]);
  const more = boolean(page, "hasNextPage");
  const cursor = page["endCursor"];
  if (cursor !== null && typeof cursor !== "string") throw new Error("invalid GraphQL endCursor");
  if (more && (cursor === null || state.seen.has(cursor))) throw new Error(`non-advancing ${name} cursor`);
  if (cursor !== null) { state.cursor = cursor; state.seen.add(cursor); }
  state.done = !more;
}

const CHECK_STATUSES = ["COMPLETED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"];
const CONCLUSIONS = ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "NEUTRAL", "SKIPPED", "STALE", "STARTUP_FAILURE", "SUCCESS", "TIMED_OUT"];
function validateNode(name: ConnectionName, node: ObjectValue): void {
  text(node, "id");
  if (name === "threads") { boolean(node, "isResolved"); boolean(node, "isOutdated"); }
  if (name === "reviews") {
    integer(node, "databaseId");
    enumValue(node, "state", ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
    if (node["submittedAt"] !== null) text(node, "submittedAt");
    if (node["author"] !== null) text(object(node["author"]), "login");
    if (node["commit"] !== null) text(object(node["commit"]), "oid");
  }
  if (name === "contexts") {
    const kind = enumValue(node, "__typename", ["CheckRun", "StatusContext"]);
    if (kind === "StatusContext") {
      text(node, "context"); enumValue(node, "state", ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]);
      if (node["creator"] !== null) text(object(node["creator"]), "login");
    } else {
      integer(node, "databaseId"); text(node, "name");
      enumValue(node, "status", CHECK_STATUSES); nullableEnum(node, "conclusion", CONCLUSIONS);
      const suite = object(node["checkSuite"]); text(suite, "id"); validateApp(suite["app"]);
    }
  }
  if (name === "suites") {
    enumValue(node, "status", CHECK_STATUSES); nullableEnum(node, "conclusion", CONCLUSIONS); validateApp(node["app"]);
    if (node["workflowRun"] !== null) {
      const run = object(node["workflowRun"]);
      integer(run, "databaseId"); text(run, "event"); integer(run, "runNumber"); integer(run, "runAttempt");
      integer(object(run["workflow"]), "databaseId"); text(object(run["workflow"]), "name");
      const prs = object(node["matchingPullRequests"]);
      for (const pr of objects(prs["nodes"])) integer(pr, "number");
      // A truncated provenance connection cannot prove which PR this workflow tested.
      if (boolean(object(prs["pageInfo"]), "hasNextPage")) throw new Error("workflow PR provenance is truncated");
    }
  }
}
function validateApp(raw: unknown): void { if (raw !== null) { integer(object(raw), "databaseId"); text(object(raw), "slug"); } }
function validatePullRequest(pr: ObjectValue): void {
  integer(pr, "number"); enumValue(pr, "state", ["open", "closed"]); boolean(pr, "draft");
  if (pr["mergeable"] !== null) boolean(pr, "mergeable");
  for (const key of ["head", "base"]) {
    const ref = object(pr[key]); text(ref, "sha"); text(ref, "ref");
    if (ref["repo"] !== null) text(object(ref["repo"]), "full_name");
  }
  if (pr["user"] !== null) { integer(object(pr["user"]), "id"); text(object(pr["user"]), "login"); }
  if (pr["merged_at"] !== null) text(pr, "merged_at");
  if (pr["merge_commit_sha"] !== null) text(pr, "merge_commit_sha");
  if (pr["merged_by"] !== null) { integer(object(pr["merged_by"]), "id"); text(object(pr["merged_by"]), "login"); }
}
function validateReview(review: ObjectValue): void {
  integer(review, "id"); enumValue(review, "state", ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
  text(review, "commit_id");
  if (review["submitted_at"] !== null) text(review, "submitted_at");
  if (review["user"] !== null) {
    const user = object(review["user"]); integer(user, "id"); text(user, "login"); text(user, "type");
  }
}
async function restPages(gh: GhRunner, path: string): Promise<ObjectValue[]> {
  const found = new Map<string, ObjectValue>();
  for (let page = 1; ; page++) {
    const rows = objects(await mergeRest(gh, `${path}?per_page=100&page=${page}`));
    for (const row of rows) found.set(row["id"] === undefined ? JSON.stringify(row) : String(row["id"]), row);
    if (rows.length < 100) return [...found.values()];
  }
}
async function answer(read: () => Promise<unknown>): Promise<ReadAnswer> {
  try { return { readable: true, value: await read() }; }
  catch (error) { return { readable: false, error: error instanceof Error ? error.message : String(error) }; }
}
export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("merge evidence: expected object");
  return value as ObjectValue;
}
export function objects(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) throw new Error("merge evidence: expected list");
  return value.map(object);
}
export function text(value: ObjectValue, key: string): string {
  if (typeof value[key] !== "string") throw new Error(`merge evidence: missing string ${key}`);
  return value[key];
}
export function integer(value: ObjectValue, key: string): number {
  if (!Number.isSafeInteger(value[key])) throw new Error(`merge evidence: missing integer ${key}`);
  return value[key] as number;
}
export function boolean(value: ObjectValue, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error(`merge evidence: missing boolean ${key}`);
  return value[key];
}
function enumValue(value: ObjectValue, key: string, allowed: string[]): string {
  const result = text(value, key);
  if (!allowed.includes(result)) throw new Error(`merge evidence: unknown ${key}: ${result}`);
  return result;
}
function nullableEnum(value: ObjectValue, key: string, allowed: string[]): string | null {
  return value[key] === null ? null : enumValue(value, key, allowed);
}
