const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/theme.js`, 'utf8');

function setup(saved = null, dark = false, blocked = false, defaultAppearance = 'auto') {
  const callbacks = {};
  const inputs = ['daylight','dark','auto'].map(value=>({value,checked:false,addEventListener:(name,fn)=>callbacks[value]=fn}));
  const control = {get value() {return inputs.find(input=>input.checked)?.value;}, set value(value) {inputs.forEach(input=>input.checked=input.value===value);}};
  callbacks.change = () => callbacks[control.value]();
  const root = { dataset: {} }, system = { matches: dark, addEventListener: (name, fn) => callbacks.system = fn };
  const store = { value: saved };
  const context = vm.createContext({
    window: { matchMedia: () => system, addEventListener: (name, fn) => callbacks[name] = fn },
    document: { currentScript: {dataset: {defaultAppearance}}, documentElement: root, querySelectorAll: () => inputs, addEventListener: (name, fn) => callbacks[name] = fn },
    localStorage: { getItem() { if (blocked) throw new Error('blocked'); return store.value; },
      setItem(key, value) { if (blocked) throw new Error('blocked'); store.value = value; } },
  });
  vm.runInContext(source, context);
  callbacks.DOMContentLoaded();
  return { root, system, callbacks, control, store };
}

test('Auto follows the system at startup and when the system changes', () => {
  const w = setup();
  assert.equal(w.root.dataset.theme, 'daylight');
  assert.equal(w.control.value, 'auto');
  w.system.matches = true;
  w.callbacks.system();
  assert.equal(w.root.dataset.theme, 'dark');
});

test('the new workspace defaults to daylight and preserves an explicit Auto preference', () => {
  assert.equal(setup(null, true, false, 'daylight').root.dataset.theme, 'daylight');
  assert.equal(setup('auto', true, false, 'daylight').root.dataset.theme, 'dark');
});

test('manual selection persists across visits and overrides the system', () => {
  const w = setup(null, true);
  w.control.value = 'daylight';
  w.callbacks.change();
  w.callbacks.system();
  assert.equal(w.root.dataset.theme, 'daylight');
  assert.equal(setup(w.store.value, true).root.dataset.theme, 'daylight');
  w.callbacks.storage({ key: 'biobot-appearance', newValue: 'dark' });
  assert.equal(w.root.dataset.theme, 'dark');
  assert.equal(w.control.value, 'dark');
});

test('invalid or unavailable storage falls back to Auto without breaking controls', () => {
  assert.equal(setup('invalid', true).root.dataset.theme, 'dark');
  const w = setup(null, false, true);
  w.control.value = 'dark';
  w.callbacks.change();
  assert.equal(w.root.dataset.theme, 'dark');
  w.callbacks.storage({ key: null, newValue: null });
  assert.equal(w.control.value, 'auto');
  assert.equal(w.root.dataset.theme, 'daylight');
});
