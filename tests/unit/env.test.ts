import { afterEach, describe, expect, it } from "vitest";
import { serverEnv } from "@/env";

const KEYS = ["SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "OUTBOX_SIGNING_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("serverEnv", () => {
  it("validates only the requested keys", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(40);
    delete process.env.CRON_SECRET;
    delete process.env.OUTBOX_SIGNING_SECRET;
    expect(serverEnv("SUPABASE_SERVICE_ROLE_KEY")).toEqual({ SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40) });
  });

  it("names every missing or invalid key", () => {
    delete process.env.CRON_SECRET;
    process.env.OUTBOX_SIGNING_SECRET = "too-short";
    expect(() => serverEnv("CRON_SECRET", "OUTBOX_SIGNING_SECRET")).toThrow(/CRON_SECRET.*OUTBOX_SIGNING_SECRET/);
  });

  it("checks all keys when none are named", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(40);
    delete process.env.CRON_SECRET;
    process.env.OUTBOX_SIGNING_SECRET = "o".repeat(40);
    expect(() => serverEnv()).toThrow(/CRON_SECRET/);
  });

  it("never returns values for keys that were not requested", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(40);
    process.env.CRON_SECRET = "c".repeat(40);
    expect(Object.keys(serverEnv("CRON_SECRET"))).toEqual(["CRON_SECRET"]);
  });
});
