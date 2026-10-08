const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(fetcher) {
  let index = 0;
  const slots = [], effects = [], cleanups = [], requests = [], revoked = [];
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(current) { const i = index++; return slots[i] ||= { current }; },
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || deps.some((value, n) => value !== slots[i][n])) {
        effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); });
      }
      slots[i] = deps;
    },
  };
  const runtime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const source = fs.readFileSync(path.join(__dirname, '../src/CallHistory.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'fetch', code)(module, module.exports,
    name => name === 'react' ? react : runtime, (url, options) => {
      requests.push({ url, options });
      return fetcher(url, options);
    });
  function render() {
    index = 0;
    const tree = module.exports.default({ apiUrl: 'https://hotel.example', token: 'test-token', revision: 'idle', onUnauthorized: message => revoked.push(message) });
    effects.splice(0).forEach(effect => effect());
    return tree;
  }
  return { render, requests, revoked, close: () => cleanups.forEach(fn => fn?.()) };
}
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const empty = { calls: [], page: 1, total: 0, totalPages: 0 };
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...Object.values(tree).flatMap(value => nodes(value, type))];
}

test('history loads empty state with bearer authentication', async t => {
  const app = harness(async () => response(empty)); t.after(app.close);
  assert.match(JSON.stringify(app.render()), /Loading call history/);
  await flush();
  assert.match(JSON.stringify(app.render()), /No calls recorded/);
  assert.equal(app.requests[0].options.headers.Authorization, 'Bearer test-token');
});

test('history shows report content and fetches subsequent pages', async t => {
  const call = { callId: 'one', guestName: 'Guest', roomNumber: '15', status: 'completed',
    requestedAt: '2026-10-08T12:00:00Z', answeredAt: '2026-10-08T12:01:00Z', endedAt: '2026-10-08T12:02:30Z',
    report: { summary: 'Service summary', notes: 'Follow-up notes', category: 'services', priority: 'high', followUpRequired: true, forwardedToAslWeb: true } };
  const app = harness(async url => response({ calls: [call], total: 21, totalPages: 2, page: url.includes('page=2') ? 2 : 1 }));
  t.after(app.close); app.render(); await flush();
  const tree = app.render();
  assert.equal(nodes(tree, 'details').length, 1);
  for (const text of ['Service summary', 'Follow-up notes', 'Delivered to hotel', '1m 30s']) {
    assert.ok(JSON.stringify(tree).includes(text));
  }
  nodes(tree, 'button').find(button => button.props.children === 'Next').props.onClick();
  app.render(); await flush();
  assert.match(app.requests[1].url, /page=2/);
});

test('revoked sessions notify the console instead of displaying history', async t => {
  const app = harness(async () => response({ error: 'Revoked' }, 401)); t.after(app.close);
  app.render(); await flush();
  assert.equal(app.revoked.length, 1);
  assert.match(app.revoked[0], /access revoked/);
  assert.equal(nodes(app.render(), 'article').length, 0);
});

test('temporary server failures expose a retry and recover without clearing the session', async t => {
  let count = 0;
  const app = harness(async () => ++count === 1 ? response({ error: 'Hotel unavailable' }, 503) : response(empty));
  t.after(app.close); app.render(); await flush();
  const tree = app.render();
  assert.match(JSON.stringify(tree), /Hotel unavailable/);
  assert.equal(app.revoked.length, 0);
  nodes(tree, 'button').find(button => button.props.children === 'Retry').props.onClick();
  app.render(); await flush();
  assert.match(JSON.stringify(app.render()), /No calls recorded/);
});

test('leaving history aborts requests and ignores a late unauthorized response', async () => {
  let resolve;
  const app = harness(() => new Promise(done => { resolve = done; }));
  app.render(); app.close();
  assert.equal(app.requests[0].options.signal.aborted, true);
  resolve(response({ error: 'Expired' }, 401)); await flush();
  assert.equal(app.revoked.length, 0);
});
