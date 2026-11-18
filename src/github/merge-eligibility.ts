import type { MergeEvidence, Requirements } from "./merge-evidence.ts";
import { effectiveReviews } from "./merge-evidence.ts";
import type { MergePolicy } from "./merge-policy.ts";

type Context = MergeEvidence["contexts"][number];

function passing(context: Context): boolean {
  if (context.kind === "status") return context.state === "SUCCESS";
  return context.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion ?? "");
}

function ciBlock(evidence: MergeEvidence, requirements: Requirements): string | null {
  // A rerun can queue its suite while the contexts still describe the previous green attempt.
  if (evidence.suites.some((suite) => suite.workflow !== null && suite.status !== "COMPLETED")) {
    return "workflow suite is incomplete";
  }
  if (evidence.rollupState !== "SUCCESS" || !evidence.contexts.every(passing)) return "head check rollup is not green";

  const latest = new Map<string, { id: string; runNumber: number; attempt: number; conclusion: string | null; matches: boolean }>();
  for (const suite of evidence.suites) {
    const run = suite.workflow;
    if (run === null || run.event !== "pull_request" || suite.repo?.toLowerCase() !== evidence.pr.base.repo?.toLowerCase()) continue;
    const previous = latest.get(run.workflowId);
    if (previous !== undefined && previous.runNumber === run.runNumber && previous.attempt === run.attempt) {
      return "latest pull_request workflow suite is ambiguous";
    }
    if (previous === undefined || run.runNumber > previous.runNumber ||
        (run.runNumber === previous.runNumber && run.attempt > previous.attempt)) {
      latest.set(run.workflowId, { id: suite.id, runNumber: run.runNumber, attempt: run.attempt, conclusion: suite.conclusion, matches: suite.matches });
    }
  }
  const matching = [...latest.values()].filter((suite) => suite.matches);
  if (matching.some((suite) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(suite.conclusion ?? ""))) {
    return "latest pull_request workflow suite did not pass";
  }
  if (!matching.some((suite) => suite.conclusion === "SUCCESS" && evidence.contexts.some(
    (check) => check.kind === "check" && check.suite === suite.id && check.status === "COMPLETED" && check.conclusion === "SUCCESS",
  ))) return "no completed successful pull_request workflow and check for this PR on the head";

  for (const required of requirements.checks) {
    const onTestMerge = evidence.testMerge?.contexts.filter((context) => context.name === required.name) ?? [];
    const matches = onTestMerge.length > 0 ? onTestMerge : evidence.contexts.filter((context) => context.name === required.name);
    if (matches.length === 0 || !matches.every(passing) ||
        (required.app !== null && !matches.some((context) => context.kind === "check" && context.app === required.app))) {
      return `required check ${required.name} is missing or not passing with the required app`;
    }
  }
  return null;
}

/** First blocker on the GitHub evidence available in this slice. Local readiness is separate. */
export function mergeEvidenceBlock(evidence: MergeEvidence, policy: MergePolicy): string | null {
  const { pr, protection } = evidence;
  if (policy.strategy === "human") return "repository requires a human merge";
  if (pr.state !== "open" || pr.mergedAt !== null) return "pull request is not open";
  if (pr.head.repo === null || pr.base.repo === null || pr.head.repo.toLowerCase() !== pr.base.repo.toLowerCase()) {
    return "head is on a fork or its repository is unavailable";
  }
  if (pr.draft) return "pull request is a draft";
  if (protection.requirements === null) return `branch protection or rules unreadable (${protection.error})`;
  if (!evidence.squashAllowed) return "repository disallows squash merging";
  if (protection.requirements.unsupported.length > 0) {
    return `unsupported branch requirements (${protection.requirements.unsupported.join(", ")})`;
  }
  if (pr.mergeable !== true || evidence.mergeable !== "MERGEABLE" || evidence.mergeState !== "CLEAN") {
    return `merge state is ${evidence.mergeState} (requires mergeable and CLEAN)`;
  }
  const ci = ciBlock(evidence, protection.requirements);
  if (ci !== null) return ci;
  const reviews = effectiveReviews(evidence.reviews);
  if (evidence.reviewDecision === "CHANGES_REQUESTED" || reviews.some((review) => review.state === "CHANGES_REQUESTED")) {
    return "changes requested";
  }
  if (evidence.threads.some((thread) => !thread.resolved)) return "unresolved review threads";
  if (evidence.reviewDecision === "REVIEW_REQUIRED") return "GitHub requires review";
  const writable = new Set(evidence.writableReviewers);
  const approved = reviews.filter((review) => review.state === "APPROVED" && review.commit === pr.head.sha &&
    review.submittedAt !== null && review.author?.userId != null && writable.has(review.author.userId));
  const required = protection.requirements.approvals;
  if (required > 0 && (evidence.reviewDecision !== "APPROVED" || approved.length < required)) {
    return `branch protection requires ${required} eligible approvals on this head`;
  }
  if (policy.strategy === "approvals" && approved.filter((review) =>
    policy.approvers.length === 0 || policy.approvers.includes(review.author!.login.toLowerCase()),
  ).length < policy.count) return `merge policy requires ${policy.count} eligible approvals on this head`;
  return null;
}
