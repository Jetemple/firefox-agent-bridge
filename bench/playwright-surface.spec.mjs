import { test, expect } from "@playwright/test";

const operation = process.env.BENCH_OPERATION;
const targetUrl = process.env.BENCH_URL;
const expectedHeading = process.env.BENCH_EXPECTED_HEADING;
const expectedLink = process.env.BENCH_EXPECTED_LINK;
const expectedTitle = process.env.BENCH_EXPECTED_TITLE;
const artifactPath = process.env.BENCH_ARTIFACT_PATH;

function emit(value) {
  console.log(`PW_BENCH_RESULT ${JSON.stringify(value)}`);
}

test(`browser cli surface ${operation}`, async ({ page }) => {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  if (operation === "open") {
    await expect(page.locator("h1")).toContainText(expectedHeading);
    emit({ url: page.url(), title: await page.title() });
  } else if (operation === "text") {
    const text = await page.locator("body").innerText();
    await expect(page.locator("body")).toContainText(expectedHeading);
    emit({ text });
  } else if (operation === "links") {
    const links = await page.locator("a[href]").evaluateAll((els) =>
      els.map((el) => ({ text: el.textContent.trim(), href: el.href })),
    );
    if (!links.some((link) => link.text.includes(expectedLink))) throw new Error(`missing link ${expectedLink}`);
    emit({ links });
  } else if (operation === "find") {
    const loc = page.locator("h1").filter({ hasText: expectedHeading }).first();
    await expect(loc).toBeVisible();
    emit({ found: true, text: await loc.innerText(), box: await loc.boundingBox() });
  } else if (operation === "js-title") {
    const title = await page.evaluate(() => document.title);
    if (title !== expectedTitle) throw new Error(`expected title ${expectedTitle}, got ${title}`);
    emit({ result: title });
  } else if (operation === "screenshot") {
    await page.screenshot({ path: artifactPath, fullPage: true });
    emit({ path: artifactPath });
  } else {
    throw new Error(`unknown BENCH_OPERATION ${operation}`);
  }
});
