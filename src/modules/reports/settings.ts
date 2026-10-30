/**
 * Export settings. The row cap is read from the server environment
 * (`REPORTS_EXPORT_MAX_ROWS`), defaulting to 50,000 rows per file. It is not a
 * secret; it lives in the environment (not core.system_settings) only because
 * the api schema has no settings read yet.
 */
export const DEFAULT_ROW_CAP = 50_000;
/** Hard ceiling, whatever the setting says (memory and function duration). */
export const MAX_ROW_CAP = 200_000;

export function exportRowCap(raw: string | undefined = process.env.REPORTS_EXPORT_MAX_ROWS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ROW_CAP;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ROW_CAP;
  return Math.min(n, MAX_ROW_CAP);
}
