import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiRequest, errorMessage, postJson, type FieldIssue } from './api';

import { WorkflowHistory, statusLabels, type RevisionStatus } from './WorkflowHistory';

interface BatchSummary {
  id: string;
  courseName: string;
  revision: {
    id: string;
    revision: number;
    version: string;
    status: RevisionStatus;
    candidateCount: number;
  } | null;
}

interface BatchDetails extends BatchSummary {
  candidates: {
    id: string;
    reference: string;
    fullName: string;
    phoneE164: string;
    completionReference: string | null;
  }[];
}

interface BatchResponse { batch: BatchDetails }

function ImportIssues({ issues }: { issues: FieldIssue[] }) {
  return (
    <div className="table-scroll">
      <table>
        <caption>CSV validation errors</caption>
        <thead><tr><th scope="col">Row</th><th scope="col">Field</th><th scope="col">What to fix</th></tr></thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={index}>
              <td>{issue.row}</td><td><code>{issue.field}</code></td><td>{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateTable({ candidates }: { candidates: BatchDetails['candidates'] }) {
  if (!candidates.length) return <p>No candidates in this batch.</p>;

  return (
    <div className="table-scroll">
      <table>
        <caption>Candidates ({candidates.length})</caption>
        <thead>
          <tr>
            <th scope="col">Reference</th><th scope="col">Full name</th>
            <th scope="col">Phone</th><th scope="col">Completion</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id}>
              <td>{candidate.reference}</td><td>{candidate.fullName}</td>
              <td className="phone">{candidate.phoneE164}</td><td>{candidate.completionReference ?? 'Unrecorded'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TrainingBatches({ centreId, onSessionExpired }: {
  centreId: string; onSessionExpired: () => void;
}) {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [selected, setSelected] = useState<BatchDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ batches: BatchSummary[] }>('/api/batches', { signal: controller.signal })
      .then(({ batches }) => setBatches(batches))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else {
          setNotice(errorMessage(error));
          setBatches([]);
        }
      });
    return () => controller.abort();
  }, [onSessionExpired]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    setSuccess('');
    setIssues([]);
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else {
        setNotice(errorMessage(error));
        if (error instanceof ApiError) setIssues(error.issues);
      }
    } finally {
      setBusy(false);
    }
  }

  function showBatch(batch: BatchDetails) {
    setSelected(batch);
    const { id, courseName, revision } = batch;
    const summary = { id, courseName, revision };
    setBatches((current) => current?.some((item) => item.id === id)
      ? current.map((item) => item.id === id ? summary : item)
      : [summary, ...(current ?? [])]);
  }

  function openBatch(id: string) {
    void perform(async () => {
      const { batch } = await apiRequest<BatchResponse>('/api/batches/' + id);
      showBatch(batch);
    });
  }

  function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const courseName = new FormData(form).get('courseName');
    void perform(async () => {
      const { batch } = await postJson<BatchResponse>('/api/batches', { centreId, courseName });
      showBatch(batch);
      form.reset();
      setSuccess('Draft created.');
    });
  }

  async function updateDraft(method: 'PATCH' | 'PUT' | 'POST', suffix: string, contentType: string, body: BodyInit) {
    if (!selected?.revision) return;
    const { batch } = await apiRequest<BatchResponse>('/api/batches/' + selected.id + suffix, {
      method,
      headers: { 'Content-Type': contentType, 'X-Draft-Version': selected.revision.version },
      body,
    });
    showBatch(batch);
  }

  function saveCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const courseName = new FormData(event.currentTarget).get('courseName');
    void perform(async () => {
      await updateDraft('PATCH', '', 'application/json', JSON.stringify({ courseName }));
      setSuccess('Course saved. Review the candidate completions before submitting.');
    });
  }

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get('candidateFile');
    void perform(async () => {
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.csv')) {
        throw new ApiError(400, 'Choose a .csv file.');
      }
      await updateDraft('PUT', '/candidates', 'text/csv', file);
      form.reset();
      setSuccess('Candidate roster imported.');
    });
  }

  function submitForReview() {
    void perform(async () => {
      await updateDraft('POST', '/submit', 'application/json', '{}');
      setSuccess('Batch submitted for district review.');
    });
  }

  function correctBatch(batch: BatchDetails) {
    if (!batch.revision) return;
    const revisionId = batch.revision.id;
    void perform(async () => {
      const corrected = await postJson<BatchResponse>('/api/batches/' + batch.id + '/correction', { revisionId });
      showBatch(corrected.batch);
      setSuccess('Correction draft opened. Review the roster before resubmitting.');
    });
  }

  const isDraft = selected?.revision?.status === 'DRAFT';
  return (
    <section className="batch-workspace" aria-labelledby="batches-title">
      <h2 id="batches-title">Batches</h2>
      <div className="batch-layout">
        <div className="panel">
          <h3>Create a draft</h3>
          <form onSubmit={createDraft}>
            <label htmlFor="create-course">Course name</label>
            <input id="create-course" name="courseName" placeholder="Solar Installation Basics" maxLength={120} required />
            <button type="submit" disabled={busy || batches === null}>Create draft</button>
          </form>
          <h3 className="batch-list-title">Your batches</h3>
          {batches === null ? <p role="status">Loading batches…</p> : !batches.length ? <p>No batches yet.</p> : (
            <ul className="batch-list">
              {batches.map((batch) => (
                <li key={batch.id}>
                  <button type="button" disabled={busy} onClick={() => openBatch(batch.id)}
                    aria-current={selected?.id === batch.id ? 'true' : undefined}>
                    <strong>{batch.courseName}</strong>
                    <small>
                      {batch.revision ? statusLabels[batch.revision.status] : 'No revision'}
                      {' · '}{batch.revision?.candidateCount ?? 0} candidates · {batch.id.slice(-8)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel batch-detail">
          {notice && <p className="notice" role="alert">{notice}</p>}
          {!!issues.length && <ImportIssues issues={issues} />}
          {success && <p className="success" role="status">{success}</p>}
          {selected ? (
            <>
              <div className="batch-detail-heading">
                <div>
                  <h3>{selected.courseName}</h3>
                  <p className="role">{selected.revision
                    ? 'Revision ' + selected.revision.revision + ' · ' + statusLabels[selected.revision.status]
                    : 'No revision'}</p>
                </div>
                <button type="button" className="outline" onClick={() => openBatch(selected.id)} disabled={busy}>Reload batch</button>
              </div>

              {selected.revision?.status === 'RETURNED' && (
                <button type="button" className="start-correction" disabled={busy}
                  onClick={() => correctBatch(selected)}>Start correction</button>
              )}
              {selected.revision && (!isDraft || selected.revision.revision > 1) && (
                <WorkflowHistory key={'history:' + selected.id} batch={selected} onSessionExpired={onSessionExpired} />
              )}

              {isDraft && (
                <div className="draft-forms" key={selected.id}>
                  {selected.revision?.revision === 1 && <form onSubmit={saveCourse}>
                    <label htmlFor="edit-course">Edit course name</label>
                    <input id="edit-course" name="courseName" key={selected.courseName}
                      defaultValue={selected.courseName} maxLength={120} required />
                    <button type="submit" className="outline" disabled={busy}>Save course</button>
                  </form>}

                  <form onSubmit={upload}>
                    <label htmlFor="candidate-csv">Candidate CSV</label>
                    <p id="candidate-csv-help">A successful import replaces the draft roster.</p>
                    <input id="candidate-csv" name="candidateFile" type="file" accept=".csv,text/csv"
                      aria-describedby="candidate-csv-help" required />
                    <button type="submit" disabled={busy}>Import candidates</button>
                    <div className="sample-links">
                      <a href="/samples/valid-candidates.csv" download>Valid sample CSV</a>
                      <a href="/samples/invalid-candidates.csv" download>Invalid sample CSV</a>
                    </div>
                  </form>
                </div>
              )}

              <CandidateTable candidates={selected.candidates} />

              {isDraft && (
                <div className="submit-batch">
                  <button type="button" disabled={busy || selected.candidates.length === 0} onClick={submitForReview}>
                    {selected.revision && selected.revision.revision > 1 ? 'Resubmit for district review' : 'Submit for district review'}
                  </button>
                  <small>Submission freezes the roster for review.</small>
                </div>
              )}
            </>
          ) : <p>Open a batch to view its candidates and submission status.</p>}
        </div>
      </div>
    </section>
  );
}
