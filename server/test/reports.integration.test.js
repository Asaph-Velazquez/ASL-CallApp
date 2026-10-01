import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { createInterpreterAuth } from '../interpreterAuth.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real call-to-hotel report bridge, retries, recovery and live dashboard events',
  { skip: process.env.TEST_CALL_MONGO !== '1', timeout: 45000 }, async t => {
    const prefix = `asl_qa_reports_${randomUUID().replaceAll('-', '')}`;
    const dbs = await Promise.all(['call', 'hotel'].map(suffix =>
      mongoose.createConnection(`mongodb://127.0.0.1:27017/${prefix}_${suffix}`, { serverSelectionTimeoutMS: 3000 }).asPromise()));
    const children = [], sockets = [];
    let relay;
    t.after(async () => {
      sockets.forEach(ws => ws.terminate());
      for (const child of children) {
        if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
      }
      if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
      for (const db of dbs) {
        assert.ok([`${prefix}_call`, `${prefix}_hotel`].includes(db.name));
        assert.match(db.name, /^asl_qa_reports_[a-f0-9]{32}_(call|hotel)$/);
        await db.dropDatabase(); await db.close();
      }
    });
    const [callPort, hotelPort] = await Promise.all([freePort(), freePort()]);
    const hotelBase = `http://127.0.0.1:${hotelPort}`, callBase = `http://127.0.0.1:${callPort}`;
    const internalToken = randomUUID(), hotelSecret = randomUUID(), interpreterSecret = randomUUID();
    let loseReply = true;
    relay = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      try {
        const upstream = await fetch(`${hotelBase}${req.url}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-token': internalToken }, body: Buffer.concat(chunks),
        });
        const body = await upstream.text();
        const loseReportReply = loseReply && req.url.includes('/interpreter-reports');
        res.writeHead(loseReportReply ? 503 : upstream.status, { 'Content-Type': 'application/json' });
        res.end(loseReportReply ? JSON.stringify({ error: 'Simulated lost receipt after hotel persisted report' }) : body);
      } catch { res.writeHead(503); res.end('{}'); }
    }).listen(0, '127.0.0.1');
    await once(relay, 'listening');

    async function start(entry, port, env) {
      const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], {
        cwd: mkdtempSync(join(tmpdir(), 'asl-reports-qa-')), windowsHide: true,
        env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let diagnostics = ''; child.stdout.on('data', () => {}); child.stderr.on('data', value => { diagnostics += value; });
      await poll(async () => {
        if (child.exitCode !== null) throw Error(`Server exited: ${diagnostics}`);
        try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
      }, 'server health');
    }
    await start('../../../ASL-Web/server/index.js', hotelPort, {
      MONGODB_URI: `mongodb://127.0.0.1:27017/${prefix}_hotel`, JWT_SECRET: hotelSecret,
      CALL_INTERNAL_TOKEN: internalToken, USE_HTTPS: 'false', CALL_PROXY_TARGET: callBase,
    });
    await start('../index.js', callPort, {
      MONGODB_URI: `mongodb://127.0.0.1:27017/${prefix}_call`, INTERPRETER_JWT_SECRET: interpreterSecret,
      CALL_INTERNAL_TOKEN: internalToken, ASL_WEB_API_URL: `http://127.0.0.1:${relay.address().port}`,
    });
    const operatorId = new mongoose.Types.ObjectId(), otherId = new mongoose.Types.ObjectId(), staffId = new mongoose.Types.ObjectId();
    await dbs[1].collection('staffusers').insertMany([
      { _id: operatorId, username: 'qa-operator', fullName: 'QA Interpreter', role: 'interpreter' },
      { _id: otherId, username: 'qa-other', fullName: 'QA Other', role: 'interpreter' },
      { _id: staffId, username: 'qa-staff', role: 'staff' },
    ]);
    const auth = createInterpreterAuth({ hotelUrl: hotelBase, internalToken, secret: interpreterSecret });
    const interpreter = auth.issue({ userId: String(operatorId), username: 'qa-operator', fullName: 'QA Interpreter' });
    const stranger = auth.issue({ userId: String(otherId), username: 'qa-other', fullName: 'QA Other' });
    const staff = jwt.sign({ userId: String(staffId), role: 'staff' }, hotelSecret);
    const ws = new WebSocket(`${hotelBase.replace('http:', 'ws:')}/ws/hotel?token=${encodeURIComponent(staff)}`);
    sockets.push(ws);
    const events = []; ws.on('message', raw => events.push(JSON.parse(raw.toString())));
    await once(ws, 'open'); await poll(() => events.some(e => e.type === 'INIT_REQUESTS'), 'dashboard initialization');

    async function request(base, route, token, body) {
      const response = await fetch(`${base}${route}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    }
    const callId = 'qa-report-call';
    const endedAt = new Date();
    await dbs[0].collection('callsessions').insertOne({ callId, status: 'completed', interpreterId: String(operatorId),
      interpreterName: 'QA Interpreter', roomNumber: 'QA-15', guestName: 'QA Guest', endedAt, reportForwardStatus: 'pending' });
    const report = { summary: 'Guest requests hotel assistance', category: 'Room issue', priority: 'high', followUpRequired: true, notes: 'Hotel should inspect the room.' };
    assert.equal((await request(callBase, `/api/calls/${callId}/report`, stranger, report)).status, 403);
    assert.equal((await request(callBase, `/api/calls/${callId}/report`, interpreter, { ...report, priority: 'invalid' })).status, 400);
    const failed = await request(callBase, `/api/calls/${callId}/report`, interpreter, report);
    assert.equal(failed.status, 502, JSON.stringify(failed.data));
    await poll(() => events.some(e => e.type === 'INTERPRETER_REPORT_RECEIVED'), 'live report notification');
    const update = await poll(() => events.find(e => e.type === 'NEW_REQUEST' && e.payload.type === 'interpreter-follow-up'), 'live follow-up');
    const requestId = update.payload.requestId;
    assert.equal(update.payload.details.interpreterNotes, report.notes);
    assert.equal(await dbs[0].collection('interpreterreports').countDocuments(), 1);
    const recovered = await request(callBase, '/api/interpreter/session', interpreter);
    assert.equal(recovered.data.pendingCall.report.reportId, failed.data.reportId);
    assert.equal((await request(callBase, '/api/interpreter/presence', interpreter, { availabilityStatus: 'available' })).status, 409);

    // Simulate staff already working before the lost receipt is retried.
    await dbs[1].collection('requests').updateOne({ requestId }, { $set: { status: 'in-progress' }, $inc: { mutationVersion: 1 } });
    loseReply = false;
    const delivered = await request(callBase, `/api/calls/${callId}/report`, interpreter, { ...report, summary: 'Edited retry must not replace saved report' });
    assert.equal(delivered.status, 201, JSON.stringify(delivered.data));
    assert.equal(delivered.data.report.reportId, failed.data.reportId);
    assert.equal(delivered.data.forwarded.report.requestId, requestId);
    assert.equal(delivered.data.pendingCall, null);
    assert.equal(delivered.data.report.summary, report.summary);
    assert.equal((await dbs[0].collection('callsessions').findOne({ callId })).endedAt.getTime(), endedAt.getTime());
    const duplicates = await Promise.all([1, 2].map(() => request(callBase, `/api/calls/${callId}/report`, interpreter, report)));
    assert.ok(duplicates.every(r => r.status === 201));
    assert.equal(await dbs[0].collection('interpreterreports').countDocuments(), 1);
    assert.equal(await dbs[1].collection('interpreterreports').countDocuments(), 1);
    assert.equal(await dbs[1].collection('requests').countDocuments(), 1);
    assert.equal((await dbs[1].collection('requests').findOne({ requestId })).status, 'in-progress');
    const listed = await request(hotelBase, '/api/calls/interpreter-reports', staff);
    assert.equal(listed.data.reports[0].followUpStatus, 'in-progress');
    assert.equal(listed.data.reports[0].requestId, requestId);
    assert.equal((await request(callBase, '/api/interpreter/presence', interpreter, { availabilityStatus: 'available' })).status, 200);

    // A late receipt from an older report must not release a new call reservation.
    await request(callBase, '/api/interpreter/presence', interpreter, { availabilityStatus: 'busy', currentCallId: 'qa-new-active-call' });
    assert.equal((await request(callBase, `/api/calls/${callId}/report`, interpreter, report)).status, 201);
    const stillBusy = await dbs[0].collection('interpreterpresences').findOne({ interpreterId: String(operatorId) });
    assert.equal(stillBusy.currentCallId, 'qa-new-active-call');
    assert.equal(stillBusy.availabilityStatus, 'busy');
    loseReply = true;
    assert.equal((await request(callBase, `/api/calls/${callId}/report`, interpreter, report)).status, 502);
    assert.equal((await dbs[0].collection('callsessions').findOne({ callId })).reportForwardStatus, 'forwarded');
    assert.equal((await dbs[0].collection('interpreterreports').findOne({ callId })).forwardedToAslWeb, true);
    loseReply = false;

    await dbs[0].collection('callsessions').insertOne({ callId: 'qa-no-followup', status: 'completed', interpreterId: String(operatorId),
      roomNumber: 'QA-15', guestName: 'QA Guest', endedAt: new Date() });
    assert.equal((await request(callBase, '/api/calls/qa-no-followup/report', interpreter,
      { ...report, followUpRequired: false, notes: '' })).status, 201);
    assert.equal(await dbs[1].collection('requests').countDocuments(), 1);
    assert.equal(await dbs[1].collection('interpreterreports').countDocuments(), 2);
  });
