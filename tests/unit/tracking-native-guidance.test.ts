import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression (Phase P step 5): the shift card told reps to pick "Allow all the time" for
 * location. Android offers that choice only to apps that declare ACCESS_BACKGROUND_LOCATION,
 * and the Android shell does not (its location service is a foreground service with a
 * permanent notification, started from the app). The guidance must match the manifest.
 */

const root = process.cwd();
const manifest = readFileSync(join(root, "mobile/android/app/src/main/AndroidManifest.xml"), "utf8");
const messages = (lang: "en" | "ar") => JSON.parse(readFileSync(join(root, `messages/${lang}/tracking.json`), "utf8")) as {
  native: { help: { location: string; notifications: string }; problem: { denied: string } };
};
const declaresBackground = /<uses-permission[^>]+ACCESS_BACKGROUND_LOCATION/.test(manifest);

describe("location guidance in the Android shell matches what the app requests", () => {
  it("the shell runs a location foreground service and does not ask for background location", () => {
    expect(manifest).toMatch(/android:foregroundServiceType="location"/);
    expect(manifest).toMatch(/FOREGROUND_SERVICE_LOCATION/);
    expect(declaresBackground).toBe(false);
  });

  it.runIf(!declaresBackground)("reps are told to choose \"Allow only while using the app\", not \"Allow all the time\"", () => {
    const en = messages("en").native;
    expect(en.help.location).toContain('"Allow only while using the app"');
    expect(en.help.location).not.toMatch(/choose\s+"Allow all the time"|^Location: "Allow all the time"/);
    expect(en.problem.denied).toContain('"Allow only while using the app"');
    expect(en.problem.denied).not.toContain("Allow all the time");

    const ar = messages("ar").native;
    expect(ar.help.location.startsWith("الموقع: «السماح أثناء استخدام التطبيق فقط»")).toBe(true);
    expect(ar.problem.denied).toContain("«السماح أثناء استخدام التطبيق فقط»");
    expect(ar.problem.denied).not.toContain("السماح طوال الوقت");
  });

  it("notifications stay part of the guidance (the permanent notification keeps tracking on)", () => {
    expect(messages("en").native.help.notifications).toMatch(/allow/i);
    expect(messages("en").native.problem.denied).toMatch(/Notifications/);
  });
});
