import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AUTH_EXPIRED_EVENT } from '@/services/api';
import { getStorageWarning, STORAGE_WARNING_EVENT } from '@/services/storage';

async function readSession(response: Response) {
  const contentType = response.headers?.get('content-type');
  if (!response.ok || response.redirected || (contentType && !contentType.includes('application/json'))) {
    throw new Error('Could not verify sign-in. Reload this page to complete sign-in through your hosting provider or try again.');
  }
  try {
    const data = await response.json();
    if (!data || typeof data.authenticated !== 'boolean' || typeof data.configured !== 'boolean') throw new Error('Invalid session');
    return data as { authenticated: boolean; configured: boolean; mode?: 'password' | 'vercel' };
  } catch {
    throw new Error('Could not verify sign-in. Reload this page to complete sign-in through your hosting provider or try again.');
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'signed-out' | 'signed-in'>('checking');
  const [configured, setConfigured] = useState(true);
  const [authMode, setAuthMode] = useState<'password' | 'vercel'>('password');
  const [needsReload, setNeedsReload] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(getStorageWarning);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const expire = () => { setState('signed-out'); setError('Your session expired. Sign in again.'); };
    const storage = () => setStorageWarning(getStorageWarning());
    window.addEventListener(AUTH_EXPIRED_EVENT, expire);
    window.addEventListener(STORAGE_WARNING_EVENT, storage);
    fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        const data = await readSession(response);
        if (!active) return;
        setConfigured(data.configured === true);
        setAuthMode(data.mode === 'vercel' ? 'vercel' : 'password');
        setState(data.authenticated === true && data.configured === true ? 'signed-in' : 'signed-out');
      }).catch(cause => {
        if (!active) return;
        setState('signed-out');
        setNeedsReload(true);
        setError(cause instanceof Error ? cause.message : 'Unable to check sign-in status');
      });
    return () => { active = false; controller.abort(); window.removeEventListener(AUTH_EXPIRED_EVENT, expire); window.removeEventListener(STORAGE_WARNING_EVENT, storage); };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    const submittedPassword = password;
    setPassword('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: submittedPassword }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect password.' : 'Sign-in failed. Check the service configuration and try again.');
      // Verify the HttpOnly session cookie before mounting any private UI.
      const session = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const data = await readSession(session);
      if (!session.ok || data.authenticated !== true || data.configured !== true) throw new Error('Sign-in could not be verified.');
      setAuthMode(data.mode === 'vercel' ? 'vercel' : 'password');
      setState('signed-in');
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('Could not verify sign-in')) setNeedsReload(true);
      setError(cause instanceof Error ? cause.message : 'Sign-in failed');
    }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    // Unmount monitoring immediately, even if the network request fails.
    setState('signed-out');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Sign-out failed. Try again before leaving this shared browser.');
    } catch { setError('Sign-out could not be confirmed. Your server session may still be active. Reload and try signing out again.'); }
    finally { setBusy(false); }
  }
  if (state === 'checking') return <main className="p-8" role="status">Checking sign-in…</main>;
  if (state === 'signed-out') return <main className="min-h-screen flex items-center justify-center p-6 bg-background">
    <form onSubmit={login} className="w-full max-w-sm space-y-4 border-[3px] border-foreground p-6 bg-card shadow-brutal">
      <h1 className="text-2xl font-black">FactCheckMe</h1>
      <p>Private access. Sign in to start fact-checking.</p>
      {!configured && <p role="alert">The owner must configure Vercel protection or password mode before sign-in is available.</p>}
      {authMode === 'password' && !needsReload && <>
      <label className="block" htmlFor="service-password">Service password</label>
      <input id="service-password" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy || !configured} value={password} onChange={event => setPassword(event.target.value)} className="w-full border-2 border-foreground p-2 bg-background" />
      <button disabled={busy || !configured} className="border-2 border-foreground bg-primary p-2 font-bold" type="submit">{busy ? 'Please wait…' : 'Sign in'}</button>
      </>}
      {error && <p role="alert">{error}</p>}
      {(authMode === 'vercel' || needsReload) && <a href={window.location.href} onClick={event => { event.preventDefault(); window.location.reload(); }} className="inline-block border-2 border-foreground bg-primary p-2 font-bold">{authMode === 'vercel' ? 'Reload and sign in through Vercel' : 'Reload to verify sign-in'}</a>}
    </form>
  </main>;
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-muted text-xs">
      <span>History stays in this browser (up to 500 checks and 100 sessions). Clear it before sharing this device.</span>
      {authMode === 'password' ? <button type="button" onClick={logout} disabled={busy} className="underline font-bold">Sign out</button> : <span>Access managed by Vercel</span>}
      {storageWarning && <p role="alert" className="w-full">{storageWarning}</p>}
    </div>
    {children}
  </>;
}
