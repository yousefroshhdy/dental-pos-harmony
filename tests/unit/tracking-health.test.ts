import { describe, expect, it } from "vitest";
import {
  ageMinutes,
  ATTENTION_AFTER_MS,
  buildDeviceStatus,
  cleanVersion,
  devicePermission,
  healthNow,
  needsAttention,
  retryAfterMs,
  shiftState,
  STATUS_REPORT_INTERVAL_MS,
  sortHealthRows,
  webBuildId,
} from "@/modules/tracking/health";
import { reportDeviceStatusSchema } from "@/modules/tracking/schemas";
import type { HealthRow } from "@/modules/tracking/types";

const NOW = Date.parse("2026-11-25T10:00:00Z");
const ago = (min: number, s = 0) => new Date(NOW - min * 60_000 - s * 1000).toISOString();

function row(over: Partial<HealthRow> = {}): HealthRow {
  return {
    employee_id: "20000000-0000-0000-0000-000000000004",
    employee_no: "E004",
    full_name_en: "Rep Cairo",
    full_name_ar: null,
    shift_id: "30000000-0000-0000-0000-000000000001",
    shift_status: "open",
    shift_open: true,
    shift_started_at: ago(60),
    shift_ended_at: null,
    shift_since: ago(60),
    last_point_at: null,
    last_point_received_at: null,
    last_point_source: null,
    shift_last_received_at: null,
    shift_point_count: 0,
    device_reported_at: null,
    device_source: null,
    device_permission: null,
    device_app_version: null,
    device_web_build: null,
    device_battery_saver: null,
    device_pending_points: null,
    checked_at: new Date(NOW).toISOString(),
    needs_attention: false,
    ...over,
  };
}

describe("the attention badge (open shift, nothing arrived for more than 15 minutes)", () => {
  it("is 15 minutes", () => {
    expect(ATTENTION_AFTER_MS).toBe(15 * 60_000);
  });

  it("is on when the last point arrived more than 15 minutes ago", () => {
    expect(needsAttention(row({ shift_last_received_at: ago(15, 1) }), NOW)).toBe(true);
    expect(needsAttention(row({ shift_last_received_at: ago(40) }), NOW)).toBe(true);
  });

  it("is off at exactly 15 minutes and below", () => {
    expect(needsAttention(row({ shift_last_received_at: ago(15) }), NOW)).toBe(false);
    expect(needsAttention(row({ shift_last_received_at: ago(4) }), NOW)).toBe(false);
  });

  it("counts from the shift start when no point arrived yet", () => {
    expect(needsAttention(row({ shift_started_at: ago(16) }), NOW)).toBe(true);
    expect(needsAttention(row({ shift_started_at: ago(5) }), NOW)).toBe(false);
  });

  it("uses the arrival of the shift's own points, not an old point of another day", () => {
    // last_point_* can belong to an earlier shift; only shift_last_received_at counts.
    expect(needsAttention(row({ shift_started_at: ago(30), last_point_received_at: ago(1) }), NOW)).toBe(true);
  });

  it("is never on for a closed shift or a rep who never started one", () => {
    expect(needsAttention(row({ shift_open: false, shift_status: "closed", shift_last_received_at: ago(300) }), NOW)).toBe(false);
    expect(needsAttention(row({ shift_id: null, shift_open: false, shift_status: null, shift_started_at: null }), NOW)).toBe(false);
  });

  it("is off without a usable time (never invents an alarm)", () => {
    expect(needsAttention(row({ shift_started_at: null }), NOW)).toBe(false);
    expect(needsAttention(row({ shift_started_at: "not a date" }), NOW)).toBe(false);
    expect(needsAttention(row({ shift_last_received_at: ago(1) }), Number.NaN)).toBe(false);
  });

  it("takes a custom threshold", () => {
    expect(needsAttention(row({ shift_last_received_at: ago(6) }), NOW, 5 * 60_000)).toBe(true);
  });
});

