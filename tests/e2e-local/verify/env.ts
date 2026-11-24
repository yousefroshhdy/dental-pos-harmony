import { tmpdir } from "node:os";
import path from "node:path";
import { PERSONAS, STATE_DIR, type Persona } from "../stack";

/**
 * Where the verification run (docs/VERIFICATION.md) points.
 *
 * - **local** (default): the local signed-in stack (`pnpm e2e:local:up`), every persona, every
 *   line, writes included (synthetic data only).
 * - **preview**: `VERIFY_BASE_URL` is set. A Vercel preview or staging with **real data**
 *   (owner decision A): one test account (`VERIFY_EMAIL`, `VERIFY_PASSWORD`, real password
 *   sign-in) whose role is `VERIFY_ROLE`. Only read-only lines of that role run; every writing
 *   line is skipped; no screenshot, trace, video or page snapshot is kept.
 */
export const PREVIEW = Boolean(process.env.VERIFY_BASE_URL);
export const MODE: "local" | "preview" = PREVIEW ? "preview" : "local";

export const ROLES = Object.keys(PERSONAS) as Persona[];

/** The role of the preview test account (preview mode only). */
export function previewRole(): Persona {
  const role = (process.env.VERIFY_ROLE ?? "").trim() as Persona;
  if (!ROLES.includes(role)) {
    throw new Error(`VERIFY_ROLE must be one of ${ROLES.join(", ")} (the role of the test account VERIFY_EMAIL)`);
  }
  return role;
}

/**
 * Preview-mode session and Playwright output live in a temporary folder outside the repository,
 * deleted after the run. Read at call time: playwright.verify.config.ts sets VERIFY_RUN_ID once
 * and the workers inherit it.
 */
export const previewDir = () => path.join(tmpdir(), `honest-verify-preview-${process.env.VERIFY_RUN_ID ?? "run"}`);
export const previewState = () => path.join(previewDir(), "state.json");
export const previewOutput = () => path.join(previewDir(), "output");

/** Session cookies of a persona for this mode. */
export function statePath(persona: Persona): string {
  return PREVIEW ? previewState() : path.join(STATE_DIR, `${persona}.json`);
}
