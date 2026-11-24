/**
 * Convert the owner's old-system workbook into Honest OS import CSVs.
 *
 *   pnpm legacy:convert --in private/HONEST_old_system_data.xlsx --out private/import
 *     [--warehouse WH-MAIN] [--governorate EG-DK] [--price-list DEFAULT] [--today YYYY-MM-DD]
 *
 * Real data (owner decision A): the output may only be written under ./private/ (git-ignored),
 * or outside the repository (e.g. a temporary folder). The terminal report holds counts and
 * totals only. Upload the files on /imports in the order of their numbers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { convertWorkbook, DEFAULT_OPTIONS, formatReport, type ConvertOptions } from "./convert";
import { readWorkbook } from "./workbook";

function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function parseArgs(argv: string[]): { input: string; output: string; options: ConvertOptions } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args.set(key.slice(2), value);
    i++;
  }
  const known = new Set(["in", "out", "warehouse", "governorate", "price-list", "price-list-name", "today"]);
  for (const k of args.keys()) if (!known.has(k)) throw new Error(`Unknown option --${k}`);
  const input = args.get("in");
  const output = args.get("out");
  if (!input || !output) throw new Error("Usage: pnpm legacy:convert --in <workbook.xlsx> --out <folder>");
  const governorate = (args.get("governorate") ?? "").toUpperCase();
  if (governorate && !/^EG-[A-Z]{1,4}$/.test(governorate)) throw new Error("--governorate must be a code such as EG-DK");
  const today = args.get("today") ?? cairoToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("--today must be YYYY-MM-DD");
  return {
    input,
    output,
    options: {
      warehouseCode: (args.get("warehouse") ?? DEFAULT_OPTIONS.warehouseCode).toUpperCase(),
      governorateCode: governorate,
      priceListCode: (args.get("price-list") ?? DEFAULT_OPTIONS.priceListCode).toUpperCase(),
      priceListName: args.get("price-list-name") ?? DEFAULT_OPTIONS.priceListName,
      today,
    },
  };
}

/** Inside the repository, only ./private/ (git-ignored) may receive real data. */
export function assertSafeOutput(output: string, repoRoot: string): void {
  const rel = relative(resolve(repoRoot), resolve(output));
  const insideRepo = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (insideRepo && !(rel === "private" || rel.startsWith(`private/`) || rel.startsWith("private\\"))) {
    throw new Error("Refusing to write real data inside the repository outside ./private/ (it is git-ignored there).");
  }
}

async function main() {
  const { input, output, options } = parseArgs(process.argv.slice(2));
  assertSafeOutput(output, process.cwd());
  const sheets = await readWorkbook(input);
  for (const required of ["Customers", "Items"]) {
    if (!sheets[required]) throw new Error(`The workbook has no ${required} sheet`);
  }
  const result = convertWorkbook(sheets, options);
  mkdirSync(output, { recursive: true });
  for (const f of result.files) writeFileSync(join(output, f.name), f.csv, "utf8");
  const report = formatReport(result);
  writeFileSync(join(output, "reconciliation.txt"), report, "utf8");
  process.stdout.write(report);
  if (result.reconciliation.some((l) => l.status === "diff")) {
    process.stdout.write("\nSome checks differ: read the notes above before importing.\n");
  }
}

// Run only as a script (the unit tests import parseArgs / assertSafeOutput).
if (process.argv[1] && /convert-workbook\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
