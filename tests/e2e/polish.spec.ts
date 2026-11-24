import { expect, test, type Page } from "@playwright/test";

/** Phase G: loading/offline/error states, mobile layout, layout stability, keyboard access and caching. */

const PAGES = ["/", "/play/unlimited", "/leaderboard", "/how-to-play", "/account", "/party"];

async function layoutShift(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let cls = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) cls += e.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => resolve(cls), 1200);
      }),
  );
}

test("unknown pages get a themed, bilingual 404 with a way home", async ({ page, context }) => {
  const res = await page.goto("/no-such-stop");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("not-found")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wrong stop" })).toBeVisible();
  // Themed: dark background, not the framework default.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
  await context.addCookies([{ name: "ml_locale", value: "fr", url: page.url() }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mauvaise station" })).toBeVisible();
  await page.getByRole("link", { name: "Retour au quai" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("offline: a banner appears, a failed check doesn't freeze the game, and it recovers", async ({ page, context }) => {
  await page.goto("/play/unlimited");
  await expect(page.getByTestId("prompt")).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  const input = page.getByTestId("answer-input");
  await input.fill("something");
  await input.press("Enter");
  // The request fails; the player gets a clear message and the controls are usable again (no endless spinner).
  await expect(page.getByTestId("game-notice")).toContainText(/offline/i);
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("submit-answer")).toBeEnabled();

  await context.setOffline(false);
  await expect(page.getByTestId("online-banner")).toBeVisible();
  await input.press("Enter");
  await expect(page.getByTestId("check-panel")).toBeVisible();
});

test("no horizontal overflow and no layout shift on the main pages", async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    expect(await layoutShift(page), `${path} layout shift`).toBeLessThan(0.1);
  }
});

test("the question, timer and answer box fit on the first screen", async ({ page }) => {
  await page.goto("/play/unlimited");
  await expect(page.getByTestId("prompt")).toBeVisible();
  const vh = page.viewportSize()!.height;
  for (const id of ["prompt", "timer", "answer-input", "submit-answer"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.y + box.height, `${id} is below the fold`).toBeLessThanOrEqual(vh);
  }
  // The input has focus, so a round needs no extra tap before typing.
  await expect(page.getByTestId("answer-input")).toBeFocused();
});

test("keyboard: skip link, visible focus, and the customizer works without a mouse", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard navigation is a desktop concern");
  await page.goto("/play/unlimited");
  await expect(page.getByTestId("prompt")).toBeVisible();
  await page.getByTestId("climb-customize").focus();
  const outline = await page.getByTestId("climb-customize").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("climb-customizer")).toBeVisible();
  await page.getByTestId("look-jacket-j1").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("look-jacket-j1")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
});

test("screen readers hear the timer at 10 seconds", async ({ page, isMobile }) => {
  test.skip(isMobile, "one run is enough for a 15-second wait");
  test.setTimeout(45_000);
  await page.goto("/play/unlimited");
  await expect(page.getByTestId("prompt")).toBeVisible();
  await expect(page.getByTestId("timer-sr")).toHaveText("", { timeout: 1000 });
  await expect(page.getByTestId("timer-sr")).toHaveText("10 seconds left", { timeout: 20_000 });
});

test("map layers are cached briefly; pages are not", async ({ request }) => {
  const layer = await request.get("/map/index.json");
  expect(layer.ok()).toBe(true);
  expect(layer.headers()["cache-control"]).toContain("max-age=3600");
  const page = await request.get("/map");
  expect(page.headers()["cache-control"] ?? "").not.toContain("max-age=3600");
});
