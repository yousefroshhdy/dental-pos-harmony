import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_LABEL_KEYS } from "@/modules/workflow/logic";
import { workflowNav } from "@/modules/workflow/nav";
import { APPROVER_TYPES, DELEGATION_STATUSES, VALUE_TYPES, WORKFLOW_ERROR_KEYS } from "@/modules/workflow/types";

/** Every key the workflow code builds dynamically must exist in both locales. */

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "workflow.json"), "utf8")) as Record<string, unknown>;

function has(tree: Record<string, unknown>, path: string): boolean {
  let node: unknown = tree;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node.length > 0;
}

describe.each(["ar", "en"])("workflow messages (%s)", (locale) => {
  const messages = load(locale);

  it("has nav and hub labels", () => {
    for (const item of workflowNav) expect(has({ workflow: messages }, item.labelKey), item.labelKey).toBe(true);
    for (const key of ["delegations", "escalations", "rules"]) {
      expect(has(messages, `nav.${key}`)).toBe(true);
      expect(has(messages, `hub.${key}`)).toBe(true);
    }
  });

  it("has every workflow label, approver type, value type, status and error", () => {
    for (const key of Object.values(WORKFLOW_LABEL_KEYS)) expect(has(messages, `workflows.${key}`), key).toBe(true);
    for (const type of APPROVER_TYPES) expect(has(messages, `approverType.${type}`), type).toBe(true);
    for (const type of VALUE_TYPES) expect(has(messages, `valueType.${type}`), type).toBe(true);
    for (const status of DELEGATION_STATUSES) expect(has(messages, `delegations.status.${status}`), status).toBe(true);
    for (const key of WORKFLOW_ERROR_KEYS) expect(has(messages, `errors.${key}`), key).toBe(true);
  });

  it("every error message shows the request id", () => {
    for (const key of WORKFLOW_ERROR_KEYS) expect(String((messages.errors as Record<string, string>)[key])).toContain("{requestId}");
  });
});
