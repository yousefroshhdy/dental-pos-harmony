import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The official loader must never be touched without a key (and never on the server).
const loaderImported = vi.fn();
vi.mock("@googlemaps/js-api-loader", () => {
  loaderImported();
  return { setOptions: vi.fn(), importLibrary: vi.fn(() => Promise.reject(new Error("no network in tests"))) };
});

import { MapView } from "@/components/map/map-view";
import { PlaceSearch } from "@/components/map/place-search";
import { importMapsLibrary, resetMapsLoaderForTests } from "@/lib/maps/loader";

function render(locale: "ar" | "en", node: ReactNode) {
  const root = join(__dirname, "../../messages");
  const messages = { ...JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")), maps: JSON.parse(readFileSync(join(root, locale, "maps.json"), "utf8")) };
  const provider = createElement(NextIntlClientProvider, { locale, messages, timeZone: "Africa/Cairo" } as ComponentProps<typeof NextIntlClientProvider>, node);
  return renderToString(provider);
}

afterEach(() => resetMapsLoaderForTests());

describe("map without NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", () => {
  const marker = { id: "m1", lat: 30.05, lng: 31.24, title: "Synthetic Clinic" };

  it.each([
    ["en", null, "Map key not configured"],
    ["ar", null, "مفتاح الخريطة غير مُعَدّ"],
    ["en", "", "Map key not configured"],
    ["en", "  not a key  ", "Map key not configured"],
  ] as const)("%s, key %j: shows the clear state", (locale, apiKey, text) => {
    const html = render(locale, createElement(MapView, { apiKey, locale, label: "Map", markers: [marker] }));
    expect(html).toContain(text);
    expect(html).toContain("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY");
    expect(html).toContain('role="status"');
  });

  it("makes no network call: the loader module is never imported", () => {
    render("en", createElement(MapView, { apiKey: null, locale: "en", label: "Map", markers: [marker] }));
    render("ar", createElement(PlaceSearch, { apiKey: null, locale: "ar", onPick: () => undefined }));
    expect(loaderImported).not.toHaveBeenCalled();
  });

  it("the address search renders nothing without a key", () => {
    expect(render("en", createElement(PlaceSearch, { apiKey: null, locale: "en", onPick: () => undefined }))).toBe("");
  });

  it("with a key, the server render is the map frame (the API loads in the browser only)", () => {
    const html = render("en", createElement(MapView, { apiKey: "AIzaSyTEST0000000000000000000000000000", locale: "en", label: "Customers", markers: [marker] }));
    expect(html).toContain('aria-label="Customers"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("Loading the map");
    expect(loaderImported).not.toHaveBeenCalled();
  });

  it("the loader refuses to run outside the browser", async () => {
    await expect(importMapsLibrary("AIzaSyTEST0000000000000000000000000000", "ar", "maps")).rejects.toThrow(/browser only/);
    expect(loaderImported).not.toHaveBeenCalled();
  });
});
