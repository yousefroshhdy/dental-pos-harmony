import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RESULTS_DIR, SHOTS_DIR, type ShotResult } from "./stack";

const cell = (items: string[], max = 3) =>
  items.length === 0 ? "" : `${items.slice(0, max).join("; ").replace(/\|/g, "\\|")}${items.length > max ? ` (+${items.length - max})` : ""}`;

/** Writes $SHOTS_DIR/index.md: one row per screenshot with what the checks found. */
export default async function globalTeardown() {
  if (!existsSync(RESULTS_DIR)) return;
  const results = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf8")) as ShotResult)
    .sort((a, b) => a.file.localeCompare(b.file));

  const issues = (r: ShotResult) => [
    ...(r.status && r.status >= 400 ? [`HTTP ${r.status}`] : []),
    ...(r.notFound ? ["404 page"] : []),
    ...(r.errorBoundary ? ["error text on page"] : []),
    ...(r.hScroll ? [`h-scroll ${r.hScroll.scrollWidth}>${r.hScroll.innerWidth}`] : []),
    ...(r.untranslated.length ? [`keys: ${cell(r.untranslated)}`] : []),
    ...(r.smallTargets.length ? [`${r.smallTargets.length} target(s) <44px: ${cell(r.smallTargets, 2)}`] : []),
    ...(r.consoleErrors.length ? [`console: ${cell(r.consoleErrors, 2)}`] : []),
    ...(r.failedRequests.length ? [`requests: ${cell(r.failedRequests, 2)}`] : []),
    ...(r.alerts.length ? [`alerts: ${cell(r.alerts, 2)}`] : []),
  ];

  const lines = [
    "# Honest OS — local signed-in screenshots",
    "",
    `Generated ${new Date().toISOString()} from the local stack (synthetic demo data, mock auth). ${results.length} screenshots.`,
    "Checks are heuristics: a 44 px finding inside a table or an inline text link may be acceptable; alerts list every `role=alert` text (including expected \"not configured\" notices).",
    "",
    "| # | Screen | Persona | Locale | Width | File | URL | Findings |",
    "|---|--------|---------|--------|-------|------|-----|----------|",
    ...results.map(
      (r) =>
        `| ${r.nn} | ${r.screen} | ${r.persona} | ${r.locale} | ${r.width} | [${r.file}](${r.file}) | \`${r.url}\` | ${issues(r).join("<br>") || "—"} |`,
    ),
    "",
  ];
  writeFileSync(path.join(SHOTS_DIR, "index.md"), lines.join("\n"));
  writeFileSync(path.join(SHOTS_DIR, "results.json"), JSON.stringify(results, null, 2));
}
