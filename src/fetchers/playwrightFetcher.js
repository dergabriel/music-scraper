export class PlaywrightFetcher {
  async fetchHtml(url) {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error(
        'Fetcher "playwright" requested, but package "playwright" is not installed. Install it with: npm i playwright'
      );
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      return await page.content();
    } finally {
      await browser.close();
    }
  }
}
