import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

const API_URL = import.meta.env.VITE_CALL_API_URL || 'http://localhost:3101';
const WS_URL = import.meta.env.VITE_CALL_WS_URL || 'ws://localhost:3101/calls';

type CallState = 'idle' | 'available' | 'incoming' | 'active' | 'report';
type IncomingCall = { callId: string; roomNumber: string; guestName: string; stayId?: string } | null;

type ReportForm = {
  summary: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  category: string;
  followUpRequired: boolean;
  notes: string;
};

const initialReport: ReportForm = {
  summary: '',
  priority: 'medium',
  category: '',
  followUpRequired: true,
  notes: '',
};

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('interpreter_token'));
  const [profile, setProfile] = useState<{ userId: string; fullName: string; username: string } | null>(() => {
    const raw = localStorage.getItem('interpreter_profile');
    return raw ? JSON.parse(raw) : null;
  });
  const [username, setUsername] = useState('interpreter');
  const [password, setPassword] = useState('hotel2026');
  const [callState, setCallState] = useState<CallState>('idle');
  const [incomingCall, setIncomingCall] = useState<IncomingCall>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [report, setReport] = useState<ReportForm>(initialReport);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('Disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;

    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => setStatusMessage('Connected to call server');
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      switch (message.type) {
        case 'CALL_REQUEST':
          setIncomingCall(message.payload);
          setActiveCallId(message.payload.callId);
          setCallState('incoming');
          setStatusMessage(`Incoming call from room ${message.payload.roomNumber}`);
          break;
        case 'CALL_ACCEPTED':
          setCallState('active');
          setStatusMessage('Call accepted');
          break;
        case 'CALL_ENDED':
          setCallState('report');
          setStatusMessage('Call ended. Report required.');
          break;
        default:
          break;
      }
    };
    ws.onclose = () => setStatusMessage('Socket closed');

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [token]);

  const canSubmitReport = useMemo(() => {
    if (!report.summary || !report.priority || !report.category) return false;
    if (report.followUpRequired && !report.notes.trim()) return false;
    return true;
  }, [report]);

  async function updatePresence(availabilityStatus: 'available' | 'offline' | 'busy', currentCallId?: string | null) {
    if (!token) return;
    await fetch(`${API_URL}/api/interpreter/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ availabilityStatus, currentCallId }),
    });
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError('');
    const response = await fetch(`${API_URL}/api/interpreter/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Login failed');
      return;
    }

    setToken(data.token);
    setProfile(data.interpreter);
    localStorage.setItem('interpreter_token', data.token);
    localStorage.setItem('interpreter_profile', JSON.stringify(data.interpreter));
    setCallState('idle');
  }

  async function handleAvailability() {
    await updatePresence('available');
    setCallState('available');
    setStatusMessage('Available for calls');
  }

  async function handleReject() {
    wsRef.current?.send(JSON.stringify({ type: 'CALL_REJECTED', payload: { callId: activeCallId } }));
    await updatePresence('available');
    setIncomingCall(null);
    setActiveCallId(null);
    setCallState('available');
  }

  async function handleAccept() {
    wsRef.current?.send(JSON.stringify({ type: 'CALL_ACCEPTED', payload: { callId: activeCallId } }));
    await updatePresence('busy', activeCallId);
    setCallState('active');
  }

  function handleEndCall() {
    wsRef.current?.send(JSON.stringify({ type: 'CALL_ENDED', payload: { callId: activeCallId, reason: 'completed' } }));
    setCallState('report');
  }

  async function handleSubmitReport(event: FormEvent) {
    event.preventDefault();
    if (!token || !activeCallId || !canSubmitReport) return;

    const response = await fetch(`${API_URL}/api/calls/${activeCallId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(report),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Unable to submit report');
      return;
    }

    await updatePresence('available');
    setIncomingCall(null);
    setActiveCallId(null);
    setReport(initialReport);
    setCallState('available');
    setStatusMessage('Report submitted to ASL-Web');
  }

  function handleLogout() {
    localStorage.removeItem('interpreter_token');
    localStorage.removeItem('interpreter_profile');
    setToken(null);
    setProfile(null);
    setIncomingCall(null);
    setActiveCallId(null);
    setCallState('idle');
    setStatusMessage('Disconnected');
  }

  return (
    <main style={{ minHeight: '100vh', padding: 32 }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gap: 24 }}>
        <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div>
              <p style={{ margin: 0, fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--muted)' }}>ASL CallAPP</p>
              <h1 style={{ margin: '8px 0 4px', fontSize: 40 }}>Interpreter Console</h1>
              <p style={{ margin: 0, color: 'var(--muted)' }}>{statusMessage}</p>
            </div>
            {profile && (
              <div style={{ textAlign: 'right' }}>
                <strong>{profile.fullName}</strong>
                <div style={{ color: 'var(--muted)' }}>@{profile.username}</div>
                <button onClick={handleLogout} style={{ marginTop: 12 }}>Logout</button>
              </div>
            )}
          </div>
        </section>

        {!token && (
          <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
            <form onSubmit={handleLogin} style={{ display: 'grid', gap: 16 }}>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)' }} />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)' }} />
              <button type="submit" style={{ padding: 14, borderRadius: 999, border: 0, background: 'var(--accent)', color: 'white' }}>Login</button>
              {error && <p style={{ color: 'var(--accent-2)', margin: 0 }}>{error}</p>}
            </form>
          </section>
        )}

        {token && callState === 'idle' && (
          <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
            <h2>Ready to receive calls</h2>
            <p style={{ color: 'var(--muted)' }}>Mark yourself available to receive guest calls.</p>
            <button onClick={handleAvailability} style={{ padding: '14px 20px', borderRadius: 999, border: 0, background: 'var(--accent)', color: 'white' }}>Go available</button>
          </section>
        )}

        {token && callState === 'available' && (
          <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
            <h2>Waiting for guest call</h2>
            <p style={{ color: 'var(--muted)' }}>Your fixed hotel assignment is online and waiting.</p>
          </section>
        )}

        {token && callState === 'incoming' && incomingCall && (
          <section style={{ background: 'var(--panel-strong)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
            <h2>Incoming call</h2>
            <p>Guest <strong>{incomingCall.guestName}</strong> from room <strong>{incomingCall.roomNumber}</strong>.</p>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={handleAccept} style={{ padding: '12px 18px', borderRadius: 999, border: 0, background: 'var(--accent)', color: 'white' }}>Accept</button>
              <button onClick={handleReject} style={{ padding: '12px 18px', borderRadius: 999, border: '1px solid var(--accent-2)', color: 'var(--accent-2)', background: 'transparent' }}>Reject</button>
            </div>
          </section>
        )}

        {token && callState === 'active' && incomingCall && (
          <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
            <h2>Active call</h2>
            <p style={{ color: 'var(--muted)' }}>Browser signaling is connected for room {incomingCall.roomNumber}. This screen is the interpreter workspace for the live session.</p>
            <div style={{ padding: 20, borderRadius: 20, background: '#efe4cf', marginBottom: 16 }}>
              <strong>{incomingCall.guestName}</strong>
              <div>Room {incomingCall.roomNumber}</div>
            </div>
            <button onClick={handleEndCall} style={{ padding: '14px 20px', borderRadius: 999, border: 0, background: 'var(--accent-2)', color: 'white' }}>Finish call</button>
          </section>
        )}

        {token && callState === 'report' && (
          <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 24, padding: 24 }}>
            <h2>Mandatory interpreter report</h2>
            <form onSubmit={handleSubmitReport} style={{ display: 'grid', gap: 14 }}>
              <textarea value={report.summary} onChange={(e) => setReport((current) => ({ ...current, summary: e.target.value }))} placeholder="Summary" rows={4} style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)' }} />
              <select value={report.priority} onChange={(e) => setReport((current) => ({ ...current, priority: e.target.value as ReportForm['priority'] }))} style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)' }}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <input value={report.category} onChange={(e) => setReport((current) => ({ ...current, category: e.target.value }))} placeholder="Category" style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)' }} />
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={report.followUpRequired} onChange={(e) => setReport((current) => ({ ...current, followUpRequired: e.target.checked }))} />
                Follow-up required in ASL-Web
              </label>
              <textarea value={report.notes} onChange={(e) => setReport((current) => ({ ...current, notes: e.target.value }))} placeholder="Notes for hotel follow-up" rows={5} style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)' }} />
              <button disabled={!canSubmitReport} type="submit" style={{ padding: '14px 20px', borderRadius: 999, border: 0, background: canSubmitReport ? 'var(--accent)' : '#9ca3af', color: 'white' }}>Submit report</button>
            </form>
            {error && <p style={{ color: 'var(--accent-2)' }}>{error}</p>}
          </section>
        )}
      </div>
    </main>
  );
}
