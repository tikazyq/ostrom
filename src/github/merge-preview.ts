import { budgetReached } from "../budget/budgets.ts";
import type { Store } from "../store/store.ts";
import type { GhRunner } from "./gh.ts";
import { mergeEligibility } from "./merge-eligibility.ts";
import { integer, mergeRest, objects, readMergeEvidence } from "./merge-evidence.ts";
import type { MergePolicy } from "./merge-policy.ts";

/** An explicit preview reads GitHub but never writes candidates, outbox records or GitHub state. */
export async function renderMergePreview(store: Store, gh: GhRunner, repo: string, base: string, policy: MergePolicy, now = new Date()): Promise<string> {
  const sections = ["## Merge evidence (read only)",
    `Policy: ${policy.strategy}. No merge request is sent.`,
    "Issue state: not yet tracked. Stop state: not yet tracked. Quiet window: not yet tracked. Idle state: not yet tracked."];
  const assignments = store.runningAssignments().filter((assignment) => assignment.branch !== null && store.ticketContext(assignment.ticketId).source.name === repo);
  if (assignments.length === 0) sections.push("No running Worker branches to inspect.");
  for (const assignment of assignments) {
    const ticket = store.getTicket(assignment.ticketId);
    const budget = budgetReached(store.ticketBudget(ticket.id), now);
    const local = [`Ticket: ${ticket.state}${ticket.pauseCause === null ? "" : ` (${ticket.pauseCause})`}.`,
      `Budget: ${budget === null ? "within limits" : `${budget} limit reached`}.`];
    const title = `### Ticket ${ticket.id}, assignment ${assignment.id}`;
    try {
      const prs = new Map<number, number>();
      for (let page = 1; ; page++) {
        const rows = objects(await mergeRest(gh, `repos/${repo}/pulls?head=${encodeURIComponent(`${repo.split("/")[0]}:${assignment.branch}`)}&state=open&per_page=100&page=${page}`));
        for (const row of rows) prs.set(integer(row, "number"), integer(row, "number"));
        if (rows.length < 100) break;
      }
      const owners = assignments.filter((owner) => owner.branch === assignment.branch);
      if (prs.size !== 1 || owners.length !== 1) {
        sections.push([title, ...local, `Blocked: ${prs.size} open PRs and ${owners.length} live branch owners; expected one of each.`].join("\n\n"));
        continue;
      }
      const number = [...prs.values()][0]!;
      const evidence = await readMergeEvidence(gh, repo, number);
      const eligibility = mergeEligibility(evidence, policy, { branch: assignment.branch!, base });
      const blockers = [...eligibility.blockers];
      if (ticket.state !== "open") blockers.unshift(`ticket is ${ticket.state}`);
      if (budget !== null) blockers.unshift(`${budget} budget limit reached`);
      if (assignment.outcome === "failed" || assignment.outcome === "cancelled") blockers.push(`Worker ${assignment.outcome}`);
      if (store.operatorStatus().stuckTickets.some((stuck) => stuck.ticketId === ticket.id)) blockers.push("uncleared stall");
      sections.push([title, `PR #${number}, head ${evidence.commitOid}.`, ...local,
        blockers.length === 0 ? "GitHub evidence passes. Merge readiness is incomplete until the untracked prerequisites are implemented." : `Blocked: ${blockers.join("; ")}.`].join("\n\n"));
    } catch (error) {
      sections.push([title, ...local, `Blocked: evidence unreadable: ${error instanceof Error ? error.message : String(error)}`].join("\n\n"));
    }
  }
  return `${sections.join("\n\n")}\n`;
}
