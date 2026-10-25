import { test, expect } from "@playwright/test";

test.describe("Engineering digest", () => {
  test("shows today's picks and either articles or the empty state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /today's picks/i })).toBeVisible();
    const articlesRegion = page.getByRole("region", { name: /articles/i });
    const emptyState = page.getByRole("heading", { name: /nothing on the desk yet/i });
    await expect(articlesRegion.or(emptyState)).toBeVisible();
  });

  test("serves an unknown path as one 404 document with the shell", async ({ request }) => {
    const response = await request.get("/no-such-page");
    expect(response.status()).toBe(404);
    const body = await response.text();
    expect(body.match(/<html/g)).toHaveLength(1);
    expect(body).toContain("404 - Not Found");
  });
});
