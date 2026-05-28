import { describe, expect, it, vi, beforeEach } from 'vitest';
import { calculateConfidence } from '../src/integrations/deezer.js';

// ---------------------------------------------------------------------------
// calculateConfidence – pure function, no mocking needed
// ---------------------------------------------------------------------------

describe('calculateConfidence', () => {
  it('returns 1.0 for a perfect match', () => {
    const score = calculateConfidence({
      titleScore: 1,
      primaryArtistScore: 1,
      artistOverlap: 1,
      durationScore: 1
    });
    expect(score).toBeCloseTo(1.0);
  });

  it('returns 0 for all-zero scores', () => {
    expect(calculateConfidence({ titleScore: 0, primaryArtistScore: 0, artistOverlap: 0, durationScore: 0 })).toBe(0);
  });

  it('defaults durationScore to 1 when omitted', () => {
    const withDuration = calculateConfidence({ titleScore: 1, primaryArtistScore: 1, artistOverlap: 1, durationScore: 1 });
    const withoutDuration = calculateConfidence({ titleScore: 1, primaryArtistScore: 1, artistOverlap: 1 });
    expect(withDuration).toBeCloseTo(withoutDuration);
  });

  it('applies correct weights (0.45 title, 0.25 primary, 0.20 overlap, 0.10 duration)', () => {
    const score = calculateConfidence({ titleScore: 1, primaryArtistScore: 0, artistOverlap: 0, durationScore: 0 });
    expect(score).toBeCloseTo(0.45);
  });
});

// ---------------------------------------------------------------------------
// searchTrackOnDeezer – mocked via vi.mock hoisting
// ---------------------------------------------------------------------------

vi.mock('undici', () => ({
  fetch: vi.fn()
}));

describe('searchTrackOnDeezer', () => {
  let searchTrackOnDeezer;
  let mockFetch;

  beforeEach(async () => {
    const undici = await import('undici');
    mockFetch = undici.fetch;
    vi.mocked(mockFetch).mockReset();

    const mod = await import('../src/integrations/deezer.js');
    searchTrackOnDeezer = mod.searchTrackOnDeezer;
  });

  function makeDeezerResponse(items) {
    return {
      ok: true,
      json: async () => ({ data: items })
    };
  }

  it('returns null when API returns empty data', async () => {
    vi.mocked(mockFetch).mockResolvedValue(makeDeezerResponse([]));
    const result = await searchTrackOnDeezer('The Weeknd', 'Blinding Lights');
    expect(result).toBeNull();
  });

  it('returns null when confidence is below 0.8', async () => {
    vi.mocked(mockFetch).mockResolvedValue(makeDeezerResponse([{
      id: '999',
      title: 'Blinding Lights',
      artist: { name: 'Completely Different Artist' },
      duration: 200,
      isrc: 'USRC12345678'
    }]));
    const result = await searchTrackOnDeezer('The Weeknd', 'Blinding Lights');
    expect(result).toBeNull();
  });

  it('returns canonical artist/title from Deezer on a high-confidence match', async () => {
    vi.mocked(mockFetch).mockResolvedValue(makeDeezerResponse([{
      id: '42',
      title: 'Blinding Lights',
      artist: { name: 'The Weeknd' },
      duration: 200,
      isrc: 'USRC12345678'
    }]));
    const result = await searchTrackOnDeezer('the weeknd', 'blinding lights');
    expect(result).not.toBeNull();
    expect(result.deezerId).toBe('42');
    expect(result.isrc).toBe('USRC12345678');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.artist).toBe('The Weeknd');
    expect(result.title).toBe('Blinding Lights');
  });

  it('throws when HTTP response is not ok', async () => {
    vi.mocked(mockFetch).mockResolvedValue({ ok: false, status: 403 });
    await expect(searchTrackOnDeezer('Artist', 'Title')).rejects.toThrow('HTTP 403');
  });

  it('returns null when artist or title are empty', async () => {
    const result = await searchTrackOnDeezer('', 'Something');
    expect(result).toBeNull();
  });
});
