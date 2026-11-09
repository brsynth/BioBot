const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const factory = source.slice(source.indexOf('function buildDeckLink('), source.indexOf('// --- Build a styled code block'));
const append = source.slice(source.indexOf('function appendChunkToBotMessage('), source.indexOf('// --- Load chat history ---'));

function setup() {
  const context = vm.createContext({ window: {}, scrollToBottom() {},
    document: { createElement: () => ({ events: {}, addEventListener(name, callback) { this.events[name] = callback; } }),
      createTextNode: text => ({ textContent: text }) } });
  vm.runInContext(factory + append, context);
  return context;
}

test('chat keeps a hidden protocol reference without an Open deck link', () => {
  const w = setup();
  const link = w.buildDeckLink('original code');
  assert.equal(link.hidden, true);
  assert.equal(link.textContent, undefined);
  assert.equal(link.innerHTML, undefined);
  link._protocolCode = 'updated code';
  assert.equal(link._protocolCode, 'updated code');
  assert.equal(link.events.click, undefined);
});

test('streamed code never appears in chat, even when fences split across reads', () => {
  const text = 'Before\n```python\nprint("secret protocol")\n```\nAfter';
  for (let split = 1; split < text.length; split++) {
    const w = setup();
    const message = { _buffer: '', children: [], appendChild(node) { this.children.push(node); } };
    w.appendChunkToBotMessage(message, text.slice(0, split));
    w.appendChunkToBotMessage(message, text.slice(split));
    const links = message.children.filter(node => node.className === 'protocol-deck-link');
    assert.equal(links.length, 1, split);
    assert.equal(links[0]._protocolCode, 'print("secret protocol")\n');
    const visible = message.children.map(node => node.textContent).join('');
    assert.equal(visible, 'Before\n\nAfter');
  }
});
