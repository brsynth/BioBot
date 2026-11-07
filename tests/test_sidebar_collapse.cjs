const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const code = source.slice(source.indexOf('const sidebarCollapseBtn ='), source.indexOf('// --- Escape HTML ---'));

function setup(saved) {
  const classes = new Set(), attributes = {};
  let click;
  const button = { setAttribute: (key, value) => attributes[key] = value,
    addEventListener: (event, callback) => click = callback };
  const store = { value: saved };
  vm.runInNewContext(code, { document: { getElementById: () => button },
    sidebar: { classList: { contains: name => classes.has(name),
      toggle(name, value) { value ? classes.add(name) : classes.delete(name); } } },
    localStorage: { getItem: () => store.value, setItem: (key, value) => store.value = value } });
  return { classes, attributes, store, click };
}

test('sidebar can collapse and expand, and remembers the selected state', () => {
  const w = setup();
  w.click();
  assert.equal(w.classes.has('collapsed'), true);
  assert.equal(w.attributes['aria-label'], 'Expand sidebar');
  assert.equal(setup(w.store.value).classes.has('collapsed'), true);
  w.click();
  assert.equal(w.classes.has('collapsed'), false);
  assert.equal(w.attributes['aria-expanded'], 'true');
});
