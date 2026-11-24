"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { clusterPoints } from "@/lib/maps/cluster";
import { DEFAULT_ZOOM, EGYPT_CENTER, mapsKeyState, PIN_ZOOM, shouldLoadMaps } from "@/lib/maps/config";
import type { LatLng } from "@/lib/maps/geo";
import { importMapsLibrary, onMapsAuthFailure } from "@/lib/maps/loader";
import { cn } from "@/lib/utils";
import { MapStateBox } from "./map-states";
import { MAP_TONES, type MapInfo, type MapMarker, type MapPolyline } from "./types";

export type { MapMarker, MapPolyline, MapInfo } from "./types";

export interface MapViewProps {
  /** NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (from the server). Null → "Map key not configured", no network. */
  apiKey: string | null;
  locale: "ar" | "en";
  /** Accessible name of the map region. Pages also list the same items as text. */
  label: string;
  markers?: MapMarker[];
  polylines?: MapPolyline[];
  /** Group nearby markers into counted circles at low zoom. */
  cluster?: boolean;
  center?: LatLng;
  zoom?: number;
  /** Refit to the content when this changes (default: whenever the set of markers changes). */
  fitKey?: string;
  onMapClick?: (p: LatLng) => void;
  onMarkerDragEnd?: (id: string, p: LatLng) => void;
  className?: string;
}

type Status = "loading" | "ready" | "error" | "rejected";

const NO_MARKERS: MapMarker[] = [];
const NO_LINES: MapPolyline[] = [];

type Libs = {
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
  core: google.maps.CoreLibrary;
};

/**
 * The one shared Google map (Phase P step 3). Loads the Maps JS API lazily in the browser
 * through @googlemaps/js-api-loader (language ar|en, region EG), and draws markers (with
 * simple grid clustering), polylines and info windows. Without a key it renders a clear
 * "Map key not configured" box and never imports the loader.
 *
 * RTL: the map canvas is LTR (map gestures and controls assume it); info windows follow the
 * page direction. Info window content is built with textContent, so no data is ever HTML.
 */
