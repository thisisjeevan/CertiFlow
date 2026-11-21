import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiRequest, errorMessage } from './api';

interface Verification {
  status: 'VALID' | 'REVOKED' | 'NOT_FOUND';
  number?: string;
  courseName?: string;
  centreName?: string;
  issuedAt?: string;
}

export function PublicVerification({ initialNumber }: { initialNumber: string }) {
  const [number, setNumber] = useState(initialNumber);
  const [checked, setChecked] = useState(initialNumber);
  const [result, setResult] = useState<Verification>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(Boolean(initialNumber));

  useEffect(() => {
    if (!checked) return;
    const controller = new AbortController();
    void apiRequest<Verification>('/api/verify/' + encodeURIComponent(checked), { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) setResult(next); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) setResult({ status: 'NOT_FOUND' });
        else setNotice(errorMessage(error));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [checked]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supplied = number.trim();
    if (!supplied) return;
    // Rechecking the same certificate must take a fresh authoritative read.
    if (supplied === checked) {
      window.location.assign('/verify/' + encodeURIComponent(supplied));
      return;
    }
    setNotice('');
    setResult(undefined);
    setBusy(true);
    setChecked(supplied);
  }

  return (
    <main>
      <section className="panel public-certificate">
        <a href="/">CertiFlow home</a>
        <h1>Verify a certificate</h1>
        <form onSubmit={search}>
          <label htmlFor="certificate-number">Certificate number</label>
          <input id="certificate-number" value={number} onChange={(event) => setNumber(event.target.value)}
            autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={43} required />
          <button type="submit" disabled={busy}>Verify certificate</button>
        </form>
        {busy && <p role="status">Checking current status…</p>}
        {notice && <p className="notice" role="alert">{notice}</p>}
        {result && (
          <section className={result.status === 'VALID' ? 'success' : 'notice'} aria-live="polite">
            <h2>{result.status === 'VALID' ? 'Valid certificate' : result.status === 'REVOKED' ? 'Certificate revoked' : 'Certificate unavailable'}</h2>
            {result.status === 'VALID' && (
              <dl>
                <dt>Programme</dt><dd>{result.courseName}</dd>
                <dt>Training centre</dt><dd>{result.centreName}</dd>
                <dt>Issue date (UTC)</dt><dd>{result.issuedAt?.slice(0, 10)}</dd>
              </dl>
            )}
            {result.number && <p className="certificate-number">{result.number}</p>}
          </section>
        )}
      </section>
    </main>
  );
}

export function CandidateDownload({ id }: { id: string }) {
  const [token] = useState(() => window.location.hash.slice(1));
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function download() {
    setBusy(true);
    setNotice('');
    setSaved(false);
    try {
      const response = await fetch('/api/certificates/' + encodeURIComponent(id) + '/download', {
        headers: { Authorization: 'Bearer ' + token }, cache: 'no-store',
      });
      if (!response.ok) throw new Error(response.status === 403
        ? 'This link is invalid, expired, or unavailable.'
        : 'The certificate file is temporarily unavailable.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'certificate.pdf';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
      setSaved(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The certificate file is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="panel public-certificate">
        <h1>Download your certificate</h1>
        {token
          ? <button type="button" disabled={busy} onClick={() => void download()}>Download PDF</button>
          : <p>Open the complete link from your certificate message.</p>}
        {notice && <p className="notice" role="alert">{notice}</p>}
        {saved && <p className="success" role="status">Your PDF download has started.</p>}
      </section>
    </main>
  );
}
