import type { LatLng } from "@/lib/maps/geo";

/** Marker colours (hex, because the Maps API paints them, not CSS). */
export const MAP_TONES = {
  primary: "#0f766e",
  info: "#2563eb",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
  muted: "#6b7280",
} as const;
export type MapTone = keyof typeof MAP_TONES;

export interface MapLink {
  href: string;
  label: string;
  /** Opens in a new tab (Google Maps links). */
  external?: boolean;
}

/** Info window content. Plain text only: it is rendered with textContent, never as HTML. */
export interface MapInfo {
  title: string;
  lines?: string[];
  links?: MapLink[];
}

export interface MapMarker extends LatLng {
  id: string;
  title: string;
  tone?: MapTone;
  /** Short text inside the pin (a stop number). */
  label?: string;
  info?: MapInfo;
  /** A larger pin (the selected clinic, "you are here"). */
  emphasis?: boolean;
  draggable?: boolean;
}

export interface MapPolyline {
  id: string;
  path: LatLng[];
  tone?: MapTone;
  /** Dashed: a gap in the route (no points), drawn as a straight hop. */
  dashed?: boolean;
}
