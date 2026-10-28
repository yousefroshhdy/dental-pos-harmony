/**
 * Structured JSON logs (one line per event) so Vercel log drains can filter by
 * request id. Never log secrets, tokens, phone numbers or GPS coordinates.
 */
type Level = "debug" | "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
