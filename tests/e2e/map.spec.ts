import { expect, test } from "@playwright/test";
import { answerFor } from "./oracle";
import { checkAndConfirm } from "./answer";

test("map: loads, toggles a lazy layer, searches and opens a place", async ({ page }) => {
  test.setTimeout(60_000);
  const layerRequests: string[] = [];
  page.on("request", (r) => r.url().includes("/map/") && layerRequests.push(new URL(r.url()).pathname));
  await page.goto("/map");
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
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
  // No horizontal page scroll on any viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("map: a finished ride shows its revealed answers; unknown rides reveal nothing", async ({ page, request }) => {
  test.setTimeout(90_000);
  const missing = await request.get("/api/game/00000000-0000-4000-8000-000000000000/map");
  expect(missing.status()).toBe(404);

  await page.goto("/");
  await page.getByTestId("play-daily").click();
  for (let i = 0; i < 7; i++) {
    await expect(page.getByTestId("prompt")).toBeVisible();
    const prompt = (await page.getByTestId("prompt").textContent())!.trim();
    await checkAndConfirm(page, answerFor.get(prompt)!);
    await page.getByTestId("next-stop").click();
  }
  await expect(page).toHaveURL(/\/results\//);
  const id = page.url().split("/results/")[1];
  const res = await request.get(`/api/game/${id}/map`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.rounds).toHaveLength(7);
  for (const r of body.rounds) expect(body.pins.filter((p: { round: number }) => p.round === r.round).length).toBeLessThanOrEqual(6);
  for (const key of ["score", "est", "id", "aliases"]) expect(JSON.stringify(body)).not.toContain(`"${key}":`);

  await page.getByTestId("results-map").click();
  await expect(page).toHaveURL(new RegExp(`/map\\?game=${id}`));
  await expect(page.getByTestId("ride-panel")).toBeVisible();
  if (body.pins.length) await expect(page.getByTestId("ride-pin").first()).toBeVisible();
});
