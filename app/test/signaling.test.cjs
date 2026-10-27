const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (node.props && predicate(node)) return node;
  for (const child of Object.values(node)) { const match = find(child, predicate); if (match) return match; }
}
const camera = { exports: {} };
const cameraCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/camera.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('exports', cameraCode)(camera.exports);

function harness(session = {}, presenceStatus = 200) {
  const slots = [], effects = [], sockets = [], peers = [], cleanups = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let index = 0, resolveCapture, captures = 0, stopped = 0;
  const capture = new Promise(resolve => { resolveCapture = resolve; });
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { slots[i] = next; }];
    },
    useRef(current) { const i = index++; return slots[i] ||= { current }; },
    useMemo: fn => fn(),
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || deps.some((value, n) => value !== slots[i][n])) effects.push(fn);
      slots[i] = deps;
    },
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    receive(type, payload = {}) { this.onmessage({ data: JSON.stringify({ type, payload: { callId: 'qa-call', ...payload } }) }); }
  }
  class Stream {
    tracks = [];
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
    getTrackById(id) { return this.tracks.find(track => track.id === id); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class Peer {
    signalingState = 'stable';
    remoteDescription = null;
    candidates = [];
    constructor() { peers.push(this); }
    getSenders() { return []; }
    addTrack() {}
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async addIceCandidate(candidate) { assert.ok(this.remoteDescription); this.candidates.push(candidate); }
    close() { this.closed = true; }
  }
  const profile = { userId: 'qa-interpreter', username: 'qa', fullName: 'QA' };
  const token = `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 1000 })).toString('base64url')}.x`;
  const storage = new Map([['interpreter_token', token], ['interpreter_profile', JSON.stringify(profile)]]);
  const localStream = new Stream();
  localStream.addTrack({ id: 'camera', kind: 'video', enabled: true, stop: () => stopped++ });
  const imports = { react, '../assets/Logo/Hotel logo.png': { default: 'hotel-logo.png' }, './CallHistory': { default: 'CallHistory' }, './CameraOptions': { default: 'CameraOptions' }, './camera': camera.exports, 'react/jsx-runtime': {
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
  } };
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'localStorage', 'navigator', 'window', 'fetch', 'WebSocket', 'RTCPeerConnection', 'MediaStream', 'document', 'setTimeout', 'clearTimeout', code)(
    module, module.exports, name => imports[name],
    { getItem: key => storage.get(key) || null, removeItem: key => storage.delete(key) },
    { mediaDevices: { getUserMedia: () => { captures++; return capture; } } }, { isSecureContext: true },
    async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/presence')) {
        return { ok: presenceStatus === 200, status: presenceStatus,
          json: async () => ({ error: 'Unable to update presence' }) };
      }
      return { ok: true, json: async () => ({ interpreter: profile, ...session }) };
    }, Socket, Peer, Stream,
    { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } },
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    id => timers.delete(id),
  );
  function render() {
    index = 0;
    const tree = module.exports.default();
    effects.splice(0).forEach(fn => cleanups.push(fn()));
    return tree;
  }
  function button(label, node = render()) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && JSON.stringify(node.props.children).includes(label)) return node.props.onClick;
    for (const value of Object.values(node)) {
      const found = button(label, value);
      if (found) return found;
    }
  }
  render();
  return { sockets, peers, render, accept: () => button('Accept'), button, requests, localStream, storage,
    timers,
    runTimer(delay) {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay) || [];
      assert.ok(timer, `expected timer at ${delay}ms`);
      timers.delete(id);
      timer.callback();
    },
    cleanup: () => cleanups.forEach(fn => fn?.()),
    resolveCapture: () => resolveCapture(localStream),
    counts: () => ({ captures, stopped }),
};
}

test('connected interpreter must confirm availability before waiting and receiving calls', async () => {
  const h = harness();
  try {
    await flush();
    h.sockets[0].onopen();
    assert.match(JSON.stringify(h.render()), /Connected to call server/);
    assert.doesNotMatch(JSON.stringify(h.render()), /Waiting for guest call/);
    assert.equal(h.requests.filter(r => r.url.endsWith('/presence')).length, 0);
    const available = h.button('Go available');
    assert.equal(typeof available, 'function');
    await available();
    const request = h.requests.find(r => r.url.endsWith('/presence'));
    assert.equal(request.options.method, 'POST');
    assert.match(request.options.headers.Authorization, /^Bearer /);
    assert.equal(JSON.parse(request.options.body).availabilityStatus, 'available');
    assert.match(JSON.stringify(h.render()), /Waiting for guest call/);
    h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA guest', roomNumber: '15' });
    assert.match(JSON.stringify(h.render()), /Call from room 15/);
    assert.equal(typeof h.accept(), 'function');
  } finally { h.cleanup(); }
});

