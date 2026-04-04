/**
 * Screenshot script für die README.
 * Voraussetzung: Server läuft auf http://localhost:8787
 * Ausführen: node docs/make-screenshots.mjs
 */

import { chromium } from 'playwright-core';
import path from 'path';

const BASE = 'http://localhost:8787';
const OUT  = '/Users/gabrielbecker/Documents/Codex/Music Scraper/docs/screenshots';
const VIEWPORT = { width: 1440, height: 900 };

async function makePage(browser, dark) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  // Chakra UI liest den Color-Mode aus localStorage beim ersten Render
  await ctx.addInitScript((mode) => {
    localStorage.setItem('chakra-ui-color-mode', mode);
  }, dark ? 'dark' : 'light');
  return ctx.newPage();
}

async function dashboardWithTracks(page, outFile) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const laden = page.locator('button:has-text("Laden")').first();
  if (await laden.count()) {
    await laden.click();
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: path.join(OUT, outFile) });
  console.log('✓', outFile);
}

async function simplePage(page, url, outFile, waitFor) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, outFile) });
  console.log('✓', outFile);
}

async function trackDetailPage(page, outFile) {
  // Dashboard laden → ersten "Öffnen"-Link klicken
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const laden = page.locator('button:has-text("Laden")').first();
  if (await laden.count()) { await laden.click(); await page.waitForTimeout(2000); }
  const oeffnen = page.locator('button:has-text("Öffnen")').first();
  if (await oeffnen.count()) {
    await oeffnen.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, outFile) });
    console.log('✓', outFile);
  } else {
    console.warn('⚠ Kein "Öffnen"-Button — ', outFile, 'übersprungen');
  }
}

(async () => {
  const browser = await chromium.launch();

  // ── Light Mode ──────────────────────────────────────────────────────────
  const light = await makePage(browser, false);
  await dashboardWithTracks(light, 'dashboard.png');
  await simplePage(light, '/new-titles',     'new-titles.png',     'table');
  await simplePage(light, '/weekly-reports', 'weekly-reports.png', 'table');
  await simplePage(light, '/my-station',     'my-station.png');

  // ── Dark Mode ───────────────────────────────────────────────────────────
  const dark = await makePage(browser, true);
  await dashboardWithTracks(dark, 'dashboard-dark.png');
  await simplePage(dark, '/weekly-reports', 'weekly-reports-dark.png', 'table');
  await trackDetailPage(dark, 'track-detail-dark.png');

  await browser.close();
  console.log('\nAlle Screenshots → docs/screenshots/');
})();
