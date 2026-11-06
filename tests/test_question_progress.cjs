const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const send = source.slice(source.indexOf('async function sendMessage('), source.indexOf('// --- Event Listeners ---'));

function request(failure = false) {
  const progress = { removed: false, remove() { this.removed = true; } };
  const summary = { querySelector: () => progress.removed ? null : progress };
  const statuses = [];
  let finishRefresh;
  const chunks = [new TextEncoder().encode('__STATUS__:Generating protocol...\n')];
  const context = vm.createContext({
    document: { getElementById: id => id === 'user-input' ? { value: '', style: {} } : null,
      createElement: () => ({ remove() { this.removed = true; } }) },
    currentChatId: 'chat', isTyping: false, sendBtn: {}, window: {}, console: { error() {} },
    TextDecoder, AbortController, setTimeout() {}, clearInterval() {},
    chatHistoryElem: { appendChild: node => statuses.push(node) },
    addMessage: () => ({}), renderUserMessage() {}, addThinkingMessage: () => 1,
    scrollToBottom() {}, appendChunkToBotMessage() {}, selectChatListItem() {},
    refreshChatList: () => new Promise(resolve => finishRefresh = resolve),
    fetch: async () => {
      if (failure) throw new Error('Network failed');
      return { status: 200, ok: true, headers: { get: () => '7' },
        body: { getReader: () => ({ read: async () => chunks.length
          ? { value: chunks.shift(), done: false } : { done: true } }) } };
    },
  });
  vm.runInContext(send, context);
  const completion = context.sendMessage({ message: '[PROTOCOL_PARAMS]\nQuantity? 10 uL', questionnaireSummary: summary });
  return { completion, progress, statuses, context, finish: () => finishRefresh() };
}

test('stops questionnaire and status spinners when the stream ends, before refreshing the chat list', async () => {
  const pending = request();
  await new Promise(setImmediate);
  assert.equal(pending.progress.removed, true);
  assert.equal(pending.statuses[0].removed, true);
  assert.equal(pending.context.isTyping, true); // Chat-list refresh is deliberately still pending.
  pending.finish();
  await pending.completion;
  assert.equal(pending.context.isTyping, false);
});

test('stops questionnaire progress when the request fails', async () => {
  const failed = request(true);
  await failed.completion;
  assert.equal(failed.progress.removed, true);
  assert.equal(failed.context.isTyping, false);
  assert.equal(failed.context.sendBtn.disabled, false);
});