test('failed availability update leaves Go available visible instead of showing the queue', async () => {
  const h = harness({}, 503);
  try {
    await flush();
    h.sockets[0].onopen();
    await h.button('Go available')();
    const tree = JSON.stringify(h.render());
    assert.match(tree, /Unable to update presence/);
    assert.doesNotMatch(tree, /Waiting for guest call/);
    assert.equal(typeof h.button('Go available'), 'function');
  } finally { h.cleanup(); }
});

test('reconnected interpreter confirms availability again after the old socket closes', async () => {
  const h = harness();
  try {
    await flush();
    const socket = h.sockets[0];
    socket.onopen();
    await h.button('Go available')();
    socket.readyState = 3;
    socket.onclose({ code: 1006 });
    h.runTimer(10000);
    await flush();
    h.sockets[1].onopen();
    assert.doesNotMatch(JSON.stringify(h.render()), /Waiting for guest call/);
    assert.equal(typeof h.button('Go available'), 'function');
    await h.button('Go available')();
    assert.match(JSON.stringify(h.render()), /Waiting for guest call/);
    assert.equal(h.requests.filter(r => r.url.endsWith('/presence')).length, 2);
  } finally { h.cleanup(); }
});

test('interpreter sockets reconnect in ten seconds without clearing credentials', async () => {
  const h = harness();
  await flush();
  const socket = h.sockets[0];
  socket.onopen();
  socket.readyState = 3;
  socket.onclose({ code: 1006 });
  assert.equal(h.storage.has('interpreter_token'), true);
  h.runTimer(10000);
  await flush();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onopen();
  assert.equal(h.timers.size, 0);
  h.cleanup();
});

test('revoked interpreter sessions and screen cleanup cancel reconnection', async () => {
  for (const revoked of [false, true]) {
    const h = harness();
    await flush();
    const socket = h.sockets[0];
    socket.onopen();
    if (revoked) socket.receive('AUTH_REVOKED');
    else { socket.readyState = 3; socket.onclose({ code: 1006 }); }
    h.cleanup();
    assert.equal(h.timers.size, 0);
    assert.equal(h.storage.has('interpreter_token'), !revoked);
  }
});

test('socket handlers use the new call ID after a rerender and queue early ICE', async () => {
  const h = harness();
  await flush();
  const socket = h.sockets[0];
  socket.receive('CALL_REQUEST', { guestName: 'QA guest', roomNumber: 'QA' });
  const accepted = h.accept()();
  assert.equal(h.counts().captures, 1);
  assert.ok(socket.sent.some(item => item.type === 'CALL_ACCEPTED'));
  h.resolveCapture();
  await accepted;
  socket.receive('WEBRTC_ICE_CANDIDATE', { candidate: { candidate: 'early' } });
  socket.receive('WEBRTC_ANSWER', { sdp: { type: 'answer', sdp: 'qa-answer' } });
  await flush();
  assert.equal(h.peers[0].remoteDescription.sdp, 'qa-answer');
  assert.equal(h.peers[0].candidates.length, 1);
  h.peers[0].onicecandidate({ candidate: { toJSON: () => ({ candidate: 'local' }) } });
  assert.equal(socket.sent.at(-1).payload.callId, 'qa-call');
  socket.receive('CALL_ENDED');
  assert.equal(h.counts().stopped, 1);
});

test('a camera capture resolving after hangup is released, not attached', async () => {
  const h = harness();
  await flush();
  h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA', roomNumber: 'QA' });
  const accepted = h.accept()();
  h.sockets[0].receive('CALL_ENDED');
  h.resolveCapture();
  await accepted;
  assert.equal(h.counts().stopped, 1);
  assert.equal(h.peers.length, 0);
});

