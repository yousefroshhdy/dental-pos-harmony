import { describe, expect, it } from "vitest";
import { RETURN_STEPS, returnProgress } from "@/modules/returns/progress";
import { RETURN_STATUSES } from "@/modules/returns/types";

const states = (status: Parameters<typeof returnProgress>[0]) => returnProgress(status).steps.map((s) => s.state);

describe("returnProgress", () => {
  it("has the four steps of a return in order", () => {
    expect(RETURN_STEPS).toEqual(["requested", "approved", "received", "credited"]);
  });

  it("marks done steps, the current one and what is still to come", () => {
    expect(states("requested")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("pending_approval")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("approved")).toEqual(["done", "done", "current", "todo"]);
    expect(states("received")).toEqual(["done", "done", "done", "current"]);
    expect(states("credited")).toEqual(["done", "done", "done", "done"]);
  });

  it("stops at the step where a rejected or cancelled return ended", () => {
    expect(returnProgress("rejected")).toEqual({ ended: "rejected", steps: [{ step: "requested", state: "done" }, { step: "approved", state: "stopped" }, { step: "received", state: "todo" }, { step: "credited", state: "todo" }] });
    expect(returnProgress("cancelled").ended).toBe("cancelled");
    expect(states("cancelled")).toEqual(["done", "stopped", "todo", "todo"]);
    // Cancelled after approval: it stopped before the goods came back.
    expect(returnProgress("cancelled", { approved: true }).steps.map((s) => s.state)).toEqual(["done", "done", "stopped", "todo"]);
  });

  it("covers every return status", () => {
    for (const s of RETURN_STATUSES) expect(returnProgress(s).steps).toHaveLength(4);
  });
});
