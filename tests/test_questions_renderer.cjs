// Run with: node --test tests/test_questions_renderer.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/questions_renderer.js`, 'utf8');

function wizard() {
  const slides = ['source', 'target'].map(id => {
    const notice = { textContent: '' };
    const slide = {
      dataset: { qid: id, qtype: 'number' }, style: {},
      selected: { value: '__other__' }, text: { value: '1' }, notice,
      querySelector: selector => selector === 'input:checked' ? slide.selected
        : selector === '.question-validation' ? notice : slide.text,
    };
    return slide;
  });
  const form = {
    querySelectorAll: selector => selector === '.question-slide' ? slides : slides.map(s => s.notice),
    querySelector: () => null,
  };
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);
  const questions = { constraints: [{ left: 'target', operator: 'lt', right: 'source', message: 'Target must be below source.' }] };
  return { context, form, slides, questions,
    validate: index => context.validateQuestionConstraints(form, questions, index) };
}

test('blocks conflicting custom quantities and allows editing an earlier answer', () => {
  const w = wizard();
  w.slides[1].text.value = '10';
  assert.equal(w.validate(1), false);
  assert.equal(w.slides[1].notice.textContent, 'Target must be below source.');
  w.slides[0].text.value = '20';
  assert.equal(w.validate(1), true);
  assert.equal(w.slides[1].notice.textContent, '');
});

test('does not assume unanswered values and handles numeric options', () => {
  const w = wizard();
  assert.equal(w.validate(0), true);
  w.slides[0].selected.value = '100';
  w.slides[1].selected.value = '10';
  assert.equal(w.validate(1), true);
  w.slides[1].selected.value = '100';
  assert.equal(w.validate(1), false);
});

test('supports generated constant bounds and inclusive comparisons', () => {
  const w = wizard();
  w.questions.constraints = [{ left: 'target', operator: 'lte', right: 5 }];
  w.slides[1].text.value = '5';
  assert.equal(w.validate(1), true);
  w.slides[1].text.value = '5.1';
  assert.equal(w.validate(1), false);
});

test('rejects invalid numeric custom input without executing expressions', () => {
  const w = wizard();
  for (const raw of ['', 'NaN', 'Infinity', '1 mM', '1 + 2']) {
    w.slides[1].text.value = raw;
    assert.equal(w.validate(1), false);
  }
  w.slides[1].text.value = '1e-3';
  assert.equal(w.validate(1), true);
});

test('questionnaires without numeric constraints keep working', () => {
  const w = wizard();
  w.slides.forEach(s => s.dataset.qtype = 'single');
  w.questions = {};
  assert.equal(w.context.validateQuestionConstraints(w.form, w.questions, 1), true);
});

test('normalizes generated unit conversions while preserving case and dimensions', () => {
  const w = wizard();
  const parse = raw => w.context.parseQuestionQuantity(raw, {
    unit: 'mM', units: { mM: 1, uM: 0.001, M: 1000 },
  });
  assert.equal(parse('12.5 mM'), 12.5);
  assert.equal(parse('12500 µM'), 12.5);
  assert.equal(parse('12500 μM'), 12.5);
  assert.equal(parse('1.25e4uM'), 12.5);
  assert.equal(parse('0,0125 M'), 12.5);
  assert.equal(parse('12.5'), 12.5);
  for (const raw of ['12 mm', '12 mL', '1 + 2 mM']) assert.ok(Number.isNaN(parse(raw)));
});

test('live checks compare converted units and clear errors after correction', () => {
  const w = wizard();
  w.questions.questions = ['source', 'target'].map(id => ({
    id, unit: 'mM', units: { mM: 1, uM: 0.001 },
  }));
  w.slides[0].text.value = '1 mM';
  w.slides[1].text.value = '2000 uM';
  assert.equal(w.context.validateQuestionConstraints(w.form, w.questions, 1, true), false);
  assert.match(w.slides[1].notice.textContent, /below source/);
  w.slides[1].text.value = '500 µM';
  assert.equal(w.context.validateQuestionConstraints(w.form, w.questions, 1, true), true);
  assert.equal(w.slides[1].notice.textContent, '');
  w.slides[1].text.value = '500 mL';
  assert.equal(w.context.validateQuestionConstraints(w.form, w.questions, 1, true), false);
  assert.match(w.slides[1].notice.textContent, /supported unit/);
});

