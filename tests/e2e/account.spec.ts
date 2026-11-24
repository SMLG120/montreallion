import { expect, test, type APIRequestContext } from "@playwright/test";
import { answerFor } from "./oracle";
import { checkAndConfirm } from "./answer";

/**
 * Email sign-in against the local Supabase stack (npm run auth:start). Magic links are read from its mail
 * catcher (Mailpit). Skipped when the test server has no auth configured.
 */
const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
const ENABLED = Boolean(process.env.E2E_SUPABASE_URL);

async function magicLink(request: APIRequestContext, email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const r = await request.get(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    if (r.ok()) {
      const { messages } = (await r.json()) as { messages: { ID: string }[] };
      if (messages?.length) {
        const msg = await (await request.get(`${MAIL}/api/v1/message/${messages[0].ID}`)).json();
        const href = String(msg.HTML ?? msg.Text).match(/https?:\/\/[^"'\s<>]+verify[^"'\s<>]+/)?.[0];
        if (href) return href.replace(/&amp;/g, "&");
      }
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no magic link for ${email}`);
}

test.describe("accounts", () => {
  test.skip(!ENABLED, "local Supabase auth not configured for this run");

  test("guest → magic link → profile; look carries over; name + cosmetics; locked items refused; logout", async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const email = `e2e-${info.project.name}-${Date.now()}@example.test`;

    // As a guest: finish part of a ride and pick a look.
    await page.goto("/play/unlimited");
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

    // Sign in by email link.
    await page.goto("/account");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-send").click();
    await expect(page.getByTestId("login-sent")).toBeVisible();
    await page.goto(await magicLink(request, email));
    await expect(page).toHaveURL(/\/account\?welcome=1/);
    await expect(page.getByTestId("signed-in-as")).toContainText(email);

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

  test("an invalid or reused link is refused", async ({ page }) => {
    await page.goto("/auth/callback?code=not-a-real-code");
    await expect(page).toHaveURL(/\/account\?error=link/);
    await expect(page.getByRole("alert").first()).toBeVisible();
  });
});
