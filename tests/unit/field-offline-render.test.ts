import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Next.js runtime pieces are not available in a plain server render.
vi.mock("@/i18n/navigation", async () => {
  const { createElement: h } = await import("react");
  return {
    Link: ({ href, ...props }: { href: string }) => h("a", { href, ...props }),
    useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/command", () => ({ callCommand: async () => ({ ok: true, data: null }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { CheckInButton } from "@/modules/field/components/check-in-button";
import { CheckOutForm } from "@/modules/field/components/check-out-form";
import { CompleteTaskFormClient } from "@/modules/field/components/complete-task-form-client";
import { ExceptionForm } from "@/modules/field/components/exception-form";

// Synthetic ids only (D-03).
const USER = "00000000-0000-4000-8000-00000000e0a1";
const VISIT = "00000000-0000-4000-8000-00000000e111";
const CUSTOMER = "00000000-0000-4000-8000-00000000e222";
const TASK = "00000000-0000-4000-8000-00000000e333";

function render(locale: "ar" | "en", node: ReactNode) {
  const root = join(__dirname, "../../messages");
  const load = (m: string) => JSON.parse(readFileSync(join(root, locale, `${m}.json`), "utf8"));
  const messages = { ...JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")), field: load("field"), offline: load("offline") };
  const provider = createElement(NextIntlClientProvider, { locale, messages, timeZone: "Africa/Cairo" } as ComponentProps<typeof NextIntlClientProvider>, node);
  return renderToString(provider);
}

/**
 * Server render (no window): the offline queue is browser-only, so the field
 * components must render their normal, online state without touching
 * IndexedDB; the saved-on-device state appears after hydration.
 */
describe.each(["ar", "en"] as const)("field components with the offline queue render on the server (%s)", (locale) => {
  const field = JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "field.json"), "utf8"));

  it("check-in shows its button", () => {
    const html = render(locale, createElement(CheckInButton, { visitId: VISIT, customerId: CUSTOMER, customerName: "Synthetic Clinic 01", userId: USER, mayRequestException: true }));
    expect(html).toContain(field.checkIn.button);
    expect(html).not.toContain(field.offline.savedTitle);
  });

  it("check-out shows its form", () => {
    const html = render(locale, createElement(CheckOutForm, { visitId: VISIT, userId: USER }));
    expect(html).toContain("<form");
    expect(html).toContain(field.checkOut.submit);
  });

  it("task completion shows its form", () => {
    const html = render(locale, createElement(CompleteTaskFormClient, { taskId: TASK, title: "Synthetic task", userId: USER }));
    expect(html).toContain(field.tasks.completeConfirm);
  });

  it("the exception form renders (online during server render)", () => {
    const html = render(locale, createElement(ExceptionForm, { visitId: VISIT }));
    expect(html).toContain(field.exception.reasonLabel);
    expect(html).not.toContain(field.offline.exceptionOffline);
  });
});
