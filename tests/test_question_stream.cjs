const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const helper = source.slice(source.indexOf('async function* readChatReply('), source.indexOf('// --- Send message ---'));
const context = vm.createContext({ TextDecoder });
vm.runInContext(helper, context);

async function consume(chunks) {
  let index = 0;
  const parts = [];
  const body = { getReader: () => ({ read: async () => index < chunks.length
    ? { value: chunks[index++], done: false } : { done: true }, releaseLock() {} }) };
  for await (const part of context.readChatReply(body)) parts.push(part);
  return parts;
}

test('preserves questionnaire JSON and Unicode across every network boundary', async () => {
  const json = JSON.stringify({ questions: [{ id: 'quantity', question: 'Quantity (µL)?' }] });
  const bytes = new TextEncoder().encode('__STATUS__:Checking...\n__QUESTIONS__:' + json);
  for (let split = 1; split < bytes.length; split++) {
    const parts = await consume([bytes.slice(0, split), bytes.slice(split)]);
    assert.equal(parts[0].type, 'status');
    const content = parts.filter(p => p.type === 'content').map(p => p.content).join('');
    assert.equal(JSON.parse(content.slice('__QUESTIONS__:'.length)).questions[0].question, 'Quantity (µL)?');
  }
});

test('keeps code and errors arriving in the same read as progress messages', async () => {
  for (const reply of ["print('__STATUS__: literal code')\n", '__FAILED_CODE__:Protocol preparation timed out. Please retry.']) {
    const wire = '__STATUS__:Loading...' + ' '.repeat(256) + '\n__STATUS__:Generating...\n' + reply;
    const parts = await consume([new TextEncoder().encode(wire)]);
    assert.deepEqual(parts.map(p => p.type), ['status', 'status', 'content']);
    assert.equal(parts[2].content, reply);
  }
});

test('reports an interrupted status instead of ending with no answer', async () => {
  for (const text of ['__STAT', '__STATUS__:Loading without completion']) {
    await assert.rejects(consume([new TextEncoder().encode(text)]), /interrupted/);
  }
});
