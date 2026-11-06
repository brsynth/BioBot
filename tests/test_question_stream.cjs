const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const start = source.indexOf('if (questionResponse !== null ||');
const block = source.slice(start, source.indexOf('// --- RAG failure:', start));

function consume(chunks) {
  let rendered = null;
  const context = vm.createContext({
    questionResponse: null, questionRendered: false, botDiv: {},
    fixTrailingCommas: text => text,
    window: { renderQuestionsForm: (_, data) => rendered = data },
  });
  for (const chunk of chunks) {
    context.contentPart = chunk;
    vm.runInContext(block, context);
  }
  return { context, rendered };
}

test('starts questionnaire when marker or JSON is split at any network boundary', () => {
  const message = '__QUESTIONS__:' + JSON.stringify({ questions: [{ id: 'quantity', question: 'Quantity (µL)?' }] });
  for (let split = 1; split < message.length; split++) {
    const result = consume([message.slice(0, split), message.slice(split)]);
    assert.equal(result.context.questionRendered, true);
    assert.equal(result.rendered.questions[0].id, 'quantity');
  }
  assert.equal(consume([...message]).context.questionRendered, true);
});

test('ordinary chat and incomplete responses do not render a questionnaire', () => {
  assert.equal(consume(['An explanation']).context.questionResponse, null);
  assert.equal(consume(['__QUESTIONS__:{']).context.questionRendered, false);
});
