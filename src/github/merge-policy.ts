export type MergePolicy =
  | { strategy: "unattended" | "human" }
  | { strategy: "approvals"; approvals: number; approvers: string[] };

export function loadMergePolicy(env: Record<string, string | undefined>): MergePolicy {
  const strategy = env["OSTROM_MERGE_STRATEGY"]?.trim() || "unattended";
  const count = env["OSTROM_MERGE_APPROVALS"]?.trim();
  const list = env["OSTROM_MERGE_APPROVERS"]?.trim();
  if (strategy !== "unattended" && strategy !== "human" && strategy !== "approvals") {
    throw new Error("OSTROM_MERGE_STRATEGY must be unattended, human or approvals");
  }
  if (strategy !== "approvals") {
    if (count !== undefined || list !== undefined) throw new Error("merge approval fields require the approvals strategy");
    return { strategy };
  }
  if (!count || !/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count))) {
    throw new Error("OSTROM_MERGE_APPROVALS must be a positive whole number");
  }
  const approvers = !list ? [] : list.split(",").map((login) => login.trim().toLowerCase());
  if (approvers.some((login) => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(login)) || new Set(approvers).size !== approvers.length) {
    throw new Error("OSTROM_MERGE_APPROVERS contains empty, invalid or duplicate logins");
  }
  if (approvers.length > 0 && approvers.length < Number(count)) throw new Error("merge approver list cannot satisfy OSTROM_MERGE_APPROVALS");
  return { strategy, approvals: Number(count), approvers };
}
