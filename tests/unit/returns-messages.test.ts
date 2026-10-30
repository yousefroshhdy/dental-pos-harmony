import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RETURN_ERROR_CODES, STATUS_FILTERS } from "@/modules/returns/logic";
import { returnsNav } from "@/modules/returns/nav";
import { CONDITIONS, REASON_CODES, RETURN_STATUSES } from "@/modules/returns/types";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/returns.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
const APPROVAL_STATUSES = ["pending", "approved", "rejected", "cancelled", "expired"];
const NEXT_STEPS = ["approval", "receive", "credit", "done", "closed"];
const CHECKS = ["noLines", "invalidQuantity", "tooMany", "missingReason", "notesRequired"];

describe.each(["ar", "en"])("returns messages (%s)", (locale) => {
  const messages = load(locale);

  it("translate every status, reason, condition, next step and error code", () => {
    for (const s of RETURN_STATUSES) expect(at(messages, `status.${s}`), s).toEqual(expect.any(String));
    for (const r of REASON_CODES) expect(at(messages, `reasons.${r}`), r).toEqual(expect.any(String));
    for (const c of CONDITIONS) expect(at(messages, `conditions.${c}`), c).toEqual(expect.any(String));
    for (const s of APPROVAL_STATUSES) expect(at(messages, `approvalStatus.${s}`), s).toEqual(expect.any(String));
    for (const n of NEXT_STEPS) expect(at(messages, `next.${n}`), n).toEqual(expect.any(String));
    for (const c of CHECKS) expect(at(messages, `request.check.${c}`), c).toEqual(expect.any(String));
    for (const e of RETURN_ERROR_CODES) expect(at(messages, `errors.${e}`), e).toEqual(expect.any(String));
  });

  it("translate every filter, success message and nav entry", () => {
    for (const f of Object.keys(STATUS_FILTERS)) expect(at(messages, `filters.${f}`), f).toEqual(expect.any(String));
    for (const k of ["requested", "received", "credited"]) expect(at(messages, `messages.${k}`), k).toEqual(expect.any(String));
    for (const item of returnsNav) expect(at(messages, item.labelKey.replace(/^returns\./, "")), item.labelKey).toEqual(expect.any(String));
  });

  it("keep the request id placeholder in the generic errors", () => {
    expect(at(messages, "errors.UNKNOWN")).toContain("{requestId}");
    expect(at(messages, "errors.UNAVAILABLE")).toContain("{requestId}");
  });
});
