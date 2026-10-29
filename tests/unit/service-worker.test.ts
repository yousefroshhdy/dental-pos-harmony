import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard for audit #9: authenticated pages must never be stored by the service worker,
// otherwise a shared field device shows the previous user's data offline after sign-out.
const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

describe("public/sw.js", () => {
  it("does not keep a page cache", () => {
    expect(sw).not.toMatch(/PAGE_CACHE|honest-pages/);
  });

  it("serves navigations from the network, falling back only to the static offline page", () => {
    const nav = sw.slice(sw.indexOf('request.mode === "navigate"'));
    expect(nav).toMatch(/fetch\(request\)\.catch\(\(\) => caches\.match\(OFFLINE_URL\)\)/);
    expect(nav).not.toMatch(/\.put\(/);
  });

  it("never touches API or auth traffic", () => {
    expect(sw).toMatch(/url\.pathname\.startsWith\("\/api\/"\)/);
    expect(sw).toMatch(/url\.pathname\.includes\("\/auth\/"\)/);
  });

  it("deletes every cache except the current static cache on activate (removes old page caches)", () => {
    expect(sw).toMatch(/keys\.filter\(\(k\) => k !== STATIC_CACHE\)/);
  });
});
