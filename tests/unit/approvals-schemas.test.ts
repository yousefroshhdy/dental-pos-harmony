import { describe, expect, it } from "vitest";
import { decideSchema, formToObject, MARK_READ_MAX, markReadSchema, parseNotificationFilter, parseTab } from "@/modules/approvals/schemas";

const ID = "a0000000-0000-0000-0000-000000000001";
const ID2 = "a0000000-0000-0000-0000-000000000002";

describe("decideSchema", () => {
  it("approves without a comment", () => {
    expect(decideSchema.safeParse({ request_id: ID, decision: "approve" }).success).toBe(true);
  });
  it("requires a comment to reject", () => {
    const missing = decideSchema.safeParse({ request_id: ID, decision: "reject" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(["comment"]);
    expect(decideSchema.safeParse({ request_id: ID, decision: "reject", comment: "no" }).success).toBe(false);
    expect(decideSchema.safeParse({ request_id: ID, decision: "reject", comment: "over budget" }).success).toBe(true);
  });
  it("rejects malformed ids, unknown decisions and long comments", () => {
    expect(decideSchema.safeParse({ request_id: "x", decision: "approve" }).success).toBe(false);
    expect(decideSchema.safeParse({ request_id: ID, decision: "approved" }).success).toBe(false);
    expect(decideSchema.safeParse({ request_id: ID, decision: "approve", comment: "x".repeat(1001) }).success).toBe(false);
  });
});

describe("markReadSchema", () => {
  it("splits, trims and de-duplicates ids", () => {
    const parsed = markReadSchema.safeParse({ ids: ` ${ID}, ${ID2},${ID} ` });
    expect(parsed.success && parsed.data.ids).toEqual([ID, ID2]);
  });
  it("rejects empty lists, bad ids and oversized batches", () => {
    expect(markReadSchema.safeParse({ ids: "" }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: `${ID},nope` }).success).toBe(false);
    const many = Array.from({ length: MARK_READ_MAX + 1 }, (_, i) => `a0000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    expect(markReadSchema.safeParse({ ids: many.join(",") }).success).toBe(false);
  });
});

describe("query-string parsing", () => {
  it("parses the inbox tab with a fallback", () => {
    expect(parseTab("mine", "decide")).toBe("mine");
    expect(parseTab(["decided", "mine"], "decide")).toBe("decided");
    expect(parseTab("everything", "mine")).toBe("mine");
    expect(parseTab(undefined, "decide")).toBe("decide");
  });
  it("parses the notifications filter", () => {
    expect(parseNotificationFilter("unread")).toBe("unread");
    expect(parseNotificationFilter("read")).toBe("all");
    expect(parseNotificationFilter(undefined)).toBe("all");
  });
});

describe("formToObject", () => {
  it("trims values and drops empty strings", () => {
    const form = new FormData();
    form.set("request_id", ` ${ID} `);
    form.set("comment", "   ");
    form.set("decision", "approve");
    expect(formToObject(form)).toEqual({ request_id: ID, decision: "approve" });
  });
});
