export type MergePolicy =
  | { strategy: "unattended" | "human" }
  | { strategy: "approvals"; count: number; approvers: string[] };

export function loadMergePolicy(env: Record<string, string | undefined>): MergePolicy {
  const strategy = env["OSTROM_MERGE_STRATEGY"]?.trim() ?? "unattended";
  const count = env["OSTROM_MERGE_APPROVALS"]?.trim();
  const logins = env["OSTROM_MERGE_APPROVERS"]?.trim();
  if (strategy === "human" || strategy === "unattended") {
    if (count !== undefined || logins !== undefined) {
      throw new Error("OSTROM_MERGE_APPROVALS and OSTROM_MERGE_APPROVERS require OSTROM_MERGE_STRATEGY=approvals");
    }
    return { strategy };
  }
  if (strategy !== "approvals") throw new Error(`Invalid OSTROM_MERGE_STRATEGY: ${JSON.stringify(strategy)}`);
  if (count === undefined || !/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count))) {
    throw new Error("OSTROM_MERGE_APPROVALS must be a positive whole number");
  }
  const approvers = logins ? logins.split(",").map((login) => login.trim().toLowerCase()) : [];
  if (approvers.some((login) => login === "") || new Set(approvers).size !== approvers.length) {
    throw new Error("OSTROM_MERGE_APPROVERS must have distinct, non-empty logins");
  }
  if (approvers.length > 0 && approvers.length < Number(count)) {
    throw new Error("OSTROM_MERGE_APPROVERS has fewer logins than OSTROM_MERGE_APPROVALS");
  }
  return { strategy, count: Number(count), approvers };
}