for (const event of ['AUTH_REVOKED', 'AUTH_UNAVAILABLE']) {
  test(`${event} clears credentials and releases an active camera`, async () => {
    const h = harness();
    await flush();
    h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA', roomNumber: '15' });
    const accepted = h.accept()();
    h.resolveCapture(); await accepted;
    h.sockets[0].receive(event, { message: 'Access removed by administrator' });
    assert.equal(h.storage.has('interpreter_token'), false);
    assert.equal(h.storage.has('interpreter_profile'), false);
    assert.equal(h.sockets[0].readyState, 3);
    assert.equal(h.counts().stopped, 1);
    assert.equal(h.peers[0].closed, true);
    assert.doesNotMatch(JSON.stringify(h.render()), /Active interpretation call/);
  });
}

test('a saved pending report is restored after sign-in without opening the camera', async () => {
  const h = harness({ pendingCall: { callId: 'qa-pending', roomNumber: '15', guestName: 'QA',
    report: { summary: 'Saved hotel report', priority: 'high', category: 'Room', notes: 'Help needed', followUpRequired: true } } });
  await flush();
  const tree = JSON.stringify(h.render());
  assert.match(tree, /Saved hotel report/);
  assert.match(tree, /Retry delivery/);
  assert.match(tree, /"disabled":true/);
  assert.equal(h.counts().captures, 0);
});

test('a guest cancelling before acceptance does not require an interpreter report', async () => {
  const h = harness();
  await flush();
  h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA', roomNumber: '15' });
  h.sockets[0].receive('CALL_ENDED', { reportRequired: false });
  const tree = JSON.stringify(h.render());
  assert.doesNotMatch(tree, /Mandatory interpreter report/);
  assert.match(tree, /Waiting for guest call/);
  assert.equal(h.counts().captures, 0);
});

test('blocked guest audio keeps guest video playing muted and enables audio on click', async () => {
  const h = harness();
  await flush();
  h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA', roomNumber: '15' });
  const accepted = h.accept()();
  h.resolveCapture(); await accepted;
  const video = find(h.render(), n => n.type === 'video' && !n.props.muted);
  let blocked = true, plays = 0;
  const element = { muted: true, srcObject: null, async play() {
    plays++;
    if (blocked && !this.muted) { const error = new Error('Gesture required'); error.name = 'NotAllowedError'; throw error; }
  } };
  video.props.ref.current = element;
  const audio = { id: 'guest-audio', kind: 'audio' };
  const guestVideo = { id: 'guest-video', kind: 'video' };
  h.peers[0].ontrack({ track: guestVideo, streams: [{ getTracks: () => [guestVideo, audio] }] });
  await flush();
  assert.equal(element.muted, true);
  assert.equal(plays, 2, 'audible autoplay falls back to muted video');
  assert.equal(element.srcObject.getVideoTracks().length, 1);
  assert.equal(element.srcObject.getAudioTracks().length, 1);
  video.props.onPlaying({ currentTarget: element });
  const button = find(h.render(), n => n.type === 'button' && n.props.children === 'Enable guest audio');
  assert.ok(button);
  blocked = false;
  button.props.onClick(); await flush();
  assert.equal(plays, 3);
  assert.equal(element.muted, false);
  assert.ok(!find(h.render(), n => n.type === 'button' && n.props.children === 'Enable guest audio'));
});

test('guest tracks attach even when local capture is still waiting for macOS permission', async () => {
  const h = harness();
  try {
    await flush();
    h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA', roomNumber: '15' });
    const accepted = h.accept()();
    h.sockets[0].receive('WEBRTC_ICE_CANDIDATE', { candidate: { candidate: 'early' } });
    await flush();
    const video = find(h.render(), n => n.type === 'video' && !n.props.muted);
    const element = { muted: false, srcObject: null, async play() {} };
    video.props.ref.current = element;
    const guest = { id: 'guest-video', kind: 'video' };
    h.peers[0].ontrack({ track: guest, streams: [] });
    assert.equal(element.srcObject.getVideoTracks()[0], guest);
    h.resolveCapture();
    await accepted;
    assert.match(JSON.stringify(h.render()), /Active interpretation call/);
    assert.equal(h.counts().captures, 1);
    assert.equal(h.peers.length, 1);
    const remoteCard = find(h.render(), n => n.type === 'article' && Boolean(find(n.props.children, c => c.type === 'h3' && c.props.children === 'Remote video')));
    assert.ok(!find(remoteCard, n => n.props.className === 'video-placeholder'), 'a pending local capture must not cover guest video');
  } finally { h.cleanup(); }
});
