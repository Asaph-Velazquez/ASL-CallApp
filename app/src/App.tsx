import { FormEvent, ReactNode, SVGProps, useEffect, useMemo, useRef, useState } from 'react';
import CameraOptions from './CameraOptions';
import { replaceCamera } from './camera';

const API_URL = import.meta.env.VITE_CALL_API_URL || 'http://localhost:3101';
const WS_URL = import.meta.env.VITE_CALL_WS_URL || 'ws://localhost:3101/calls';

type CallState = 'idle' | 'available' | 'incoming' | 'active' | 'report';
type IncomingCall = { callId: string; roomNumber: string; guestName: string; stayId?: string } | null;
type MediaState = 'idle' | 'preparing' | 'ready' | 'connecting' | 'connected' | 'error';
type SignalingMessage = {
  type: 'WEBRTC_OFFER' | 'WEBRTC_ANSWER' | 'WEBRTC_ICE_CANDIDATE';
  payload?: {
    callId?: string;
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  };
};

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

function MicIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </IconBase>
  );
}

function MicOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="m3 3 18 18" />
      <path d="M9 9v2a3 3 0 0 0 5.1 2.1" />
      <path d="M15 7V6a3 3 0 0 0-5.7-1.3" />
      <path d="M19 10v1a7 7 0 0 1-12.7 4" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </IconBase>
  );
}

function CameraOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="m3 3 18 18" />
      <path d="M10.7 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8" />
      <path d="m16 10 5-3v10l-5-3" />
      <path d="M16 16.5V8.8" />
    </IconBase>
  );
}

function clsx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function decodeJwtPayload(token: string) {
  try {
    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }

    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (_error) {
    return null;
  }
}

