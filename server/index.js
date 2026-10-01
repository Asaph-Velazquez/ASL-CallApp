import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { CallSession, InterpreterPresence, InterpreterReport } from './models/index.js';
import { createInterpreterAuth, createLoginLimiter } from './interpreterAuth.js';

config();

const app = express();
const PORT = Number(process.env.PORT || 3101);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/asl-call';
const CALL_JWT_SECRET = process.env.CALL_JWT_SECRET || 'call-secret';
const INTERPRETER_JWT_SECRET = process.env.INTERPRETER_JWT_SECRET || 'interpreter-secret';
const ASL_WEB_API_URL = process.env.ASL_WEB_API_URL || 'http://localhost:3001';
const CALL_INTERNAL_TOKEN = process.env.CALL_INTERNAL_TOKEN || '';
const REPORT_FORWARD_TIMEOUT_MS = Number(process.env.REPORT_FORWARD_TIMEOUT_MS || 8000);
const interpreterAuth = createInterpreterAuth({ hotelUrl: ASL_WEB_API_URL, internalToken: CALL_INTERNAL_TOKEN, secret: INTERPRETER_JWT_SECRET });
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8080',
  'http://localhost:8081',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081',
];

function parseCsvEnv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTrustProxy(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return ['loopback', 'linklocal', 'uniquelocal'];
  }

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  return parseCsvEnv(normalized);
}

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...parseCsvEnv(process.env.ALLOWED_ORIGINS)])];
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

app.set('trust proxy', TRUST_PROXY);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
app.use('/api/calls/:callId/report', express.json({ limit: '64kb' }));
app.use(express.json({ limit: '25kb' }));

function send(socket, payload) {
  if (socket?.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

function truncateError(error, maxLength = 500) {
  return String(error || 'Unknown error').slice(0, maxLength);
}

function buildForwardHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (CALL_INTERNAL_TOKEN) {
    headers['x-internal-token'] = CALL_INTERNAL_TOKEN;
  }
  return headers;
}

async function verifyInterpreterHttp(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Interpreter token required' });
  }

  try {
    req.user = await interpreterAuth.validate(authHeader.slice(7));
    next();
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message });
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const socketMeta = new WeakMap();
const interpreterSockets = new Map();
const callPeers = new Map();

async function revokeInterpreter(socket, error) {
  const meta = socketMeta.get(socket);
  if (!meta || meta.revoked) return;
  meta.revoked = true;
  if (interpreterSockets.get(meta.userId) === socket) interpreterSockets.delete(meta.userId);
  const unavailable = error.status === 503;
  send(socket, { type: unavailable ? 'AUTH_UNAVAILABLE' : 'AUTH_REVOKED', payload: { message: error.message } });
  socket.close(unavailable ? 1013 : 1008, unavailable ? 'Hotel authentication unavailable' : 'Interpreter access revoked');
  // Notify the guest immediately, even if persistence is temporarily unavailable.
  for (const [callId, peers] of callPeers) {
    if (peers.interpreterSocket !== socket) continue;
    send(peers.guestSocket, { type: 'CALL_ENDED', payload: { callId, endReason: 'interpreter_access_revoked' } });
    try { await finalizeCall(callId, unavailable ? 'authentication_unavailable' : 'interpreter_access_revoked'); }
    catch { callPeers.delete(callId); }
  }
  await setInterpreterPresence(meta.userId, meta.fullName, 'offline', null).catch(() => {});
}

async function validateInterpreterSocket(socket) {
  const meta = socketMeta.get(socket);
  if (!meta || meta.revoked || socket.readyState !== 1) return false;
  if (meta.validation) return meta.validation;
  meta.validation = (async () => {
    try {
      const user = await interpreterAuth.validate(meta.token);
      if (meta.revoked || socket.readyState !== 1) return false;
      Object.assign(meta, user);
      return true;
    } catch (error) {
      await revokeInterpreter(socket, error);
      return false;
    } finally { meta.validation = null; }
  })();
  return meta.validation;
}

setInterval(() => {
  for (const socket of wss.clients) {
    if (socketMeta.get(socket)?.clientType === 'interpreter') void validateInterpreterSocket(socket);
  }
}, 20000).unref();

