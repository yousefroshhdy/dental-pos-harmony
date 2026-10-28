import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-redirect";

describe("safeNextPath", () => {
  it("allows locale-prefixed internal paths", () => {
    expect(safeNextPath("/ar/admin/users", "ar")).toBe("/ar/admin/users");
    expect(safeNextPath("/en/admin/roles?x=1", "en")).toBe("/en/admin/roles?x=1");
  });
  it.each([
    "//evil.example.com",
    "https://evil.example.com",
    "/\\evil.example.com",
    "/fr/whatever",
    "javascript:alert(1)",
    "/ar/login",
    "/ar\n/x",
    "",
    undefined,
  ])("rejects %s", (value) => {
    expect(safeNextPath(value, "ar")).toBe("/ar");
  });
});
