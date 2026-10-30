import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { securityNav } from "@/modules/security/nav";
import { SECURITY_ERROR_KEYS } from "@/modules/security/types";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "security.json"), "utf8")) as Record<string, Record<string, unknown>>;

/** Every value the UI shows has a label (ar/en key parity is checked in module-messages.test.ts). */
describe.each(["ar", "en"])("security messages (%s)", (locale) => {
  const m = load(locale);

  it("labels every error key", () => {
    expect(Object.keys(m.errors ?? {}).sort()).toEqual([...SECURITY_ERROR_KEYS].sort());
  });

  it("labels every account standing", () => {
    const status = m.status as { standing: Record<string, string> };
    expect(Object.keys(status.standing).sort()).toEqual(["enrolNeeded", "optional", "protected", "verifyNow"]);
  });

  it("has the nav label, open to every signed-in user", () => {
    expect(securityNav).toEqual([{ href: "/account/security", labelKey: "security.nav.account", permission: null }]);
    expect(typeof m.nav?.account).toBe("string");
  });

  it("keeps the {date} placeholder", () => {
    expect((m.factors as Record<string, string>).addedOn).toContain("{date}");
  });
});
