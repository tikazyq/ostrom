import { boolean, integer, object, objects, text, type MergeEvidence, type ObjectValue } from "./merge-evidence.ts";
import type { MergePolicy } from "./merge-policy.ts";

export interface MergeEligibility { eligible: boolean; blockers: string[] }
export interface MergeIdentity { branch: string; base: string }
interface RequiredCheck { name: string; appId: number | null }

/** GitHub evidence only. Local ownership, idle/stop and quiet time remain separate prerequisites. */
export function mergeEligibility(evidence: MergeEvidence, policy: MergePolicy, identity: MergeIdentity): MergeEligibility {
  const blockers: string[] = [];
  const block = (reason: string) => { if (!blockers.includes(reason)) blockers.push(reason); };
  const result = () => ({ eligible: blockers.length === 0, blockers });
  if (policy.strategy === "human") { block("waiting for a human merge"); return result(); }
  const { pr } = evidence;
  const head = object(pr["head"]);
  const base = object(pr["base"]);
  // Fork evidence must never become a CI question: workflows may run in a different repository.
  if (head["repo"] === null || base["repo"] === null ||
      text(object(head["repo"]), "full_name").toLowerCase() !== evidence.repo.toLowerCase() ||
      text(object(head["repo"]), "full_name").toLowerCase() !== text(object(base["repo"]), "full_name").toLowerCase()) {
    block("head and base repositories differ or are unavailable"); return result();
  }
  if (text(head, "ref") !== identity.branch || text(base, "ref") !== identity.base) block("PR branch does not match the Worker branch/base");
  if (pr["state"] !== "open" || pr["merged_at"] !== null) block("PR is not open");
  if (pr["draft"] !== false) block("PR is draft");
  if (pr["mergeable"] !== true || evidence.mergeState !== "CLEAN") block("PR merge state is not CLEAN and mergeable");
  if (evidence.repository["allow_squash_merge"] !== true) block("repository does not allow squash merging");
  if (text(head, "sha") !== evidence.commitOid) block("rollup is not on the captured head");

  const required: RequiredCheck[] = [];
  let requiredApprovals = policy.strategy === "approvals" ? policy.approvals : 0;
  if (!evidence.protection.readable) block(`classic protection unreadable: ${evidence.protection.error}`);
  else {
    try {
      const protection = object(evidence.protection.value);
      // A successful protection response must identify itself; {} is not proof of no requirements.
      text(protection, "url");
      for (const key of ["required_signatures", "lock_branch"]) {
        if (protection[key] !== undefined && boolean(object(protection[key]), "enabled")) block(`unsupported classic protection: ${key}`);
      }
      if (protection["restrictions"] !== undefined && protection["restrictions"] !== null) block("classic push restrictions require operator action");
      const checks = protection["required_status_checks"];
      if (checks !== undefined && checks !== null) {
        const settings = object(checks);
        boolean(settings, "strict");
        for (const check of objects(settings["checks"])) {
          const appId = check["app_id"] === null ? null : integer(check, "app_id");
          required.push({ name: text(check, "context"), appId: appId === -1 ? null : appId });
        }
        // Older context-only entries still express requirements, with any app allowed.
        if (!Array.isArray(settings["contexts"]) || settings["contexts"].some((name) => typeof name !== "string")) throw new Error("invalid required contexts");
        for (const name of settings["contexts"] as string[]) {
          if (!required.some((check) => check.name === name)) required.push({ name, appId: null });
        }
      }
      const reviews = protection["required_pull_request_reviews"];
      if (reviews !== undefined && reviews !== null) {
        const settings = object(reviews);
        requiredApprovals = Math.max(requiredApprovals, integer(settings, "required_approving_review_count"));
        boolean(settings, "dismiss_stale_reviews");
        if (boolean(settings, "require_code_owner_reviews")) block("code owner approval requirements are not established");
        if (boolean(settings, "require_last_push_approval")) block("last-push approval requirements are not established");
      }
    } catch (error) { block(`classic protection unsupported: ${message(error)}`); }
  }
  if (!evidence.rules.readable) block(`branch rules unreadable: ${evidence.rules.error}`);
  else {
    try {
      for (const rule of objects(evidence.rules.value)) {
        const type = text(rule, "type");
        if (type === "required_status_checks") {
          const settings = object(rule["parameters"]);
          boolean(settings, "strict_required_status_checks_policy");
          for (const check of objects(settings["required_status_checks"])) {
            const appId = check["integration_id"] === null ? null : integer(check, "integration_id");
            required.push({ name: text(check, "context"), appId });
          }
        } else if (type === "pull_request") {
          const settings = object(rule["parameters"]);
          requiredApprovals = Math.max(requiredApprovals, integer(settings, "required_approving_review_count"));
          boolean(settings, "dismiss_stale_reviews_on_push");
          boolean(settings, "required_review_thread_resolution");
          if (boolean(settings, "require_code_owner_review")) block("code owner approval requirements are not established");
          if (boolean(settings, "require_last_push_approval")) block("last-push approval requirements are not established");
          if (settings["allowed_merge_methods"] !== undefined &&
              (!Array.isArray(settings["allowed_merge_methods"]) || !settings["allowed_merge_methods"].includes("squash"))) block("branch rule does not allow squash merging");
        } else if (!["deletion", "non_fast_forward", "required_linear_history"].includes(type)) {
          block(`unsupported enforced branch rule: ${type}`);
        }
      }
    } catch (error) { block(`branch rules unsupported: ${message(error)}`); }
  }
  if (evidence.reviewDecision === "CHANGES_REQUESTED" || evidence.reviewDecision === "REVIEW_REQUIRED") block(`GitHub review decision: ${evidence.reviewDecision}`);
  if (evidence.threads.some((thread) => thread["isResolved"] !== true)) block("unresolved review threads");
  const decisive = new Map<number, ObjectValue>();
  for (const review of evidence.reviews) {
    if (review["state"] === "PENDING") continue;
    if (review["user"] === null) { block("submitted review has a deleted/unknown reviewer"); continue; }
    if (review["submitted_at"] === null) { block("submitted review has no submission time"); continue; }
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(text(review, "state"))) {
      decisive.set(integer(object(review["user"]), "id"), review);
    }
  }
  if ([...decisive.values()].some((review) => review["state"] === "CHANGES_REQUESTED")) block("outstanding changes requested");
  let approvals = 0;
  const authorId = pr["user"] === null ? null : integer(object(pr["user"]), "id");
  if (requiredApprovals > 0 && authorId === null) block("PR author identity is unavailable for approval counting");
  for (const [id, review] of decisive) {
    const user = object(review["user"]);
    const login = text(user, "login").toLowerCase();
    if (review["state"] !== "APPROVED" || review["commit_id"] !== evidence.commitOid || id === authorId || user["type"] !== "User") continue;
    if (!["write", "maintain", "admin"].includes(evidence.reviewerPermissions[login] ?? "")) continue;
    if (policy.strategy === "approvals" && policy.approvers.length > 0 && !policy.approvers.includes(login)) continue;
    approvals++;
  }
  if (approvals < requiredApprovals) block(`current-head approvals ${approvals}/${requiredApprovals}`);

  if (evidence.rollupState !== "SUCCESS" || evidence.contexts.length === 0) block("head check rollup is not a nonempty SUCCESS");
  for (const context of evidence.contexts) {
    if (context["__typename"] === "CheckRun") {
      if (context["status"] !== "COMPLETED" || !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(context["conclusion"]))) block(`check is not successful: ${context["name"]}`);
    } else if (context["state"] !== "SUCCESS") block(`status is not successful: ${context["context"]}`);
  }
  for (const check of required) {
    if (!evidence.contexts.some((context) => context["__typename"] === "CheckRun"
      ? context["name"] === check.name && (check.appId === null || (object(context["checkSuite"])["app"] !== null && object(object(context["checkSuite"])["app"])["databaseId"] === check.appId))
      : context["context"] === check.name && check.appId === null)) block(`required check missing or wrong app: ${check.name}`);
  }
  const workflows = new Map<number, { suite: ObjectValue; run: ObjectValue }>();
  for (const suite of evidence.suites) {
    if (suite["workflowRun"] === null) continue; // GitHub creates queued suites even when no workflow is dispatched.
    const run = object(suite["workflowRun"]);
    if (suite["status"] !== "COMPLETED") block("workflow suite is incomplete");
    const workflow = integer(object(run["workflow"]), "databaseId");
    const old = workflows.get(workflow);
    if (old === undefined) { workflows.set(workflow, { suite, run }); continue; }
    const runNumber = integer(run, "runNumber"), oldNumber = integer(old.run, "runNumber");
    const attempt = integer(run, "runAttempt"), oldAttempt = integer(old.run, "runAttempt");
    if (runNumber === oldNumber && attempt === oldAttempt && suite["id"] !== old.suite["id"]) block("ambiguous workflow suite ordering");
    if (runNumber > oldNumber || (runNumber === oldNumber && attempt > oldAttempt)) workflows.set(workflow, { suite, run });
  }
  let successfulPrWorkflow = false;
  for (const { suite, run } of workflows.values()) {
    if (suite["status"] !== "COMPLETED" || suite["conclusion"] !== "SUCCESS") { block("latest workflow suite is not successful"); continue; }
    if (run["event"] !== "pull_request" || !objects(object(suite["matchingPullRequests"])["nodes"]).some((pr) => pr["number"] === evidence.number)) continue;
    if (evidence.contexts.some((context) => context["__typename"] === "CheckRun" && context["status"] === "COMPLETED" && context["conclusion"] === "SUCCESS" && object(context["checkSuite"])["id"] === suite["id"])) successfulPrWorkflow = true;
  }
  if (!successfulPrWorkflow) block("no successful pull_request workflow check on the head");
  return result();
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