async function setInterpreterPresence(interpreterId, displayName, availabilityStatus, currentCallId = null) {
  return InterpreterPresence.findOneAndUpdate(
    { interpreterId },
    {
      $set: {
        displayName,
        availabilityStatus,
        currentCallId,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function markCallSession(callId, values) {
  return CallSession.findOneAndUpdate(
    { callId },
    { $set: values },
    { new: true }
  );
}

async function reserveAvailableInterpreter(callId) {
  while (true) {
    const presence = await InterpreterPresence.findOneAndUpdate(
      { availabilityStatus: 'available' },
      {
        $set: {
          availabilityStatus: 'busy',
          currentCallId: callId,
          lastSeenAt: new Date(),
        },
      },
      { new: true, sort: { updatedAt: -1 } }
    ).lean();

    if (!presence) {
      return null;
    }

    const socket = interpreterSockets.get(presence.interpreterId);
    if (socket?.readyState === 1 && await validateInterpreterSocket(socket)) {
      return { presence, socket };
    }

    await setInterpreterPresence(presence.interpreterId, presence.displayName, 'offline', null);
  }
}

async function releaseInterpreter(meta, nextStatus = 'available') {
  if (!meta?.userId) {
    return;
  }

  await setInterpreterPresence(meta.userId, meta.fullName, nextStatus, null);
}

async function finalizeCall(callId, endReason, status = 'completed') {
  if (!callId) {
    return null;
  }

  const peers = callPeers.get(callId);
  const existingSession = await CallSession.findOne({ callId }).lean();
  const interpreterMeta =
    peers?.interpreterMeta?.userId
      ? peers.interpreterMeta
      : existingSession?.interpreterId
        ? { userId: existingSession.interpreterId, fullName: existingSession.interpreterName }
        : null;

  const reportRequired = Boolean(existingSession?.interpreterId && existingSession.reportForwardStatus !== 'forwarded');
  if (interpreterMeta?.userId) {
    const otherPending = await pendingReportFor(interpreterMeta.userId);
    await releaseInterpreter(interpreterMeta, reportRequired || otherPending ? 'busy' : 'available');
  }

  const session = await markCallSession(callId, {
    status,
    endedAt: existingSession?.endedAt || new Date(),
    endReason,
  });

  if (peers) {
    send(peers.guestSocket, { type: 'CALL_ENDED', payload: { callId, endReason, status } });
    send(peers.interpreterSocket, { type: 'CALL_ENDED', payload: { callId, endReason, status, reportRequired } });
    callPeers.delete(callId);
  }

  return session;
}

async function forwardReportToAslWeb(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORT_FORWARD_TIMEOUT_MS);

  try {
    const response = await fetch(`${ASL_WEB_API_URL}/api/calls/internal/interpreter-reports`, {
      method: 'POST',
      headers: buildForwardHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch (_error) {
        responseBody = responseText;
      }
    }

    if (!response.ok) {
      const errorMessage = typeof responseBody === 'string' ? responseBody : responseBody?.error || `ASL-Web responded with ${response.status}`;
      throw new Error(errorMessage);
    }

    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mongoReadyState: mongoose.connection.readyState,
  });
});

app.post('/api/interpreter/login', createLoginLimiter(), async (req, res) => {
  try {
    const interpreter = await interpreterAuth.login({ username: req.body?.username, password: req.body?.password });
    return res.json({
      token: interpreterAuth.issue(interpreter),
      interpreter,
    });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message });
  }
});

async function pendingReportFor(interpreterId) {
  const session = await CallSession.findOne({ interpreterId, status: 'completed', reportForwardStatus: { $ne: 'forwarded' } })
    .sort({ endedAt: 1 }).lean();
  if (!session) return null;
  const report = await InterpreterReport.findOne({ callId: session.callId }).sort({ submittedAt: 1 }).lean();
  return { callId: session.callId, roomNumber: session.roomNumber, guestName: session.guestName, report };
}

app.get('/api/interpreter/session', verifyInterpreterHttp, async (req, res) => {
  try {
    const pendingCall = await pendingReportFor(req.user.userId);
    if (pendingCall) await setInterpreterPresence(req.user.userId, req.user.fullName, 'busy', pendingCall.callId);
    return res.json({
      pendingCall,
      interpreter: {
        userId: req.user.userId,
        username: req.user.username,
        fullName: req.user.fullName,
      },
    });
  } catch {
    return res.status(503).json({ error: 'Unable to recover pending reports' });
  }
});

