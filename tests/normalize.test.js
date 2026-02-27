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
});