// Small DOM fixture exercises rendering, input events, and answer collection together.
function element(tag) {
  const el = {
    tag, children: [], dataset: {}, style: {}, events: {}, className: '', value: '', checked: false,
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); },
    querySelectorAll(selector) {
      const matches = node => {
        if (selector.startsWith('#')) return node.id === selector.slice(1);
        if (selector.startsWith('.')) {
          const name = selector.slice(1).split('[')[0];
          return node.className.split(' ').includes(name);
        }
        if (selector.startsWith('input')) {
          const name = selector.match(/name="([^"]+)"/);
          return node.tag === 'input' && (!name || node.name === name[1]) &&
            (!selector.includes(':checked') || node.checked);
        }
        return false;
      };
      return this.children.flatMap(child => [
        ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  return el;
}

test('renders a direct unit-aware textbox with no visible Other choice', () => {
  const context = vm.createContext({ window: {}, document: { createElement: element } });
  vm.runInContext(source, context);
  const parent = element('div');
  context.renderQuestionsForm(parent, {
    questions: [{ id: 'quantity', question: 'Quantity (nL)', type: 'number',
      options: [], allow_other: false, unit: 'nL', units: { nL: 1, uL: 1000 } }],
    constraints: [{ left: 'quantity', operator: 'lte', right: 20000, message: 'Too large.' }],
  });
  const form = parent.children[0];
  const text = form.querySelector('.other-text-input');
  const selection = form.querySelector('input:checked');
  assert.equal(selection.hidden, true);
  assert.equal(text.type, 'text');
  assert.equal(text.disabled, false);
  assert.equal(form.querySelector('.option-label'), null);
  text.value = '25 uL';
  text.events.input[0]();
  assert.equal(form.querySelector('.question-validation').textContent, 'Too large.');
  text.value = '12.5 uL';
  text.events.input[0]();
  assert.equal(form.querySelector('.question-validation').textContent, '');
  assert.equal(context.validateSlide(form.querySelector('.question-slide')), true);
  assert.equal(context.collectQuestionAnswers(form)[0].answers[0], '12.5 uL');
});

test('legacy quantity fields explain missing metadata instead of asking for only numbers', () => {
  const w = wizard();
  w.slides[1].text.value = '10 mM';
  assert.equal(w.validate(1), false);
  assert.match(w.slides[1].notice.textContent, /no unit definitions/);
  assert.doesNotMatch(w.slides[1].notice.textContent, /Enter a number/);
});

test("Don't know skips only the unknown quantity without masking other conflicts", () => {
  const w = wizard();
  w.slides[0].text.value = 'invalid';
  w.slides[0].dataset.unknown = 'true';
  assert.equal(w.context.validateSlide(w.slides[0]), true);
  assert.equal(w.validate(1), true);
  w.questions.constraints.push({ left: 'target', operator: 'gte', right: 2, message: 'Target too low.' });
  assert.equal(w.validate(1), false);
  assert.equal(w.slides[1].notice.textContent, 'Target too low.');
});

test("Don't know advances, is preserved in answers, and can be replaced by typing", () => {
  const context = vm.createContext({ window: {}, document: { createElement: element } });
  vm.runInContext(source, context);
  const parent = element('div');
  context.renderQuestionsForm(parent, {
    questions: [
      { id: 'quantity', question: 'Quantity (uL)?', type: 'number', options: [], unit: 'uL', units: { uL: 1 } },
      { id: 'details', question: 'Details?', type: 'single', options: [] },
    ],
  });
  const form = parent.children[0];
  const slides = form.querySelectorAll('.question-slide');
  const skip = slides[0].querySelector('.q-unknown-btn');
  skip.events.click[0]();
  assert.equal(slides[0].dataset.unknown, 'true');
  assert.equal(slides[1].style.display, '');
  assert.match(context.collectQuestionAnswers(form)[0].answers[0], /Don't know/);
  const text = slides[0].querySelector('.other-text-input');
  text.value = '12 uL';
  text.events.input[0]();
  assert.equal(slides[0].dataset.unknown, 'false');
  assert.equal(skip.textContent, "Don't know");
  assert.equal(context.collectQuestionAnswers(form)[0].answers[0], '12 uL');
});

function memoryHarness() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value) };
  function reload(session = 'login-one') {
    const context = vm.createContext({ window: {}, sessionStorage: storage,
      document: { createElement: element, body: { dataset: { answerSession: session } } } });
    vm.runInContext(source, context);
    return {
      context,
      render(question) {
        const parent = element('div');
        context.renderQuestionsForm(parent, { questions: [question] });
        return parent.querySelector('.question-slide');
      },
    };
  }
  return { reload };
}

