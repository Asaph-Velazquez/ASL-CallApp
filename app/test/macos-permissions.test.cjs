const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('CPM_INT_002: macOS app packaging includes camera and microphone usage descriptions and entitlements', () => {
  const root = path.join(__dirname, '../src-tauri');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tauri.macos.conf.json'), 'utf8'));
  assert.ok(config.bundle.targets.includes('app'));
  const permissions = config.bundle.macOS;
  const info = fs.readFileSync(path.join(root, permissions.infoPlist), 'utf8');
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription']) {
    assert.match(info, new RegExp(`<key>${key}</key>\\s*<string>[^<]+</string>`));
  }
  const entitlements = fs.readFileSync(path.join(root, permissions.entitlements), 'utf8');
  for (const key of ['com.apple.security.device.camera', 'com.apple.security.device.audio-input']) {
    const escaped = key.replaceAll('.', '\\.');
    assert.match(entitlements, new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`));
  }
});
