import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiRequest, errorMessage, postJson } from './api';

interface BatchProgress {
  batch: { courseName: string; centre: { name: string } };
  revisionId: string;
  revision: number;
  candidates: number;
  ready: number;
  failed: number;
  delivered: number;
  revoked: number;
}
interface Certificate {
  id: string;
  number: string;
  generationStatus: string;
  generationError: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  candidate: { fullName: string };
  delivery: { status: string; attempts: number; lastError: string | null } | null;
}
interface Details {
  courseName: string;
  revision: number;
  candidateCount: number;
  certificates: Certificate[];
}
interface MockMessage {
  receiptId: string;
  number: string;
  candidateName: string;
  downloadUrl: string | null;
  acceptedAt: string;
  status: string;
  history: { attempt: number; outcome: string }[];
}

function readable(status: string) {
  return status.toLowerCase().replaceAll('_', ' ');
}

export function CertificateWorkspace({ stateOfficer, onSessionExpired }: {
  stateOfficer: boolean;
  onSessionExpired: () => void;
}) {
  const [batches, setBatches] = useState<BatchProgress[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [details, setDetails] = useState<Details | null>(null);
  const [messages, setMessages] = useState<MockMessage[] | null>(null);
  const [revoking, setRevoking] = useState<Certificate | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onSessionExpired();
    else setNotice(errorMessage(error));
  }, [onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ batches: BatchProgress[] }>('/api/certificates/batches', { signal: controller.signal })
      .then(({ batches }) => { if (!controller.signal.aborted) setBatches(batches); })
      .catch((error: unknown) => { if (!controller.signal.aborted) handleError(error); });
    return () => controller.abort();
  }, [handleError]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    setSuccess('');
    try { await action(); } catch (error) { handleError(error); } finally { setBusy(false); }
  }

  async function openRevision(id: string) {
    const revision = await apiRequest<Details>('/api/certificates/batches/' + id);
    setSelectedId(id);
    setDetails(revision);
  }

  async function refresh() {
    const { batches } = await apiRequest<{ batches: BatchProgress[] }>('/api/certificates/batches');
    setBatches(batches);
    if (selectedId) await openRevision(selectedId);
    if (messages && selectedId) await loadMessages();
  }

  async function loadMessages() {
    const result = await apiRequest<{ messages: MockMessage[] }>('/api/certificates/batches/' + selectedId + '/mock-messages');
    setMessages(result.messages);
  }

  function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revoking) return;
    const reason = new FormData(event.currentTarget).get('reason');
    void perform(async () => {
      await postJson('/api/certificates/' + revoking.id + '/revoke', { reason });
      setRevoking(null);
      await refresh();
      setSuccess('Certificate revoked.');
    });
  }

  return (
    <section className="batch-workspace" aria-label="Certificate workspace">
      <div className="batch-detail-heading">
        <h2>Approved batches and certificates</h2>
        <button type="button" className="outline" disabled={busy} onClick={() => void perform(refresh)}>Refresh certificates</button>
      </div>
      {notice && <p role="alert" className="notice">{notice}</p>}
      {success && <p role="status" className="success">{success}</p>}
      <div className="panel">
        {!batches && !notice && <p role="status">Loading approved batches…</p>}
        {batches?.length === 0 && <p>No approved batches.</p>}
        {!!batches?.length && <ul className="batch-list certificate-batches">
          {batches.map((batch) => (
            <li key={batch.revisionId}>
              <button type="button" disabled={busy} aria-current={selectedId === batch.revisionId ? 'true' : undefined}
                onClick={() => void perform(async () => {
                  setMessages(null);
                  setRevoking(null);
                  await openRevision(batch.revisionId);
                })}>
                <strong>{batch.batch.courseName}</strong>
                <small>{batch.batch.centre.name} · Revision {batch.revision}</small>
                <small>{batch.ready}/{batch.candidates} issued · {batch.delivered} delivered · {batch.failed} generation failures · {batch.revoked} revoked</small>
              </button>
            </li>
          ))}
        </ul>}
        {details && (
          <div className="certificate-details">
            <h3>{details.courseName} · Revision {details.revision}</h3>
            <p>{details.certificates.length} of {details.candidateCount} certificate records</p>
            {revoking && (
              <form onSubmit={revoke} className="revocation-form">
                <label htmlFor="revocation-reason">Reason for revoking {revoking.candidate.fullName}’s certificate</label>
                <input id="revocation-reason" name="reason" maxLength={500} required />
                <div className="action-buttons">
                  <button type="submit" disabled={busy}>Confirm revocation</button>
                  <button type="button" className="outline" disabled={busy} onClick={() => setRevoking(null)}>Cancel</button>
                </div>
              </form>
            )}
            {!!details.certificates.length && <div className="table-scroll">
              <table>
                <caption>Certificates and delivery progress</caption>
                <thead><tr><th scope="col">Candidate</th><th scope="col">Number</th><th scope="col">Certificate</th>
                  <th scope="col">Mock delivery</th>{stateOfficer && <th scope="col">Action</th>}</tr></thead>
                <tbody>{details.certificates.map((certificate) => (
                  <tr key={certificate.id}>
                    <td>{certificate.candidate.fullName}</td>
                    <td className="certificate-number"><a href={'/verify/' + certificate.number}>{certificate.number}</a></td>
                    <td>{certificate.revokedAt ? 'Revoked' : readable(certificate.generationStatus)}
                      {certificate.revocationReason && <small>{certificate.revocationReason}</small>}
                      {certificate.generationError && <small>{readable(certificate.generationError)}</small>}</td>
                    <td>{certificate.delivery ? readable(certificate.delivery.status) + ' · ' + certificate.delivery.attempts + ' attempts' : 'Awaiting issuance'}
                      {certificate.delivery?.lastError && <small>{readable(certificate.delivery.lastError)}</small>}</td>
                    {stateOfficer && <td>{!certificate.revokedAt && certificate.generationStatus === 'READY'
                      && <button type="button" className="outline reject" disabled={busy} onClick={() => setRevoking(certificate)}>Revoke</button>}</td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>}
            {stateOfficer && <button className="outline" type="button" disabled={busy}
              onClick={() => void perform(loadMessages)}>View simulated WhatsApp messages</button>}
            {messages && <div className="table-scroll">
              <table>
                <caption>Simulated WhatsApp receipts ({messages.length})</caption>
                <thead><tr><th scope="col">Candidate</th><th scope="col">Mock receipt</th><th scope="col">Attempts</th><th scope="col">Candidate link</th></tr></thead>
                <tbody>{messages.map((message) => (
                  <tr key={message.receiptId}>
                    <td>{message.candidateName}</td>
                    <td>{message.receiptId.slice(-8)}<small>{new Date(message.acceptedAt).toLocaleString()}</small></td>
                    <td>{message.history.map(({ outcome }) => readable(outcome)).join(', ')}</td>
                    <td>{message.downloadUrl
                      ? <a href={message.downloadUrl} target="_blank" rel="noreferrer">Open download link</a>
                      : 'Unavailable'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>}
          </div>
        )}
      </div>
    </section>
  );
}
