import { routing } from "@/i18n/routing";

/**
 * Accepts only same-origin, locale-prefixed paths for post-login redirects
 * (prevents open redirects such as `?next=//evil.com` or `?next=https://…`).
 */
export function safeNextPath(next: unknown, locale: string): string {
  const fallback = `/${locale}`;
  if (typeof next !== "string" || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\r\n\t]/.test(next)) return fallback;
  const firstSegment = next.split(/[/?#]/)[1] ?? "";
  if (!(routing.locales as readonly string[]).includes(firstSegment)) return fallback;
  if (/^\/(ar|en)\/login(\/|\?|$)/.test(next)) return fallback;
  return next;
}
