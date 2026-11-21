import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiRequest, errorMessage, postJson, type Centre, type Role, type User } from './api';

const roles: Record<Role, string> = {
  TRAINING_CENTRE: 'Training centre',
  DISTRICT_OFFICER: 'District officer',
  QUALITY_REVIEWER: 'Quality reviewer',
  STATE_OFFICER: 'State officer',
};

function SignIn({ onSignIn }: { onSignIn: (user: User) => void }) {
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setNotice('');
    setBusy(true);
    try {
      const { user } = await postJson<{ user: User }>('/api/auth/login', {
        email: data.get('email'),
        password: data.get('password'),
      });
      onSignIn(user);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel sign-in" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">Sign in</h1>
      <p>Use your CertiFlow staff account.</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="username" maxLength={254} required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" maxLength={128} required />
        {notice && <p className="notice" role="alert">{notice}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </section>
  );
}

function CentreDirectory({ user, onSessionExpired }: { user: User; onSessionExpired: () => void }) {
  const [centres, setCentres] = useState<Centre[] | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ centres: Centre[] }>('/api/centres', { signal: controller.signal })
      .then((result) => setCentres(result.centres))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
        } else {
          setNotice(errorMessage(error));
        }
      });
    return () => controller.abort();
  }, [onSessionExpired]);

  return (
    <section className="directory" aria-labelledby="workspace-title">
      <p className="role">{roles[user.role]}</p>
      <h1 id="workspace-title">Welcome, {user.displayName}</h1>
      <div className="panel">
        <h2>Training centres</h2>
        {notice && <p className="notice" role="alert">{notice}</p>}
        {!centres && !notice && <p role="status">Loading training centres…</p>}
        {centres?.length === 0 && <p>No training centres are assigned to this account.</p>}
        {!!centres?.length && (
          <ul className="centres">
            {centres.map((centre) => (
              <li key={centre.id}>
                <span><strong>{centre.name}</strong><small>{centre.district.name}</small></span>
                <span className="code">{centre.code}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const endSession = useCallback(() => setUser(null), []);

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ user: User }>('/api/auth/me', { signal: controller.signal })
      .then((result) => setUser(result.user))
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof ApiError && error.status === 401)) return;
        setNotice(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function signOut() {
    setSigningOut(true);
    setNotice('');
    try {
      await postJson('/api/auth/logout', {});
      endSession();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <strong>CertiFlow</strong>
            <span>Pragati Skills Mission</span>
          </div>
          {user && (
            <button className="secondary" onClick={signOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          )}
        </div>
      </header>
      <main>
        {notice && <p className="notice" role="alert">{notice}</p>}
        {loading ? <p role="status">Loading your session…</p> : user ? (
          <CentreDirectory
            key={user.id}
            user={user}
            onSessionExpired={endSession}
          />
        ) : <SignIn onSignIn={(signedInUser) => { setNotice(''); setUser(signedInUser); }} />}
      </main>
    </>
  );
}
