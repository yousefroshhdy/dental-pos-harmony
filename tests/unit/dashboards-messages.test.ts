import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_ERROR_CODES, TILE_GROUPS } from "@/modules/dashboards/logic";
import { dashboardsNav } from "@/modules/dashboards/nav";
import { TARGET_SUBJECTS } from "@/modules/dashboards/schemas";
import { KPI_CODES, PERIOD_KINDS } from "@/modules/dashboards/types";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/dashboards.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);

describe.each(["ar", "en"])("dashboards messages (%s)", (locale) => {
  const messages = load(locale);

  it("name, short label and definition for every KPI", () => {
    for (const code of KPI_CODES) {
      for (const part of ["name", "short", "definition"]) expect(at(messages, `kpi.${code}.${part}`), `${code}.${part}`).toEqual(expect.any(String));
    }
  });

  it("every group, period, status, scope, subject and error code", () => {
    for (const g of Object.keys(TILE_GROUPS)) expect(at(messages, `groups.${g}`), g).toEqual(expect.any(String));
    for (const p of PERIOD_KINDS) expect(at(messages, `period.${p}`), p).toEqual(expect.any(String));
    for (const s of ["onTrack", "atRisk", "behind"]) expect(at(messages, `status.${s}`), s).toEqual(expect.any(String));
    for (const s of ["own", "team", "all"]) {
      expect(at(messages, `title.${s}`), s).toEqual(expect.any(String));
      expect(at(messages, `subtitle.${s}`), s).toEqual(expect.any(String));
    }
    for (const s of TARGET_SUBJECTS) {
      expect(at(messages, `targets.subjects.${s}`), s).toEqual(expect.any(String));
      expect(at(messages, `targets.subjectHint.${s}`), s).toEqual(expect.any(String));
    }
    for (const c of DASHBOARD_ERROR_CODES) expect(at(messages, `errors.${c}`), c).toEqual(expect.any(String));
    for (const item of dashboardsNav) expect(at(messages, item.labelKey.replace(/^dashboards\./, "")), item.labelKey).toEqual(expect.any(String));
  });

  it("UNKNOWN carries the request id placeholder", () => {
    expect(at(messages, "errors.UNKNOWN")).toContain("{requestId}");
  });
});

describe("dashboards nav", () => {
  it("is gated on perf.kpi.read and lives in the dashboards namespace", () => {
    expect(dashboardsNav.map((i) => [i.href, i.permission])).toEqual([["/dashboard", "perf.kpi.read"]]);
    for (const item of dashboardsNav) expect(item.labelKey.startsWith("dashboards.nav.")).toBe(true);
  });
});
