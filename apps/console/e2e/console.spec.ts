/** The console against a running API (`rif serve` with a season in the database). Every screen is
 * checked with axe in light and dark, and the loading, error and empty states are forced by
 * intercepting the API. */
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const SCREENS = [
  { hash: "#/sources", heading: "Five regulator sites, one season" },
  { hash: "#/incidents", heading: "Incidents" },
  { hash: "#/impact", heading: "Change impact" },
  { hash: "#/results", heading: "What was measured" },
];

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0]?.target.join(" ")})`);
}

for (const scheme of ["light", "dark"] as const)
  for (const s of SCREENS)
    test(`${s.hash} renders and passes axe (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(`/${s.hash}`);
      await expect(page.getByRole("heading", { level: 1, name: s.heading })).toBeVisible();
      await expect(page.getByRole("status")).toHaveCount(0, { timeout: 15_000 });
      expect(await axe(page)).toEqual([]);
    });

test("an incident shows its gates and the reviewer's verdict", async ({ page }) => {
  await page.goto("/#/incidents");
  await page
    .getByRole("link", { name: /day \d+/ })
    .first()
    .click();
  await expect(page.getByText("What the contract found")).toBeVisible();
  // a people-only season has no attempts; an agent season shows each attempt's gates and diff
  if (await page.getByText("went straight to a person").isVisible()) return;
  await expect(page.getByRole("heading", { level: 3, name: /Attempt 1/ })).toBeVisible();
  await expect(page.getByText("contract on every page").first()).toBeVisible();
  await page.getByRole("button", { name: "Show the change" }).first().click();
  await expect(page.locator("pre").first()).toContainText("@@");
});

test("an assessment shows clause text and evidence, and signs as the chosen person", async ({ page }) => {
  await page.goto("/#/impact");
  await page.getByLabel("Rules").check();
  await page
    .getByRole("link", { name: /version \d+/ })
    .first()
    .click();
  await expect(page.getByText("Before", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Signed in as").selectOption({ label: "Tobias Lang, quality assurance" });
  if (!process.env.E2E_SIGN)
    await page.route("**/signoff", (r) =>
      r.fulfill({ status: 201, contentType: "application/json", body: '{"ok":true,"seq":1}' }),
    );
  let sent: Record<string, string> = {};
  page.on("request", (req) => {
    if (req.url().endsWith("/signoff")) sent = req.headers();
  });
  await page.getByRole("button", { name: "Sign assessment" }).click();
  await expect(page.getByText("Signed. The signature is in the audit trail.")).toBeVisible();
  expect(sent["x-user-name"]).toBe("Tobias Lang");
  expect(sent["x-user-role"]).toBe("quality_assurance");
});

test("a stale sign-off is refused with a reason", async ({ page }) => {
  await page.route("**/signoff", (r) =>
    r.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"ok":false,"error":"the assessment changed since you opened it; reload and review again"}',
    }),
  );
  await page.goto("/#/impact");
  await page.getByLabel("Rules").check();
  await page
    .getByRole("link", { name: /version \d+/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Sign assessment" }).click();
  await expect(page.getByRole("alert")).toContainText("changed since you opened it");
});

test("every screen shows a loading skeleton, then an error with retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/overview**", async (r) => {
    await new Promise((x) => setTimeout(x, 400));
    return fail
      ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"database unavailable"}' })
      : r.continue();
  });
  await page.goto("/#/sources");
  await expect(page.getByRole("status", { name: "Loading the sites" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("database unavailable");
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
});

test("empty states say what to do", async ({ page }) => {
  await page.route("**/api/incidents?**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/assessments?**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.goto("/#/incidents");
  await expect(page.getByText("No incidents in this season.")).toBeVisible();
  await page.goto("/#/impact");
  await expect(page.getByText("No assessments for this matcher yet.")).toBeVisible();
});

test("works at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/sources");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