test('restores multiple choices despite option order changes and survives page refresh', () => {
  const memory = memoryHarness();
  const first = memory.reload();
  const question = { id: 'steps', question: 'Which steps?', type: 'multiple',
    options: [{ value: 'a', label: 'Step A' }, { value: 'b', label: 'Step B' }] };
  const slide = first.render(question);
  slide.querySelectorAll('input').filter(input => input.name === 'q_steps' && input.value !== '__other__').forEach(input => input.checked = true);
  first.context.rememberQuestionAnswer(question, slide);
  const restored = memory.reload().render({ ...question, options: [...question.options].reverse() });
  assert.deepEqual(restored.querySelectorAll('input:checked').map(input => input.value), ['b', 'a']);
  const newSession = memory.reload('login-two').render(question);
  assert.equal(newSession.querySelectorAll('input:checked').length, 0);
});

test('restores custom quantities across question IDs and reference units without changing their meaning', () => {
  const memory = memoryHarness();
  const first = memory.reload();
  const question = { id: 'volume', question: 'Final volume?', type: 'number', options: [], unit: 'uL', units: { uL: 1 } };
  const slide = first.render(question);
  const text = slide.querySelector('.other-text-input');
  text.value = '0,5';
  text.events.input[0]();
  const next = { ...question, id: 'final_volume', unit: 'nL', units: { nL: 1, uL: 1000 } };
  const restored = memory.reload().render(next);
  assert.equal(restored.querySelector('.other-text-input').value, '0,5 uL');
  assert.equal(restored.querySelector('.other-text-input').disabled, false);
  assert.equal(first.context.parseQuestionQuantity(restored.querySelector('.other-text-input').value, next), 500);
  const incompatible = memory.reload().render({ ...next, unit: 'mM', units: { mM: 1 } });
  assert.equal(incompatible.querySelector('.other-text-input').value, '');
});

test("restores Don't know, and a new answer replaces it", () => {
  const memory = memoryHarness();
  const first = memory.reload();
  const question = { id: 'details', question: 'Details?', type: 'single', options: [] };
  const slide = first.render(question);
  slide.dataset.unknown = 'true';
  first.context.rememberQuestionAnswer(question, slide);
  const second = memory.reload();
  const restored = second.render(question);
  assert.equal(restored.dataset.unknown, 'true');
  assert.equal(restored.querySelector('.q-unknown-btn').textContent, "Don't know ✓");
  const text = restored.querySelector('.other-text-input');
  text.value = 'Updated details';
  text.events.input[0]();
  const latest = memory.reload().render(question);
  assert.notEqual(latest.dataset.unknown, 'true');
  assert.equal(latest.querySelector('.other-text-input').value, 'Updated details');
});

test('does not restore removed options or reinterpret dimensionless values as quantities', () => {
  const memory = memoryHarness();
  const first = memory.reload();
  const question = { id: 'choice', question: 'Choose?', type: 'single', allow_other: false,
    options: [{ value: 'old', label: 'Old choice' }] };
  const slide = first.render(question);
  slide.querySelector('input').checked = true;
  first.context.rememberQuestionAnswer(question, slide);
  const restored = memory.reload().render({ ...question, options: [{ value: 'new', label: 'New choice' }] });
  assert.equal(restored.querySelectorAll('input:checked').length, 0);
  const number = { id: 'amount', question: 'Amount?', type: 'number', options: [], unit: '', units: { '': 1 } };
  const amount = first.render(number);
  amount.querySelector('.other-text-input').value = '12';
  first.context.rememberQuestionAnswer(number, amount);
  const quantity = memory.reload().render({ ...number, unit: 'uL', units: { uL: 1 } });
  assert.equal(quantity.querySelector('.other-text-input').value, '');
});
