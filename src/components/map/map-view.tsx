"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MLMap, MapGeoJSONFeature, Popup, StyleSpecification } from "maplibre-gl";
import { Layers, MapPin, Search, X } from "lucide-react";
import { useApp } from "@/components/providers";
import type { MapPin as Pin, MapRound } from "@/lib/game/answer-geo";

type LayerMeta = { id: LayerId; file: string; geometry: "fill" | "line" | "circle"; group: string; count: number; sources: { title: string; url: string; license: string; retrieved: string }[] };
type Index = { generated: string; bbox: [number, number, number, number]; layers: LayerMeta[] };
type Fc = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
type LayerId =
  | "areas" | "neighbourhoods" | "roads" | "interchanges" | "bridges" | "rail" | "stations" | "parks" | "gardens"
  | "heritage" | "museums" | "theatres" | "festivals" | "skyscrapers" | "food";

/** Base map: OpenFreeMap (OpenStreetMap data, ODbL; no key). If it can't load, a plain local style is used. */
const BASE_STYLE = "https://tiles.openfreemap.org/styles/dark";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const FONT = ["Noto Sans Regular"];
const ISLAND: [number, number, number, number] = [-73.98, 45.4, -73.47, 45.71];
const FALLBACK: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#1d2a44" } }],
};

const COLOR: Record<LayerId, string> = {
  areas: "#8aa4d6", neighbourhoods: "#b9c6e6", roads: "#ef5b4c", interchanges: "#ffb547", bridges: "#ffd166", rail: "#d95700",
  stations: "#ffffff", parks: "#4cc38a", gardens: "#9be15d", heritage: "#c99bff", museums: "#5ec8ff", theatres: "#ff7eb6",
  festivals: "#ff9f1c", skyscrapers: "#a3b1c6", food: "#ffcc4d",
};
const CLUSTERED = new Set<LayerId>(["food", "parks", "heritage", "gardens"]);
const DEFAULT_ON = new Set<LayerId>(["areas", "roads", "rail", "stations", "parks", "bridges"]);
const ROLE_COLOR: Record<Pin["role"], string> = { matched: "#22c55e", popular: "#38bdf8", rarest: "#f472b6" };

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Hit = { layer: LayerId; name: string; sub?: string; lon: number; lat: number; props: Record<string, unknown> };

