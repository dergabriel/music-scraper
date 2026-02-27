import { fetch } from 'undici';

export class HttpFetcher {
  async fetchHtml(url) {
    const maxAttempts = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch(url, {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 yrpa/1.0',
            'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
            accept: 'text/html,application/xhtml+xml'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} while fetching ${url}`);
        }

        return await res.text();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = new Error(`Fetch attempt ${attempt}/${maxAttempts} failed for ${url}: ${message}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
  }
}
