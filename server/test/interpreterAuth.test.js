import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLoginLimiter } from '../interpreterAuth.js';

function attempt(limiter, ip, status) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.set = () => res;
  let passed = false;
  limiter({ ip }, res, () => { passed = true; });
  if (passed && status) { res.statusCode = status; res.emit('finish'); }
  return { passed, res };
}

test('login limiter counts failures and concurrent attempts, isolates IPs, releases successes and outages', () => {
  const limiter = createLoginLimiter();
  for (let i = 0; i < 8; i++) {
    assert.equal(attempt(limiter, 'qa-a', 200).passed, true);
    assert.equal(attempt(limiter, 'qa-a', 503).passed, true);
  }
  for (let i = 0; i < 5; i++) assert.equal(attempt(limiter, 'qa-a', 401).passed, true);
  assert.equal(attempt(limiter, 'qa-a', 401).res.statusCode, 429);
  assert.equal(attempt(limiter, 'qa-b', 200).passed, true);
  for (let i = 0; i < 5; i++) assert.equal(attempt(limiter, 'qa-concurrent').passed, true);
  assert.equal(attempt(limiter, 'qa-concurrent').res.statusCode, 429);
});
