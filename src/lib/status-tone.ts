/**
 * One colour rule for status badges in every module (Phase P H1 UI pass, docs/DECISIONS.md
 * Part C). A badge's colour says what the status means to the person looking at it; the text
 * always says the status itself (colour is never the only cue).
 *
 *   waiting  → warning (amber):  someone has to act (pending, submitted, requested, …)
 *   active   → info (teal):      under way (planned, scheduled, in progress)
 *   done     → success (green):  finished well (completed, posted, paid, credited, …)
 *   problem  → danger (red):     refused, missed or failed (rejected, missed, bounced)
 *   inactive → neutral (grey):   not in anyone's queue (draft, cancelled, written off)
 *
 * Status words that several modules share get their colour here, so "cancelled" or
 * "in progress" look the same on orders, returns, visits and approvals. Words whose meaning
 * differs by module (an approved *request* is done; an approved *order* is still moving)
 * stay with the module's own tone function. Pure; tests/unit/status-tone.test.ts.
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export const STATUS_MEANINGS = ["waiting", "active", "done", "problem", "inactive"] as const;
export type StatusMeaning = (typeof STATUS_MEANINGS)[number];

export const MEANING_TONE: Record<StatusMeaning, BadgeTone> = {
  waiting: "warning",
  active: "info",
  done: "success",
  problem: "danger",
  inactive: "neutral",
};

/** Shared status words and what they mean, whichever module shows them. */
export const SHARED_STATUS_MEANING: Readonly<Record<string, StatusMeaning>> = {
  pending: "waiting",
  pending_approval: "waiting",
  pending_verification: "waiting",
  submitted: "waiting",
  requested: "waiting",
  planned: "active",
  scheduled: "active",
  in_progress: "active",
  completed: "done",
  posted: "done",
  paid: "done",
  credited: "done",
  fulfilled: "done",
  invoiced: "done",
  verified: "done",
  rejected: "problem",
  missed: "problem",
  bounced: "problem",
  draft: "inactive",
  cancelled: "inactive",
  written_off: "inactive",
};

export function toneOf(meaning: StatusMeaning): BadgeTone {
  return MEANING_TONE[meaning];
}

/** The shared colour of a status word, or null when the module decides (its word is not shared). */
export function sharedStatusTone(status: string | null | undefined): BadgeTone | null {
  if (!status) return null;
  const meaning = Object.prototype.hasOwnProperty.call(SHARED_STATUS_MEANING, status) ? SHARED_STATUS_MEANING[status] : undefined;
  return meaning ? MEANING_TONE[meaning] : null;
}
