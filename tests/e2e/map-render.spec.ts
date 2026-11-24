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
