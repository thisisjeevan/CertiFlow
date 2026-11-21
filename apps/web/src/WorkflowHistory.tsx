import { useEffect, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from './api';

export const statusLabels = {
  DRAFT: 'Draft',
  DISTRICT_REVIEW: 'District review',
  QUALITY_REVIEW: 'Quality review',
  STATE_REVIEW: 'State review',
  APPROVED: 'Approved',
  RETURNED: 'Returned',
  REJECTED: 'Rejected',
};
export type RevisionStatus = keyof typeof statusLabels;
export type Stage = 'DISTRICT' | 'QUALITY' | 'STATE';
export type Outcome = 'APPROVE' | 'RETURN' | 'REJECT';

const stageLabels: Record<Stage, string> = { DISTRICT: 'District', QUALITY: 'Quality', STATE: 'State' };
const outcomeLabels: Record<Outcome, string> = { APPROVE: 'Approved', RETURN: 'Returned', REJECT: 'Rejected' };

interface Timeline {
  revisions: {
    id: string;
    revision: number;
    status: RevisionStatus;
    decisions: { id: string; stage: Stage; outcome: Outcome; reason: string | null; createdAt: string; actor: { displayName: string } }[];
  }[];
  audit: {
    id: string;
    revisionId: string;
    action: string;
    createdAt: string;
    actor: { displayName: string } | null;
    details: { status?: RevisionStatus };
  }[];
}

function auditLabel(action: string, status?: RevisionStatus) {
  if (action === 'BATCH_CORRECTION_STARTED') return 'Correction opened';
  if (action === 'BATCH_SUBMITTED') return 'Submitted for district review';
  return status ? statusLabels[status] : 'Review status changed';
}

export function WorkflowHistory({ batch, onSessionExpired }: { batch: { id: string }; onSessionExpired: () => void }) {
  const [history, setHistory] = useState<Timeline | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<Timeline>('/api/reviews/' + batch.id + '/timeline', { signal: controller.signal })
      .then((timeline) => { setHistory(timeline); setNotice(''); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setNotice(errorMessage(error));
      });
    return () => controller.abort();
  }, [batch, onSessionExpired]);

  return (
    <section className="workflow-history" aria-label="Approval history">
      <h4>Approval history</h4>
      {notice && <p role="alert" className="notice">{notice}</p>}
      {!history && !notice && <p role="status">Loading approval history…</p>}
      {history?.revisions.map((revision) => {
        const entries = [
          ...revision.decisions.map((decision) => ({ kind: 'decision' as const, value: decision })),
          ...history.audit
            .filter((entry) => entry.revisionId === revision.id && entry.action !== 'BATCH_REVIEW_DECISION')
            .map((entry) => ({ kind: 'audit' as const, value: entry })),
        ].sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));

        return (
          <div key={revision.id} className="history-revision">
            <h5>Revision {revision.revision} · {statusLabels[revision.status]}</h5>
            {entries.map((entry) => {
              const { id, actor, createdAt } = entry.value;
              return (
                <p key={entry.kind + ':' + id} className="history-entry">
                  {entry.kind === 'decision'
                    ? <strong>{stageLabels[entry.value.stage]} · {outcomeLabels[entry.value.outcome]}</strong>
                    : auditLabel(entry.value.action, entry.value.details.status)}
                  {actor && ' by ' + actor.displayName}
                  <small>{new Date(createdAt).toLocaleString()}</small>
                  {entry.kind === 'decision' && entry.value.reason && (
                    <span className="decision-reason">{entry.value.reason}</span>
                  )}
                </p>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
