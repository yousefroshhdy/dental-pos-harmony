import { rmSync } from "node:fs";
import { PREVIEW, previewDir } from "./verify/env";

/** Preview mode: forget the test account's session and any Playwright output (it may show real data). */
export default async function verifyTeardown() {
  if (PREVIEW) rmSync(previewDir(), { recursive: true, force: true });
}
