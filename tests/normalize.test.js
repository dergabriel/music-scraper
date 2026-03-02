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

  it('uses one track key for joiner variants and artist order', () => {
    const a = normalizeArtistTitle('milleniumkid & jbs', 'vielleicht vielleicht');
    const b = normalizeArtistTitle('milleniumkid x jbs', 'vielleicht vielleicht');
    const c = normalizeArtistTitle('jbs; milleniumkid', 'vielleicht vielleicht');
    expect(a.trackKey).toBe(b.trackKey);
    expect(a.trackKey).toBe(c.trackKey);
  });

  it('normalizes trailing beats suffix safely', () => {
    const a = normalizeArtistTitle('jbs beats; milleniumkid', 'vielleicht vielleicht');
    const b = normalizeArtistTitle('jbs & milleniumkid', 'vielleicht vielleicht');
    expect(a.artist).toBe('jbs & milleniumkid');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it('keeps remix normalization behavior stable', () => {
    const a = normalizeArtistTitle('Artist x Guest', 'Track (Remix)');
    const b = normalizeArtistTitle('Guest; Artist', 'Track');
    expect(a.title).toBe('track');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it('strips short trailing subtitle brackets for canonical title variants', () => {
    const a = normalizeArtistTitle('a7s & topic', 'kernkraft 400 (a better day)');
    const b = normalizeArtistTitle('a7s & topic', 'kernkraft 400');
    expect(a.title).toBe('kernkraft 400');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it('strips short color subtitle at end without breaking canonical title', () => {
    const a = normalizeArtistTitle('bebe rexha & david guetta', "i'm good (blue)");
    const b = normalizeArtistTitle('bebe rexha & david guetta', "i'm good");
    expect(a.title).toBe("i'm good");
    expect(a.trackKey).toBe(b.trackKey);
  });

  it('strips trailing apostrophe year editions in 20-29 range only', () => {
    const a = normalizeArtistTitle('hurts & purple disco machine', "wonderful life '25");
    const b = normalizeArtistTitle('hurts & purple disco machine', 'wonderful life');
    expect(a.title).toBe('wonderful life');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it("keeps classic year markers like summer '69 untouched", () => {
    const out = normalizeArtistTitle('bryan adams', "summer '69");
    expect(out.title).toBe("summer '69");
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
    expect(isLikelyJingleLike('Am Mikrofon', 'Gunnar Töpfer')).toBe(true);
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

  it('marks hotline and traffic-center entries as noise', () => {
    expect(isLikelyNoiseTrack('anruf im verkehrszentrum', '0800 637 637 8')).toBe(true);
    expect(isLikelyNoiseTrack('hotline: 08000-210000', 'kontakt zur')).toBe(true);
    expect(isLikelyNoiseTrack('jetzt anrufen !', '0331 70 97 110')).toBe(true);
    expect(isLikelyNoiseTrack('jetzt anrufen ! 0331 70 97 110', '')).toBe(true);
  });

  it('marks ad and bulletin fragments as noise', () => {
    expect(
      isLikelyNoiseTrack(
        'die abendshow - pop und nachrichten gehen weiter',
        '*** live ticker - marken-discount'
      )
    ).toBe(true);
    expect(isLikelyNoiseTrack('marke xyz (handel)', '250721 kampagne 2026 musik2 15sec.')).toBe(true);
    expect(isLikelyNoiseTrack('usa/israel und iran gehen weiter', '*** gegenseitige angriffe')).toBe(true);
  });

  it('marks station slogan lines as noise', () => {
    expect(isLikelyNoiseTrack('ffn', 'mehr musik. mehr abwechslung. mehr niedersachse')).toBe(true);
  });

  it('marks show-context hints as noise', () => {
    expect(isLikelyNoiseTrack('aus dem 1live haus in köln die junge nacht der ard', '')).toBe(true);
  });

  it('keeps normal tracks with numbers valid', () => {
    expect(isLikelyNoiseTrack('maroon 5', 'one more night')).toBe(false);
    expect(isLikelyNoiseTrack('bruno mars', '24k magic')).toBe(false);
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
