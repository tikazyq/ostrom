export function stuckDecision(attempts: number, blocked: boolean, stalled: boolean, settled: boolean) {
  if (blocked || !settled) return "wait";
  if (!stalled) return "clear";
  return attempts < 2 ? "recover" : "block";
}

const FIELDS = ["trying", "blockedBy", "tried", "options", "work"] as const;

export const RECOVERY_PROMPT =
  "Ostrom detected a stall. Check your worktree and existing pull request, then continue if possible. Do not post to GitHub.";
export const RETRY_PROMPT = `${RECOVERY_PROMPT} If still blocked, push any work in progress to the existing branch. ` +
  `Return only a JSON object with fields ${FIELDS.join(", ")}. Each field is a non-empty string, except ` +
  "options, which is an array of at least two distinct choices. Link to pushed commits or the PR if available, and be explicit if nothing was pushed.";

export interface StuckReply {
  trying: string;
  blockedBy: string;
  tried: string;
  options: string[];
  work: string;
}

export function parseStuckReply(text: string): StuckReply {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a stuck reply object");
  const reply = value as Record<string, unknown>;
  const field = (key: string) => {
    const item = reply[key];
    if (!line(item)) throw new Error(`invalid stuck reply field ${key}`);
    return item.trim();
  };
  const options: unknown = reply["options"];
  if (!Array.isArray(options) || options.length < 2 || !options.every(line) || new Set(options.map((option) => option.trim())).size !== options.length) {
    throw new Error("a stuck reply needs at least two distinct options");
  }
  return { trying: field("trying"), blockedBy: field("blockedBy"), tried: field("tried"), options: options.map((option) => option.trim()), work: field("work") };
}

function line(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\r\n<>]/.test(value);
}

export function renderStuckReply(reply: StuckReply): string {
  return [
    "**I'm stuck on this and need a decision.**",
    "",
    `**Trying to:** ${reply.trying}`,
    `**Blocked by:** ${reply.blockedBy}`,
    `**Tried:** ${reply.tried}`,
    "**I need you to choose:**",
    ...reply.options.map((option, i) => `${i + 1}. ${option}`),
    "",
    `**Work so far:** ${reply.work}`,
    "Reply with a number, or anything else to redirect.",
  ].join("\n");
}
