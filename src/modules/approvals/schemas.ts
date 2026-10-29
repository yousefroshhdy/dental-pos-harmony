import { z } from "zod";
import type { InboxTab } from "./types";

/**
 * Input validation for the approvals Server Actions. These only reject
 * malformed input early; who may decide what is enforced again by
 * api.decide_approval in Postgres.
 */

/** FormData → plain object: strings trimmed, empty strings and files dropped. Repeated keys keep the last value. */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();

export const COMMENT_MAX = 1000;
/** A rejection must say why, so the requester can fix and resubmit. */
export const REJECT_COMMENT_MIN = 3;

export const decideSchema = z
  .object({
    request_id: id,
    decision: z.enum(["approve", "reject"]),
    comment: z.string().max(COMMENT_MAX).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "reject" && (value.comment ?? "").length < REJECT_COMMENT_MIN) {
      ctx.addIssue({ code: "custom", path: ["comment"], message: "a rejection needs a comment" });
    }
  });
export type DecideInput = z.infer<typeof decideSchema>;

/** At most this many notifications are marked per request (matches the page size). */
export const MARK_READ_MAX = 200;

/** `ids` is a comma-separated list (one hidden field), so a whole page can be marked at once. */
export const markReadSchema = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(id).min(1).max(MARK_READ_MAX)),
});

const TABS = ["decide", "mine", "decided"] as const satisfies readonly InboxTab[];

/** Inbox tab from the query string; anything unknown falls back to `fallback`. */
export function parseTab(raw: unknown, fallback: InboxTab): InboxTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (TABS as readonly string[]).includes(String(value)) ? (value as InboxTab) : fallback;
}

/** Notifications filter from the query string. */
export function parseNotificationFilter(raw: unknown): "unread" | "all" {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "unread" ? "unread" : "all";
}
