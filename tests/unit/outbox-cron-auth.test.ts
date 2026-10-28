import { describe, expect, it } from "vitest";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";

const SECRET = "cron_secret_0123456789abcdef0123456789";

describe("isAuthorizedCron", () => {
  it("accepts exactly `Bearer <CRON_SECRET>`", () => {
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isAuthorizedCron(null, SECRET)).toBe(false);
    expect(isAuthorizedCron(undefined, SECRET)).toBe(false);
    expect(isAuthorizedCron("", SECRET)).toBe(false);
  });

  it("rejects a wrong token, including prefixes and suffixes of the right one", () => {
    expect(isAuthorizedCron("Bearer wrong", SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  });

  it("rejects the wrong scheme or a bare secret", () => {
    expect(isAuthorizedCron(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it("never authorizes when the server secret is unset", () => {
    expect(isAuthorizedCron("Bearer ", "")).toBe(false);
    expect(isAuthorizedCron("Bearer undefined", undefined)).toBe(false);
  });
});
