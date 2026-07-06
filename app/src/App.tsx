import { FormEvent, ReactNode, SVGProps, useEffect, useMemo, useRef, useState } from 'react';

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

type Tone = 'blue' | 'green' | 'purple' | 'red' | 'amber' | 'teal';

const initialReport: ReportForm = {
  summary: '',
  priority: 'medium',
  category: '',
  followUpRequired: true,
  notes: '',
};

const priorityConfig: Record<ReportForm['priority'], { label: string; tone: Tone }> = {
  low: { label: 'Low', tone: 'green' },
  medium: { label: 'Medium', tone: 'blue' },
  high: { label: 'High', tone: 'amber' },
  urgent: { label: 'Urgent', tone: 'red' },
};

function IconBase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props} />
  );
}

function HandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M8 11V5a1 1 0 1 1 2 0v5" />
      <path d="M12 10V4a1 1 0 1 1 2 0v6" />
      <path d="M16 11V6a1 1 0 1 1 2 0v7" />
      <path d="M6 12.5V9a1 1 0 1 1 2 0v5.5" />
      <path d="M18 13.5l1.5-.8a1.4 1.4 0 0 1 2 1.37V15a7 7 0 0 1-7 7h-2A6.5 6.5 0 0 1 6 15.5V12" />
    </IconBase>
  );
}

function PhoneIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19 19.5 19.5 0 0 1 5 12.8 19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.8L7.6 10a16 16 0 0 0 6.4 6.4l1.5-1.4a2 2 0 0 1 1.8-.6l3 .5A2 2 0 0 1 22 16.9Z" />
    </IconBase>
  );
}

function PhoneOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="m3 3 18 18" />
      <path d="M16.7 13.3l1.8 1.8 1.1-.2a2 2 0 0 1 2.4 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.8 19.8 0 0 1-6.3-6.2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.2 1.1 1.8 1.8" />
    </IconBase>
  );
}

function VideoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </IconBase>
  );
}

function ClipboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </IconBase>
  );
}

function CheckCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.3 2.3L15.8 9.5" />
    </IconBase>
  );
}

function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3 2.7 19a1.3 1.3 0 0 0 1.1 2h16.4a1.3 1.3 0 0 0 1.1-2Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </IconBase>
  );
}

function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </IconBase>
  );
}

function WifiIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M5 13a10 10 0 0 1 14 0" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M12 20h.01" />
      <path d="M2 9a15 15 0 0 1 20 0" />
    </IconBase>
  );
}

