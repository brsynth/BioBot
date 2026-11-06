const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const helpers = source.slice(source.indexOf('function setTrashView('), source.indexOf('// Close modals on backdrop click'));

function setup({ current = 'current', fail = false } = {}) {
  const calls = [], loaded = [], errors = [], selected = [];
  const header = {}, button = { classList: { toggle() {} }, setAttribute() {} };
  const context = vm.createContext({
    document: { querySelector: () => header, getElementById: () => button },
    currentChatId: current, showingTrash: false, chatRequestController: null, chatRequestDone: Promise.resolve(),
    localStorage: { removeItem() {} }, alert: error => errors.push(error),
    refreshChatList: async () => [{ chat_id: 'next' }],
    loadChatHistory: async id => loaded.push(id), createNewChat: async () => loaded.push('new'),
    selectChatListItem: id => selected.push(id),
    fetch: async (url, options) => { calls.push({ url, method: options.method }); return { ok: !fail }; },
  });
  vm.runInContext(helpers, context);
  return { context, calls, loaded, errors, header, selected };
}

test('trash click removes the row immediately and sends a single move request', async () => {
  const w = setup();
  const row = { removed: false, remove() { this.removed = true; } };
  const moving = w.context.trashChat('other', row);
  assert.equal(row.removed, true);
  await moving;
  assert.deepEqual(w.calls, [{ url: '/chat/other', method: 'DELETE' }]);
  assert.deepEqual(w.loaded, []);
});

test('moving the current chat waits for its canceled response before opening the next chat', async () => {
  const w = setup();
  let finish;
  w.context.chatRequestDone = new Promise(resolve => finish = resolve);
  let aborted = false;
  w.context.chatRequestController = { abort() { aborted = true; } };
  const moving = w.context.trashChat('current');
  await new Promise(setImmediate);
  assert.equal(aborted, true);
  assert.deepEqual(w.loaded, []);
  finish();
  await moving;
  assert.deepEqual(w.loaded, ['next']);
});

test('restore returns to conversations and opens the restored chat', async () => {
  const w = setup();
  w.context.showingTrash = true;
  await w.context.restoreChat('restored');
  assert.deepEqual(w.calls, [{ url: '/chat/restored/restore', method: 'POST' }]);
  assert.equal(w.context.showingTrash, false);
  assert.equal(w.header.textContent, 'Conversations');
  assert.deepEqual(w.loaded, ['restored']);
});

test('failed move refreshes the list and reports the error', async () => {
  const w = setup({ fail: true });
  await w.context.trashChat('other');
  assert.equal(w.errors.length, 1);
  assert.deepEqual(w.loaded, []);
  assert.deepEqual(w.selected, ['current']);
});
