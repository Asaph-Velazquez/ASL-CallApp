import { useEffect, useRef, useState } from 'react';

type Report = {
  reportId: string;
  summary: string;
  priority: string;
  category: string;
  followUpRequired: boolean;
  notes: string;
  submittedAt: string;
  forwardedToAslWeb: boolean;
  forwardedAt: string | null;
};
type Call = {
  callId: string;
  roomNumber: string;
  guestName: string;
  status: string;
  requestedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  report: Report | null;
};
type History = { calls: Call[]; page: number; total: number; totalPages: number };

function date(value: string | null) {
  if (!value) return '—';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '—' : timestamp.toLocaleString();
}

function duration(call: Call) {
  if (!call.answeredAt || !call.endedAt) return call.answeredAt ? 'In progress' : 'Not answered';
  const seconds = Math.floor((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : '—';
}

export default function CallHistory({ apiUrl, token, revision, onUnauthorized }: {
  apiUrl: string;
  token: string;
  revision: string;
  onUnauthorized: (message: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setError('');
    setHistory(null);
    async function load() {
      try {
        const response = await fetch(`${apiUrl}/api/interpreter/history?page=${page}&pageSize=20`, {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (!current) return;
        if (response.status === 401 || response.status === 403) {
          unauthorizedRef.current('Interpreter session expired or access revoked. Sign in again.');
          return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load call history.');
        if (!Array.isArray(data.calls) || !Number.isInteger(data.totalPages) || !Number.isInteger(data.total)) {
          throw new Error('Unable to load call history.');
        }
        if (!current) return;
        if (page > Math.max(1, data.totalPages)) { setPage(Math.max(1, data.totalPages)); return; }
        setHistory(data);
      } catch (failure) {
        if (current) setError(controller.signal.aborted ? 'Loading timed out. Please retry.'
          : failure instanceof Error ? failure.message : 'Unable to load call history.');
      } finally {
        clearTimeout(timeout);
        if (current) setLoading(false);
      }
    }
    void load();
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [apiUrl, token, page, refresh, revision]);

  return (
    <section id="call-history" className="panel-card" aria-labelledby="history-heading" aria-busy={loading}>
      <div className="history-heading">
        <div className="section-heading">
          <span className="section-kicker">Your activity</span>
          <h2 id="history-heading">Call history</h2>
          <p>Your calls and their saved reports, newest first.</p>
        </div>
        <button className="ghost-button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh history</button>
      </div>
      {loading && <p role="status">Loading call history…</p>}
      {error && <div><p className="error-banner" role="alert">{error}</p>
        <button className="ghost-button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div>}
      {history && <>
        <p role="status">{history.total} call{history.total === 1 ? '' : 's'}</p>
        {history.calls.length === 0 && <p>No calls recorded for your account yet.</p>}
        <div className="history-list">
          {history.calls.map(call => (
            <article className="history-call" key={call.callId}>
              <div className="history-heading">
                <div><h3>{call.guestName} · Room {call.roomNumber}</h3><p>{date(call.requestedAt)}</p></div>
                <span className={`info-badge ${call.status === 'completed' ? 'tone-green' : call.status === 'rejected' ? 'tone-red' : 'tone-blue'}`}>
                  {call.status}
                </span>
              </div>
              <dl className="history-facts">
                <div><dt>Answered</dt><dd>{date(call.answeredAt)}</dd></div>
                <div><dt>Ended</dt><dd>{date(call.endedAt)}</dd></div>
                <div><dt>Duration</dt><dd>{duration(call)}</dd></div>
                <div><dt>End reason</dt><dd>{call.endReason?.replace(/_/g, ' ') || '—'}</dd></div>
              </dl>
              {call.report ? <details className="history-report">
                <summary>View report · {call.report.forwardedToAslWeb ? 'Delivered to hotel' : 'Delivery pending'}</summary>
                <dl className="history-facts">
                  <div><dt>Submitted</dt><dd>{date(call.report.submittedAt)}</dd></div>
                  <div><dt>Delivered</dt><dd>{date(call.report.forwardedAt)}</dd></div>
                  <div><dt>Priority</dt><dd>{call.report.priority}</dd></div>
                  <div><dt>Category</dt><dd>{call.report.category}</dd></div>
                  <div><dt>Follow-up</dt><dd>{call.report.followUpRequired ? 'Required' : 'Not required'}</dd></div>
                </dl>
                <h4>Summary</h4><p className="history-text">{call.report.summary}</p>
                <h4>Notes</h4><p className="history-text">{call.report.notes || 'No notes.'}</p>
              </details> : <p>{call.answeredAt ? 'Report not submitted yet.' : 'No report: call was not answered.'}</p>}
            </article>
          ))}
        </div>
        {history.totalPages > 1 && <nav className="history-pagination" aria-label="Call history pages">
          <button className="ghost-button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
          <span>Page {page} of {history.totalPages}</span>
          <button className="ghost-button" disabled={page >= history.totalPages} onClick={() => setPage(value => value + 1)}>Next</button>
        </nav>}
      </>}
    </section>
  );
}