function clsx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

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

  const priorityTone = priorityConfig[report.priority].tone;

  return (
    <main className="app-shell">
      <div className="app-grid">
        <section className="hero-card">
          <div className="hero-topbar">
            <div className="brand-lockup">
              <div className="brand-icon">
                <HandIcon className="icon-xl" />
              </div>
              <div>
                <p className="eyebrow">ASL CallAPP</p>
                <h1>Interpreter Console</h1>
                <p className="hero-copy">Real-time workspace aligned with ASL-Web operations and follow-up flow.</p>
              </div>
            </div>
            {profile && (
              <div className="profile-panel">
                <div className="status-pill">
                  <WifiIcon className="icon-sm" />
                  {statusMessage}
                </div>
                <strong>{profile.fullName}</strong>
                <span>@{profile.username}</span>
                <button onClick={handleLogout} className="ghost-button">
                  <LogoutIcon className="icon-sm" />
                  Logout
                </button>
              </div>
            )}
          </div>

          <div className="hero-metrics">
            <StatusCard
              title="Connection"
              value={token ? 'Online' : 'Offline'}
              detail={statusMessage}
              tone={token ? 'green' : 'red'}
              icon={<WifiIcon className="icon-md" />}
            />
            <StatusCard
              title="Call State"
              value={callState === 'idle' ? 'Standby' : callState}
              detail={incomingCall ? `Room ${incomingCall.roomNumber}` : 'No active room'}
              tone={callState === 'active' ? 'purple' : callState === 'incoming' ? 'amber' : 'blue'}
              icon={<PhoneIcon className="icon-md" />}
            />
            <StatusCard
              title="Follow-Up"
              value={report.followUpRequired ? 'Required' : 'Optional'}
              detail="Sends context back into ASL-Web"
              tone={report.followUpRequired ? 'teal' : 'green'}
              icon={<ClipboardIcon className="icon-md" />}
            />
          </div>
        </section>

        {!token && (
          <section className="panel-card">
            <div className="section-heading">
              <span className="section-kicker">Access</span>
              <h2>Interpreter sign in</h2>
              <p>Use the same visual rhythm as the web control panel, with a compact operational login card.</p>
            </div>

            <form onSubmit={handleLogin} className="form-grid">
              <label className="field">
                <span>Username</span>
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
              </label>
              <button type="submit" className="primary-button">
                <CheckCircleIcon className="icon-sm" />
                Login
              </button>
              {error && <p className="error-banner"><AlertIcon className="icon-sm" />{error}</p>}
            </form>
          </section>
        )}

        {token && callState === 'idle' && (
          <StatePanel
            kicker="Availability"
            title="Ready to receive calls"
            copy="Switch to available when you are ready to take the next guest session."
            tone="blue"
            actions={
              <button onClick={handleAvailability} className="primary-button">
                <PhoneIcon className="icon-sm" />
                Go available
              </button>
            }
          />
        )}

        {token && callState === 'available' && (
          <StatePanel
            kicker="Queue"
            title="Waiting for guest call"
            copy="Your hotel assignment is online. This view will change automatically when a request comes in."
            tone="green"
            actions={<div className="info-badge tone-green">Monitoring active line</div>}
          />
        )}

        {token && callState === 'incoming' && incomingCall && (
          <StatePanel
            kicker="Incoming"
            title={`Call from room ${incomingCall.roomNumber}`}
            copy={`Guest ${incomingCall.guestName} is requesting interpretation support.`}
            tone="amber"
            actions={
              <div className="action-row">
                <button onClick={handleAccept} className="primary-button">
                  <PhoneIcon className="icon-sm" />
                  Accept
                </button>
                <button onClick={handleReject} className="danger-button">
                  <PhoneOffIcon className="icon-sm" />
                  Reject
                </button>
              </div>
            }
          >
            <div className="callout-card tone-amber">
              <div className="callout-row">
                <span className="callout-label">Guest</span>
                <strong>{incomingCall.guestName}</strong>
              </div>
              <div className="callout-row">
                <span className="callout-label">Room</span>
                <strong>{incomingCall.roomNumber}</strong>
              </div>
            </div>
          </StatePanel>
        )}

        {token && callState === 'active' && incomingCall && (
          <StatePanel
            kicker="Live Session"
            title="Active interpretation call"
            copy={`Browser signaling is connected for room ${incomingCall.roomNumber}. Keep this console open during the session.`}
            tone="purple"
            actions={
              <button onClick={handleEndCall} className="danger-button">
                <PhoneOffIcon className="icon-sm" />
                Finish call
              </button>
            }
          >
            <div className="live-session-card">
              <div className="live-session-identity">
                <div className="live-session-avatar">
                  <VideoIcon className="icon-md" />
                </div>
                <div>
                  <strong>{incomingCall.guestName}</strong>
                  <p>Room {incomingCall.roomNumber}</p>
                </div>
              </div>
              <div className="info-badge tone-purple">Live interpreting in progress</div>
            </div>
          </StatePanel>
        )}

        {token && callState === 'report' && (
          <section className="panel-card">
            <div className="section-heading">
              <span className="section-kicker">Required Report</span>
              <h2>Mandatory interpreter report</h2>
              <p>This report is pushed back to ASL-Web, so the visual treatment mirrors the operational dashboard states.</p>
            </div>

            <div className="report-summary">
              <div className={clsx('info-badge', `tone-${priorityTone}`)}>
                <AlertIcon className="icon-sm" />
                Priority: {priorityConfig[report.priority].label}
              </div>
              <div className={clsx('info-badge', report.followUpRequired ? 'tone-teal' : 'tone-green')}>
                <ClipboardIcon className="icon-sm" />
                {report.followUpRequired ? 'Follow-up required' : 'No follow-up'}
              </div>
            </div>

            <form onSubmit={handleSubmitReport} className="form-grid">
              <label className="field field-wide">
                <span>Summary</span>
                <textarea
                  value={report.summary}
                  onChange={(e) => setReport((current) => ({ ...current, summary: e.target.value }))}
                  placeholder="Summary of the interpretation session"
                  rows={4}
                />
              </label>

              <label className="field">
                <span>Priority</span>
                <select
                  value={report.priority}
                  onChange={(e) => setReport((current) => ({ ...current, priority: e.target.value as ReportForm['priority'] }))}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>

              <label className="field">
                <span>Category</span>
                <input
                  value={report.category}
                  onChange={(e) => setReport((current) => ({ ...current, category: e.target.value }))}
                  placeholder="Medical, concierge, room issue..."
                />
              </label>

              <label className="checkbox-field field-wide">
                <input
                  type="checkbox"
                  checked={report.followUpRequired}
                  onChange={(e) => setReport((current) => ({ ...current, followUpRequired: e.target.checked }))}
                />
                <span>Follow-up required in ASL-Web</span>
              </label>

              <label className="field field-wide">
                <span>Notes for hotel follow-up</span>
                <textarea
                  value={report.notes}
                  onChange={(e) => setReport((current) => ({ ...current, notes: e.target.value }))}
                  placeholder="Operational notes, pending actions, or guest context"
                  rows={5}
                />
              </label>

              <button disabled={!canSubmitReport} type="submit" className="primary-button">
                <CheckCircleIcon className="icon-sm" />
                Submit report
              </button>
            </form>

            {error && <p className="error-banner"><AlertIcon className="icon-sm" />{error}</p>}
          </section>
        )}
      </div>
    </main>
  );
}

function StatusCard({
  title,
  value,
  detail,
  tone,
  icon,
}: {
  title: string;
  value: string;
  detail: string;
  tone: Tone;
  icon: ReactNode;
}) {
  return (
    <article className="status-card">
      <div className={clsx('status-icon', `tone-${tone}`)}>{icon}</div>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function StatePanel({
  kicker,
  title,
  copy,
  tone,
  actions,
  children,
}: {
  kicker: string;
  title: string;
  copy: string;
  tone: Tone;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <span className={clsx('section-kicker', `text-${tone}`)}>{kicker}</span>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      {children}
      <div className="action-row">{actions}</div>
    </section>
  );
}