function getStoredInterpreterToken() {
  const storedToken = localStorage.getItem('interpreter_token');
  if (!storedToken) {
    return null;
  }

  const payload = decodeJwtPayload(storedToken);
  const expiresAt = typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    localStorage.removeItem('interpreter_token');
    localStorage.removeItem('interpreter_profile');
    return null;
  }

  return storedToken;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => getStoredInterpreterToken());
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
  const [reportStored, setReportStored] = useState(false);
  const [submittingReport, setSubmittingReport] = useState(false);
  const submittingReportRef = useRef(false);
  const [cameraId, setCameraId] = useState('');
  const cameraIdRef = useRef('');
  const [switchingCamera, setSwitchingCamera] = useState(false);
  const switchingCameraRef = useRef(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('Disconnected');
  const [mediaState, setMediaState] = useState<MediaState>('idle');
  const [remotePlaybackBlocked, setRemotePlaybackBlocked] = useState(false);
  const [mediaMessage, setMediaMessage] = useState('Local camera and microphone are offline.');
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [isCameraEnabled, setIsCameraEnabled] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const mediaGenerationRef = useRef(0);
  const mediaPendingRef = useRef<Promise<void> | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const makingOfferRef = useRef(false);
  const validatingTokenRef = useRef<string | null>(null);

  function clearSession(nextMessage = 'Disconnected', nextError = '') {
    activeCallIdRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    localStorage.removeItem('interpreter_token');
    localStorage.removeItem('interpreter_profile');
    setToken(null);
    setProfile(null);
    setIncomingCall(null);
    setActiveCallId(null);
    setError(nextError);
    resetMediaSession();
    setCallState('idle');
    setStatusMessage(nextMessage);
  }

  async function handleUnauthorized(message = 'Interpreter session expired. Sign in again.') {
    clearSession('Disconnected', message);
  }

  function stopMediaTracks(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  function attachStream(element: HTMLVideoElement | null, stream: MediaStream | null) {
    if (element) {
      if (element.srcObject !== stream) element.srcObject = stream;
    }
  }

  async function playRemoteMedia() {
    const element = remoteVideoRef.current;
    const stream = remoteStreamRef.current;
    if (!element || !stream || !stream.getTracks().length) return;
    const generation = mediaGenerationRef.current;
    attachStream(element, stream);
    element.muted = false;
    try {
      await element.play();
      if (generation === mediaGenerationRef.current) setRemotePlaybackBlocked(false);
    } catch (cause) {
      if (generation !== mediaGenerationRef.current) return;
      if (cause instanceof Error && cause.name === 'NotAllowedError') setRemotePlaybackBlocked(true);
    }
  }

  function resetMediaSession() {
    setRemotePlaybackBlocked(false);
    mediaGenerationRef.current += 1;
    mediaPendingRef.current = null;
    pendingIceRef.current = [];
    makingOfferRef.current = false;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    stopMediaTracks(localStreamRef.current);
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    attachStream(localVideoRef.current, null);
    attachStream(remoteVideoRef.current, null);
    setMediaState('idle');
    setMediaMessage('Local camera and microphone are offline.');
    setIsMicEnabled(true);
    setIsCameraEnabled(true);
  }

  async function ensurePeerConnection(callId: string) {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;
    attachStream(remoteVideoRef.current, remoteStream);

    connection.ontrack = (event) => {
      const tracks = [event.track, ...event.streams.flatMap(stream => stream.getTracks())];
      tracks.forEach((track) => {
        if (!remoteStream.getTrackById(track.id)) remoteStream.addTrack(track);
      });
      void playRemoteMedia();
      setMediaState('connected');
      setMediaMessage(remoteStream.getVideoTracks().length ? 'Guest video track received.' : 'Guest audio track received. Waiting for video...');
    };

    connection.onicecandidate = (event) => {
      if (!event.candidate || activeCallIdRef.current !== callId || wsRef.current?.readyState !== WebSocket.OPEN) {
        return;
      }
      wsRef.current?.send(JSON.stringify({
        type: 'WEBRTC_ICE_CANDIDATE',
        payload: { callId, candidate: event.candidate.toJSON() },
      }));
    };

    connection.onconnectionstatechange = () => {
      switch (connection.connectionState) {
        case 'connected':
          setMediaState('connected');
          setMediaMessage('Secure media channel established.');
          break;
        case 'connecting':
          setMediaState('connecting');
          setMediaMessage('Negotiating guest media stream...');
          break;
        case 'failed':
          setMediaState('error');
          setMediaMessage('Media connection failed. Retry camera or wait for guest reconnection.');
          break;
        case 'disconnected':
          setMediaState('connecting');
          setMediaMessage('Media disconnected. Waiting for reconnection...');
          break;
        default:
          break;
      }
    };

    connection.onnegotiationneeded = async () => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN ||
          activeCallIdRef.current !== callId || connection.signalingState !== 'stable') {
        return;
      }
      try {
        makingOfferRef.current = true;
        setMediaState('connecting');
        setMediaMessage('Sending local offer to guest...');
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        wsRef.current.send(JSON.stringify({
          type: 'WEBRTC_OFFER',
          payload: { callId, sdp: connection.localDescription },
        }));
      } catch (_error) {
        setMediaState('error');
        setMediaMessage('Unable to create the media offer for this session.');
      } finally {
        makingOfferRef.current = false;
      }
    };

    peerConnectionRef.current = connection;
    return connection;
  }

  function prepareLocalMedia(callId: string): Promise<void> {
    if (mediaPendingRef.current) return mediaPendingRef.current;
    const pending = captureLocalMedia(callId);
    mediaPendingRef.current = pending;
    void pending.finally(() => {
      if (mediaPendingRef.current === pending) mediaPendingRef.current = null;
    });
    return pending;
  }

  async function captureLocalMedia(callId: string) {
    const generation = mediaGenerationRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaState('error');
      setMediaMessage(window.isSecureContext
        ? 'This browser does not support camera and microphone capture.'
        : 'Camera access requires HTTPS or http://localhost. Open the console using a secure address.');
      return;
    }

    try {
      setMediaState('preparing');
      setMediaMessage('Requesting access to camera and microphone...');

      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraIdRef.current ? { deviceId: { exact: cameraIdRef.current } } : { facingMode: 'user' },
        audio: true,
      });

      if (generation !== mediaGenerationRef.current || activeCallIdRef.current !== callId) {
        stopMediaTracks(stream);
        return;
      }
      stopMediaTracks(localStreamRef.current);
      localStreamRef.current = stream;
      const actualCamera = stream.getVideoTracks()[0]?.getSettings?.().deviceId || '';
      cameraIdRef.current = actualCamera;
      setCameraId(actualCamera);
      attachStream(localVideoRef.current, stream);
      setIsMicEnabled(stream.getAudioTracks().every((track) => track.enabled));
      setIsCameraEnabled(stream.getVideoTracks().every((track) => track.enabled));

      const connection = await ensurePeerConnection(callId);
      const senders = connection.getSenders();

      await Promise.all(stream.getTracks().map(async (track) => {
        const sender = senders.find((entry) => entry.track?.kind === track.kind);
        if (sender) {
          await sender.replaceTrack(track);
        } else {
          connection.addTrack(track, stream);
        }
      }));

      setMediaState('ready');
      setMediaMessage('Local preview is live. Waiting for guest media negotiation...');
    } catch (mediaError) {
      if (generation !== mediaGenerationRef.current) return;
      stopMediaTracks(localStreamRef.current);
      localStreamRef.current = null;
      attachStream(localVideoRef.current, null);
      setMediaState('error');
      const name = mediaError instanceof Error ? mediaError.name : '';
      setMediaMessage(name === 'NotAllowedError'
        ? 'Allow camera and microphone access in the browser site settings, then retry media.'
        : name === 'NotFoundError'
          ? 'No camera or microphone was found. Connect both devices and retry media.'
          : name === 'NotReadableError'
            ? 'Camera or microphone is unavailable. Close other apps using it and retry media.'
            : mediaError instanceof Error ? mediaError.message : 'Unable to access camera and microphone.');
    }
  }

  async function handleSignalMessage(message: SignalingMessage) {
    const generation = mediaGenerationRef.current;
    const callId = message.payload?.callId;
    if (!callId || callId !== activeCallIdRef.current) {
      return;
    }

    const connection = await ensurePeerConnection(callId);

    try {
      if (message.type === 'WEBRTC_OFFER' && message.payload?.sdp) {
        await connection.setRemoteDescription(message.payload.sdp);
        for (const candidate of pendingIceRef.current.splice(0)) await connection.addIceCandidate(candidate);
        if (!localStreamRef.current) {
          await prepareLocalMedia(callId);
        }
        if (generation !== mediaGenerationRef.current || callId !== activeCallIdRef.current) return;
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        wsRef.current?.send(JSON.stringify({
          type: 'WEBRTC_ANSWER',
          payload: { callId, sdp: connection.localDescription },
        }));
        setMediaState('connecting');
        setMediaMessage('Answer sent. Waiting for remote media...');
      }

      if (message.type === 'WEBRTC_ANSWER' && message.payload?.sdp) {
        await connection.setRemoteDescription(message.payload.sdp);
        for (const candidate of pendingIceRef.current.splice(0)) await connection.addIceCandidate(candidate);
        setMediaState('connecting');
        setMediaMessage('Remote answer received. Finalizing media connection...');
      }

      if (message.type === 'WEBRTC_ICE_CANDIDATE' && message.payload?.candidate) {
        if (connection.remoteDescription) {
          await connection.addIceCandidate(message.payload.candidate);
        } else {
          pendingIceRef.current.push(message.payload.candidate);
        }
      }
    } catch (_error) {
      if (generation !== mediaGenerationRef.current) return;
      setMediaState('error');
      setMediaMessage('WebRTC signaling failed for the current call.');
    }
  }

  async function selectCamera(deviceId: string) {
    if (switchingCameraRef.current || mediaPendingRef.current) return;
    if (!localStreamRef.current) {
      cameraIdRef.current = deviceId;
      setCameraId(deviceId);
      if (activeCallIdRef.current) await prepareLocalMedia(activeCallIdRef.current);
      return;
    }
    switchingCameraRef.current = true;
    setSwitchingCamera(true);
    const generation = mediaGenerationRef.current;
    const stream = localStreamRef.current;
    try {
      await replaceCamera(navigator.mediaDevices, stream, peerConnectionRef.current, deviceId,
        () => generation === mediaGenerationRef.current && localStreamRef.current === stream);
      if (generation !== mediaGenerationRef.current) return;
      cameraIdRef.current = deviceId;
      setCameraId(deviceId);
      attachStream(localVideoRef.current, stream);
      setMediaMessage('Camera changed. Your microphone and call remain connected.');
    } catch (cause) {
      if (generation === mediaGenerationRef.current) setMediaMessage(`Unable to use this camera. ${cause instanceof Error ? cause.message : 'Try another camera.'}`);
    } finally {
      switchingCameraRef.current = false;
      setSwitchingCamera(false);
    }
  }

  function restorePendingCall(pending: IncomingCall & { report?: ReportForm | null }) {
    if (!pending) return;
    setIncomingCall(pending);
    setActiveCallId(pending.callId);
    setReport(pending.report || initialReport);
    setReportStored(Boolean(pending.report));
    setCallState('report');
    setStatusMessage('Pending report recovered. Submit it before receiving another call.');
  }

  useEffect(() => {
    if (!token) return;
    if (validatingTokenRef.current === token) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let signalingQueue = Promise.resolve();

    const verifySessionAndConnect = async () => {
      validatingTokenRef.current = token;
      setStatusMessage('Validating interpreter session...');

      const response = await fetch(`${API_URL}/api/interpreter/session`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (cancelled) {
        return;
      }

      if (response.status === 401 || response.status === 403) {
        await handleUnauthorized();
        return;
      }

      if (!response.ok) {
        setStatusMessage('Unable to validate interpreter session');
        return;
      }

      const data = await response.json();
      if (cancelled) {
        return;
      }

      setProfile(data.interpreter);
      if (data.pendingCall) restorePendingCall(data.pendingCall);

      ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => setStatusMessage('Connected to call server');
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case 'AUTH_REVOKED':
            clearSession('Access revoked', message.payload?.message || 'Interpreter access revoked. Contact the hotel administrator.');
            break;
          case 'AUTH_UNAVAILABLE':
            clearSession('Authentication unavailable', 'The hotel authentication service is unavailable. Please sign in again later.');
            break;
          case 'CALL_REQUEST':
            setReport(initialReport);
            setReportStored(false);
            activeCallIdRef.current = message.payload.callId;
            setIncomingCall(message.payload);
            setActiveCallId(message.payload.callId);
            setCallState('incoming');
            setStatusMessage(`Incoming call from room ${message.payload.roomNumber}`);
            setMediaState('idle');
            setMediaMessage('Local camera and microphone are offline.');
            break;
          case 'CALL_ACCEPTED':
            setCallState('active');
            setStatusMessage('Call accepted');
            break;
          case 'CALL_ERROR':
            setError('The call server could not process the request. End the call and try again.');
            break;
          case 'CALL_ENDED':
            activeCallIdRef.current = null;
            setCallState(message.payload?.reportRequired === false ? 'available' : 'report');
            setStatusMessage(message.payload?.reportRequired === false ? 'Call cancelled before acceptance. Available for calls.' : 'Call ended. Report required.');
            if (message.payload?.reportRequired === false) { setIncomingCall(null); setActiveCallId(null); }
            resetMediaSession();
            break;
          case 'WEBRTC_OFFER':
          case 'WEBRTC_ANSWER':
          case 'WEBRTC_ICE_CANDIDATE':
            signalingQueue = signalingQueue.then(() => {
              if (!cancelled) return handleSignalMessage(message);
            }).catch(() => {
              if (!cancelled) setMediaMessage('Unable to process call signaling. Retry media.');
            });
            break;
          default:
            break;
        }
      };
      ws.onerror = () => setStatusMessage('Unable to connect to call server. Check the gateway URL.');
      ws.onclose = (event) => {
        if (!cancelled) {
          if (event.code === 1008 || event.code === 1013) {
            clearSession('Disconnected', event.code === 1008
              ? 'Interpreter session expired or access revoked. Contact the hotel administrator.'
              : 'Hotel authentication is unavailable. Please sign in again later.');
            return;
          }
          activeCallIdRef.current = null;
          resetMediaSession();
          setStatusMessage('Socket closed. Sign in again to reconnect.');
        }
      };
    };

    void verifySessionAndConnect().catch(() => {
      if (!cancelled) setError('Unable to reach the call server. Check the API URL and Nginx connection.');
    });

    return () => {
      cancelled = true;
      activeCallIdRef.current = null;
      if (validatingTokenRef.current === token) {
        validatingTokenRef.current = null;
      }
      ws?.close();
      wsRef.current = null;
      resetMediaSession();
    };
  }, [token]);

  useEffect(() => {
    attachStream(localVideoRef.current, localStreamRef.current);
  }, [callState]);

  useEffect(() => {
    attachStream(remoteVideoRef.current, remoteStreamRef.current);
    void playRemoteMedia();
  }, [callState]);

  const canSubmitReport = useMemo(() => {
    if (!report.summary.trim() || !report.priority || !report.category.trim()) return false;
    if (report.followUpRequired && !report.notes.trim()) return false;
    return true;
  }, [report]);

  async function updatePresence(availabilityStatus: 'available' | 'offline' | 'busy', currentCallId?: string | null) {
    if (!token) return;
    const response = await fetch(`${API_URL}/api/interpreter/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ availabilityStatus, currentCallId }),
    });

    if (response.status === 401 || response.status === 403) {
      await handleUnauthorized();
      return false;
    }

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Unable to update interpreter presence');
    }
    return true;
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
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
    } catch {
      setError('Unable to reach the authentication service. Please try again later.');
    }
  }

  async function handleAvailability() {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setError('Wait for the call server connection before going available. If disconnected, sign in again.');
      return;
    }
    setError('');
    try {
      if (!await updatePresence('available')) return;
      setCallState('available');
      setStatusMessage('Available for calls');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update availability.');
    }
  }

  async function handleReject() {
    wsRef.current?.send(JSON.stringify({ type: 'CALL_REJECTED', payload: { callId: activeCallId } }));
    if (!await updatePresence('available')) return;
    resetMediaSession();
    activeCallIdRef.current = null;
    setIncomingCall(null);
    setActiveCallId(null);
    setCallState('available');
  }

  async function handleAccept() {
    if (!activeCallId || mediaPendingRef.current) {
      return;
    }
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setError('The call server is disconnected. Sign in again before accepting a call.');
      return;
    }
    setError('');
    activeCallIdRef.current = activeCallId;
    wsRef.current?.send(JSON.stringify({ type: 'CALL_ACCEPTED', payload: { callId: activeCallId } }));
    setCallState('active');
    await prepareLocalMedia(activeCallId);
  }

  function handleEndCall() {
    wsRef.current?.send(JSON.stringify({ type: 'CALL_ENDED', payload: { callId: activeCallId, reason: 'completed' } }));
    resetMediaSession();
    activeCallIdRef.current = null;
    setCallState('report');
  }

  async function handleSubmitReport(event: FormEvent) {
    event.preventDefault();
    if (!token || !activeCallId || !canSubmitReport || submittingReportRef.current) return;
    submittingReportRef.current = true;
    setSubmittingReport(true);
    setError('');
    try {

    const response = await fetch(`${API_URL}/api/calls/${activeCallId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(report),
    });

    if (response.status === 401 || response.status === 403) {
      await handleUnauthorized();
      return;
    }

    const data = await response.json();
    if (!response.ok) {
      if (data.reportId) {
        setReportStored(true);
        if (data.report) setReport(data.report);
      }
      setError(data.reportId
        ? 'Report saved in the call server, but the hotel has not confirmed receipt. Retry delivery; the saved report will not be duplicated.'
        : data.error || 'Unable to submit report');
      return;
    }

    if (data.pendingCall) { restorePendingCall(data.pendingCall); return; }
    setIncomingCall(null);
    setActiveCallId(null);
    setReport(initialReport);
    setReportStored(false);
    resetMediaSession();
    setCallState('available');
    setStatusMessage('Report submitted to ASL-Web');
    } catch {
      setError('Delivery could not be confirmed. Retry this report; the server reuses its saved copy if it already exists.');
    } finally {
      submittingReportRef.current = false;
      setSubmittingReport(false);
    }
  }

  function handleLogout() {
    clearSession('Disconnected');
  }

  function toggleTrack(kind: 'audio' | 'video') {
    const stream = localStreamRef.current;
    if (!stream) {
      if (activeCallIdRef.current) void prepareLocalMedia(activeCallIdRef.current);
      return;
    }

    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    const nextEnabled = !tracks.every((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = nextEnabled;
    });

    if (kind === 'audio') {
      setIsMicEnabled(nextEnabled);
    } else {
      setIsCameraEnabled(nextEnabled);
    }
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
              <div className="action-row">
                <button type="button" onClick={() => toggleTrack('audio')} className="ghost-button">
                  {isMicEnabled ? <MicIcon className="icon-sm" /> : <MicOffIcon className="icon-sm" />}
                  {isMicEnabled ? 'Mute mic' : 'Unmute mic'}
                </button>
                <button type="button" onClick={() => toggleTrack('video')} className="ghost-button">
                  {isCameraEnabled ? <VideoIcon className="icon-sm" /> : <CameraOffIcon className="icon-sm" />}
                  {isCameraEnabled ? 'Stop camera' : 'Start camera'}
                </button>
                <CameraOptions selected={cameraId} busy={switchingCamera || mediaState === 'preparing'} onSelect={selectCamera} />
                <button type="button" disabled={mediaState === 'preparing'} onClick={() => activeCallId && prepareLocalMedia(activeCallId)} className="ghost-button">
                  <WifiIcon className="icon-sm" />
                  Retry media
                </button>
                <button onClick={handleEndCall} className="danger-button">
                  <PhoneOffIcon className="icon-sm" />
                  Finish call
                </button>
              </div>
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
              <div className={clsx('info-badge', mediaState === 'connected' ? 'tone-green' : mediaState === 'error' ? 'tone-red' : 'tone-purple')}>
                <VideoIcon className="icon-sm" />
                {mediaMessage}
              </div>
            </div>

            <div className="media-grid">
              <article className="media-card">
                <div className="media-card-header">
                  <div>
                    <span className="section-kicker text-purple">Interpreter</span>
                    <h3>Local preview</h3>
                  </div>
                  <span className={clsx('info-badge', isCameraEnabled ? 'tone-green' : 'tone-amber')}>
                    {!localStreamRef.current ? 'Camera offline' : isCameraEnabled ? 'Camera live' : 'Camera paused'}
                  </span>
                </div>
                <div className="video-frame">
                  <video ref={localVideoRef} className="video-surface" autoPlay muted playsInline />
                  {!localStreamRef.current && (
                    <div className="video-placeholder">
                      <VideoIcon className="icon-md" />
                      <p>No local media stream</p>
                    </div>
                  )}
                </div>
              </article>

              <article className="media-card">
                <div className="media-card-header">
                  <div>
                    <span className="section-kicker text-blue">Guest</span>
                    <h3>Remote video</h3>
                  </div>
                  <span className={clsx('info-badge', mediaState === 'connected' ? 'tone-green' : mediaState === 'error' ? 'tone-red' : 'tone-blue')}>
                    {mediaState}
                  </span>
                </div>
                <div className="video-frame">
                  <video ref={remoteVideoRef} className="video-surface" autoPlay playsInline controls
                    onLoadedMetadata={() => void playRemoteMedia()} onPlaying={() => setRemotePlaybackBlocked(false)} />
                  {mediaState !== 'connected' && (
                    <div className="video-placeholder">
                      <WifiIcon className="icon-md" />
                      <p>{mediaMessage}</p>
                    </div>
                  )}
                </div>
                {remotePlaybackBlocked && <div role="status">
                  <p>Your browser paused guest audio/video. Enable playback to hear the guest.</p>
                  <button type="button" className="ghost-button" onClick={() => void playRemoteMedia()}>Enable guest audio</button>
                </div>}
              </article>
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

            {reportStored && <p role="status">A saved report is pending hotel confirmation. Retry to send the same report.</p>}
            <form onSubmit={handleSubmitReport}>
              <fieldset className="form-grid report-fields" disabled={submittingReport || reportStored}>
              <label className="field field-wide">
                <span>Summary</span>
                <textarea
                  value={report.summary}
                  maxLength={4000}
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
                  maxLength={120}
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
                  maxLength={8000}
                  onChange={(e) => setReport((current) => ({ ...current, notes: e.target.value }))}
                  placeholder="Operational notes, pending actions, or guest context"
                  rows={5}
                />
              </label>

              </fieldset>
              <button disabled={!canSubmitReport || submittingReport} type="submit" className="primary-button">
                <CheckCircleIcon className="icon-sm" />
                {submittingReport ? 'Sending to hotel...' : reportStored ? 'Retry delivery to hotel' : 'Submit report'}
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
