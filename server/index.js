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
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',').map((item) => item.trim()).filter(Boolean) || ['http://localhost:5173', 'http://localhost:5174'];

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '25kb' }));

mongoose.connect(MONGODB_URI).then(() => {
  console.log('ASL-CallAPP MongoDB connected');
}).catch((error) => {
  console.error('ASL-CallAPP MongoDB connection error', error);
});

async function ensureDefaultInterpreter() {
  const username = process.env.INTERPRETER_DEFAULT_USERNAME || 'interpreter';
  const password = process.env.INTERPRETER_DEFAULT_PASSWORD || 'hotel2026';
  const fullName = process.env.INTERPRETER_DEFAULT_FULL_NAME || 'Hotel Interpreter';
  const existing = await InterpreterUser.findOne({ username });
  if (!existing) {
    await new InterpreterUser({ username, password, fullName }).save();
  }
}

await ensureDefaultInterpreter();

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

function send(socket, payload) {
  if (socket?.readyState === 1) {
    socket.send(JSON.stringify(payload));
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

async function getAvailableInterpreter() {
  const presence = await InterpreterPresence.findOne({ availabilityStatus: 'available' }).sort({ updatedAt: -1 }).lean();
  if (!presence) {
    return null;
  }

  const socket = interpreterSockets.get(presence.interpreterId);
  if (!socket || socket.readyState !== 1) {
    await setInterpreterPresence(presence.interpreterId, presence.displayName, 'offline', null);
    return null;
  }

  return { presence, socket };
}

async function finalizeCall(callId, endReason) {
  const peers = callPeers.get(callId);
  if (!peers) {
    return;
  }

  if (peers.interpreterMeta?.userId) {
    await setInterpreterPresence(peers.interpreterMeta.userId, peers.interpreterMeta.fullName, 'available', null);
  }

  await CallSession.findOneAndUpdate(
    { callId },
    { $set: { status: 'completed', endedAt: new Date(), endReason } },
    { new: true }
  );

  send(peers.guestSocket, { type: 'CALL_ENDED', payload: { callId, endReason } });
  send(peers.interpreterSocket, { type: 'CALL_ENDED', payload: { callId, endReason } });
  callPeers.delete(callId);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
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

app.post('/api/interpreter/presence', verifyInterpreterHttp, async (req, res) => {
  try {
    const status = ['available', 'offline', 'busy'].includes(req.body?.availabilityStatus) ? req.body.availabilityStatus : 'offline';
    const presence = await setInterpreterPresence(req.user.userId, req.user.fullName, status, status === 'busy' ? req.body?.currentCallId || null : null);
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

    const summary = String(req.body?.summary || '').trim();
    const priority = String(req.body?.priority || '').trim();
    const category = String(req.body?.category || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const followUpRequired = typeof req.body?.followUpRequired === 'boolean' ? req.body.followUpRequired : true;

    if (!summary || !priority || !category || (followUpRequired && !notes)) {
      return res.status(400).json({ error: 'Missing required report fields' });
    }

    const reportId = `report-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const report = await InterpreterReport.create({
      reportId,
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
    });

    const forwardResponse = await fetch(`${ASL_WEB_API_URL}/api/calls/internal/interpreter-reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': CALL_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        reportId,
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
        submittedAt: report.submittedAt,
      }),
    });

    if (!forwardResponse.ok) {
      return res.status(502).json({ error: await forwardResponse.text() });
    }

    const forwarded = await forwardResponse.json();
    await CallSession.updateOne(
      { callId: req.params.callId },
      { $set: { status: 'completed', endedAt: new Date(), endReason: followUpRequired ? 'specialized_followup_required' : 'completed' } }
    );

    return res.status(201).json({ report, forwarded });
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
      if (!currentMeta) return;

      if (currentMeta.clientType === 'guest' && message.type === 'CALL_REQUEST') {
        const available = await getAvailableInterpreter();
        await CallSession.findOneAndUpdate(
          { callId: currentMeta.callId },
          {
            $setOnInsert: {
              callId: currentMeta.callId,
              stayId: currentMeta.stayId,
              roomNumber: currentMeta.roomNumber,
              guestName: currentMeta.guestName,
              requestedAt: new Date(),
            },
            $set: { status: available ? 'ringing' : 'unavailable' },
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
        send(available.socket, { type: 'CALL_REQUEST', payload: { callId: currentMeta.callId, roomNumber: currentMeta.roomNumber, guestName: currentMeta.guestName, stayId: currentMeta.stayId } });
        return;
      }

      if (currentMeta.clientType === 'interpreter' && message.type === 'CALL_ACCEPTED') {
        const peers = callPeers.get(message.payload?.callId);
        if (!peers) return;
        await setInterpreterPresence(currentMeta.userId, currentMeta.fullName, 'busy', message.payload.callId);
        await CallSession.updateOne(
          { callId: message.payload.callId },
          { $set: { interpreterId: currentMeta.userId, interpreterName: currentMeta.fullName, status: 'active', answeredAt: new Date() } }
        );
        peers.interpreterSocket = socket;
        peers.interpreterMeta = currentMeta;
        send(peers.guestSocket, { type: 'CALL_ACCEPTED', payload: { callId: message.payload.callId, interpreterName: currentMeta.fullName } });
        return;
      }

      if (currentMeta.clientType === 'interpreter' && message.type === 'CALL_REJECTED') {
        const peers = callPeers.get(message.payload?.callId);
        if (!peers) return;
        await CallSession.updateOne(
          { callId: message.payload.callId },
          { $set: { status: 'rejected', endedAt: new Date(), endReason: 'interpreter_rejected' } }
        );
        send(peers.guestSocket, { type: 'CALL_REJECTED', payload: { callId: message.payload.callId } });
        callPeers.delete(message.payload.callId);
        return;
      }

      if (['WEBRTC_OFFER', 'WEBRTC_ANSWER', 'WEBRTC_ICE_CANDIDATE'].includes(message.type)) {
        const peers = callPeers.get(message.payload?.callId);
        if (!peers) return;
        send(currentMeta.clientType === 'guest' ? peers.interpreterSocket : peers.guestSocket, message);
        return;
      }

      if (message.type === 'CALL_ENDED') {
        await finalizeCall(message.payload?.callId, message.payload?.reason || 'completed');
      }
    } catch (_error) {
    }
  });

  socket.on('close', async () => {
    const currentMeta = socketMeta.get(socket);
    if (!currentMeta) return;

    if (currentMeta.clientType === 'interpreter') {
      interpreterSockets.delete(currentMeta.userId);
      await setInterpreterPresence(currentMeta.userId, currentMeta.fullName, 'offline', null);
    }

    for (const [callId, peers] of callPeers.entries()) {
      if (peers.guestSocket === socket || peers.interpreterSocket === socket) {
        await finalizeCall(callId, 'network_error');
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

server.listen(PORT, () => {
  console.log(`ASL-CallAPP server running on http://localhost:${PORT}`);
});
