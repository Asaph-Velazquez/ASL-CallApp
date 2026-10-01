const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(devices) {
  const slots = [], effects = [], selections = [];
  let index = 0;
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], next => { slots[i] = next; }];
    },
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || deps.some((value, n) => value !== slots[i][n])) effects.push(fn);
      slots[i] = deps;
    },
  };
  const imports = { react, 'react/jsx-runtime': {
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
  } };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/CameraOptions.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'navigator', code)(module, module.exports, name => imports[name], { mediaDevices: devices });
  function render() {
    index = 0;
    const tree = module.exports.default({ selected: '', busy: false, onSelect: async id => { selections.push(id); } });
    effects.splice(0).forEach(effect => effect());
    return tree;
  }
  function find(predicate, node = render()) {
    if (!node || typeof node !== 'object') return;
    if (node.props && predicate(node)) return node;
    for (const child of Object.values(node)) {
      const found = find(predicate, child);
      if (found) return found;
    }
  }
  return { render, find, selections };
}

test('camera options detects only video devices, supports selection and device changes', async () => {
  let changed, stopped = 0;
  let available = [{ kind: 'videoinput', deviceId: 'usb', label: 'USB Camera' }, { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }];
  const h = harness({
    enumerateDevices: async () => available,
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }),
    addEventListener: (_, fn) => { changed = fn; }, removeEventListener() {},
  });
  h.find(node => node.type === 'button').props.onClick();
  h.render(); await flush();
  assert.match(JSON.stringify(h.render()), /USB Camera/);
  assert.doesNotMatch(JSON.stringify(h.render()), /Microphone/);
  h.find(node => node.type === 'select').props.onChange({ target: { value: 'usb' } });
  assert.deepEqual(h.selections, ['usb']);
  h.find(node => node.type === 'button' && node.props.children === 'Detect cameras').props.onClick();
  await flush();
  assert.equal(stopped, 1, 'temporary permission capture is released');
  available = [{ kind: 'videoinput', deviceId: 'builtin', label: 'Built-in camera' }];
  await changed();
  assert.match(JSON.stringify(h.render()), /Built-in camera/);
  assert.doesNotMatch(JSON.stringify(h.render()), /USB Camera/);
});

test('camera options explains unavailable media access without crashing', async () => {
  const h = harness(undefined);
  h.find(node => node.type === 'button').props.onClick();
  h.render(); await flush();
  assert.match(JSON.stringify(h.render()), /HTTPS or localhost/);
  assert.equal(h.find(node => node.type === 'select').props.disabled, true);
});
