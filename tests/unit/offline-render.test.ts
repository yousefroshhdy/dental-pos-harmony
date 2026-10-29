import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next-intl's navigation needs the Next.js runtime; a plain anchor is enough here.
vi.mock("@/i18n/navigation", async () => {
  const { createElement: h } = await import("react");
  return { Link: ({ href, ...props }: { href: string }) => h("a", { href, ...props }) };
});

import type { SyncEngine } from "@/lib/offline/sync";
import type { QueueItem } from "@/lib/offline/types";
import { QueueItemCard } from "@/modules/offline/components/queue-item-card";
import { SyncIndicator } from "@/modules/offline/components/sync-indicator";
import { SyncQueueView } from "@/modules/offline/components/sync-queue-view";

// Server render (no window): the queue is browser-only, so both components must
// render their loading state without touching IndexedDB.
const USER = "00000000-0000-4000-8000-0000000000d1";

function render(locale: "ar" | "en", node: ReactNode) {
  const root = join(__dirname, "../../messages");
  const messages = {
    ...JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")),
    offline: JSON.parse(readFileSync(join(root, locale, "offline.json"), "utf8")),
  };
  const html = renderToString(createElement(NextIntlClientProvider, { locale, messages, timeZone: "Africa/Cairo" } as ComponentProps<typeof NextIntlClientProvider>, node));
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

describe.each(["ar", "en"] as const)("offline components render on the server (%s)", (locale) => {
  it("the indicator renders a labelled button, with the panel closed", () => {
    const html = render(locale, createElement(SyncIndicator, { userId: USER }));
    expect(html).toMatch(/<button[^>]+aria-label="[^"]+"/);
    expect(html).toContain("<dialog");
    expect(html).not.toContain("<h2");
  });

  it("the sync view renders its heading and loading state", () => {
    const html = render(locale, createElement(SyncQueueView, { userId: USER }));
    expect(html).toContain("<h1");
    expect(html).toContain('role="status"');
  });

  const messages = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "offline.json"), "utf8"));
  const coreErrors = JSON.parse(readFileSync(join(__dirname, "../../messages", `${locale}.json`), "utf8")).errors;
  const engine = { canKeepMine: () => true } as unknown as SyncEngine;
  const at = "2026-10-29T08:00:00.000Z";
  const base: QueueItem = {
    id: "11111111-1111-4111-8111-111111111111",
    userId: USER,
    command: "field.visit_check_in",
    args: { p_customer_id: "c-1" },
    groupKey: null,
    summary: "Test Clinic (synthetic)",
    createdAt: at,
    seq: 1,
    attempts: 2,
    status: "failed",
    lastError: { code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED", at, requestId: "req-1" },
    flag: null,
    staleAcknowledged: false,
    result: null,
    updatedAt: at,
  };
  const card = (over: Partial<QueueItem>) => render(locale, createElement(QueueItemCard, { item: { ...base, ...over }, engine, online: true }));

  it("a failed item shows its command label and the translated reason", () => {
    const html = card({});
    expect(html).toContain(messages.commands.field.visit_check_in);
    expect(html).toContain(coreErrors.PERMISSION_DENIED);
    expect(html).toContain(messages.actions.retry);
  });

  it("an engine code uses the offline translation; unknown commands get a generic label", () => {
    const html = card({ command: "x.unknown_cmd", status: "pending", lastError: { code: "NO_SENDER", messageKey: "UNKNOWN", at } });
    expect(html).toContain(messages.commands.unknown);
    expect(html).toContain(messages.codes.NO_SENDER);
  });

  it("a stale item offers 'send anyway'; a conflict shows the server-vs-yours diff", () => {
    expect(card({ status: "pending", flag: "stale", lastError: null })).toContain(messages.actions.sendAnyway);
    const html = card({
      command: "crm.update_customer",
      status: "conflict",
      args: { p_version: 2 },
      lastError: { code: "CONFLICT", messageKey: "CONFLICT", at, conflict: { currentVersion: 3 } },
    });
    expect(html).toContain(messages.conflict.title);
    expect(html).toContain(messages.conflict.differs);
    expect(html).toContain(messages.actions.keepMine);
  });
});
