/**
 * GPS consent acknowledgement (docs/ARCHITECTURE.md §7: one-time, versioned,
 * stored with a timestamp).
 *
 * INTERIM: no table or command for consent records exists yet, so the
 * acknowledgement is kept on the device only. It is NOT a legal record: a DB
 * record (per user, per text version) is needed before production data
 * (decision D-03). Bump GPS_CONSENT_VERSION whenever the consent text changes,
 * so every rep acknowledges the new text.
 */

export const GPS_CONSENT_VERSION = "2026-10-29.1";
export const GPS_CONSENT_STORAGE_KEY = "honest.field.gpsConsent";

export interface GpsConsentRecord {
  version: string;
  acceptedAt: string;
  /** The user the acknowledgement belongs to (shared devices). */
  userId: string;
}

export type ConsentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): ConsentStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage disabled (private mode, policy)
  }
}

export function parseConsent(raw: string | null): GpsConsentRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GpsConsentRecord>;
    if (typeof v.version !== "string" || typeof v.acceptedAt !== "string" || typeof v.userId !== "string") return null;
    return { version: v.version, acceptedAt: v.acceptedAt, userId: v.userId };
  } catch {
    return null;
  }
}

/** The current text version was acknowledged by this user on this device. */
export function hasCurrentConsent(userId: string, store: ConsentStorage | null = storage()): boolean {
  const record = parseConsent(store?.getItem(GPS_CONSENT_STORAGE_KEY) ?? null);
  return record !== null && record.version === GPS_CONSENT_VERSION && record.userId === userId;
}

export function readConsent(store: ConsentStorage | null = storage()): GpsConsentRecord | null {
  return parseConsent(store?.getItem(GPS_CONSENT_STORAGE_KEY) ?? null);
}

export function recordConsent(userId: string, now: Date = new Date(), store: ConsentStorage | null = storage()): GpsConsentRecord {
  const record: GpsConsentRecord = { version: GPS_CONSENT_VERSION, acceptedAt: now.toISOString(), userId };
  try {
    store?.setItem(GPS_CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota or policy: the acknowledgement then lasts for this page only.
  }
  return record;
}

export function withdrawConsent(store: ConsentStorage | null = storage()): void {
  try {
    store?.removeItem(GPS_CONSENT_STORAGE_KEY);
  } catch {
    // nothing stored
  }
}
