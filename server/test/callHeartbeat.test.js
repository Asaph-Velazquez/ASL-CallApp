import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startCallHeartbeat } from '../callHeartbeat.js';

test('CPM_MOV_042: a silent connection terminates within twenty seconds; healthy peers remain connected', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const wss = new EventEmitter();
  wss.clients = new Set();
  startCallHeartbeat(wss);
  function connect() {
    const socket = new EventEmitter();
    Object.assign(socket, { readyState: 1, pings: 0, ended: false,
      ping() { this.pings++; }, terminate() { this.ended = true; this.readyState = 3; } });
    wss.clients.add(socket);
    wss.emit('connection', socket);
    return socket;
  }
  const lost = connect(), healthy = connect();
  t.mock.timers.tick(10000);
  assert.equal(lost.pings, 1);
  assert.equal(lost.ended, false);
  healthy.emit('pong');
  t.mock.timers.tick(10000);
  assert.equal(lost.ended, true);
  assert.equal(healthy.ended, false);
  assert.equal(healthy.pings, 2);
  healthy.emit('pong');
  wss.emit('close');
  t.mock.timers.tick(30000);
  assert.equal(healthy.pings, 2);
});
