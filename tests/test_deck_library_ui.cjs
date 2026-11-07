const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/deck_universal.js`, 'utf8');

function element(tag) {
  const node = { tag, children: [], dataset: {}, style: {}, attributes: {}, events: {}, className: '',
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
  node.classList = { add(name) { node.className += ` ${name}`; },
    remove(name) { node.className = node.className.split(' ').filter(value => value !== name).join(' '); },
    contains(name) { return node.className.split(' ').includes(name); } };
  return node;
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
  const renderInitialDeck = context._renderDeck;
  vm.runInContext('_renderDeck = function(state) { rendered = state; }; _removeTipOverlay = function() {}; _clearCodeBlockHighlights = function() {};', context);
  const library = { selected: { id: 'base', name: 'Device default', owner_id: null, is_default: true },
    alternatives: [{ id: 'base', name: 'Device default', author: 'BioBot', is_default: true },
                   { id: 'public', name: 'Alternative', author: 'Second user', published: true }],
    layout: { platform: 'Device', layout_type: 'grid', grid: { rows: 1, cols: 2 },
      positions: [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 0, col: 1 }] } };
  context.state = { ...structuredClone(library.layout), steps: [{ volume: '10 uL' }], _library: library };
  vm.runInContext('_currentState = state; _currentCode = "protocol";', context);
  return { context, requests, renderInitialDeck, render() {
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

test('the chat link toggles its active deck without reloading, and opens another protocol when needed', () => {
  const w = setup();
  const link = {};
  w.context.sourceLink = link;
  vm.runInContext('_sourceCodeBlock = sourceLink;', w.context);
  let toggled = 0, opened;
  w.context.toggleDeckPanel = () => toggled++;
  w.context.parseDeckFromCode = (...args) => opened = args;
  w.context.toggleProtocolDeck('protocol', link);
  w.context.toggleProtocolDeck('protocol', link);
  assert.equal(toggled, 2);
  assert.equal(opened, undefined);
  w.context.toggleProtocolDeck('other protocol', link);
  assert.deepEqual(opened, ['other protocol', link]);
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

test('slot previews render plates, tips and tubes without a plate-map format variable', () => {
  const w = setup();
  for (const [type, labware, count] of [['plate', '96_well_plate', 96],
      ['plate', '384_well_plate', 384], ['tiprack', '96_tiprack', 96], ['tuberack', '24_tuberack', 24]]) {
    const html = w.context._renderSlotInterior(type, { id: 'a', labware });
    assert.equal((html.match(/data-well=/g) || []).length, count);
    assert.ok(html.includes('data-well="A1"'));
  }
});

test('first display renders cached hardware aliases as plate, tip and tube visuals', () => {
  const w = setup();
  for (const [type, labware, css, count] of [
    ['labware', '96_wellplate', 'mini-well', 96],
    ['source plate', '384_wellplate', 'mini-well', 384],
    ['destination plate', '96_wellplate', 'mini-well', 96],
    ['tube_rack', '24_tube_rack', 'mini-tube', 24],
    ['tip rack', '96_tiprack', 'mini-tip', 96],
    ['empty', '96_wellplate', 'mini-well', 96],
  ]) {
    const pos = { id: 'a', type, labware };
    const slot = w.context._createSlot(pos);
    assert.equal((slot.innerHTML.match(/data-well=/g) || []).length, count, type);
    assert.ok(slot.innerHTML.includes(css), type);
    assert.ok(slot.className.includes('filled'), type);
    assert.equal(pos.type, type); // Rendering does not rewrite saved device data.
  }
  const empty = w.context._createSlot({ id: 'b', type: 'empty', labware: null });
  assert.equal(empty.innerHTML.includes('data-well='), false);
});

test('linear carrier positions show the same plate visuals on first display', () => {
  const w = setup();
  const carrier = w.context._renderLinear({ carriers: { items: [{ type: 'carrier', track: 1,
    positions: [{ index: 0, labware: '96_wellplate' }] }] } });
  const slot = carrier.children[0].children[1];
  assert.equal((slot.innerHTML.match(/data-well=/g) || []).length, 96);
  assert.equal(slot.dataset.id, 'carrier_0');
});

test('area tooltip hides on pointer down and stays hidden until the pointer leaves', () => {
  const w = setup();
  let tip;
  w.context.window.innerWidth = 800;
  w.context.window.innerHeight = 600;
  w.context.document.body.appendChild = node => {
    tip = node;
    node.offsetWidth = 200;
    node.offsetHeight = 80;
    node.remove = () => tip = null;
  };
  w.context.document.getElementById = id => id === 'deck-area-tooltip' ? tip : null;
  const area = element('div');
  area.getBoundingClientRect = () => ({ left: 50, bottom: 60 });
  w.context._bindDeckTooltip(area, ['Position: a', '<sample>']);
  area.events.pointerenter({ clientX: 790, clientY: 590 });
  assert.equal(tip.textContent, 'Position: a\n<sample>');
  assert.equal(tip.style.left, '592px');
  area.events.pointerdown();
  assert.equal(tip, null);
  area.events.pointerenter({});
  assert.equal(tip, null);
  area.events.pointerleave();
  area.events.pointerenter({});
  assert.ok(tip);
});

test('one click on an empty position opens the add selector without rerendering the deck', () => {
  const w = setup();
  const calls = [];
  w.context._showSelector = (...args) => calls.push(args);
  const empty = w.context._createSlot({ id: 'a', type: 'empty' });
  empty.events.click();
  assert.deepEqual(calls, [['a', null]]);
  const loaded = w.context._createSlot({ id: 'b', type: 'plate', labware: 'plate_api' });
  loaded.events.click();
  assert.equal(calls.length, 1);
  assert.equal(loaded.draggable, true);
  loaded.events.dblclick();
  assert.deepEqual(calls[1], ['b', 'plate_api']);
});

test('dragging hardware preserves geometry and variables and tracks the code update', () => {
  const w = setup();
  Object.assign(w.context.state.positions[0], { labware: 'tips_api', variable: 'tips', type: 'tiprack' });
  w.context.state.steps = [{ source: { slot: 'a', wells: ['A1'] } }];
  w.context.state.instruments = [{ tipracks: ['a'] }];
  vm.runInContext('_originalState = JSON.parse(JSON.stringify(_currentState)); _renderApplyBar = function() {};', w.context);
  const loaded = w.context._createSlot(w.context.state.positions[0]);
  const empty = w.context._createSlot(w.context.state.positions[1]);
  const dataTransfer = { setData(type, value) { this.value = value; } };
  loaded.events.dragstart({ dataTransfer });
  let allowed = false;
  empty.events.dragover({ dataTransfer, preventDefault() { allowed = true; } });
  assert.equal(allowed, true);
  empty.events.drop({ preventDefault() {} });
  assert.equal(w.context.state.positions[0].type, 'empty');
  assert.equal(w.context.state.positions[1].variable, 'tips');
  assert.equal(w.context.state.positions[1].col, 1);
  assert.equal(w.context.state.steps[0].source.slot, 'b');
  assert.equal(w.context.state.instruments[0].tipracks[0], 'b');
  const changes = JSON.parse(vm.runInContext('JSON.stringify(_pendingChanges)', w.context));
  assert.deepEqual(changes, [{ type: 'move_labware', from_slot: 'a', to_slot: 'b', labware: 'tips_api', variable: 'tips' }]);
  w.context._discardChanges();
  assert.equal(w.context.rendered.positions[0].variable, 'tips');
  assert.equal(w.requests.length, 0);
});

test('moves cannot overwrite occupied areas or move fixed hardware', () => {
  const w = setup();
  Object.assign(w.context.state.positions[0], { labware: 'plate_api', type: 'plate' });
  Object.assign(w.context.state.positions[1], { labware: 'fixed_api', type: 'trash' });
  const before = JSON.stringify(w.context.state);
  w.context._moveDeckArea('a', 'b');
  w.context._moveDeckArea('b', 'a');
  assert.equal(JSON.stringify(w.context.state), before);
  assert.equal(w.context._createSlot(w.context.state.positions[1]).draggable, false);
});

test('applying a move sends the change and replaces the protocol with the returned code', async () => {
  const w = setup();
  const updatedState = structuredClone(w.context.state);
  let sent, sourceCode;
  w.context.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ code: 'updated protocol', state: updatedState }) };
  };
  w.context._updateSourceCodeBlock = code => sourceCode = code;
  vm.runInContext('_pendingChanges = [{type: "move_labware", from_slot: "a", to_slot: "b", labware: "plate_api"}];', w.context);
  await w.context._commitChanges();
  assert.equal(sent.url, '/deck/update');
  assert.equal(sent.body.changes[0].to_slot, 'b');
  assert.equal(sent.body.code, 'protocol');
  assert.equal(sourceCode, 'updated protocol');
  assert.equal(vm.runInContext('_currentCode', w.context), 'updated protocol');
  assert.equal(vm.runInContext('_pendingChanges.length', w.context), 0);
});

test('an inferred empty grid position remains available when hardware is added', () => {
  const w = setup();
  w.context.state.positions = [{ id: 'a', row: 0, col: 0, type: 'empty' }];
  w.context.state.grid.labels = ['a', 'b'];
  const grid = w.context._renderGrid(w.context.state);
  assert.equal(grid.children.length, 2);
  assert.equal(w.context.state.positions[1].id, 'b');
  vm.runInContext('_renderApplyBar = function() {};', w.context);
  w.context._applyChange('b', 'plate_api', null);
  assert.equal(w.context.state.positions[1].labware, 'plate_api');
});

test('the entire deck scales to fit in both normal and fullscreen panes', () => {
  const w = setup();
  let fullscreen = true;
  const wrapper = { scrollWidth: 1200, scrollHeight: 800,
    style: { removeProperty(name) { delete this[name]; } } };
  const container = { clientWidth: 624, clientHeight: 424, querySelector: () => wrapper };
  w.context.document.getElementById = id => id === 'deck-panel'
    ? { classList: { contains: name => name === 'deck-fullscreen' && fullscreen } } : id === 'deck-svg-container' ? container : null;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.5)');
  assert.equal(wrapper.style.left, '12px');
  assert.equal(wrapper.style.top, '12px');
  container.clientHeight = 224;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.25)');
  fullscreen = false;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.25)');
  assert.equal(wrapper.style.width, '600px');
});

test('active code lines are centered using viewport coordinates regardless of offset parents', () => {
  const w = setup();
  let scroll;
  const pre = { scrollTop: 600, scrollHeight: 2400, clientHeight: 200, clientTop: 1,
    offsetTop: 1200, getBoundingClientRect: () => ({ top: 700 }), scrollTo: value => scroll = value };
  const line = { offsetTop: 50, getBoundingClientRect: () => ({ top: 1201, height: 20 }) };
  w.context._revealCodeLine(pre, line);
  assert.equal(scroll.top, 1010);
  assert.equal(scroll.behavior, 'instant');
  line.getBoundingClientRect = () => ({ top: -500, height: 20 });
  w.context._revealCodeLine(pre, line);
  assert.equal(scroll.top, 0);
  line.getBoundingClientRect = () => ({ top: 3000, height: 20 });
  w.context._revealCodeLine(pre, line);
  assert.equal(scroll.top, 2200);
});

function catalogSetup() {
  const w = setup();
  const close = element('button'), rendered = [];
  let modal, timer, finish;
  w.context.document.body.appendChild = node => {
    modal = node;
    node.isConnected = true;
    node.remove = () => node.isConnected = false;
    node.querySelector = () => ({ value: '' });
  };
  w.context.document.getElementById = id => id === 'deck-selector-close-btn' ? close
    : id === 'deck-selector-modal' && modal?.isConnected ? modal : null;
  w.context._renderCatalog = () => {
    const list = element('div');
    list.customEntryAvailable = true;
    rendered.push(list);
    return list;
  };
  w.context._renderCatalogItems = list => list.suggestionsLoaded = true;
  w.context._filterCatalog = () => {};
  w.context.setTimeout = callback => { timer = callback; return 1; };
  w.context.clearTimeout = () => {};
  let requests = 0;
  w.context.fetch = (url, options) => {
    requests++;
    return new Promise((resolve, reject) => {
      finish = () => resolve({ ok: true, json: async () => ({ categories: [] }) });
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  return { ...w, rendered, close, timeout: () => timer(), finish: () => finish(), requests: () => requests };
}

test('hardware entry is available before lookup completes and successful suggestions are reused', async () => {
  const w = catalogSetup();
  const pending = w.context._showSelector('a', null);
  assert.equal(w.rendered[0].customEntryAvailable, true);
  assert.equal(w.rendered[0].suggestionsLoaded, undefined);
  w.finish();
  await pending;
  assert.equal(w.rendered[0].suggestionsLoaded, true);
  await w.context._showSelector('b', null);
  assert.equal(w.rendered[1].suggestionsLoaded, true);
  assert.equal(w.requests(), 1);
});

test('hardware lookup timeout replaces the spinner without removing custom entry', async () => {
  const w = catalogSetup();
  const pending = w.context._showSelector('a', null);
  w.timeout();
  await pending;
  assert.match(w.rendered[0].textContent, /timed out/);
  assert.equal(w.rendered[0].customEntryAvailable, true);
});

test('closing a dialog leaves shared preload available without updating the closed dialog', async () => {
  const w = catalogSetup();
  const pending = w.context._showSelector('a', null);
  w.close.events.click();
  w.finish();
  await pending;
  assert.equal(w.rendered[0].textContent, undefined);
  assert.equal(w.rendered[0].suggestionsLoaded, undefined);
  await w.context._showSelector('b', 'another_labware');
  assert.equal(w.requests(), 1);
});

test('background preloading and slot selectors share one request per robot', async () => {
  const w = catalogSetup();
  const preload = w.context._loadHardwareCatalog('Device');
  const pending = w.context._showSelector('a', 'existing_labware');
  assert.equal(w.requests(), 1);
  assert.equal(w.context._loadHardwareCatalog(' device '), preload);
  w.finish();
  await Promise.all([preload, pending]);
  await w.context._showSelector('b', null);
  assert.equal(w.requests(), 1);
});

test('a failed background preload can be retried when opening a slot', async () => {
  const w = catalogSetup();
  w.context.preloadHardwareCatalog('Device');
  w.timeout();
  await new Promise(setImmediate);
  const pending = w.context._showSelector('a', null);
  assert.equal(w.requests(), 2);
  w.finish();
  await pending;
  assert.equal(w.rendered[0].suggestionsLoaded, true);
});

test('initial deck rendering starts preloading for its identified robot', () => {
  const w = setup();
  const container = element('div');
  let platform;
  w.context.document.getElementById = id => id === 'deck-svg-container' ? container : null;
  w.context._watchDeckFit = () => {};
  w.context.preloadHardwareCatalog = value => platform = value;
  w.context.state.steps = [];
  w.renderInitialDeck(w.context.state);
  assert.equal(platform, 'Device');
});

test('divider supports dragging and keyboard resizing while keeping both panes available', () => {
  const w = setup();
  let splitter, height = 300;
  const code = { before(node) { splitter = node; }, getBoundingClientRect: () => ({ height }) };
  const panel = { clientHeight: 1000, style: { setProperty(name, value) { this[name] = value; height = parseFloat(value); } },
    querySelector: selector => selector === '.deck-code-panel' ? code
      : selector === '.deck-panel-header' ? { offsetHeight: 60 } : splitter };
  w.context.document.getElementById = id => id === 'deck-panel' ? panel : null;
  w.context._ensureDeckSplitter();
  splitter.offsetHeight = 10;
  let captured = false;
  splitter.focus = () => {};
  splitter.setPointerCapture = () => captured = true;
  splitter.hasPointerCapture = () => captured;
  splitter.releasePointerCapture = () => captured = false;
  splitter.events.pointerdown({ preventDefault() {}, clientY: 500, pointerId: 1 });
  splitter.events.pointermove({ clientY: 400, pointerId: 1 });
  assert.equal(height, 400);
  splitter.events.pointerup({ pointerId: 1 });
  splitter.events.pointermove({ clientY: 0, pointerId: 1 });
  assert.equal(height, 400);
  splitter.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(height, 376);
  splitter.events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(height, 850);
  splitter.events.keydown({ key: 'End', preventDefault() {} });
  assert.equal(height, 80);
});

test('fullscreen shows the current protocol below the deck and restores the normal panel on close', () => {
  const w = setup();
  function node() {
    const result = element('div');
    const classes = new Set();
    result.classList = { contains: name => classes.has(name), add: name => classes.add(name),
      remove: name => classes.delete(name), toggle(name, value) { value ? classes.add(name) : classes.delete(name); } };
    result.replaceChildren = () => result.children = [];
    result.removeAttribute = name => delete result.attributes[name];
    return result;
  }
  const panel = node(), view = node(), button = node(), sidebar = node(), chat = node();
  const elements = { 'deck-panel': panel, 'deck-code-view': view, 'deck-fullscreen-btn': button,
    sidebar, 'chat-panel': chat };
  w.context.document.getElementById = id => elements[id] || null;
  let expanded = 0;
  w.context.detectFormat = () => 'python';
  w.context.buildCodeBlock = code => {
    const block = node();
    block.code = code;
    block.querySelector = selector => selector === '.code-preview-toggle'
      ? { getAttribute: () => 'false', click: () => expanded++, remove() {} } : null;
    return block;
  };
  w.context._renderDeckCode();
  assert.equal(view.children[0].code, 'protocol');
  w.context._setDeckFullscreen(true);
  assert.equal(panel.classList.contains('deck-fullscreen'), true);
  assert.equal(panel.attributes['aria-modal'], 'true');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(sidebar.inert, true);
  assert.equal(chat.inert, true);
  assert.equal(view.children[0].code, 'protocol');
  assert.equal(expanded, 1);
  w.context._renderDeckCode();
  assert.equal(expanded, 1); // Selecting a slot must not rebuild or reset code scrolling.
  vm.runInContext('_currentCode = "updated protocol";', w.context);
  w.context._renderDeckCode();
  assert.equal(view.children[0].code, 'updated protocol');
  w.context.closeDeckPanel();
  assert.equal(panel.classList.contains('deck-fullscreen'), false);
  assert.equal(panel.classList.contains('hidden'), true);
  assert.equal(sidebar.inert, false);
  assert.equal(chat.inert, false);
  assert.equal(view.children[0].code, 'updated protocol');
  assert.equal(button.attributes['aria-pressed'], 'false');
});
