import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DlfNovaParser } from '../src/parsers/dlfNova.js';
import { FluxFmParser } from '../src/parsers/fluxfm.js';
import { OnlineradioboxParser } from '../src/parsers/onlineradiobox.js';
import { GenericHtmlParser } from '../src/parsers/genericHtml.js';
import { NrwLokalradiosJsonParser } from '../src/parsers/nrwlokalradiosJson.js';
import { RadioMenuParser } from '../src/parsers/radioMenu.js';

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

  it('parses table playlist rows with separate time/artist/title cells', () => {
    const parser = new GenericHtmlParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('radio_horen_table.html'), 'https://example.test');
    expect(plays.length).toBe(3);
    expect(plays[0].artistRaw).toBe('Tate McRae');
    expect(plays[0].titleRaw).toBe('Sports car');
    expect(plays[2].artistRaw).toBe('The Weeknd, Daft Punk');
  });

  it('parses onlineradiobox rows in "Artist: Title" format and skips promo rows', () => {
    const parser = new OnlineradioboxParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('onlineradiobox_colon_schedule.html'), 'https://example.test');
    expect(plays.length).toBe(3);
    expect(plays[0].artistRaw).toBe('Alex Warren');
    expect(plays[0].titleRaw).toBe('Fever Dream');
    expect(plays[2].artistRaw).toBe('Nico Santos');
  });

  it('parses onlineradiobox rows in "Title - Artist" format (N-JOY style)', () => {
    const parser = new OnlineradioboxParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('onlineradiobox_title_artist_schedule.html'), 'https://example.test');
    expect(plays.length).toBe(3);
    expect(plays[0].artistRaw).toBe('Nico Santos');
    expect(plays[0].titleRaw).toBe('All Time High');
    expect(plays[2].artistRaw).toBe('Eminem feat. Rihanna');
    expect(plays[2].titleRaw).toBe('The Monster');
  });

  it('parses onlineradiobox rows in "Title / Artist" format (SWR3 style)', () => {
    const parser = new OnlineradioboxParser({ timezone: 'Europe/Berlin' });
    const plays = parser.parse(fixture('onlineradiobox_slash_schedule.html'), 'https://example.test');
    expect(plays.length).toBe(2);
    expect(plays[0].artistRaw).toBe('Imagine Dragons x J.I.D');
    expect(plays[0].titleRaw).toBe('Enemy');
    expect(plays[1].artistRaw).toBe("K'naan");
    expect(plays[1].titleRaw).toBe("Wavin' Flag");
  });

  it('parses nrw lokalradios json playlist payload', () => {
    const parser = new NrwLokalradiosJsonParser({ timezone: 'Europe/Berlin' });
    const payload = JSON.stringify([
      {
        station_id: '24',
        artist: 'RAYE',
        title: 'WHERE IS MY HUSBAND!',
        timeslot_iso: '2026-03-05T17:47:46+01:00'
      },
      {
        station_id: '24',
        artist: 'ROBBIE WILLIAMS',
        title: 'ALL MY LIFE',
        timeslot: '2026-03-05 18:39:09'
      }
    ]);
    const plays = parser.parse(payload, 'https://api-prod.nrwlokalradios.com/playlist/latest?station=24');
    expect(plays.length).toBe(2);
    expect(plays[0].artistRaw).toBe('RAYE');
    expect(plays[0].titleRaw).toBe('WHERE IS MY HUSBAND!');
    expect(plays[1].artistRaw).toBe('ROBBIE WILLIAMS');
    expect(plays[1].titleRaw).toBe('ALL MY LIFE');
  });

  it('parses radio.menu playlist rows for Capital FM', () => {
    const parser = new RadioMenuParser({ timezone: 'Europe/London' });
    const plays = parser.parse(
      fixture('radiomenu_capitalfm.html'),
      'https://radio.menu/stations/capitalfm-com-capital-fm/playlist/'
    );
    expect(plays.length).toBe(4);
    expect(plays[0].artistRaw).toBe('The Weeknd');
    expect(plays[0].titleRaw).toBe('Blinding Lights');
    expect(plays[1].artistRaw).toBe('Sombr');
    expect(plays[1].titleRaw).toBe('Back to Friends');
    expect(plays[3].artistRaw).toBe('PinkPantheress, Ice Spice');
    expect(plays[3].titleRaw).toBe("Boy's a liar Pt. 2");
  });
});
