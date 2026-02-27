import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DlfNovaParser } from '../src/parsers/dlfNova.js';
import { FluxFmParser } from '../src/parsers/fluxfm.js';
import { OnlineradioboxParser } from '../src/parsers/onlineradiobox.js';
import { GenericHtmlParser } from '../src/parsers/genericHtml.js';

function fixture(name) {
  return fs.readFileSync(path.resolve('tests/fixtures', name), 'utf8');
}

describe('parsers', () => {
  it('parses dlf nova fixture', () => {
    const parser = new DlfNovaParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('dlfNova.html'), 'https://example.test');
    expect(plays.length).toBe(2);
    expect(plays[0].artistRaw).toBe('Moderat');
    expect(plays[0].titleRaw).toBe('Bad Kingdom');
  });

  it('parses fluxfm fixture', () => {
    const parser = new FluxFmParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('fluxfm.html'), 'https://example.test');
    expect(plays.length).toBe(2);
    expect(plays[1].artistRaw).toBe('Pixies');
  });

  it('parses onlineradiobox fixture', () => {
    const parser = new OnlineradioboxParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('onlineradiobox.html'), 'https://example.test');
    expect(plays.length).toBe(2);
    expect(plays[0].titleRaw).toBe('One More Time');
  });

  it('parses generic html fixture', () => {
    const parser = new GenericHtmlParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('generic.html'), 'https://example.test');
    expect(plays.length).toBe(2);
    expect(plays[1].titleRaw).toBe('Kids');
  });

  it('parses "Uhr - Artist - Title" and "Title von Artist" format', () => {
    const onlineradiobox = new OnlineradioboxParser({ timezone: 'Europe/Berlin' });
    const generic = new GenericHtmlParser({ timezone: 'Europe/Berlin' });
    const html = fixture('playlist_von_uhr.html');

    const fromOrb = onlineradiobox.parse(html, 'https://example.test');
    expect(fromOrb.length).toBe(2);
    expect(fromOrb[0].artistRaw).toBe('The Weeknd');
    expect(fromOrb[0].titleRaw).toBe('Blinding Lights');
    expect(fromOrb[1].artistRaw).toBe('The Kid Laroi');
    expect(fromOrb[1].titleRaw).toBe("She Don't Need To Know");

    const fromGeneric = generic.parse(html, 'https://example.test');
    expect(fromGeneric.length).toBe(2);
    expect(fromGeneric[1].artistRaw).toBe('The Kid Laroi');
  });
});
