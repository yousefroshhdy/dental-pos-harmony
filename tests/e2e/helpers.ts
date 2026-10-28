import type { Page } from "@playwright/test";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

/** UI strings come from the real message catalogues, so copy edits don't break tests. */
export const messages = { ar, en } as const;
export type Locale = keyof typeof messages;

/** Arabic script block; proves a string is actually Arabic, not an untranslated fallback. */
export const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Smallest phone we support (docs/TESTING.md §2.7). */
export const SMALL_PHONE = { width: 360, height: 640 } as const;

/** Minimum tap target in CSS px (docs/TESTING.md §2.7). */
export const MIN_TAP_TARGET = 44;

export async function scrollExtent(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}
