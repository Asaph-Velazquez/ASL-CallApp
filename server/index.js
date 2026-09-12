import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { CallSession, InterpreterPresence, InterpreterReport, InterpreterUser } from './models/index.js';

config();

const app = express();
const PORT = Number(process.env.PORT || 3101);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/asl-call';
const CALL_JWT_SECRET = process.env.CALL_JWT_SECRET || 'call-secret';
const INTERPRETER_JWT_SECRET = process.env.INTERPRETER_JWT_SECRET || 'interpreter-secret';
const ASL_WEB_API_URL = process.env.ASL_WEB_API_URL || 'http://localhost:3001';
const CALL_INTERNAL_TOKEN = process.env.CALL_INTERNAL_TOKEN || '';
const REPORT_FORWARD_TIMEOUT_MS = Number(process.env.REPORT_FORWARD_TIMEOUT_MS || 8000);
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

async function ensureDefaultInterpreter() {
  const username = process.env.INTERPRETER_DEFAULT_USERNAME || 'interpreter';
  const password = process.env.INTERPRETER_DEFAULT_PASSWORD || 'hotel2026';
  const fullName = process.env.INTERPRETER_DEFAULT_FULL_NAME || 'Hotel Interpreter';
  const existing = await InterpreterUser.findOne({ username });
  if (!existing) {
    await new InterpreterUser({ username, password, fullName }).save();
  }
}

function issueInterpreterToken(user) {
  return jwt.sign(
    {
      userId: String(user._id),
      username: user.username,
      fullName: user.fullName,
      role: 'interpreter',
    },
    INTERPRETER_JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function verifyInterpreterHttp(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Interpreter token required' });
  }

  try {
    req.user = jwt.verify(authHeader.slice(7), INTERPRETER_JWT_SECRET);
    next();
  } catch (_error) {
    return res.status(401).json({ error: 'Invalid interpreter token' });
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const socketMeta = new WeakMap();
const interpreterSockets = new Map();
const callPeers = new Map();

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
    if (socket?.readyState === 1) {
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

  if (interpreterMeta?.userId) {
    await releaseInterpreter(interpreterMeta, 'available');
  }

  const session = await markCallSession(callId, {
    status,
    endedAt: new Date(),
    endReason,
  });

  if (peers) {
    send(peers.guestSocket, { type: 'CALL_ENDED', payload: { callId, endReason, status } });
    send(peers.interpreterSocket, { type: 'CALL_ENDED', payload: { callId, endReason, status } });
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

app.post('/api/interpreter/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const interpreter = await InterpreterUser.findOne({ username });
    if (!interpreter) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await interpreter.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    return res.json({
      token: issueInterpreterToken(interpreter),
      interpreter: {
        userId: String(interpreter._id),
        username: interpreter.username,
        fullName: interpreter.fullName,
      },
    });
  } catch (_error) {
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/interpreter/session', verifyInterpreterHttp, (req, res) => {
  return res.json({
    interpreter: {
      userId: req.user.userId,
      username: req.user.username,
      fullName: req.user.fullName,
    },
  });
});

app.post('/api/interpreter/presence', verifyInterpreterHttp, async (req, res) => {
  try {
    const status = ['available', 'offline', 'busy'].includes(req.body?.availabilityStatus) ? req.body.availabilityStatus : 'offline';
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

    if (session.interpreterId && session.interpreterId !== req.user.userId) {
      return res.status(403).json({ error: 'Interpreter does not own this call' });
    }

    if (!['active', 'completed'].includes(session.status)) {
      return res.status(409).json({ error: 'Call is not ready for report submission' });
    }

    const summary = String(req.body?.summary || '').trim();
    const priority = String(req.body?.priority || '').trim();
    const category = String(req.body?.category || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const followUpRequired = typeof req.body?.followUpRequired === 'boolean' ? req.body.followUpRequired : true;

    if (!summary || !priority || !category || (followUpRequired && !notes)) {
      return res.status(400).json({ error: 'Missing required report fields' });
    }

    const reportPayload = {
      reportId: `report-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
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

    const report = await InterpreterReport.create(reportPayload);
    const now = new Date();

    try {
      const forwarded = await forwardReportToAslWeb(reportPayload);

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
        endedAt: now,
        endReason: followUpRequired ? 'specialized_followup_required' : 'completed',
        reportForwardStatus: 'forwarded',
        reportForwardedAt: now,
        reportForwardError: null,
        interpreterId: req.user.userId,
        interpreterName: req.user.fullName,
      });

      const peers = callPeers.get(req.params.callId);
      if (peers) {
        peers.interpreterMeta = { userId: req.user.userId, fullName: req.user.fullName };
      }
      await finalizeCall(req.params.callId, followUpRequired ? 'specialized_followup_required' : 'completed', 'completed');

      return res.status(201).json({
        report: {
          ...report.toObject(),
          forwardedToAslWeb: true,
          forwardedAt: now,
          forwardAttemptedAt: now,
          forwardError: null,
        },
        forwarded,
      });
    } catch (error) {
      const forwardError = truncateError(error instanceof Error ? error.message : error);

      await InterpreterReport.updateOne(
        { reportId: report.reportId },
        {
          $set: {
            forwardedToAslWeb: false,
            forwardAttemptedAt: now,
            forwardedAt: null,
            forwardError,
          },
        }
      );

      await markCallSession(req.params.callId, {
        reportForwardStatus: 'failed',
        reportForwardError: forwardError,
        interpreterId: req.user.userId,
        interpreterName: req.user.fullName,
      });

      return res.status(502).json({
        error: 'Report stored locally but forwarding to ASL-Web failed',
        details: forwardError,
        reportId: report.reportId,
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
    try {
      const message = JSON.parse(raw.toString());
      const currentMeta = socketMeta.get(socket);
      if (!currentMeta) {
        return;
      }

      if (currentMeta.clientType === 'guest' && message.type === 'CALL_REQUEST') {
        const existingPeers = callPeers.get(currentMeta.callId);
        if (existingPeers?.guestSocket === socket) {
          send(socket, { type: 'CALL_PENDING', payload: { callId: currentMeta.callId } });
          return;
        }

        const available = await reserveAvailableInterpreter(currentMeta.callId);
        const now = new Date();

        await CallSession.findOneAndUpdate(
          { callId: currentMeta.callId },
          {
            $setOnInsert: {
              callId: currentMeta.callId,
              stayId: currentMeta.stayId,
              roomNumber: currentMeta.roomNumber,
              guestName: currentMeta.guestName,
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
        await finalizeCall(message.payload?.callId, message.payload?.reason || 'completed', 'completed');
      }
    } catch (_error) {
    }
  });

  socket.on('close', async () => {
    const currentMeta = socketMeta.get(socket);
    if (!currentMeta) {
      return;
    }

    if (currentMeta.clientType === 'interpreter') {
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

server.on('upgrade', (request, socket, head) => {
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
        const interpreterDecoded = jwt.verify(token, INTERPRETER_JWT_SECRET);
        meta = {
          clientType: 'interpreter',
          userId: interpreterDecoded.userId,
          username: interpreterDecoded.username,
          fullName: interpreterDecoded.fullName,
        };
      } catch (_error) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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
    await ensureDefaultInterpreter();

    server.listen(PORT, () => {
      console.log(`ASL-CallAPP server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('ASL-CallAPP startup error', error);
    process.exit(1);
  }
}

start();
