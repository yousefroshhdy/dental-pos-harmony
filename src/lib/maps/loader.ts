/// <reference types="google.maps" />
import { loaderOptions } from "./config";

/**
 * Browser-only access to the Google Maps JavaScript API through the official loader
 * (@googlemaps/js-api-loader v2, functional API). The loader module itself is imported lazily,
 * on the first map that has a key, so pages without a map (or without a key) never download it.
 *
 * The API loads once per page: the first call fixes the key and language (Arabic or English,
 * region EG). A locale switch takes effect on the next full page load.
 */

type LoaderModule = typeof import("@googlemaps/js-api-loader");
type LibraryName = keyof google.maps.ImportLibraryMap;

let configured: Promise<LoaderModule> | null = null;
let authFailed = false;
const authListeners = new Set<() => void>();

/** Google calls window.gm_authFailure() when the key is rejected (wrong referrer, API disabled, billing). */
function watchAuthFailure() {
  if (typeof window === "undefined") return;
  (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
    authFailed = true;
    for (const listener of authListeners) listener();
  };
}

/** Subscribe to a key rejection; returns the unsubscribe function. Fires at once if it already happened. */
export function onMapsAuthFailure(listener: () => void): () => void {
  if (authFailed) listener();
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function importMapsLibrary<N extends LibraryName>(
  key: string,
  locale: string,
  name: N,
): Promise<google.maps.ImportLibraryMap[N]> {
  if (typeof window === "undefined") return Promise.reject(new Error("Google Maps loads in the browser only"));
  configured ??= import("@googlemaps/js-api-loader").then(
    (loader) => {
      watchAuthFailure();
      loader.setOptions(loaderOptions(key, locale));
      return loader;
    },
    (cause: unknown) => {
      configured = null; // offline or blocked: a later map may try again
      throw cause;
    },
  );
  return configured.then((loader) => loader.importLibrary(name));
}

/** Test hook: forget the loaded state. */
export function resetMapsLoaderForTests() {
  configured = null;
  authFailed = false;
  authListeners.clear();
}
