import { describe, expect, it } from "vitest";
import { MEANING_TONE, SHARED_STATUS_MEANING, sharedStatusTone, STATUS_MEANINGS, toneOf } from "@/lib/status-tone";
import { statusTone as approvalTone } from "@/modules/approvals/logic";
import { requestTone } from "@/modules/commissions/logic";
import { visitStatusTone } from "@/modules/field/logic";
import { paymentStatusTone } from "@/modules/finance/logic";
import { receiptStatusTone, transferStatusTone } from "@/modules/inventory/logic";
import { statusTone as orderTone } from "@/modules/orders/logic";
import { statusTone as returnTone } from "@/modules/returns/logic";

describe("one status colour rule", () => {
  it("each meaning has its own colour", () => {
    expect(STATUS_MEANINGS.map(toneOf)).toEqual(["warning", "info", "success", "danger", "neutral"]);
    expect(new Set(Object.values(MEANING_TONE)).size).toBe(STATUS_MEANINGS.length);
  });

  it("shared words map to their meaning's colour; unknown words are the module's call", () => {
    for (const [word, meaning] of Object.entries(SHARED_STATUS_MEANING)) expect(sharedStatusTone(word), word).toBe(MEANING_TONE[meaning]);
    expect(sharedStatusTone("approved")).toBeNull();
    expect(sharedStatusTone("received")).toBeNull();
    expect(sharedStatusTone("toString")).toBeNull();
    expect(sharedStatusTone(null)).toBeNull();
    expect(sharedStatusTone("")).toBeNull();
  });

  it("the same word looks the same in every module", () => {
    // cancelled: grey on orders, returns, approvals, visits, transfers and receipts
    for (const tone of [orderTone("cancelled"), returnTone("cancelled"), approvalTone("cancelled"), visitStatusTone("cancelled"), transferStatusTone("cancelled"), receiptStatusTone("cancelled")]) {
      expect(tone).toBe("neutral");
    }
    // draft: grey
    for (const tone of [orderTone("draft"), transferStatusTone("draft"), receiptStatusTone("draft")]) expect(tone).toBe("neutral");
    // waiting on someone: amber
    for (const tone of [orderTone("pending_approval"), returnTone("pending_approval"), transferStatusTone("pending_approval"), approvalTone("pending"), requestTone("pending"), paymentStatusTone("pending_verification")]) {
      expect(tone).toBe("warning");
    }
    // refused or failed: red
    for (const tone of [orderTone("rejected"), returnTone("rejected"), approvalTone("rejected"), requestTone("rejected"), paymentStatusTone("bounced"), visitStatusTone("missed")]) {
      expect(tone).toBe("danger");
    }
    // under way: teal; finished: green
    expect(visitStatusTone("planned")).toBe("info");
    expect(visitStatusTone("in_progress")).toBe("info");
    expect(visitStatusTone("completed")).toBe("success");
    expect(receiptStatusTone("posted")).toBe("success");
    expect(returnTone("credited")).toBe("success");
    expect(orderTone("invoiced")).toBe("success");
  });

  it("module-specific words keep the module's meaning", () => {
    expect(approvalTone("approved")).toBe("success"); // a decided request is done
    expect(orderTone("approved")).toBe("info"); // an approved order is still moving
    expect(transferStatusTone("received")).toBe("success");
    expect(returnTone("received")).toBe("info"); // waits for the credit note
    expect(requestTone("expired")).toBe("neutral");
  });
});
