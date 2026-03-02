import { describe, expect, it, vi, beforeEach } from 'vitest';
import { backendPost, DEFAULT_API_BASE_URL } from '@/services/backendApi';

describe('backendPost', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts JSON and returns parsed response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'abc' }), { status: 200 })
    );

    const response = await backendPost<{ token: string }>('/api/elevenlabs-scribe-token');
    expect(response.token).toBe('abc');
    expect(fetchSpy).toHaveBeenCalledWith(
      `${DEFAULT_API_BASE_URL}/api/elevenlabs-scribe-token`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws backend error message when request fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'No token' }), { status: 500 })
    );

    await expect(backendPost('/api/elevenlabs-scribe-token')).rejects.toThrow('No token');
    expect(fetchSpy).toHaveBeenCalledWith(
      `${DEFAULT_API_BASE_URL}/api/elevenlabs-scribe-token`,
      expect.objectContaining({ method: 'POST' })
    );
  });
});
