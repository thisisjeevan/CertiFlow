import { useEffect, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from './api';
import { useLiveVersion } from './LiveUpdates';
import type { Stage } from './WorkflowHistory';

interface Notification {
  id: string;
  type: string;
  resourceId: string;
  createdAt: string;
  readAt: string | null;
  escalation: { stage: Stage; thresholdHours: number; revision: { revision: number; batch: { courseName: string } } } | null;
}

const messages: Record<string, string> = {
  BATCH_DISTRICT_REVIEW: 'A batch is ready for district review.',
  BATCH_QUALITY_REVIEW: 'A batch moved to quality review.',
  BATCH_STATE_REVIEW: 'A batch moved to state review.',
  BATCH_RETURNED: 'A batch was returned for correction.',
  BATCH_REJECTED: 'A batch was rejected.',
  BATCH_APPROVED: 'A batch received final approval.',
};

export function Notifications({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [entries, setEntries] = useState<Notification[] | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const liveVersion = useLiveVersion('notifications');

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ notifications: Notification[] }>('/api/notifications', { signal: controller.signal })
      .then(({ notifications }) => { if (!controller.signal.aborted) setEntries(notifications); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setNotice(errorMessage(error));
      });
    return () => controller.abort();
  }, [liveVersion, onSessionExpired]);

  async function refresh(readId?: string) {
    setBusy(true);
    setNotice('');
    try {
      if (readId) {
        await apiRequest('/api/notifications/' + readId + '/read', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
      }
      const { notifications } = await apiRequest<{ notifications: Notification[] }>('/api/notifications');
      setEntries(notifications);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="panel notifications">
      <summary>Notifications{entries && ' · ' + entries.filter(({ readAt }) => !readAt).length + ' unread'}</summary>
      <button className="outline" type="button" disabled={busy} onClick={() => void refresh()}>Refresh notifications</button>
      {notice && <p role="alert" className="notice">{notice}</p>}
      {!entries && !notice && <p role="status">Loading notifications…</p>}
      {entries?.length === 0 && <p>No notifications.</p>}
      {!!entries?.length && (
        <ul>
          {entries.map(({ id, type, resourceId, createdAt, readAt, escalation }) => (
            <li key={id}>
              <div>
                <strong>{escalation
                  ? escalation.revision.batch.courseName + ' is overdue for ' + escalation.stage.toLowerCase() + ' review'
                  : messages[type] ?? 'Batch updated.'}</strong>
                {escalation && <small>Revision {escalation.revision.revision} · Review pending over {escalation.thresholdHours} hours</small>}
                <small>Batch {resourceId.slice(-8)} · {new Date(createdAt).toLocaleString()}</small>
              </div>
              {!readAt && <button className="outline" type="button" disabled={busy} onClick={() => void refresh(id)}>Mark read</button>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
