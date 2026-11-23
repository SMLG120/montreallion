/**
 * Post-deploy /map smoke test in a real browser (desktop + mobile). Read-only.
 *   node scripts/smoke-map.ts https://your-deployment.example
 * Checks: MapLibre worker (200, JS MIME), no worker/CSP/WebGL/init errors, nonzero canvas that is visibly drawn,
 * base map + transit lines + stations + clusters rendered, zoom, pan, layer toggle, search, and data/tile requests.
 */
import { chromium, devices, type Page } from "@playwright/test";

const base = (process.argv[2] ?? process.env.SMOKE_URL ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke-map.ts <base-url>");
  process.exit(2);
}

type Rendered = { base: number; rail: number; stations: number; clusters: number; food: number; zoom: number; center: [number, number] };
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const rendered = async (page: Page): Promise<Rendered | null> => {
  const raw = await page.getByTestId("map-canvas").getAttribute("data-rendered");
  return raw ? (JSON.parse(raw) as Rendered) : null;
};
const until = async <T>(page: Page, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await page.waitForTimeout(250);
    v = await fn();
  }
  return v;
};

async function run(label: string, device: (typeof devices)[string]) {
  console.log(`\n# ${label}`);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ ...device })).newPage();
  const errors: string[] = [];
  const bad: string[] = [];
  let tiles = 0;
  let geojson = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || /worker|content security policy|webgl/i.test(m.text())) {
      if (!/GPU stall|GL Driver Message/i.test(m.text())) errors.push(m.text());
    }
  });
  page.on("requestfailed", (r) => bad.push(`${r.failure()?.errorText} ${r.url()}`));
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("tiles.openfreemap.org") && /\.pbf|\/tiles\//.test(u) && r.ok()) tiles++;
    if (/\/map\/[^/]+\.geojson/.test(u) && r.ok()) geojson++;
    if (r.status() >= 400 && (u.startsWith(base) || u.includes("openfreemap"))) bad.push(`${r.status()} ${u}`);
  });

  const worker = page.waitForResponse((r) => r.url().includes("/vendor/maplibre-gl-worker.mjs"), { timeout: 30_000 }).catch(() => null);
  await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
  const w = await worker;
  check("worker 200 + JavaScript MIME", !!w && w.status() === 200 && /javascript/.test(w.headers()["content-type"] ?? ""), w ? `${w.status()} ${w.headers()["content-type"]}` : "never requested");

  const r0 = await until(page, () => rendered(page), (v) => !!v && v.base > 0 && v.rail > 0 && v.stations > 0 && v.clusters > 0, 30_000);
  check("base map, transit lines, stations, clusters rendered", !!r0 && r0.base > 0 && r0.rail > 0 && r0.stations > 0 && r0.clusters > 0, JSON.stringify(r0));

  const box = await page.locator("canvas.maplibregl-canvas").boundingBox();
  check("canvas has nonzero size", !!box && box.width > 100 && box.height > 100, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "no canvas");
  // Visibly drawn: a blank/collapsed map is one or two flat colours.
  const shot = (await page.locator("canvas.maplibregl-canvas").screenshot()).toString("base64");
  const colours = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    [c.width, c.height] = [img.width, img.height];
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 37) seen.add((d[i] >> 3) | ((d[i + 1] >> 3) << 5) | ((d[i + 2] >> 3) << 10));
    return seen.size;
  }, shot);
  check("canvas visibly drawn", colours > 50, `${colours} distinct colours sampled`);

  if (r0) {
    await page.locator(".maplibregl-ctrl-zoom-in").click();
    const z = await until(page, () => rendered(page), (v) => !!v && v.zoom > r0.zoom + 0.5);
    check("zoom in", !!z && z.zoom > r0.zoom + 0.5, `${r0.zoom} → ${z?.zoom}`);

    const before = (await rendered(page))!.center;
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 120, cy - 80, { steps: 8 });
    await page.mouse.up();
    const p = await until(page, () => rendered(page), (v) => !!v && (v.center[0] !== before[0] || v.center[1] !== before[1]));
    check("pan", !!p && (p.center[0] !== before[0] || p.center[1] !== before[1]), `${before} → ${p?.center}`);
  }

  await page.getByTestId("map-panel-toggle").click();
  await page.getByTestId("layer-food").check();
  const f = await until(page, () => rendered(page), (v) => !!v && v.food > 0);
  check("layer toggle (food on)", !!f && f.food > 0, `food features ${f?.food}`);

  await page.getByTestId("map-search").fill("Berri");
  const hit = page.getByTestId("map-search-results").getByRole("button").first();
  await hit.click({ timeout: 10_000 }).catch(() => undefined);
  const popup = await page.locator(".maplibregl-popup").textContent({ timeout: 10_000 }).catch(() => "");
  check("search opens a place", /Berri/i.test(popup ?? ""), popup?.slice(0, 60) ?? "");

  check("geojson layers loaded", geojson >= 6, `${geojson} files`);
  check("base map tiles loaded", tiles > 0, `${tiles} tiles`);
  check("no failed requests", bad.length === 0, bad.slice(0, 3).join(" | "));
  check("no worker/CSP/WebGL/init errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
}

await run("desktop", devices["Desktop Chrome"]);
await run("mobile", devices["Pixel 7"]);
console.log(failures ? `\n${failures} map smoke check(s) failed` : "\nall map smoke checks passed");
process.exit(failures ? 1 : 0);
