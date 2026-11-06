const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/deck_universal.js`, 'utf8');

function element(tag) {
  return { tag, children: [], dataset: {}, style: {}, attributes: {}, events: {}, className: '',
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { this.events[name] = fn; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const match = node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector;
      return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
  };
}
function setup() {
  const requests = [];
  const document = { createElement: element, body: { dataset: { userId: '1' } },
    addEventListener() {}, getElementById: () => null, querySelector: () => null };
  const context = vm.createContext({ window: {}, document, currentChatId: 'chat', AbortController,
    clearInterval() {}, setTimeout() {}, fetch: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      return { ok: true, json: async () => ({ id: 'copy', published: true }) };
    },
  });
  vm.runInContext(source, context);
  vm.runInContext('_renderDeck = function(state) { rendered = state; }; _removeTipOverlay = function() {}; _clearCodeBlockHighlights = function() {};', context);
  const library = { selected: { id: 'base', name: 'Device default', owner_id: null, is_default: true },
    alternatives: [{ id: 'base', name: 'Device default', author: 'BioBot', is_default: true },
                   { id: 'public', name: 'Alternative', author: 'Second user', published: true }],
    layout: { platform: 'Device', layout_type: 'grid', grid: { rows: 1, cols: 2 },
      positions: [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 0, col: 1 }] } };
  context.state = { ...structuredClone(library.layout), steps: [{ volume: '10 uL' }], _library: library };
  vm.runInContext('_currentState = state; _currentCode = "protocol";', context);
  return { context, requests, render() {
    const wrapper = element('div');
    context._renderLibraryControls(wrapper, context.state);
    return wrapper;
  } };
}

test('lists published alternatives with attribution and switches using the same protocol', () => {
  const w = setup();
  const select = w.render().querySelector('select');
  assert.equal(select.children[1].textContent, 'Alternative · Second user');
  let selected;
  w.context.parseDeckFromCode = (...args) => selected = args;
  select.value = 'public';
  select.events.change();
  assert.deepEqual(selected, ['protocol', null, 'public']);
});

test('editing creates a separate layout draft and cancel preserves protocol state', () => {
  const w = setup();
  const original = JSON.stringify(w.context.state);
  w.render().querySelectorAll('button').find(button => button.textContent === 'Edit a copy').events.click();
  vm.runInContext('_currentState.positions[0].col = 1;', w.context);
  assert.equal(JSON.stringify(w.context.state), original);
  assert.equal(w.context.rendered.steps, undefined);
  const wrapper = element('div');
  w.context._renderLibraryControls(wrapper, w.context.rendered);
  wrapper.querySelectorAll('button').find(button => button.textContent === 'Cancel').events.click();
  assert.equal(w.context.rendered, w.context.state);
  assert.equal(w.requests.length, 0);
});

test('saving a copy sends layout and lineage without changing code', async () => {
  const w = setup();
  w.render().querySelectorAll('button').find(button => button.textContent === 'Edit a copy').events.click();
  let selected;
  w.context.parseDeckFromCode = (...args) => selected = args;
  await w.context._saveLibraryCopy();
  assert.equal(w.requests[0].url, '/deck/library');
  assert.equal(w.requests[0].body.parent_id, 'base');
  assert.equal(w.requests[0].body.layout.steps, undefined);
  assert.equal(w.requests[0].body.code, undefined);
  assert.deepEqual(selected, ['protocol', null, 'copy']);
});

test('publish is offered only for the current user\'s unpublished copy', async () => {
  const w = setup();
  assert.equal(w.render().querySelectorAll('button').some(button => button.textContent === 'Publish'), false);
  w.context.state._library.selected = { id: 'mine', name: 'My copy', owner_id: 1, published: false };
  assert.equal(w.render().querySelectorAll('button').some(button => button.textContent === 'Publish'), true);
  await w.context._publishLibraryDeck();
  assert.equal(w.requests[0].url, '/deck/library/mine/publish');
  w.context.state._library.selected.owner_id = 2;
  assert.equal(w.render().querySelectorAll('button').some(button => button.textContent === 'Publish'), false);
});

test('library selection is disabled until pending protocol changes are resolved', () => {
  const w = setup();
  vm.runInContext('_pendingChanges = [{ type: "change_labware" }];', w.context);
  const wrapper = w.render();
  assert.equal(wrapper.querySelector('select').disabled, true);
  assert.equal(wrapper.querySelectorAll('button').find(button => button.textContent === 'Edit a copy').disabled, true);
});

test('well maps use declared plate counts and do not invent an unspecified format', () => {
  const w = setup();
  const known = w.context._renderPlateMap({ name: 'Source', format: 384 }, 'source', 'source', null);
  assert.equal(known.querySelectorAll('.deck-well').length, 384);
  const unknown = w.context._renderPlateMap({ name: 'Source', format: null }, 'source', 'source', null);
  assert.equal(unknown.querySelectorAll('.deck-well').length, 0);
});
