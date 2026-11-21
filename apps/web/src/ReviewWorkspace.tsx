import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest, errorMessage, postJson, type Role } from './api';
import { WorkflowHistory, statusLabels, type Outcome, type RevisionStatus, type Stage } from './WorkflowHistory';
import { useLiveVersion } from './LiveUpdates';

interface QueueItem {
  id: string;
  courseName: string;
  centre: { name: string; district: { name: string } };
  revision: { id: string; revision: number; status: RevisionStatus };
  candidateCount: number;
  districtApprovals: number;
}

interface ReviewDetail extends QueueItem {
  stage: Stage;
  canDecide: boolean;
  districtThreshold: number;
  candidates: { reference: string; fullName: string }[];
}

const workspaceNames: Partial<Record<Role, string>> = {
  DISTRICT_OFFICER: 'District review queue',
  QUALITY_REVIEWER: 'Quality review queue',
  STATE_OFFICER: 'State review queue',
};

export function ReviewWorkspace({ role, onSessionExpired }: { role: Role; onSessionExpired: () => void }) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [selected, setSelected] = useState<ReviewDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [reason, setReason] = useState('');
  const liveVersion = useLiveVersion('workflow');
  const selectedId = selected?.id;

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onSessionExpired();
    else setNotice(errorMessage(error));
  }, [onSessionExpired]);

  const loadQueue = useCallback(async (signal?: AbortSignal) => {
    const result = await apiRequest<{ queue: QueueItem[] }>('/api/reviews', { signal });
    if (!signal?.aborted) setQueue(result.queue);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadQueue(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) handleError(error);
    });
    return () => controller.abort();
  }, [handleError, loadQueue, liveVersion]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void apiRequest<{ batch: ReviewDetail }>('/api/reviews/' + selectedId, { signal: controller.signal })
      .then(({ batch }) => {
        if (!controller.signal.aborted) setSelected((current) => current?.id === selectedId ? batch : current);
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) handleError(error); });
    return () => controller.abort();
  }, [handleError, selectedId, liveVersion]);

  async function selectBatch(id: string) {
    setBusy(true);
    setNotice('');
    setSuccess('');
    try {
      const { batch } = await apiRequest<{ batch: ReviewDetail }>('/api/reviews/' + id);
      setSelected(batch);
      setReason('');
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setNotice('');
    try {
      await loadQueue();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function decide(outcome: Outcome) {
    if (!selected) return;
    if (outcome !== 'APPROVE' && !reason.trim()) {
      setNotice('Enter a reason to return or reject this revision.');
      return;
    }
    setBusy(true);
    setNotice('');
    setSuccess('');
    try {
      const path = '/api/reviews/' + selected.id;
      const result = await postJson<{ status: RevisionStatus }>(path + '/revisions/' + selected.revision.id + '/decisions', {
        stage: selected.stage, outcome, reason: reason.trim() || undefined,
      });
      setSelected({ ...selected, canDecide: false, revision: { ...selected.revision, status: result.status } });
      setReason('');
      setSuccess('Decision recorded.');
      const [{ batch }] = await Promise.all([apiRequest<{ batch: ReviewDetail }>(path), loadQueue()]);
      setSelected(batch);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="batch-workspace">
      <div className="batch-detail-heading">
        <h2>{workspaceNames[role]}</h2>
        <button type="button" className="outline" disabled={busy} onClick={() => void refresh()}>Refresh queue</button>
      </div>
      {notice && <p role="alert" className="notice">{notice}</p>}
      {success && <p role="status" className="success">{success}</p>}
      <div className="batch-layout review-layout">
        <div className="panel">
          {queue === null && !notice && <p role="status">Loading review queue…</p>}
          {queue?.length === 0 && <p>No batches awaiting your decision.</p>}
          {!!queue?.length && (
            <ul className="batch-list">
              {queue.map((entry) => (
                <li key={entry.revision.id}>
                  <button type="button" disabled={busy} onClick={() => void selectBatch(entry.id)}
                    aria-current={selected?.id === entry.id ? 'true' : undefined}>
                    <strong>{entry.courseName}</strong>
                    <small>{entry.centre.name} · {entry.candidateCount} candidates</small>
                    <small>Revision {entry.revision.revision}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          {selected ? (
            <>
              <div className="batch-detail-heading">
                <div>
                  <h3>{selected.courseName}</h3>
                  <p className="role">Revision {selected.revision.revision} · {statusLabels[selected.revision.status]}</p>
                </div>
                <button type="button" className="outline" disabled={busy} onClick={() => void selectBatch(selected.id)}>Reload batch</button>
              </div>
              <p>{selected.centre.name} · {selected.centre.district.name}</p>
              {selected.stage === 'DISTRICT' && <p>District approvals {selected.districtApprovals} of {selected.districtThreshold}</p>}
              {selected.canDecide && (
                <div className="review-actions">
                  <label htmlFor="review-reason">Reason for return or rejection</label>
                  <textarea id="review-reason" rows={3} maxLength={500} value={reason}
                    onChange={(event) => setReason(event.target.value)} disabled={busy} />
                  <div className="action-buttons">
                    <button type="button" disabled={busy} onClick={() => void decide('APPROVE')}>Approve</button>
                    <button type="button" className="outline" disabled={busy} onClick={() => void decide('RETURN')}>Return for correction</button>
                    <button type="button" className="outline reject" disabled={busy} onClick={() => void decide('REJECT')}>Reject</button>
                  </div>
                </div>
              )}
              <details className="review-roster">
                <summary>Candidates ({selected.candidateCount})</summary>
                <ul>{selected.candidates.map(({ reference, fullName }) => <li key={reference}>{reference} · {fullName}</li>)}</ul>
              </details>
              <WorkflowHistory key={selected.id} batch={selected} onSessionExpired={onSessionExpired} />
            </>
          ) : <p>Open a batch to review its roster and decision history.</p>}
        </div>
      </div>
    </section>
  );
}
