import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { answerFor } from "./oracle";
import { checkAndConfirm, startGame } from "./answer";

/**
 * Email-code sign-in. Production uses Neon Auth; there is no local Neon Auth emulator, so the test server runs the
 * in-memory test backend (AUTH_DEV_BACKEND=1, refused on Vercel) and reads the "emailed" code from its
 * test-only endpoint. Everything after the code (session cookie, profile, RLS-backed saves, device links) is real.
 */
async function emailedCode(request: APIRequestContext, email: string): Promise<string> {
  const r = await request.get(`/api/auth/dev-code?email=${encodeURIComponent(email)}`);
  expect(r.ok(), "test auth backend is on").toBe(true);
  return ((await r.json()) as { code: string }).code;
}

async function signIn(page: Page, email: string) {
  await page.goto("/account");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-sent")).toBeVisible();
  await expect(page.getByTestId("login-code")).toBeFocused();
  await page.getByTestId("login-code").fill(await emailedCode(page.request, email));
  await page.getByTestId("login-verify").click();
  await expect(page.getByTestId("signed-in-as")).toContainText(email);
}

test.describe("accounts", () => {
  test("guest → email code → profile; look carries over; name + cosmetics; locked items refused; logout", async ({ page }, info) => {
    test.setTimeout(120_000);
    const email = `e2e-${info.project.name}-${Date.now()}@example.test`;

    // As a guest: finish part of a ride and pick a look.
    await page.goto("/play/unlimited");
    await startGame(page);
    await page.getByTestId("climb-customize").click();
    await page.getByTestId("look-jacket-j2").click();
    await page.getByTestId("look-hair-curly").waitFor({ state: "detached" }).catch(() => undefined); // guests only see guest parts
    for (let i = 0; i < 7; i++) {
      await expect(page.getByTestId("prompt")).toBeVisible();
      const prompt = (await page.getByTestId("prompt").textContent())!.trim();
      await checkAndConfirm(page, answerFor.get(prompt)!);
      await page.getByTestId("next-stop").click();
    }
    await expect(page).toHaveURL(/results/);

    // Sign in with the emailed code.
    await signIn(page, email);

    // The guest ride and look came along.
    await expect(page.getByTestId("stat-rides")).toHaveText("1");
    await expect(page.getByTestId("look-jacket-j2")).toHaveAttribute("aria-pressed", "true");

    // Account-only cosmetics are available; achievement items stay locked until earned.
    await page.getByTestId("look-hair-curly").click();
    await expect(page.getByTestId("look-hair-curly")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("look-accessory-lantern")).toHaveAttribute("data-locked", "1"); // 7-day streak: not earned
    await expect(page.getByTestId("look-accessory-lantern")).toBeDisabled();
    await expect(page.getByTestId("look-hair-long")).toHaveAttribute("data-locked", "0"); // account item
    const lockedRes = await page.request.put("/api/me", { data: { appearance: { accessory: "lantern" } } });
    expect(lockedRes.status()).toBe(422); // 7-day streak item: refused server-side

    // Display name: validated, public on leaderboards; the email never is.
    await page.getByTestId("profile-name").fill("x");
    await page.getByTestId("profile-name-save").click();
    await expect(page.locator("#name-msg")).not.toBeEmpty();
    await page.getByTestId("profile-name").fill("Mont Royal Fan");
    await page.getByTestId("profile-name-save").click();
    await expect(page.getByTestId("profile-name-save")).toContainText(/Saved|Enregistré/);
    const board = await (await page.request.get("/api/leaderboard")).text();
    expect(board).not.toContain(email);

    // Persistence across reloads, then sign out.
    await page.reload();
    await expect(page.getByTestId("look-hair-curly")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("profile-name")).toHaveValue("Mont Royal Fan");
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login-email")).toBeVisible();
    expect((await page.request.get("/api/me")).ok()).toBe(true);
    expect((await (await page.request.get("/api/me")).json()).me).toBeNull();
    expect((await page.request.put("/api/me", { data: { displayName: "Nope" } })).status()).toBe(401);
  });

  test("wrong and reused codes are refused; another device signs into the same account", async ({ page, browser }, info) => {
    const email = `e2e-code-${info.project.name}-${Date.now()}@example.test`;
    await page.goto("/account");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-send").click();
    const code = await emailedCode(page.request, email);
    await page.getByTestId("login-code").fill(code === "000000" ? "111111" : "000000");
    await page.getByTestId("login-verify").click();
    await expect(page.locator("#login-msg")).toContainText(/wrong or expired|erroné ou expiré/);
    await page.getByTestId("login-code").fill(code);
    await page.getByTestId("login-verify").click();
    await expect(page.getByTestId("signed-in-as")).toContainText(email);
    await page.getByTestId("profile-name").fill("Plateau Rider");
    await page.getByTestId("profile-name-save").click();
    await expect(page.getByTestId("profile-name-save")).toContainText(/Saved|Enregistré/);
    // The used code can't sign anyone in again.
    expect((await page.request.post("/api/auth/verify", { data: { email, code } })).status()).toBe(400);

    // A second device (fresh browser) signs in with a new code and sees the same profile.
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await signIn(p2, email);
    await expect(p2.getByTestId("profile-name")).toHaveValue("Plateau Rider");
    await other.close();
  });
});
