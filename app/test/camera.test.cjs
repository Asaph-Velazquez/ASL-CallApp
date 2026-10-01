const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/camera.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUnderTest = { exports: {} };
new Function('exports', code)(moduleUnderTest.exports);
const { replaceCamera } = moduleUnderTest.exports;
const track = (kind, enabled = true) => ({ kind, enabled, stopped: false, stop() { this.stopped = true; } });

function fixture() {
  const original = track('video', false), microphone = track('audio'), next = track('video');
  const tracks = [original, microphone];
  const stream = { getVideoTracks: () => tracks.filter(t => t.kind === 'video'), addTrack: t => tracks.push(t), removeTrack: t => tracks.splice(tracks.indexOf(t), 1) };
  const devices = { async getUserMedia(constraints) {
    assert.deepEqual(constraints, { video: { deviceId: { exact: 'usb' } }, audio: false });
    return { getVideoTracks: () => [next], getTracks: () => [next] };
  } };
  return { original, microphone, next, tracks, stream, devices };
}
test('camera switching replaces video and preserves microphone and disabled state', async () => {
  const f = fixture();
  let sentTrack;
  const connection = { getSenders: () => [{ track: f.original, async replaceTrack(t) { sentTrack = t; } }] };
  await replaceCamera(f.devices, f.stream, connection, 'usb', () => true);
  assert.equal(sentTrack, f.next);
  assert.deepEqual(f.tracks, [f.microphone, f.next]);
  assert.equal(f.next.enabled, false);
  assert.equal(f.microphone.stopped, false);
  assert.equal(f.original.stopped, true);
});
test('failed replacement retains the current camera and releases the new one', async () => {
  const f = fixture();
  const connection = { getSenders: () => [{ track: f.original, async replaceTrack() { throw Error('Cannot replace'); } }] };
  await assert.rejects(replaceCamera(f.devices, f.stream, connection, 'usb', () => true), /Cannot replace/);
  assert.equal(f.original.stopped, false);
  assert.equal(f.next.stopped, true);
});
test('capture resolving after hangup is discarded', async () => {
  const f = fixture();
  await replaceCamera(f.devices, f.stream, null, 'usb', () => false);
  assert.equal(f.next.stopped, true);
  assert.deepEqual(f.tracks, [f.original, f.microphone]);
});
