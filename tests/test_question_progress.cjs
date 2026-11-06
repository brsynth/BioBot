const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const send = source.slice(source.indexOf('async function* readChatReply('), source.indexOf('// --- Event Listeners ---'));

function request(failure = false, packets = null) {
  const progress = { removed: false, remove() { this.removed = true; } };
  const summary = { querySelector: () => progress.removed ? null : progress };
  const statuses = [], blocks = [], displayed = [];
  let finishRefresh;
  const chunks = (packets || ['__STATUS__:Generating protocol...\n', 'pass\n']).map(text => new TextEncoder().encode(text));
  const context = vm.createContext({
    document: { getElementById: id => id === 'user-input' ? { value: '', style: {} } : null,
      createTextNode: text => ({ textContent: text }),
      createElement: () => ({ children: [], replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }, remove() { this.removed = true; } }) },
    currentChatId: 'chat', isTyping: false, sendBtn: {}, window: {}, console: { error() {} },
    TextDecoder, AbortController, setTimeout() {}, clearInterval() {},
    chatHistoryElem: { appendChild: node => statuses.push(node) },
    addMessage: () => ({ appendChild: node => displayed.push(node) }),
    buildCodeBlock: code => { blocks.push(code); return {}; }, detectFormat: () => 'python', renderUserMessage() {}, addThinkingMessage: () => 1,
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
  return { completion, progress, statuses, blocks, displayed, context, finish: () => finishRefresh() };
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


test('renders one complete protocol even when its bytes arrive in separate reads', async () => {
  const pending = request(false, ['__STATUS__:Generating...\nfirst line\n', 'second line\n', 'last line\n']);
  await new Promise(setImmediate);
  assert.deepEqual(pending.blocks, ['first line\nsecond line\nlast line\n']);
  pending.finish();
  await pending.completion;
});

test('a failure following status in the same read is visible as an explanation, not code', async () => {
  const pending = request(false, ['__STATUS__:Indexing...\n__FAILED_CODE__:Preparation timed out. Please retry.']);
  await new Promise(setImmediate);
  assert.deepEqual(pending.blocks, []);
  assert.equal(pending.displayed[0].textContent, 'Preparation timed out. Please retry.');
  assert.equal(pending.progress.removed, true);
  pending.finish();
  await pending.completion;
});
