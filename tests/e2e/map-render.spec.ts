import { expect, test } from "@playwright/test";

// MapLibre needs WebGL; the project default turns it off for the game specs.
test.use({ launchOptions: { args: [] } });

test("map: loads, toggles a lazy layer, searches and opens a place", async ({ page }) => {
  test.setTimeout(60_000);
  const layerRequests: string[] = [];
  const workerErrors: string[] = [];
  page.on("request", (r) => r.url().includes("/map/") && layerRequests.push(new URL(r.url()).pathname));
  page.on("console", (m) => m.type() === "error" && /worker/i.test(m.text()) && workerErrors.push(m.text()));
  page.on("pageerror", (e) => /worker/i.test(e.message) && workerErrors.push(e.message));
  const worker = page.waitForResponse((r) => r.url().includes("/vendor/maplibre-gl-worker.mjs"));
  await page.goto("/map");
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  // Without a working MapLibre worker the style "loads" but no tiles or layers are ever drawn.
  expect((await worker).status()).toBe(200);
  // The map must fill its frame (a CSS-cascade bug once collapsed it to 0px tall).
  const box = await page.getByTestId("map-canvas").boundingBox();
  expect(box!.height).toBeGreaterThan(200);
  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  expect(Math.round(canvas!.height)).toBe(Math.round(box!.height));
  // Food is off by default and is only downloaded when switched on (viewport-friendly lazy loading).
  expect(layerRequests).not.toContain("/map/food.geojson");

  await page.getByTestId("map-panel-toggle").click();
  await expect(page.getByTestId("map-panel")).toBeVisible();
  await page.getByTestId("layer-food").check();
  await expect.poll(() => layerRequests.includes("/map/food.geojson")).toBe(true);

  await page.getByTestId("map-search").fill("Berri");
  const first = page.getByTestId("map-search-results").getByRole("button").first();
  await expect(first).toContainText(/Berri/i);
  await first.click();
  await expect(page.locator(".maplibregl-popup")).toContainText(/Berri/i);
  expect(workerErrors).toEqual([]);
  // No horizontal page scroll on any viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

/** Phase J: popups use the dark popup tokens, pass WCAG AA, wrap long names and stay inside a phone viewport. */
async function checkPopup(page: import("@playwright/test").Page) {
  await page.goto("/map");
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await page.getByTestId("map-panel-toggle").click();
  // A long name (≈ 60 characters) to exercise wrapping.
  await page.getByTestId("map-search").fill("Côte-des-Neiges");
  const hit = page.getByTestId("map-search-results").getByRole("button").first();
  await expect(hit).toBeVisible();
  await hit.click();
  const pop = page.locator(".maplibregl-popup.ml-popup");
  await expect(pop).toBeVisible();
  const s = await pop.evaluate((el) => {
    const css = (sel: string) => getComputedStyle(el.querySelector(sel)!);
    const rgb = (c: string) => c.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const bg = css(".maplibregl-popup-content").backgroundColor;
    const r = el.getBoundingClientRect();
    const close = el.querySelector(".maplibregl-popup-close-button")!.getBoundingClientRect();
    return {
      bg,
      title: ratio(css(".ml-pop-title").color, bg),
      meta: ratio(css(".ml-pop-meta").color, bg),
      inside: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
      noOverflow: el.querySelector(".maplibregl-popup-content")!.scrollWidth <= el.querySelector(".maplibregl-popup-content")!.clientWidth + 1,
      closeSize: Math.min(close.width, close.height),
    };
  });
  expect(s.bg).toBe("rgb(23, 33, 47)");
  expect(s.title).toBeGreaterThanOrEqual(4.5);
  expect(s.meta).toBeGreaterThanOrEqual(4.5);
  expect(s.inside).toBe(true);
  expect(s.noOverflow).toBe(true);
  expect(s.closeSize).toBeGreaterThanOrEqual(32);
  await expect(pop.locator(".maplibregl-popup-close-button")).toHaveAttribute("aria-label", "Close");
  await pop.locator(".maplibregl-popup-close-button").click();
  await expect(pop).toHaveCount(0);
}

test("map popup: readable dark popup, AA contrast, wraps, closes", async ({ page }) => {
  test.setTimeout(60_000);
  await checkPopup(page);
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 412, height: 839 }, isMobile: true, hasTouch: true });
  test("map popup stays inside the screen on a phone", async ({ page }) => {
    test.setTimeout(60_000);
    await checkPopup(page);
  });
});