app.post('/api/interpreter/presence', verifyInterpreterHttp, async (req, res) => {
  try {
    const status = ['available', 'offline', 'busy'].includes(req.body?.availabilityStatus) ? req.body.availabilityStatus : 'offline';
    if (status === 'available' && await pendingReportFor(req.user.userId)) {
      return res.status(409).json({ error: 'Submit the pending interpreter report before receiving another call' });
    }
    const presence = await setInterpreterPresence(
      req.user.userId,
      req.user.fullName,
      status,
      status === 'busy' ? req.body?.currentCallId || null : null
    );
    return res.json({ presence });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to update presence' });
  }
});

app.post('/api/calls/:callId/report', verifyInterpreterHttp, async (req, res) => {
  try {
    const session = await CallSession.findOne({ callId: req.params.callId });
    if (!session) {
      return res.status(404).json({ error: 'Call not found' });
    }

    if (session.interpreterId !== req.user.userId) {
      return res.status(403).json({ error: 'Interpreter does not own this call' });
    }

    if (session.status !== 'completed') {
      return res.status(409).json({ error: 'Call is not ready for report submission' });
    }

    const summary = String(req.body?.summary || '').trim();
    const priority = String(req.body?.priority || '').trim();
    const category = String(req.body?.category || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const followUpRequired = typeof req.body?.followUpRequired === 'boolean' ? req.body.followUpRequired : true;

    if (!summary || !['low', 'medium', 'high', 'urgent'].includes(priority) || !category || (followUpRequired && !notes)
        || summary.length > 4000 || category.length > 120 || notes.length > 8000) {
      return res.status(400).json({ error: 'Missing required report fields' });
    }

    const reportPayload = {
      reportId: `report-${session.callId}`,
      callId: req.params.callId,
      stayId: session.stayId,
      roomNumber: session.roomNumber,
      guestName: session.guestName,
      interpreterId: req.user.userId,
      interpreterName: req.user.fullName,
      summary,
      priority,
      category,
      followUpRequired,
      notes,
      submittedAt: new Date(),
    };

    // Preserve the first saved payload and its identity on retries, including
    // legacy reports that used random IDs. A timeout must not create duplicates.
    const existing = await InterpreterReport.findOne({ callId: session.callId }).sort({ submittedAt: 1 });
    let report = existing;
    if (!report) {
      try {
        report = await InterpreterReport.findOneAndUpdate({ reportId: reportPayload.reportId },
          { $setOnInsert: reportPayload }, { upsert: true, new: true, runValidators: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        report = await InterpreterReport.findOne({ reportId: reportPayload.reportId });
      }
    }
    const savedPayload = report.toObject();
    const now = new Date();

    try {
      const forwarded = await forwardReportToAslWeb(savedPayload);

      await InterpreterReport.updateOne(
        { reportId: report.reportId },
        {
          $set: {
            forwardedToAslWeb: true,
            forwardedAt: now,
            forwardAttemptedAt: now,
            forwardError: null,
          },
        }
      );

      await markCallSession(req.params.callId, {
        status: 'completed',
        endedAt: session.endedAt || now,
        endReason: report.followUpRequired ? 'specialized_followup_required' : 'completed',
        reportForwardStatus: 'forwarded',
        reportForwardedAt: now,
        reportForwardError: null,
        interpreterId: req.user.userId,
        interpreterName: req.user.fullName,
      });

      const pendingCall = await pendingReportFor(req.user.userId);
      // A delayed duplicate receipt must not release a different, newer call.
      await InterpreterPresence.updateOne({
        interpreterId: req.user.userId,
        $or: [{ currentCallId: null }, { currentCallId: session.callId }],
      }, { $set: {
        availabilityStatus: pendingCall ? 'busy' : 'available',
        currentCallId: pendingCall?.callId || null,
        lastSeenAt: now,
      } });

      return res.status(201).json({
        report: {
          ...report.toObject(),
          forwardedToAslWeb: true,
          forwardedAt: now,
          forwardAttemptedAt: now,
          forwardError: null,
        },
        forwarded,
        pendingCall,
      });
    } catch (error) {
      const forwardError = truncateError(error instanceof Error ? error.message : error);

      await InterpreterReport.updateOne(
        { reportId: report.reportId, forwardedToAslWeb: { $ne: true } },
        {
          $set: {
            forwardedToAslWeb: false,
            forwardAttemptedAt: now,
            forwardedAt: null,
            forwardError,
          },
        }
      );

      await CallSession.updateOne({ callId: session.callId, reportForwardStatus: { $ne: 'forwarded' } }, {
        $set: { reportForwardStatus: 'failed', reportForwardError: forwardError },
      });

      return res.status(502).json({
        error: 'Report stored locally but forwarding to ASL-Web failed',
        details: forwardError,
        reportId: report.reportId,
        report: report.toObject(),
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to submit report' });
  }
});

wss.on('connection', (socket) => {
  const meta = socketMeta.get(socket);
  if (meta?.clientType === 'interpreter') {
    interpreterSockets.set(meta.userId, socket);
  }

  socket.on('message', async (raw) => {
    const currentMeta = socketMeta.get(socket);
    let message;
    let reservation = null;
    let ownsRequest = false;
    try {
      message = JSON.parse(raw.toString());
      if (!currentMeta) {
        return;
      }
      if (currentMeta.clientType === 'interpreter' && !await validateInterpreterSocket(socket)) return;

      if (currentMeta.clientType === 'guest' && message.type === 'CALL_REQUEST') {
        if (currentMeta.requestPending) return;
        currentMeta.requestPending = true;
        ownsRequest = true;
        const existingPeers = callPeers.get(currentMeta.callId);
        if (existingPeers?.guestSocket === socket) {
          send(socket, { type: 'CALL_PENDING', payload: { callId: currentMeta.callId } });
          return;
        }

        const available = await reserveAvailableInterpreter(currentMeta.callId);
        reservation = available;
        const now = new Date();

        await CallSession.findOneAndUpdate(
          { callId: currentMeta.callId },
          {
            $setOnInsert: {
              callId: currentMeta.callId,
              requestedAt: now,
            },
            $set: {
              stayId: currentMeta.stayId,
              roomNumber: currentMeta.roomNumber,
              guestName: currentMeta.guestName,
              status: available ? 'ringing' : 'unavailable',
              endedAt: available ? null : now,
              endReason: available ? null : 'no_interpreter_available',
              answeredAt: null,
              reportForwardStatus: 'pending',
              reportForwardedAt: null,
              reportForwardError: null,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (!available) {
          send(socket, { type: 'CALL_UNAVAILABLE', payload: { callId: currentMeta.callId, reason: 'no_interpreter_available' } });
          return;
        }

        callPeers.set(currentMeta.callId, {
          guestSocket: socket,
          guestMeta: currentMeta,
          interpreterSocket: available.socket,
          interpreterMeta: { userId: available.presence.interpreterId, fullName: available.presence.displayName },
        });

        send(socket, { type: 'CALL_PENDING', payload: { callId: currentMeta.callId } });
        send(available.socket, {
          type: 'CALL_REQUEST',
          payload: {
            callId: currentMeta.callId,
            roomNumber: currentMeta.roomNumber,
            guestName: currentMeta.guestName,
            stayId: currentMeta.stayId,
          },
        });
        return;
      }

      if (currentMeta.clientType === 'interpreter' && message.type === 'CALL_ACCEPTED') {
        const callId = message.payload?.callId;
        const peers = callPeers.get(callId);
        if (!peers || peers.interpreterSocket !== socket) {
          return;
        }

        await setInterpreterPresence(currentMeta.userId, currentMeta.fullName, 'busy', callId);
        await markCallSession(callId, {
          interpreterId: currentMeta.userId,
          interpreterName: currentMeta.fullName,
          status: 'active',
          answeredAt: new Date(),
          endedAt: null,
          endReason: null,
        });

        peers.interpreterSocket = socket;
        peers.interpreterMeta = currentMeta;
        send(peers.guestSocket, { type: 'CALL_ACCEPTED', payload: { callId, interpreterName: currentMeta.fullName } });
        return;
      }

      if (currentMeta.clientType === 'interpreter' && message.type === 'CALL_REJECTED') {
        const callId = message.payload?.callId;
        const peers = callPeers.get(callId);
        if (!peers || peers.interpreterSocket !== socket) {
          return;
        }

        await releaseInterpreter(currentMeta, 'available');
        await markCallSession(callId, {
          interpreterId: currentMeta.userId,
          interpreterName: currentMeta.fullName,
          status: 'rejected',
          endedAt: new Date(),
          endReason: 'interpreter_rejected',
        });
        send(peers.guestSocket, { type: 'CALL_REJECTED', payload: { callId } });
        callPeers.delete(callId);
        return;
      }

      if (['WEBRTC_OFFER', 'WEBRTC_ANSWER', 'WEBRTC_ICE_CANDIDATE'].includes(message.type)) {
        const peers = callPeers.get(message.payload?.callId);
        const isExpectedPeer = currentMeta.clientType === 'guest'
          ? peers?.guestSocket === socket
          : peers?.interpreterSocket === socket;
        if (!isExpectedPeer) {
          return;
        }

        send(currentMeta.clientType === 'guest' ? peers.interpreterSocket : peers.guestSocket, message);
        return;
      }

      if (message.type === 'CALL_ENDED') {
        const peers = callPeers.get(message.payload?.callId);
        if (!peers || (peers.guestSocket !== socket && peers.interpreterSocket !== socket)) return;
        await finalizeCall(message.payload?.callId, message.payload?.reason || 'completed', 'completed');
      }
    } catch (error) {
      // Never leave a guest waiting without an acknowledgement or strand the
      // interpreter in busy when persistence fails before delivering the call.
      if (reservation && !callPeers.has(currentMeta.callId)) {
        try {
          await InterpreterPresence.updateOne(
            { interpreterId: reservation.presence.interpreterId, currentCallId: currentMeta.callId },
            { $set: { availabilityStatus: reservation.socket.readyState === 1 ? 'available' : 'offline',
              currentCallId: null, lastSeenAt: new Date() } }
          );
        } catch (releaseError) {
          console.error('CALL_RESERVATION_RELEASE_FAILED', { callId: currentMeta.callId, error: releaseError.name });
        }
      }
      console.error('CALL_MESSAGE_FAILED', {
        type: message?.type, callId: currentMeta?.callId || message?.payload?.callId,
        error: error.name, code: error.code,
      });
      send(socket, { type: 'CALL_ERROR', payload: {
        callId: currentMeta?.callId || message?.payload?.callId,
        reason: 'call_processing_failed',
      } });
    } finally {
      if (ownsRequest) currentMeta.requestPending = false;
    }
  });

  socket.on('close', async () => {
    const currentMeta = socketMeta.get(socket);
    if (!currentMeta || currentMeta.revoked) {
      return;
    }

    if (currentMeta.clientType === 'interpreter' && interpreterSockets.get(currentMeta.userId) === socket) {
      interpreterSockets.delete(currentMeta.userId);
      const activePeer = [...callPeers.values()].find((entry) => entry.interpreterSocket === socket);
      const nextStatus = activePeer ? 'busy' : 'offline';
      await setInterpreterPresence(currentMeta.userId, currentMeta.fullName, nextStatus, activePeer?.guestMeta?.callId || null);
    }

    for (const [callId, peers] of callPeers.entries()) {
      if (peers.guestSocket === socket || peers.interpreterSocket === socket) {
        await finalizeCall(callId, 'network_error', 'completed');
      }
    }
  });
});

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/calls') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let meta = null;
    try {
      const guestDecoded = jwt.verify(token, CALL_JWT_SECRET);
      if (guestDecoded.scope === 'call') {
        meta = {
          clientType: 'guest',
          callId: guestDecoded.callId,
          stayId: guestDecoded.stayId,
          roomNumber: guestDecoded.roomNumber,
          guestName: guestDecoded.guestName,
        };
      }
    } catch (_error) {
    }

    if (!meta) {
      try {
        const interpreterDecoded = await interpreterAuth.validate(token);
        meta = {
          clientType: 'interpreter',
          token,
          userId: interpreterDecoded.userId,
          username: interpreterDecoded.username,
          fullName: interpreterDecoded.fullName,
        };
      } catch (error) {
        socket.write(error.status === 503 ? 'HTTP/1.1 503 Service Unavailable\r\n\r\n' : 'HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      socketMeta.set(ws, meta);
      wss.emit('connection', ws, request);
    });
  } catch (_error) {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('ASL-CallAPP MongoDB connected');

    server.listen(PORT, () => {
      console.log(`ASL-CallAPP server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('ASL-CallAPP startup error', error);
    process.exit(1);
  }
}

start();