export function MapView(props: MapViewProps) {
  const { apiKey, locale, label, markers = NO_MARKERS, polylines = NO_LINES, cluster = false, center, zoom, onMapClick, onMarkerDragEnd, className } = props;
  const t = useTranslations("maps.map");
  const keyState = useMemo(() => mapsKeyState(apiKey), [apiKey]);
  const ready = shouldLoadMaps(keyState);
  const key = ready ? keyState.key : null;

  const box = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const libs = useRef<Libs | null>(null);
  const info = useRef<google.maps.InfoWindow | null>(null);
  const drawn = useRef<{ setMap(m: google.maps.Map | null): void }[]>([]);
  const fittedFor = useRef<string | null>(null);
  const handlers = useRef({ onMapClick, onMarkerDragEnd });
  const [status, setStatus] = useState<Status>("loading");
  const [zoomLevel, setZoomLevel] = useState<number>(zoom ?? DEFAULT_ZOOM);

  useEffect(() => {
    handlers.current = { onMapClick, onMarkerDragEnd };
  }, [onMapClick, onMarkerDragEnd]);

  // Load the API and create the map once (only with a key).
  useEffect(() => {
    if (!key || !box.current) return;
    let cancelled = false;
    const unsubscribe = onMapsAuthFailure(() => setStatus("rejected"));
    Promise.all([
      importMapsLibrary(key, locale, "maps"),
      importMapsLibrary(key, locale, "marker"),
      importMapsLibrary(key, locale, "core"),
    ])
      .then(([maps, marker, core]) => {
        if (cancelled || !box.current) return;
        libs.current = { maps, marker, core };
        const m = new maps.Map(box.current, {
          center: center ?? EGYPT_CENTER,
          zoom: zoom ?? DEFAULT_ZOOM,
          clickableIcons: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          // One finger scrolls the page on phones; two fingers move the map.
          gestureHandling: "cooperative",
        });
        m.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (e.latLng) handlers.current.onMapClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        });
        m.addListener("zoom_changed", () => setZoomLevel(m.getZoom() ?? DEFAULT_ZOOM));
        info.current = new maps.InfoWindow();
        map.current = m;
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // The map is created once; later prop changes are drawn by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, locale]);

  const fitSignature = props.fitKey ?? `${markers.length}:${markers.map((m) => m.id).join(",")}:${polylines.length}`;

  // Draw markers, clusters and polylines; fit the view when the content changes.
  useEffect(() => {
    const m = map.current;
    const l = libs.current;
    if (status !== "ready" || !m || !l) return;
    for (const o of drawn.current) o.setMap(null);
    drawn.current = [];
    const dir = locale === "ar" ? "rtl" : "ltr";

    const openInfo = (anchor: google.maps.Marker, content: MapInfo) => {
      info.current?.setContent(infoContent(content, dir));
      info.current?.open({ map: m, anchor });
    };

    for (const line of polylines) {
      if (line.path.length < 2) continue;
      const color = MAP_TONES[line.tone ?? "primary"];
      const poly = new l.maps.Polyline({
        map: m,
        path: line.path,
        strokeColor: color,
        strokeOpacity: line.dashed ? 0 : 0.85,
        strokeWeight: 4,
        icons: line.dashed
          ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: color, scale: 3 }, offset: "0", repeat: "14px" }]
          : undefined,
      });
      drawn.current.push(poly);
    }

    const entries = cluster ? clusterPoints(markers, zoomLevel) : markers.map((item) => ({ kind: "point" as const, item }));
    for (const entry of entries) {
      if (entry.kind === "cluster") {
        const c = new l.marker.Marker({
          map: m,
          position: entry.center,
          title: t("cluster", { count: String(entry.count) }),
          label: { text: String(entry.count), color: "#ffffff", fontWeight: "600" },
          icon: { path: l.core.SymbolPath.CIRCLE, scale: 18, fillColor: MAP_TONES.primary, fillOpacity: 0.9, strokeColor: "#ffffff", strokeWeight: 2 },
        });
        const b = entry.bounds;
        c.addListener("click", () => m.fitBounds({ north: b.north, south: b.south, east: b.east, west: b.west }, 48));
        drawn.current.push(c);
        continue;
      }
      const p = entry.item;
      const marker = new l.marker.Marker({
        map: m,
        position: { lat: p.lat, lng: p.lng },
        title: p.title,
        draggable: p.draggable ?? false,
        label: p.label ? { text: p.label, color: "#ffffff", fontSize: "12px", fontWeight: "600" } : undefined,
        icon: {
          path: l.core.SymbolPath.CIRCLE,
          scale: p.emphasis ? 13 : p.label ? 11 : 8,
          fillColor: MAP_TONES[p.tone ?? "primary"],
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
        zIndex: p.emphasis ? 1000 : undefined,
      });
      if (p.info) {
        const content = p.info;
        marker.addListener("click", () => openInfo(marker, content));
      }
      if (p.draggable) {
        marker.addListener("dragend", (e: google.maps.MapMouseEvent) => {
          if (e.latLng) handlers.current.onMarkerDragEnd?.(p.id, { lat: e.latLng.lat(), lng: e.latLng.lng() });
        });
      }
      drawn.current.push(marker);
    }

    if (fittedFor.current !== fitSignature) {
      fittedFor.current = fitSignature;
      const pts: LatLng[] = [...markers, ...polylines.flatMap((pl) => pl.path)];
      if (pts.length === 1) {
        m.setCenter(pts[0]!);
        m.setZoom(zoom ?? PIN_ZOOM);
      } else if (pts.length > 1) {
        const bounds = new l.core.LatLngBounds();
        for (const pt of pts) bounds.extend(pt);
        m.fitBounds(bounds, 48);
      } else if (center) {
        m.setCenter(center);
      }
    }
  }, [status, markers, polylines, cluster, zoomLevel, fitSignature, locale, center, zoom, t]);

  if (!ready) return <MapStateBox className={className} title={t("noKeyTitle")} body={t("noKeyBody")} tone="info" />;

  return (
    <div className={cn("relative overflow-hidden rounded-lg border bg-muted", className ?? "h-[60vh] min-h-72 w-full")}>
      <div ref={box} dir="ltr" role="region" aria-label={label} className="absolute inset-0" />
      {status === "loading" ? (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground" role="status">
          {t("loading")}
        </div>
      ) : null}
      {status === "error" || status === "rejected" ? (
        <div className="absolute inset-0 grid place-items-center bg-card/95 p-4" role="alert">
          <div className="max-w-sm space-y-1 text-center">
            <p className="font-medium">{status === "rejected" ? t("rejectedTitle") : t("errorTitle")}</p>
            <p className="text-sm text-muted-foreground">{status === "rejected" ? t("rejectedBody") : t("errorBody")}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Info window DOM, text only. */
function infoContent(content: MapInfo, dir: "rtl" | "ltr"): HTMLElement {
  const root = document.createElement("div");
  root.dir = dir;
  root.style.maxWidth = "260px";
  root.style.fontSize = "14px";
  root.style.lineHeight = "1.4";
  const title = document.createElement("p");
  title.style.fontWeight = "600";
  title.style.margin = "0 0 4px";
  title.textContent = content.title;
  root.append(title);
  for (const line of content.lines ?? []) {
    const p = document.createElement("p");
    p.style.margin = "0 0 2px";
    p.textContent = line;
    root.append(p);
  }
  for (const link of content.links ?? []) {
    const a = document.createElement("a");
    a.href = link.href;
    a.textContent = link.label;
    a.style.display = "inline-block";
    a.style.minHeight = "44px";
    a.style.lineHeight = "44px";
    a.style.marginInlineEnd = "12px";
    a.style.color = MAP_TONES.info;
    if (link.external) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    root.append(a);
  }
  return root;
}
