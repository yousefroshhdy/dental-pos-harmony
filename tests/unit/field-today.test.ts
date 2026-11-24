import { describe, expect, it } from "vitest";
import { groupToday, todayQuickActions, todaySummary } from "@/modules/field/logic";
import type { TodayItem } from "@/modules/field/types";

// Synthetic values only (D-03).
const item = (over: Partial<TodayItem>): TodayItem => ({
  item_type: "visit",
  item_id: "70000000-0000-0000-0000-000000000001",
  title: "Synthetic Clinic",
  kind: null,
  priority: null,
  status: "planned",
  customer_id: "40000000-0000-0000-0000-000000000001",
  customer_name: "Synthetic Clinic",
  due_at: null,
  planned_for: "2026-11-24",
  is_overdue: false,
  ...over,
});

describe("todayQuickActions", () => {
  const planned = item({});
  const open = item({ item_id: "70000000-0000-0000-0000-000000000002", status: "in_progress", due_at: "2026-11-24T08:00:00Z" });

  it("offers check-in (to the plan), an unplanned visit and a new order to a rep", () => {
    expect(todayQuickActions({ mayCheckIn: true, mayOrder: true, groups: groupToday([planned]) })).toEqual([
      { key: "checkIn", href: "#plan" },
      { key: "unplanned", href: "/visits/new" },
      { key: "newOrder", href: "/orders/new" },
    ]);
  });

  it("links the new order to the visit in progress", () => {
    expect(todayQuickActions({ mayCheckIn: true, mayOrder: true, groups: groupToday([planned, open]) })).toContainEqual({
      key: "newOrder",
      href: `/orders/new?customer=${open.customer_id}&visit=${open.item_id}`,
    });
  });

  it("drops check-in when nothing is planned, and each action without its permission", () => {
    expect(todayQuickActions({ mayCheckIn: true, mayOrder: false, groups: groupToday([]) })).toEqual([{ key: "unplanned", href: "/visits/new" }]);
    expect(todayQuickActions({ mayCheckIn: false, mayOrder: true, groups: groupToday([planned]) })).toEqual([{ key: "newOrder", href: "/orders/new" }]);
    expect(todayQuickActions({ mayCheckIn: false, mayOrder: false, groups: groupToday([planned, open]) })).toEqual([]);
  });
});

describe("todaySummary", () => {
  it("counts the day for the header (overdue tasks separately)", () => {
    const groups = groupToday([
      item({}),
      item({ item_id: "v2", status: "in_progress" }),
      item({ item_type: "task", item_id: "t1", kind: "follow_up", status: "open", is_overdue: true }),
      item({ item_type: "task", item_id: "t2", kind: "general", status: "open" }),
    ]);
    expect(todaySummary(groups)).toEqual({ planned: 1, inProgress: 1, due: 2, overdue: 1 });
  });
});