describe("panel helpers", () => {
  it("ages in whole minutes, never negative", () => {
    expect(ageMinutes(ago(12, 59), NOW)).toBe(12);
    expect(ageMinutes(new Date(NOW + 90_000).toISOString(), NOW)).toBe(0);
    expect(ageMinutes(null, NOW)).toBeNull();
    expect(ageMinutes("x", NOW)).toBeNull();
  });

  it("takes the server clock of the read as now", () => {
    expect(healthNow([row()], () => 1)).toBe(NOW);
    expect(healthNow([], () => 42)).toBe(42);
    expect(healthNow([row({ checked_at: "bad" })], () => 42)).toBe(42);
  });

  it("names the shift state", () => {
    expect(shiftState(row())).toBe("open");
    expect(shiftState(row({ shift_open: false }))).toBe("closed");
    expect(shiftState(row({ shift_id: null, shift_open: false }))).toBe("never");
  });

  it("lists attention first, then open shifts, then by name", () => {
    const a = row({ employee_id: "a", full_name_en: "Zed", shift_open: false, shift_status: "closed" });
    const b = row({ employee_id: "b", full_name_en: "Amr", shift_last_received_at: ago(2) });
    const c = row({ employee_id: "c", full_name_en: "Yara", shift_last_received_at: ago(30) });
    const d = row({ employee_id: "d", full_name_en: "Bassem", shift_open: false, shift_status: "closed" });
    expect(sortHealthRows([a, b, c, d], "en", NOW).map((r) => r.employee_id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("the device's own report", () => {
  it("a problem seen by the collector wins over everything", () => {
    expect(devicePermission({ problem: "denied", hasFix: true, browserState: "granted" })).toBe("denied");
    expect(devicePermission({ problem: "services_off", hasFix: false, browserState: null })).toBe("services_off");
  });

  it("then the browser's Permissions API, then a fix this shift", () => {
    expect(devicePermission({ problem: null, hasFix: false, browserState: "prompt" })).toBe("prompt");
    expect(devicePermission({ problem: "timeout", hasFix: true, browserState: null })).toBe("granted");
    expect(devicePermission({ problem: null, hasFix: false, browserState: null })).toBe("unknown");
    expect(devicePermission({ problem: "unavailable", hasFix: false, browserState: null })).toBe("unknown");
  });

  it("keeps only clean version strings", () => {
    expect(cleanVersion(" 1.0.3 ")).toBe("1.0.3");
    expect(cleanVersion("1.0<script>")).toBeNull();
    expect(cleanVersion("x".repeat(41))).toBeNull();
    expect(cleanVersion(3)).toBeNull();
  });

  it("builds the whitelisted payload (app version only from the Android shell)", () => {
    const base = { problem: null, hasFix: true, browserState: null, appVersion: "1.0", batterySaver: null, pendingPoints: 2.7 } as const;
    expect(buildDeviceStatus({ ...base, native: true })).toEqual({
      source: "native",
      permission: "granted",
      app_version: "1.0",
      battery_saver: null,
      pending_points: 2,
    });
    expect(buildDeviceStatus({ ...base, native: false, pendingPoints: -4 })).toMatchObject({ source: "pwa", app_version: null, pending_points: 0 });
    expect(buildDeviceStatus({ ...base, native: true, pendingPoints: null, batterySaver: true })).toMatchObject({ pending_points: null, battery_saver: true });
  });

  it("retries once just after a rate_limited answer, within a minute", () => {
    expect(retryAfterMs(20)).toBe(21_000);
    expect(retryAfterMs(0)).toBe(2_000);
    expect(retryAfterMs(600)).toBe(61_000);
    expect(retryAfterMs("x")).toBe(61_000);
    expect(STATUS_REPORT_INTERVAL_MS).toBe(5 * 60_000);
  });

  it("the server names its web build from Vercel's commit sha", () => {
    expect(webBuildId({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123" })).toBe("0123456789ab");
    expect(webBuildId({ VERCEL_DEPLOYMENT_ID: "dpl_ABC123" })).toBe("dpl_ABC123");
    expect(webBuildId({})).toBeNull();
  });

  it("the action schema accepts the payload and refuses anything else", () => {
    const shiftId = "30000000-0000-0000-0000-000000000001";
    const status = buildDeviceStatus({ native: true, problem: null, hasFix: true, browserState: null, appVersion: null, batterySaver: null, pendingPoints: 0 });
    expect(reportDeviceStatusSchema.safeParse({ shift_id: shiftId, status }).success).toBe(true);
    expect(reportDeviceStatusSchema.safeParse({ shift_id: shiftId, status: { ...status, lat: 30 } }).success).toBe(false);
    expect(reportDeviceStatusSchema.safeParse({ shift_id: shiftId, status: { ...status, web_build: "abc" } }).success).toBe(false);
    expect(reportDeviceStatusSchema.safeParse({ shift_id: shiftId, status: { ...status, permission: "maybe" } }).success).toBe(false);
    expect(reportDeviceStatusSchema.safeParse({ shift_id: "nope", status }).success).toBe(false);
  });
});
