import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '@/components/AuthGate';
import { AUTH_EXPIRED_EVENT, authenticatedFetch } from '@/services/api';
beforeEach(() => { vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
describe('private app gate', () => {
  it('does not mount the monitor while session verification is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    expect(screen.queryByText('Private monitor')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking');
  });
  it('blocks access and explains both setup options if configuration is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ authenticated: false, configured: false })));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('configure Vercel protection or password mode');
    expect(screen.queryByText('Private monitor')).not.toBeInTheDocument();
  });
  it('mounts private UI only after successful login and cookie verification', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: false, configured: true }))
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ authenticated: true, configured: true }));
    vi.stubGlobal('fetch', fetch);
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    fireEvent.change(await screen.findByLabelText('Service password'), { target: { value: 'test-only-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Private monitor')).toBeInTheDocument();
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/login', expect.objectContaining({ credentials: 'same-origin', body: JSON.stringify({ password: 'test-only-password' }) }));
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
  it('uses verified Vercel protection without offering password sign-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ authenticated: true, configured: true, mode: 'vercel' })));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    expect(await screen.findByText('Private monitor')).toBeInTheDocument();
    expect(screen.getByText('Access managed by Vercel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
  it('does not trust Vercel mode without an authenticated configured session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ authenticated: false, configured: false, mode: 'vercel' })));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    expect(await screen.findByRole('link', { name: 'Reload and sign in through Vercel' })).toHaveAttribute('href', window.location.href);
    expect(screen.queryByText('Private monitor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service password')).not.toBeInTheDocument();
  });
  it('recovers expired Vercel sessions through a full-page sign-in reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ authenticated: true, configured: true, mode: 'vercel' })));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    await screen.findByText('Private monitor');
    fireEvent(window, new Event(AUTH_EXPIRED_EVENT));
    expect(screen.queryByText('Private monitor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reload and sign in through Vercel' })).toHaveAttribute('href', window.location.href);
  });
  it.each(['redirect', 'html', 'invalid-json'])('offers safe recovery for a %s session response', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, redirected: kind === 'redirect',
      headers: new Headers({ 'content-type': kind === 'html' ? 'text/html' : 'application/json' }),
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    expect(await screen.findByRole('link', { name: 'Reload to verify sign-in' })).toHaveAttribute('href', window.location.href);
    expect(screen.queryByText('Private monitor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service password')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not verify sign-in');
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
  });
  it('unmounts private UI on session expiry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ authenticated: true, configured: true })));
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    await screen.findByText('Private monitor');
    fireEvent(window, new Event(AUTH_EXPIRED_EVENT));
    expect(screen.queryByText('Private monitor')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('expired');
  });
  it('dispatches expiry when any authenticated API returns 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({}, 401)));
    const listener = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, listener);
    await authenticatedFetch('/api/transcribe');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
  });
  it('unmounts private UI immediately when signing out', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ authenticated: true, configured: true })).mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    render(<AuthGate><div>Private monitor</div></AuthGate>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Private monitor')).not.toBeInTheDocument());
  });
});
