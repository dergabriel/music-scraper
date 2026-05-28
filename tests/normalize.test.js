import { describe, expect, it } from 'vitest';
import {
  isLikelyJingleLike,
  isLikelyNoiseTrack,
  normalizeArtistTitle,
  getArtistParts,
  primaryArtist,
  artistSet,
  artistOverlapRatioLoose,
  canonicalTitleKey
} from '../src/normalize.js';

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

  it("strips explicit edition tags like taylor's version", () => {
    const a = normalizeArtistTitle('taylor swift', "love story (taylor's version)");
    const b = normalizeArtistTitle('taylor swift', 'love story');
    expect(a.title).toBe('love story');
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

  it('strips trailing event parenthetical suffixes with date context', () => {
    const a = normalizeArtistTitle('james hype', "ferrari (radio 1's big weekend, 23 may 2025)");
    const b = normalizeArtistTitle('james hype', 'ferrari');
    expect(a.title).toBe('ferrari');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it('strips date-ampersand event syntax from title variants', () => {
    const a = normalizeArtistTitle("barry can't swim", '23 may 2025 & blackpool boulevard radio 1 s big weekend');
    const b = normalizeArtistTitle("barry can't swim", 'blackpool boulevard');
    expect(a.title).toBe('blackpool boulevard');
    expect(a.trackKey).toBe(b.trackKey);
  });

  it("keeps classic year markers like summer '69 untouched", () => {
    const out = normalizeArtistTitle('bryan adams', "summer '69");
    expect(out.title).toBe("summer '69");
  });

  it('normalizes trailing punctuation variants to one track key', () => {
    const a = normalizeArtistTitle('raye', 'where is my husband!');
    const b = normalizeArtistTitle('raye', 'where is my husband');
    const c = normalizeArtistTitle('raye', 'where is my husband?!');
    expect(a.title).toBe('where is my husband');
    expect(a.trackKey).toBe(b.trackKey);
    expect(a.trackKey).toBe(c.trackKey);
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

  it('marks date-and-event syntax lines as noise', () => {
    expect(
      isLikelyNoiseTrack(
        "barry can't swim",
        "23 may 2025 & blackpool boulevard radio 1 s big weekend"
      )
    ).toBe(true);
    expect(
      isLikelyNoiseTrack(
        "barry can't swim",
        "23 may 2025 & ferrari radio 1 s big weekend"
      )
    ).toBe(true);
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

  it('exposes stable artist helper functions', () => {
    expect(getArtistParts('milleniumkid x jbs')).toEqual(['jbs', 'milleniumkid']);
    expect(primaryArtist('disco lines & tinashe')).toBe('disco lines');
    expect(Array.from(artistSet('jbs; milleniumkid')).sort()).toEqual(['jbs', 'milleniumkid']);
    expect(artistOverlapRatioLoose('huntr', 'huntrix')).toBeGreaterThanOrEqual(1);
    expect(canonicalTitleKey("don't stop")).toBe('dont stop');
    expect(canonicalTitleKey("don't stop")).toBe('dont stop');
  });

  // Problem 2: slash-without-spaces must not split artist names
  it('preserves inline-slash artist names like huntr/x and AC/DC', () => {
    const huntrix = normalizeArtistTitle('huntr/x', 'golden');
    expect(huntrix.artist).toBe('huntr-x');

    const acdc = normalizeArtistTitle('AC/DC', 'Thunderstruck');
    expect(acdc.artist).toBe('ac-dc');

    // Two distinct artists separated by spaced slash should split
    const twoArtists = normalizeArtistTitle('Artist One / Artist Two', 'Song');
    expect(twoArtists.artist).toBe('artist one & artist two');
  });

  // Problem 3: spaced single-letter abbreviations collapse to a single word
  it('collapses spaced abbreviations like T L C to tlc', () => {
    const tlc = normalizeArtistTitle('T L C', 'Waterfalls');
    expect(tlc.artist).toBe('tlc');
    // Same track_key as the properly written form
    const tlcDirect = normalizeArtistTitle('TLC', 'Waterfalls');
    expect(tlc.trackKey).toBe(tlcDirect.trackKey);

    const pink = normalizeArtistTitle('P I N K', 'Get the Party Started');
    expect(pink.artist).toBe('pink');

    // Must NOT collapse multi-letter tokens — "the xx" stays "the xx"
    const thexx = normalizeArtistTitle('the xx', 'crystallised');
    expect(thexx.artist).toBe('the xx');
  });

  // Problem 4: year in parentheses/brackets stripped from title
  it('strips trailing year in parentheses from title', () => {
    const a = normalizeArtistTitle('TLC', 'No Scrubs (1999)');
    expect(a.title).toBe('no scrubs');
    const b = normalizeArtistTitle('TLC', 'No Scrubs');
    expect(a.trackKey).toBe(b.trackKey);

    expect(normalizeArtistTitle('Artist', 'My Love (2024)').title).toBe('my love');
    expect(normalizeArtistTitle('Artist', 'Toyota (2016)').title).toBe('toyota');

    // Bare year without brackets must NOT be stripped
    expect(normalizeArtistTitle('Artist', 'Love 1999').title).toBe('love 1999');
    // Non-year bracket suffix (not a 4-digit year) is untouched by the year-strip rule
    expect(normalizeArtistTitle('Artist', 'Song (live version)').title).toBe('song (live version)');
  });

  // Problem 5: remix prefix in artist field (MDR Sputnik style)
  it('strips remix-descriptor prefix from artist field', () => {
    const out = normalizeArtistTitle('Notion Remix - Chrystal x Notion', 'The Days');
    expect(out.artist).toBe('chrystal & notion');

    // Normal artist with hyphen should NOT be affected
    const normal = normalizeArtistTitle('Twenty One Pilots', 'Heathens');
    expect(normal.artist).toBe('twenty one pilots');

    // Hyphens in artist name without remix keyword should be unaffected
    const hyphenArtist = normalizeArtistTitle('Post Malone - Something', 'Song');
    // No remix keyword → should not strip
    expect(hyphenArtist.artist).not.toBe('something');
  });

  // Problem 6: Levenshtein-1 tolerance in artist overlap
  it('matches artist tokens with edit-distance-1 typos for loose overlap', () => {
    // "jose" vs "josa" — single char substitution
    expect(artistOverlapRatioLoose('dj jose', 'dj josa')).toBeGreaterThanOrEqual(0.9);
    // Exact match still works
    expect(artistOverlapRatioLoose('dj jose', 'dj jose')).toBe(1);
    // Unrelated artists should still return low overlap
    expect(artistOverlapRatioLoose('dj jose', 'madonna')).toBeLessThan(0.3);
  });

  // Problem 1 (radio_hamburg): chart-position prefixes stripped from title
  it('strips TOP NNN and PLATZ NNN chart-position prefixes from title', () => {
    expect(normalizeArtistTitle('Artist', 'TOP 799 SIMPLE LIFE').title).toBe('simple life');
    expect(normalizeArtistTitle('Artist', 'TOP 794 PEDRO').title).toBe('pedro');
    expect(normalizeArtistTitle('Artist', 'PLATZ 12 SOMETHING').title).toBe('something');
    expect(normalizeArtistTitle('Artist', 'platz 3 hero').title).toBe('hero');

    // "TOP GUN" has no number after TOP — must not be stripped
    expect(normalizeArtistTitle('Artist', 'TOP GUN').title).toBe('top gun');
    // Five-digit number exceeds the 1-4 digit guard — must not be stripped
    expect(normalizeArtistTitle('Artist', 'TOP 10000 OVERFLOW').title).toBe('top 10000 overflow');
    // Ensures the corrected title produces the same key as the clean form
    const withPrefix = normalizeArtistTitle('Artist', 'TOP 799 SIMPLE LIFE');
    const clean = normalizeArtistTitle('Artist', 'SIMPLE LIFE');
    expect(withPrefix.trackKey).toBe(clean.trackKey);
  });

  // Problem 5 (artist cleanup): trailing hyphens/dashes stripped from artist
  it('strips trailing hyphens and dashes from artist names', () => {
    expect(normalizeArtistTitle('leony -', 'Song').artist).toBe('leony');
    expect(normalizeArtistTitle('Artist -', 'Song').artist).toBe('artist');
    expect(normalizeArtistTitle('Artist --', 'Song').artist).toBe('artist');

    // Inline hyphens that are part of the name must be preserved
    expect(normalizeArtistTitle('Wu-Tang Clan', 'C.R.E.A.M.').artist).toBe('wu-tang clan');
    // ac/dc becomes ac-dc via slash→hyphen conversion and must keep the hyphen
    expect(normalizeArtistTitle('AC/DC', 'Thunderstruck').artist).toBe('ac-dc');
  });
});
