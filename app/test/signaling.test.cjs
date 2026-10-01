const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(session = {}) {
  const slots = [], effects = [], sockets = [], peers = [];
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
  const imports = { react, './CameraOptions': { default: 'CameraOptions' }, './camera': {}, 'react/jsx-runtime': {
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
  } };
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'localStorage', 'navigator', 'window', 'fetch', 'WebSocket', 'RTCPeerConnection', 'MediaStream', code)(
    module, module.exports, name => imports[name],
    { getItem: key => storage.get(key) || null, removeItem: key => storage.delete(key) },
    { mediaDevices: { getUserMedia: () => { captures++; return capture; } } }, { isSecureContext: true },
    async () => ({ ok: true, json: async () => ({ interpreter: profile, ...session }) }), Socket, Peer, Stream,
  );
  function render() {
    index = 0;
    const tree = module.exports.default();
    effects.splice(0).forEach(fn => fn());
    return tree;
  }
  function accept(node = render()) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && JSON.stringify(node.props.children).includes('Accept')) return node.props.onClick;
    for (const value of Object.values(node)) {
      const found = accept(value);
      if (found) return found;
    }
  }
  render();
  return { sockets, peers, render, accept, localStream, storage,
    resolveCapture: () => resolveCapture(localStream),
    counts: () => ({ captures, stopped }),
  };
}

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

test('blocked guest audio offers a playback action and retries on user click', async () => {
  const h = harness();
  await flush();
  h.sockets[0].receive('CALL_REQUEST', { guestName: 'QA', roomNumber: '15' });
  const accepted = h.accept()();
  h.resolveCapture(); await accepted;
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return;
    if (node.props && predicate(node)) return node;
    for (const child of Object.values(node)) { const match = find(child, predicate); if (match) return match; }
  }
  const video = find(h.render(), n => n.type === 'video' && !n.props.muted);
  let blocked = true, plays = 0;
  const element = { muted: true, srcObject: null, async play() {
    plays++;
    if (blocked) { const error = new Error('Gesture required'); error.name = 'NotAllowedError'; throw error; }
  } };
  video.props.ref.current = element;
  h.peers[0].ontrack({ track: { id: 'guest-audio', kind: 'audio' }, streams: [] });
  await flush();
  assert.equal(element.muted, false);
  assert.equal(element.srcObject.getAudioTracks().length, 1);
  const button = find(h.render(), n => n.type === 'button' && n.props.children === 'Enable guest audio');
  assert.ok(button);
  blocked = false;
  button.props.onClick(); await flush();
  assert.equal(plays, 2);
  assert.ok(!find(h.render(), n => n.type === 'button' && n.props.children === 'Enable guest audio'));
});
