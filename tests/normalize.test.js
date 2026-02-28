import { describe, expect, it } from 'vitest';
import { isLikelyJingleLike, isLikelyNoiseTrack, normalizeArtistTitle } from '../src/normalize.js';

describe('normalizeArtistTitle', () => {
  it('normalizes case and whitespace', () => {
    const out = normalizeArtistTitle('  The WEEKND ', '  Blinding   Lights  ');
    expect(out.artist).toBe('the weeknd');
    expect(out.title).toBe('blinding lights');
    expect(out.trackKey).toHaveLength(40);
  });

  it('removes feat patterns', () => {
    const out = normalizeArtistTitle('Artist feat. Guest', 'Song ft. Other');
    expect(out.artist).toBe('artist');
    expect(out.title).toBe('song');
  });

  it('removes bracket suffixes', () => {
    const out = normalizeArtistTitle('Artist', 'Track (Radio Edit) [Remix]');
    expect(out.title).toBe('track');
  });

  it('builds stable hash for equal canonical forms', () => {
    const a = normalizeArtistTitle('A FEAT. B', 'C (remix)');
    const b = normalizeArtistTitle('a', 'c');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it('removes *neu* style promo markers but keeps real title words', () => {
    const a = normalizeArtistTitle('Artist', '*NEU* Song');
    const b = normalizeArtistTitle('Artist', '[neu] Song');
    const c = normalizeArtistTitle('Artist', '(neu) Song');
    const d = normalizeArtistTitle('Artist', 'Alles neu');
    expect(a.title).toBe('song');
    expect(b.title).toBe('song');
    expect(c.title).toBe('song');
    expect(d.title).toBe('alles neu');
  });

  it('cleans tracklist numbering, quotes and duplicated artist in title', () => {
    const out = normalizeArtistTitle('Wu-Tang Clan', '"08. Wu Tang Clan - C.R.E.A.M."');
    expect(out.artist).toBe('wu-tang clan');
    expect(out.title).toBe('c.r.e.a.m.');
  });

  it('removes station name from parsed artist/title', () => {
    const out = normalizeArtistTitle('bigfm', 'bigfm berlin', { stationName: 'bigFM', stationId: 'bigfm' });
    expect(out.artist).toBe('');
    expect(out.title).toBe('berlin');
  });

  it('marks page/js garbage as noise', () => {
    expect(
      isLikelyNoiseTrack(
        'bigfm',
        'window.trackServer="https://scraper2.onlineradiobox.com/"; freestar.config.enabled_slots.push'
      )
    ).toBe(true);
  });

  it('does not treat artist names containing "ios" as web noise', () => {
    expect(isLikelyNoiseTrack('Felix Jaehn & Sarah Barrios', "NOW'S A GOOD TIME TO BE")).toBe(false);
  });

  it('marks show/jingle-like items as suspicious', () => {
    expect(isLikelyJingleLike('Good Morning Show', 'Feel Good Friday')).toBe(true);
    expect(isLikelyJingleLike('Bruno Mars', '24K Magic')).toBe(false);
  });

  it('marks unknown placeholders as noise', () => {
    expect(isLikelyNoiseTrack('Unknown', 'Unknown')).toBe(true);
    expect(isLikelyNoiseTrack('n/a', 'Title')).toBe(true);
  });

  it('marks station self-promos as noise/jingle', () => {
    expect(
      isLikelyNoiseTrack('bigfm', 'bigfm - deutschlands biggste beats', {
        stationName: 'bigFM',
        stationId: 'bigfm'
      })
    ).toBe(true);
    expect(
      isLikelyJingleLike('bigfm', 'bigfm berlin', {
        stationName: 'bigFM',
        stationId: 'bigfm'
      })
    ).toBe(true);
  });

  it('detects station terms with punctuation/hyphen variants', () => {
    expect(
      isLikelyJingleLike('Fritz', 'immer wenn ich dis play, erscheint es auf meinem display', {
        stationName: 'Fritz (RBB)',
        stationId: 'fritz_rbb'
      })
    ).toBe(true);
    expect(
      isLikelyNoiseTrack('N-JOY', 'N-JOY vom NDR', {
        stationName: 'N-JOY',
        stationId: 'njoy'
      })
    ).toBe(true);
    expect(
      isLikelyNoiseTrack('immer wenn ich dis play, erscheint es auf meinem display', 'fritz', {
        stationName: 'Fritz (RBB)',
        stationId: 'fritz_rbb'
      })
    ).toBe(true);
  });
});
