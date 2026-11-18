// The operator CLI uses the local store until the milestone-1 local API lands.

import { queueStatusCard } from "../github/cards.ts";
import { renderPreview } from "../github/preview.ts";
import { Store } from "../store/store.ts";
import { MINUTE_MS, type BudgetExtension } from "../worker/budget.ts";

const USAGE = `usage: ostrom preview
       ostrom extend <ticket> [--time M] [--turns N] [--tokens N]

Supply at least one increase. --time is in minutes.`;

const FLAGS = { "--time": "wallMs", "--turns": "turns", "--tokens": "tokens" } as const;

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[1-9]\d*$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseExtend(args: readonly string[]): { ticketId: number; extension: BudgetExtension } | null {
  const ticketId = positiveInteger(args[0]);
  if (ticketId === undefined || args.length < 3 || args.length % 2 !== 1) return null;
  const extension: BudgetExtension = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    if (flag !== "--time" && flag !== "--turns" && flag !== "--tokens") return null;
    const key = FLAGS[flag];
    const count = positiveInteger(args[i + 1]);
    if (count === undefined || extension[key] !== undefined) return null;
    const increase = key === "wallMs" ? count * MINUTE_MS : count;
    if (!Number.isSafeInteger(increase)) return null;
    extension[key] = increase;
  }
  return { ticketId, extension };
}

interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: CliOutput = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) },
): Promise<number> {
  const command = argv[0];
  const extend = command === "extend" ? parseExtend(argv.slice(1)) : null;
  if (extend === null && !(command === "preview" && argv.length === 1)) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const path = env["OSTROM_DB"]?.trim() ?? "";
  if (path === "") {
    io.stderr(`ostrom ${command}: OSTROM_DB must be the path to the store\n`);
    return 1;
  }
  let store: Store | undefined;
  try {
    store = Store.open(path);
    if (extend === null) io.stdout(renderPreview(store));
    else {
      const ticket = store.extendBudget(extend.ticketId, extend.extension);
      queueStatusCard(store, ticket.id);
      io.stdout(`Ticket ${ticket.id} budget extended.${ticket.budgetResume ? " Its Worker will resume on the next Watchdog pass." : ""}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`ostrom ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
