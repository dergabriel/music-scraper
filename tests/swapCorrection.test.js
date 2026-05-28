import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { normalizeArtistTitle } from '../src/normalize.js';

// ---------------------------------------------------------------------------
// swap correction helpers – ingest logic extracted for unit testing
// ---------------------------------------------------------------------------

function applySwapCorrection(verified, originalNormalized) {
  if (!verified.swappedDetected || !verified.correctedArtist || !verified.correctedTitle) {
    return originalNormalized;
  }
  const swapNormalized = normalizeArtistTitle(verified.correctedArtist, verified.correctedTitle);
  if (!swapNormalized.artist || !swapNormalized.title) return originalNormalized;
  return swapNormalized;
}

describe('swap correction logic (ingest helper)', () => {
  it('applies swap when verifyTrack signals swappedDetected', () => {
    const original = normalizeArtistTitle('Blinding Lights', 'The Weeknd');
    const verifyResult = {
      verifiedExists: true,
      swappedDetected: true,
      correctedArtist: 'The Weeknd',
      correctedTitle: 'Blinding Lights'
    };
    const corrected = applySwapCorrection(verifyResult, original);
    expect(corrected.artist).toBe('the weeknd');
    expect(corrected.title).toBe('blinding lights');
  });

  it('does NOT change identity when swappedDetected is false', () => {
    const original = normalizeArtistTitle('The Weeknd', 'Blinding Lights');
    const verifyResult = { verifiedExists: true, swappedDetected: false };
    const result = applySwapCorrection(verifyResult, original);
    expect(result.artist).toBe(original.artist);
    expect(result.title).toBe(original.title);
    expect(result.trackKey).toBe(original.trackKey);
  });

  it('does NOT change identity when correctedArtist/Title are missing', () => {
    const original = normalizeArtistTitle('The Weeknd', 'Blinding Lights');
    const verifyResult = { verifiedExists: true, swappedDetected: true };
    const result = applySwapCorrection(verifyResult, original);
    expect(result.artist).toBe(original.artist);
  });

  it('corrected identity has a different trackKey from the original swapped input', () => {
    const swappedInput = normalizeArtistTitle('Blinding Lights', 'The Weeknd');
    const correctedInput = normalizeArtistTitle('The Weeknd', 'Blinding Lights');
    const verifyResult = {
      swappedDetected: true,
      correctedArtist: 'The Weeknd',
      correctedTitle: 'Blinding Lights'
    };
    const corrected = applySwapCorrection(verifyResult, swappedInput);
    expect(corrected.trackKey).toBe(correctedInput.trackKey);
    expect(corrected.trackKey).not.toBe(swappedInput.trackKey);
  });
});

// ---------------------------------------------------------------------------
// TrackVerifier swap detection – verifyTrack returns correction signal
// ---------------------------------------------------------------------------

describe('TrackVerifier swap detection', () => {
  let TrackVerifier;
  let mockFetchImpl;

  beforeEach(async () => {
    mockFetchImpl = vi.fn();
    vi.doMock('undici', () => ({ fetch: mockFetchImpl }));
    vi.doMock('../src/integrations/spotify.js', () => ({
      searchTrackOnSpotify: vi.fn().mockResolvedValue(null)
    }));

    const mod = await import('../src/trackVerifier.js?t=' + Date.now());
    TrackVerifier = mod.TrackVerifier;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function makeItunesResponse(results) {
    return {
      ok: true,
      json: async () => ({ results })
    };
  }

  it('returns correctedArtist/correctedTitle when swap is clearly detected', async () => {
    // First call (normal order): not found
    // Second call (swapped): found with high confidence
    mockFetchImpl
      .mockResolvedValueOnce(makeItunesResponse([]))
      .mockResolvedValueOnce(makeItunesResponse([{
        artistName: 'The Weeknd',
        trackName: 'Blinding Lights',
        trackId: 123,
        trackViewUrl: 'https://example.com',
        artworkUrl100: null,
        releaseDate: '2019-11-29',
        primaryGenreName: 'Pop',
        collectionName: 'After Hours',
        copyright: null,
        trackTimeMillis: 202000,
        previewUrl: null
      }]));

    const db = { prepare: vi.fn() };
    const getStmt = { get: vi.fn().mockReturnValue(null) };
    const runStmt = { run: vi.fn() };
    db.prepare.mockReturnValue({ ...getStmt, ...runStmt });

    const verifier = new TrackVerifier({ db, logger: null });
    const result = await verifier.verifyTrack({
      trackKey: 'abc123',
      artist: 'Blinding Lights',
      title: 'The Weeknd'
    });

    expect(result.swappedDetected).toBe(true);
    expect(result.correctedArtist).toBe('The Weeknd');
    expect(result.correctedTitle).toBe('Blinding Lights');
    expect(result.verifiedExists).toBe(true);
  });

  it('does not set swappedDetected when normal order finds the track', async () => {
    mockFetchImpl.mockResolvedValueOnce(makeItunesResponse([{
      artistName: 'The Weeknd',
      trackName: 'Blinding Lights',
      trackId: 123,
      trackViewUrl: 'https://example.com',
      artworkUrl100: null,
      releaseDate: '2019-11-29',
      primaryGenreName: 'Pop',
      collectionName: 'After Hours',
      copyright: null,
      trackTimeMillis: 202000,
      previewUrl: null
    }]));

    const db = { prepare: vi.fn() };
    db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(null), run: vi.fn() });

    const verifier = new TrackVerifier({ db, logger: null });
    const result = await verifier.verifyTrack({
      trackKey: 'abc123',
      artist: 'The Weeknd',
      title: 'Blinding Lights'
    });

    expect(result.swappedDetected).toBeFalsy();
    expect(result.verifiedExists).toBe(true);
  });
});