export function MapView({ game }: { game: string | null }) {
  const { t, locale } = useApp();
  const tm = t.map;
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const data = useRef(new Map<LayerId, Fc>());
  const [index, setIndex] = useState<Index | null>(null);
  const [on, setOn] = useState<Set<LayerId>>(new Set(DEFAULT_ON));
  const [ready, setReady] = useState(false);
  const [baseFailed, setBaseFailed] = useState(false);
  const [panel, setPanel] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [ride, setRide] = useState<{ rounds: MapRound[]; pins: Pin[] } | null | "missing">(null);
  const [styleTick, setStyleTick] = useState(0);

  const load = useCallback(
    async (id: LayerId): Promise<Fc | null> => {
      if (data.current.has(id)) return data.current.get(id)!;
      const meta = index?.layers.find((l) => l.id === id);
      if (!meta) return null;
      const fc = (await (await fetch(meta.file)).json()) as Fc;
      data.current.set(id, fc);
      return fc;
    },
    [index],
  );

  const popupHtml = useCallback(
    (layer: LayerId, p: Record<string, unknown>) => {
      const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const kindKey = String(p.kind ?? p.system ?? p.cls ?? "");
      const kind = tm.kind[kindKey] ?? tm.layer[layer];
      const name = layer === "roads" ? `${p.ref ?? ""}` : String(p.name ?? "");
      const alt = locale === "en" && p.name_en ? String(p.name_en) : null;
      const lines = [
        `<strong>${esc(alt ?? name)}</strong>`,
        alt && alt !== name ? `<span class="opacity-70">${esc(name)}</span>` : "",
        layer === "roads" && p.name ? esc(p.name) : "",
        `<span class="opacity-70">${esc(kind)}${p.area ? ` · ${esc(p.area)}` : ""}${typeof p.ha === "number" && p.ha > 0 ? ` · ${esc(tm.hectares(p.ha as number))}` : ""}</span>`,
      ];
      return `<div class="ml-pop">${lines.filter(Boolean).join("<br/>")}</div>`;
    },
    [locale, tm],
  );

  // ---------------------------------------------------------------- init
  useEffect(() => {
    let cancelled = false;
    fetch("/map/index.json")
      .then((r) => r.json())
      .then((ix: Index) => !cancelled && setIndex(ix))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!box.current || mapRef.current) return;
    let disposed = false;
    (async () => {
      const lib = await import("maplibre-gl");
      if (disposed || !box.current) return;
      libRef.current = lib;
      // The bundled default worker URL 404s; serve the copy in public/vendor (scripts/copy-maplibre-worker.mjs).
      lib.setWorkerUrl(`/vendor/maplibre-gl-worker.mjs?v=${lib.getVersion()}`);
      const map = new lib.Map({
        container: box.current,
        style: BASE_STYLE,
        bounds: ISLAND,
        fitBoundsOptions: { padding: 16 },
        maxBounds: [-74.6, 45.0, -72.8, 46.1],
        minZoom: 8,
        attributionControl: { compact: true, customAttribution: "Données : Ville de Montréal, STM, ARTM/REM, exo, Wikidata, Wikipédia · © OpenStreetMap" },
        dragRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new lib.ScaleControl({ unit: "metric" }), "bottom-left");
      mapRef.current = map;
      // The base style is remote: if it fails before loading, switch to a local plain style (data layers re-added on style.load).
      const fail = window.setTimeout(() => {
        if (!map.isStyleLoaded()) {
          setBaseFailed(true);
          map.setStyle(FALLBACK);
        }
      }, 10000);
      map.on("error", (e) => {
        if (!map.isStyleLoaded() && /style|tiles\.openfreemap/i.test(String(e.error?.message ?? ""))) {
          window.clearTimeout(fail);
          setBaseFailed(true);
          map.setStyle(FALLBACK);
        }
      });
      map.on("style.load", () => {
        window.clearTimeout(fail);
        setStyleTick((n) => n + 1);
        setReady(true);
      });
    })();
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- data layers
  const ensureLayer = useCallback(
    async (id: LayerId) => {
      const map = mapRef.current;
      if (!map || !index) return;
      const fc = await load(id);
      if (!fc || !map.getStyle()) return;
      const src = `src-${id}`;
      if (map.getSource(src)) return;
      const meta = index.layers.find((l) => l.id === id)!;
      const clustered = CLUSTERED.has(id);
      map.addSource(src, { type: "geojson", data: fc, ...(clustered ? { cluster: true, clusterMaxZoom: 14, clusterRadius: 44 } : {}) });
      const c = COLOR[id];
      const before = map.getLayer("ride-pins") ? "ride-pins" : undefined;
      if (meta.geometry === "fill") {
        map.addLayer({ id: `${id}-fill`, type: "fill", source: src, paint: { "fill-color": c, "fill-opacity": id === "areas" ? 0.06 : 0.03 } }, before);
        map.addLayer({ id: `${id}-line`, type: "line", source: src, paint: { "line-color": c, "line-width": id === "areas" ? 1.4 : 0.8, "line-opacity": 0.7, ...(id === "neighbourhoods" ? { "line-dasharray": [2, 2] } : {}) } }, before);
        map.addLayer({ id: `${id}-label`, type: "symbol", source: src, minzoom: id === "areas" ? 10 : 12.5,
          layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": id === "areas" ? 12 : 11, "symbol-placement": "point" },
          paint: { "text-color": c, "text-halo-color": "#0b1020", "text-halo-width": 1.2 } }, before);
      } else if (meta.geometry === "line") {
        if (id === "roads") {
          map.addLayer({ id: "roads-line", type: "line", source: src, layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": ["match", ["get", "cls"], "autoroute", "#ef5b4c", "#f59e0b"], "line-width": ["interpolate", ["linear"], ["zoom"], 9, ["match", ["get", "cls"], "autoroute", 1.6, 0.8], 14, ["match", ["get", "cls"], "autoroute", 4.5, 2.5]], "line-opacity": 0.85 } }, before);
          map.addLayer({ id: "roads-label", type: "symbol", source: src, minzoom: 10,
            layout: { "symbol-placement": "line", "text-field": ["get", "ref"], "text-font": FONT, "text-size": 11, "symbol-spacing": 400 },
            paint: { "text-color": "#fff", "text-halo-color": ["match", ["get", "cls"], "autoroute", "#b42318", "#a15c07"], "text-halo-width": 2 } }, before);
        } else {
          map.addLayer({ id: `${id}-line`, type: "line", source: src, layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": ["coalesce", ["get", "color"], c], "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2, 14, 5] } }, before);
        }
      } else {
        if (clustered) {
          map.addLayer({ id: `${id}-cluster`, type: "circle", source: src, filter: ["has", "point_count"],
            paint: { "circle-color": c, "circle-opacity": 0.75, "circle-stroke-color": "#0b1020", "circle-stroke-width": 1.5,
              "circle-radius": ["step", ["get", "point_count"], 13, 20, 17, 100, 22] } }, before);
          map.addLayer({ id: `${id}-count`, type: "symbol", source: src, filter: ["has", "point_count"],
            layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 11 }, paint: { "text-color": "#0b1020" } }, before);
        }
        map.addLayer({ id: `${id}-pt`, type: "circle", source: src, ...(clustered ? { filter: ["!", ["has", "point_count"]] } : {}),
          paint: { "circle-color": c, "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, id === "stations" ? 3 : 4, 15, id === "stations" ? 6 : 7],
            "circle-stroke-color": "#0b1020", "circle-stroke-width": 1.2 } }, before);
        map.addLayer({ id: `${id}-label`, type: "symbol", source: src, minzoom: id === "stations" ? 12.5 : 14.5, ...(clustered ? { filter: ["!", ["has", "point_count"]] } : {}),
          layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
          paint: { "text-color": "#e6ecff", "text-halo-color": "#0b1020", "text-halo-width": 1.2 } }, before);
      }
      const clickable = meta.geometry === "fill" ? `${id}-fill` : meta.geometry === "line" ? `${id}-line` : `${id}-pt`;
      map.on("click", clickable, (e) => {
        const f = e.features?.[0] as MapGeoJSONFeature | undefined;
        if (!f || !libRef.current) return;
        popupRef.current?.remove();
        popupRef.current = new libRef.current.Popup({ closeButton: true, maxWidth: "260px" }).setLngLat(e.lngLat).setHTML(popupHtml(id, f.properties)).addTo(map);
      });
      if (clustered) {
        map.on("click", `${id}-cluster`, async (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const zoom = await (map.getSource(src) as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id as number);
          map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
        });
      }
      for (const l of [clickable, `${id}-cluster`]) {
        map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
      }
    },
    [index, load, popupHtml],
  );

  const layerIds = useCallback((id: LayerId) => {
    const map = mapRef.current;
    return map ? [`${id}-fill`, `${id}-line`, `${id}-label`, `${id}-pt`, `${id}-cluster`, `${id}-count`, "roads-line", "roads-label"].filter((l) => (l.startsWith(id) || l.startsWith(`${id}-`)) && map.getLayer(l)) : [];
  }, []);

  // Apply visibility (adds a layer's source on first use: lazy, so unused layers are never downloaded).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !index || !map) return;
    (async () => {
      for (const l of index.layers) {
        if (on.has(l.id)) await ensureLayer(l.id);
        for (const lid of layerIds(l.id)) map.setLayoutProperty(lid, "visibility", on.has(l.id) ? "visible" : "none");
      }
    })();
  }, [on, ready, index, ensureLayer, layerIds, styleTick]);

  // ---------------------------------------------------------------- your ride
  useEffect(() => {
    if (!game) return;
    fetch(`/api/game/${encodeURIComponent(game)}/map`)
      .then(async (r) => (r.ok ? setRide(await r.json()) : setRide("missing")))
      .catch(() => setRide("missing"));
  }, [game]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !ride || ride === "missing" || !ride.pins.length) return;
    const fc: Fc = {
      type: "FeatureCollection",
      features: ride.pins.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { ...p, label: locale === "fr" ? p.fr : p.en } })),
    };
    if (!map.getSource("ride")) {
      map.addSource("ride", { type: "geojson", data: fc });
      map.addLayer({ id: "ride-pins", type: "circle", source: "ride",
        paint: { "circle-radius": 9, "circle-color": ["match", ["get", "role"], "matched", ROLE_COLOR.matched, "rarest", ROLE_COLOR.rarest, ROLE_COLOR.popular], "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
      map.addLayer({ id: "ride-labels", type: "symbol", source: "ride",
        layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 12, "text-offset": [0, 1.4], "text-anchor": "top" },
        paint: { "text-color": "#fff", "text-halo-color": "#0b1020", "text-halo-width": 1.5 } });
    } else (map.getSource("ride") as GeoJSONSource).setData(fc);
    const lons = ride.pins.map((p) => p.lon);
    const lats = ride.pins.map((p) => p.lat);
    map.fitBounds([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], { padding: 60, maxZoom: 14, duration: 0 });
  }, [ride, ready, locale, styleTick]);

  // ---------------------------------------------------------------- search
  useEffect(() => {
    const term = norm(q);
    if (term.length < 2 || !index) return; // the results list is hidden below 2 characters
    let stale = false;
    const handle = window.setTimeout(async () => {
      const pts = index.layers.filter((l) => l.geometry === "circle" || l.id === "areas" || l.id === "neighbourhoods");
      const all: Hit[] = [];
      for (const l of pts) {
        const fc = await load(l.id);
        for (const f of fc?.features ?? []) {
          const p = f.properties;
          const names = [p.name, p.name_en].filter(Boolean).map(String);
          if (!names.some((n) => norm(n).includes(term))) continue;
          const g = f.geometry;
          const [lon, lat] = g.type === "Point" ? (g.coordinates as [number, number]) : centroid(g);
          all.push({ layer: l.id, name: String(locale === "en" && p.name_en ? p.name_en : p.name), sub: p.area ? String(p.area) : undefined, lon, lat, props: p });
        }
      }
      const rank = (h: Hit) => (norm(h.name).startsWith(term) ? 0 : 1);
      if (!stale) setHits(all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 8));
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(handle);
    };
  }, [q, index, load, locale]);

  const goTo = (h: { lon: number; lat: number }, layer?: LayerId, props?: Record<string, unknown>) => {
    const map = mapRef.current;
    if (!map || !libRef.current) return;
    if (layer && !on.has(layer)) setOn((s) => new Set(s).add(layer));
    map.flyTo({ center: [h.lon, h.lat], zoom: Math.max(map.getZoom(), 15) });
    if (layer && props) {
      popupRef.current?.remove();
      popupRef.current = new libRef.current.Popup({ maxWidth: "260px" }).setLngLat([h.lon, h.lat]).setHTML(popupHtml(layer, props)).addTo(map);
    }
    setPanel(false);
  };

  const groups = useMemo(() => {
    const g = new Map<string, LayerMeta[]>();
    for (const l of index?.layers ?? []) g.set(l.group, [...(g.get(l.group) ?? []), l]);
    return [...g.entries()];
  }, [index]);

  const toggle = (id: LayerId) => setOn((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="relative -mx-4 h-[calc(100dvh-3.5rem)] overflow-hidden sm:mx-0 sm:h-[calc(100dvh-7rem)] sm:rounded-2xl sm:border sm:border-border">
      {/* size-full: maplibre-gl.css (unlayered) sets .maplibregl-map{position:relative}, which beats Tailwind's layered
          `absolute`, so inset-0 alone collapses the map to 0px tall. */}
      <div ref={box} className="absolute inset-0 size-full" data-testid="map-canvas" data-ready={ready ? "1" : "0"} aria-label={tm.title} role="region" />
      {!ready && <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm opacity-70">{tm.loading}</div>}

      <button
        type="button"
        onClick={() => setPanel((p) => !p)}
        className="absolute left-3 top-3 z-10 inline-flex h-11 items-center gap-2 rounded-xl bg-background/90 px-3 text-sm font-bold shadow-lg backdrop-blur"
        aria-expanded={panel}
        aria-controls="map-panel"
        data-testid="map-panel-toggle"
      >
        {panel ? <X className="size-4" /> : <Layers className="size-4" />}
        {panel ? tm.hideLayers : tm.showLayers}
      </button>

      <aside
        id="map-panel"
        className={`absolute inset-x-2 bottom-2 top-16 z-10 flex flex-col gap-3 overflow-y-auto rounded-2xl bg-background/95 p-4 shadow-2xl backdrop-blur sm:inset-x-auto sm:left-3 sm:w-80 ${panel ? "" : "hidden"}`}
        data-testid="map-panel"
      >
        <label className="relative block">
          <span className="sr-only">{tm.search}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 opacity-60" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tm.searchPlaceholder}
            className="h-11 w-full rounded-xl border border-border bg-muted/40 pl-9 pr-3 text-sm"
            data-testid="map-search"
          />
        </label>
        {q.trim().length >= 2 && (
          <ul className="space-y-1" data-testid="map-search-results">
            {hits.length === 0 && <li className="text-sm opacity-70">{tm.noResults}</li>}
            {hits.map((h, i) => (
              <li key={i}>
                <button type="button" onClick={() => goTo(h, h.layer, h.props)} className="flex min-h-11 w-full flex-col items-start rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted">
                  <span className="font-semibold">{h.name}</span>
                  <span className="text-xs opacity-70">{tm.layer[h.layer]}{h.sub ? ` · ${h.sub}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <h2 className="text-xs font-bold uppercase tracking-[0.18em] opacity-60">{tm.layers}</h2>
        {groups.map(([group, layers]) => (
          <fieldset key={group} className="space-y-1">
            <legend className="mb-1 text-sm font-bold">{tm.groups[group as keyof typeof tm.groups] ?? group}</legend>
            {layers.map((l) => (
              <label key={l.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={on.has(l.id)} onChange={() => toggle(l.id)} className="size-4 accent-[var(--line-orange)]" data-testid={`layer-${l.id}`} />
                <span className="inline-block size-3 rounded-full" style={{ background: COLOR[l.id] }} aria-hidden />
                <span className="flex-1">{tm.layer[l.id]}</span>
                <span className="text-xs tabular-nums opacity-60">{l.count.toLocaleString(locale === "fr" ? "fr-CA" : "en-CA")}</span>
              </label>
            ))}
          </fieldset>
        ))}

        <details className="text-xs opacity-80">
          <summary className="cursor-pointer font-bold">{tm.sources}</summary>
          <ul className="mt-2 space-y-1">
            {[...new Map((index?.layers ?? []).flatMap((l) => l.sources).map((s) => [s.url, s])).values()].map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer" className="underline">{s.title}</a> — {s.license} ({s.retrieved})
              </li>
            ))}
          </ul>
        </details>
      </aside>

      {baseFailed && <p className="absolute inset-x-3 bottom-10 z-10 rounded-lg bg-background/90 p-2 text-xs sm:left-auto sm:w-80">{tm.baseFailed}</p>}

      {game && ride && (
        <section className="absolute bottom-8 right-2 z-10 max-h-[45%] w-[min(22rem,calc(100%-1rem))] overflow-y-auto rounded-2xl bg-background/95 p-3 text-sm shadow-2xl backdrop-blur" data-testid="ride-panel">
          {ride === "missing" ? (
            <p>{tm.rideNotFound}</p>
          ) : (
            <>
              <h2 className="font-bold">{tm.yourRide}</h2>
              <p className="mb-2 text-xs opacity-70">{tm.rideHint}</p>
              <ol className="space-y-2">
                {ride.rounds.map((r) => (
                  <li key={r.round}>
                    <p className="text-xs font-semibold opacity-80">{tm.stop(r.round + 1)} · {r.prompt[locale]}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {ride.pins.filter((p) => p.round === r.round).map((p, i) => (
                        <button key={i} type="button" onClick={() => goTo(p)} className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-2 text-xs hover:bg-muted" data-testid="ride-pin">
                          <MapPin className="size-3" style={{ color: ROLE_COLOR[p.role] }} aria-hidden />
                          <span>{locale === "fr" ? p.fr : p.en}</span>
                          <span className="sr-only">({tm.role[p.role]})</span>
                        </button>
                      ))}
                      {r.located === 0 && <span className="text-xs opacity-60">{tm.notLocated}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function centroid(g: GeoJSON.Geometry): [number, number] {
  let ring: number[][] = [];
  if (g.type === "Polygon") ring = g.coordinates[0];
  else if (g.type === "MultiPolygon") ring = g.coordinates.reduce((a, p) => (p[0].length > a.length ? p[0] : a), [] as number[][]);
  else if (g.type === "LineString") ring = g.coordinates;
  if (!ring.length) return [-73.6, 45.5];
  const s = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / ring.length, s[1] / ring.length];
}
