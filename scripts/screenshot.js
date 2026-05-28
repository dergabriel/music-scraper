import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

const docsDir = '/Users/gabrielbecker/Documents/Codex/Music Scraper/docs/screenshots';
mkdirSync(docsDir, { recursive: true });

async function shot(url, filename, waitMs = 2500) {
  await page.goto(`http://localhost:8787${url}`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${docsDir}/${filename}`, fullPage: false });
  console.log(`✓ ${filename}`);
}

// Dashboard — track list
await shot('/dashboard', 'dashboard.png');

// Track detail — click first Öffnen button
await page.goto('http://localhost:8787/dashboard', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);
const buttons = await page.$$('button');
for (const btn of buttons) {
  const text = await btn.textContent();
  if (text?.trim() === 'Öffnen') {
    await btn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${docsDir}/track-detail.png`, fullPage: false });
    console.log('✓ track-detail.png');
    break;
  }
}

// Track detail scrolled down (charts)
await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(300);
await page.screenshot({ path: `${docsDir}/track-detail-charts.png`, fullPage: false });
console.log('✓ track-detail-charts.png');

// New titles
await shot('/new-titles', 'new-titles.png');

// My station
await shot('/my-station', 'my-station.png', 3000);

// Weekly reports
await shot('/weekly-reports', 'weekly-reports.png');

await browser.close();
console.log('\nAll screenshots done →', docsDir);
