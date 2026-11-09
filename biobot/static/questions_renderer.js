/**
 * questions_renderer.js — Stepper Question UI for BioBot
 *
 * Shows questions one at a time like a wizard:
 *   Q1: select answer → Next →
 *   Q2: select answer → Next →
 *   Q3: select answer → Submit →
 *   Answers checked before advancing, then compiled for generation.
 */

let questionAnswerMemory = null;

function questionAnswerCache() {
  const session = document.body?.dataset.answerSession || "";
  if (!questionAnswerMemory || questionAnswerMemory.session !== session) {
    questionAnswerMemory = { session, answers: {} };
    try {
      const stored = JSON.parse(sessionStorage.getItem("biobot-questionnaire-answers"));
      if (session && stored?.session === session && stored.answers && typeof stored.answers === "object") {
        questionAnswerMemory = stored;
      }
    } catch (_) {} // Storage may be unavailable; keep answers in memory instead.
  }
  return questionAnswerMemory;
}

function questionAnswerKeys(question) {
  return [`id:${question.id}`, `text:${question.question.trim().toLowerCase().replace(/\s+/g, " ")}`];
}

function rememberQuestionAnswer(question, slide) {
  const selected = [...slide.querySelectorAll("input:checked")];
  const custom = slide.querySelector(".other-text-input")?.value.trim() || "";
  const unknown = slide.dataset.unknown === "true";
  if (!unknown && (!selected.length || selected.some(input => input.value === "__other__") && !custom)) return;
  const cache = questionAnswerCache();
  const answer = {
    type: question.type || "single", unit: question.unit || "", unknown, custom,
    selected: selected.map(input => ({ value: input.value, label: input.dataset.label })),
  };
  for (const key of questionAnswerKeys(question)) cache.answers[key] = answer;
  try { sessionStorage.setItem("biobot-questionnaire-answers", JSON.stringify(cache)); } catch (_) {}
}

function restoreQuestionAnswer(question, slide) {
  const cache = questionAnswerCache();
  const saved = questionAnswerKeys(question).map(key => cache.answers[key]).find(Boolean);
  if (!saved || saved.type !== (question.type || "single")) return;
  if (saved.unknown) {
    slide.dataset.unknown = "true";
    slide.querySelector(".q-unknown-btn").textContent = "Don't know ✓";
    return;
  }
  const inputs = [...slide.querySelectorAll("input")].filter(input => input.name === `q_${question.id}`);
  let custom = saved.custom;
  // Keep the old unit attached if a new questionnaire changes the reference unit.
  if (question.type === "number" && saved.unit !== (question.unit || "")) {
    const previous = saved.selected[0];
    custom = previous.value === "__other__" ? saved.custom : previous.value;
    if (Number.isFinite(parseQuestionQuantity(custom, {}))) {
      if (!saved.unit) return;
      custom = `${custom} ${saved.unit}`;
    }
    if (!Number.isFinite(parseQuestionQuantity(custom, question))) return;
  }
  const changedUnit = question.type === "number" && saved.unit !== (question.unit || "");
  const matches = (changedUnit ? [{ value: "__other__" }] : saved.selected).map(option =>
    inputs.find(input => input.value === option.value || option.value !== "__other__" && input.dataset.label === option.label));
  if (!matches.length || matches.some(input => !input)) return;
  inputs.forEach(input => input.checked = matches.includes(input));
  const text = slide.querySelector(".other-text-input");
  if (text) {
    text.value = custom;
    text.disabled = !matches.some(input => input.value === "__other__");
  }
}

function renderQuestionsForm(parentDiv, questionsData) {
  const questions = questionsData.questions || [];
  if (questions.length === 0) return;

  const form = document.createElement("div");
  form.className = "biobot-questions-form";

  // Header
  if (questionsData.message) {
    const header = document.createElement("div");
    header.className = "questions-header";
    header.textContent = questionsData.message;
    form.appendChild(header);
  }

  // Progress bar
  const progressBar = document.createElement("div");
  progressBar.className = "questions-progress";
  progressBar.innerHTML = `<div class="questions-progress-fill" id="q-progress-fill"></div>`;
  form.appendChild(progressBar);

  // Progress label
  const progressLabel = document.createElement("div");
  progressLabel.className = "questions-progress-label";
  progressLabel.id = "q-progress-label";
  form.appendChild(progressLabel);

  // Question slides container
  const slidesContainer = document.createElement("div");
  slidesContainer.className = "questions-slides";
  slidesContainer.id = "q-slides";

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const slide = document.createElement("div");
    slide.className = "question-slide";
    slide.dataset.index = i;
    slide.dataset.qid = q.id;
    slide.dataset.qtype = q.type || "single";
    if (i > 0) slide.style.display = "none";

    // Question text
    const label = document.createElement("div");
    label.className = "question-label";
    label.textContent = q.question;
    slide.appendChild(label);

    // Options
    const optionsDiv = document.createElement("div");
    optionsDiv.className = "question-options";

    for (const opt of (q.options || [])) {
      const optLabel = document.createElement("label");
      optLabel.className = "question-option";

      const input = document.createElement("input");
      input.name = `q_${q.id}`;
      input.value = opt.value;
      input.dataset.label = opt.label;
      input.type = q.type === "multiple" ? "checkbox" : "radio";
      input.addEventListener("change", () => {
        clearUnknownAnswer(slide);
        rememberQuestionAnswer(q, slide);
      });

      // Auto-advance on selection for single-choice
      if (q.type !== "multiple") {
        input.addEventListener("change", () => {
          // Brief delay so the user sees the selection
          setTimeout(() => {
            const nextBtn = slide.querySelector(".q-next-btn");
            if (nextBtn) nextBtn.click();
          }, 300);
        });
      }

      const span = document.createElement("span");
      span.className = "option-label";
      span.textContent = opt.label;

      optLabel.appendChild(input);
      optLabel.appendChild(span);
      optionsDiv.appendChild(optLabel);
    }

    // Without suggestions, expose the text field directly.
    const textOnly = !(q.options || []).length;
    if (textOnly || q.allow_other !== false) {
      const otherLabel = document.createElement("label");
      otherLabel.className = "question-option other-option";

      const otherInput = document.createElement("input");
      otherInput.name = `q_${q.id}`;
      otherInput.value = "__other__";
      otherInput.dataset.label = "Other";
      otherInput.type = q.type === "multiple" ? "checkbox" : "radio";
      otherInput.hidden = textOnly;
      otherInput.checked = textOnly;

      const otherSpan = document.createElement("span");
      otherSpan.className = "option-label";
      otherSpan.textContent = "Other:";

      const otherText = document.createElement("input");
      otherText.type = "text";
      otherText.className = "other-text-input";
      otherText.placeholder = q.unit ? `Value and unit (${q.unit})` : "Type here...";
      otherText.setAttribute("aria-label", q.question);
      otherText.dataset.qid = q.id;
      otherText.disabled = !textOnly;
      otherText.addEventListener("input", () => {
        clearUnknownAnswer(slide);
        rememberQuestionAnswer(q, slide);
        if (q.type === "number") validateQuestionConstraints(form, questionsData, i, true);
      });

      otherInput.addEventListener("change", () => {
        clearUnknownAnswer(slide);
        otherText.disabled = !otherInput.checked;
        rememberQuestionAnswer(q, slide);
        if (otherInput.checked) otherText.focus();
      });

      if (q.type !== "multiple") {
        optionsDiv.querySelectorAll(`input[name="q_${q.id}"]`).forEach(inp => {
          inp.addEventListener("change", () => {
            otherText.disabled = !otherInput.checked;
          });
        });
      }

      // Enter in other text field → advance
      otherText.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && otherText.value.trim()) {
          const nextBtn = slide.querySelector(".q-next-btn, .q-submit-btn");
          if (nextBtn) nextBtn.click();
        }
      });

      otherLabel.appendChild(otherInput);
      if (!textOnly) otherLabel.appendChild(otherSpan);
      otherLabel.appendChild(otherText);
      optionsDiv.appendChild(otherLabel);
    }

    slide.appendChild(optionsDiv);

    // Navigation buttons
    const navRow = document.createElement("div");
    navRow.className = "question-nav";

    if (i > 0) {
      const backBtn = document.createElement("button");
      backBtn.className = "q-back-btn";
      backBtn.textContent = "← Back";
      backBtn.addEventListener("click", () => goToQuestion(i - 1, form));
      navRow.appendChild(backBtn);
    } else {
      navRow.appendChild(document.createElement("span")); // spacer
    }

    const unknownBtn = document.createElement("button");
    unknownBtn.className = "q-unknown-btn";
    unknownBtn.textContent = "Don't know";
    unknownBtn.addEventListener("click", () => {
      slide.dataset.unknown = "true";
      unknownBtn.textContent = "Don't know ✓";
      rememberQuestionAnswer(q, slide);
      if (!validateQuestionConstraints(form, questionsData, i)) return;
      if (i < questions.length - 1) goToQuestion(i + 1, form);
      else submitAllAnswers(form, parentDiv);
    });
    navRow.appendChild(unknownBtn);

    if (i < questions.length - 1) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "q-next-btn";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        if (validateSlide(slide) && validateQuestionConstraints(form, questionsData, i)) goToQuestion(i + 1, form);
      });
      navRow.appendChild(nextBtn);
    } else {
      const submitBtn = document.createElement("button");
      submitBtn.className = "q-submit-btn";
      submitBtn.textContent = "Continue";
      submitBtn.addEventListener("click", () => {
        if (validateSlide(slide) && validateQuestionConstraints(form, questionsData, i)) submitAllAnswers(form, parentDiv);
      });
      navRow.appendChild(submitBtn);
    }

    slide.appendChild(navRow);
    restoreQuestionAnswer(q, slide);
    slidesContainer.appendChild(slide);
  }

  form.appendChild(slidesContainer);
  parentDiv.innerHTML = "";
  parentDiv.appendChild(form);

  updateProgress(0, questions.length, form);
}


function goToQuestion(targetIndex, form) {
  const slides = form.querySelectorAll(".question-slide");
  slides.forEach((s, i) => {
    s.style.display = i === targetIndex ? "" : "none";
  });
  const total = slides.length;
  updateProgress(targetIndex, total, form);
}


function updateProgress(current, total, form) {
  const fill = form.querySelector("#q-progress-fill");
  const label = form.querySelector("#q-progress-label");
  const pct = ((current + 1) / total) * 100;
  if (fill) fill.style.width = pct + "%";
  if (label) label.textContent = `Question ${current + 1} of ${total}`;
}


function validateSlide(slide) {
  if (slide.dataset.unknown === "true") return true;
  const qid = slide.dataset.qid;
  const checked = slide.querySelectorAll(`input[name="q_${qid}"]:checked`);

  if (checked.length === 0) {
    slide.classList.add("unanswered");
    setTimeout(() => slide.classList.remove("unanswered"), 1500);
    return false;
  }

  // If "Other" is selected, check that text is filled
  for (const input of checked) {
    if (input.value === "__other__") {
      const otherText = slide.querySelector(`.other-text-input[data-qid="${qid}"]`);
      if (!otherText || !otherText.value.trim()) {
        otherText.style.borderColor = "#ff4d4d";
        otherText.focus();
        return false;
      }
    }
  }

  return true;
}


function collectQuestionAnswers(form) {
  const slides = form.querySelectorAll(".question-slide");
  const answers = [];

  for (const slide of slides) {
    const qid = slide.dataset.qid;
    const questionText = slide.querySelector(".question-label").textContent;
    if (slide.dataset.unknown === "true") {
      answers.push({ question: questionText, answers: ["Don't know — suggest a suitable default if possible."] });
      continue;
    }
    const checked = slide.querySelectorAll(`input[name="q_${qid}"]:checked`);

    const selectedLabels = [];
    for (const input of checked) {
      if (input.value === "__other__") {
        const otherText = slide.querySelector(`.other-text-input[data-qid="${qid}"]`);
        if (otherText && otherText.value.trim()) selectedLabels.push(otherText.value.trim());
      } else {
        selectedLabels.push(input.dataset.label);
      }
    }

    if (selectedLabels.length > 0) {
      answers.push({ question: questionText, answers: selectedLabels });
    }
  }

  return answers;
}


// Units and their conversion factors come from the generated questionnaire.
function parseQuestionQuantity(raw, question) {
  const match = String(raw).trim().match(/^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(.*?)$/i);
  if (!match) return NaN;
  const normalize = unit => unit.replace(/[µμ]/g, "u").replace(/\s+/g, "");
  const unit = normalize(match[2] || question.unit || "");
  const units = { ...question.units, [question.unit || ""]: 1 };
  const entry = Object.entries(units).find(([name]) => normalize(name) === unit);
  const factor = entry?.[1];
  return typeof factor === "number" && factor > 0
    ? Number(match[1].replace(",", ".")) * factor : NaN;
}


// Numeric relationships are supplied with the questionnaire, never executed as code.
function validateQuestionConstraints(form, questionsData, throughIndex, live = false) {
  const slides = [...form.querySelectorAll(".question-slide")];
  form.querySelectorAll(".question-validation").forEach(el => el.textContent = "");
  const values = new Map();
  for (const slide of slides.slice(0, throughIndex + 1)) {
    if (slide.dataset.qtype !== "number" || slide.dataset.unknown === "true") continue;
    const input = slide.querySelector("input:checked");
    if (!input) continue;
    const raw = input.value === "__other__"
      ? slide.querySelector(".other-text-input").value.trim() : input.value;
    const question = (questionsData.questions || []).find(q => q.id === slide.dataset.qid) || {};
    // Older saved questionnaires may predate unit metadata; do not call them unitless.
    if (!Object.hasOwn(question, "unit") && !Object.hasOwn(question, "units") && /[^\d\s.,eE+\-]/.test(raw)) {
      showQuestionError(slide, "This saved question has no unit definitions. Please request a new questionnaire to validate quantities with units.");
      return false;
    }
    const value = input.value === "__other__" ? parseQuestionQuantity(raw, question) : Number(raw);
    if (!Number.isFinite(value)) {
      const units = Object.keys({ ...question.units, ...(question.unit ? { [question.unit]: 1 } : {}) });
      showQuestionError(slide, units.length
        ? `Enter a number, optionally followed by a supported unit: ${units.join(", ")}.`
        : "Enter a number.");
      if (!live) goToQuestion(slides.indexOf(slide), form);
      return false;
    }
    values.set(slide.dataset.qid, value);
  }
  const comparisons = {
    lt: (a, b) => a < b, lte: (a, b) => a <= b,
    gt: (a, b) => a > b, gte: (a, b) => a >= b, eq: (a, b) => a === b,
  };
  for (const constraint of questionsData.constraints || []) {
    const left = values.get(constraint.left);
    const right = typeof constraint.right === "number" ? constraint.right : values.get(constraint.right);
    // A dependency may not have been answered yet.
    if (left === undefined || right === undefined) continue;
    if (!comparisons[constraint.operator]?.(left, right)) {
      const slide = slides[throughIndex];
      showQuestionError(slide, constraint.message || "These answers conflict. Please correct them before continuing.");
      return false;
    }
  }
  return true;
}


function showQuestionError(slide, message) {
  let notice = slide.querySelector(".question-validation");
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "question-validation";
    notice.setAttribute("role", "alert");
    slide.appendChild(notice);
  }
  notice.textContent = message;
}


function clearUnknownAnswer(slide) {
  slide.dataset.unknown = "false";
  const button = slide.querySelector(".q-unknown-btn");
  if (button) button.textContent = "Don't know";
}

function submitAllAnswers(form, parentDiv) {
  if (typeof sendMessage !== "function" || !currentChatId || isTyping) return;
  const answers = collectQuestionAnswers(form);
  // Disable the form
  form.querySelectorAll("input, button").forEach(el => el.disabled = true);

  // Show all slides as a summary
  const slides2 = form.querySelectorAll(".question-slide");
  slides2.forEach(s => s.style.display = "none");

  const summary = document.createElement("div");
  summary.className = "questions-summary";
  summary.innerHTML = `<div class="summary-title">Your selections:</div>`;
  for (const a of answers) {
    summary.innerHTML += `<div class="summary-item"><span class="summary-q">${a.question}</span><span class="summary-a">${a.answers.join(", ")}</span></div>`;
  }
  summary.innerHTML += `<div class="summary-generating"><span class="rag-spinner"></span> Reviewing your answers...</div>`;
  const indicator = window.workspace?.analyzingIcon();
  if (indicator) summary.querySelector(".rag-spinner")?.replaceWith(indicator);
  form.appendChild(summary);

  // Build the message from answers; the server rechecks completeness and consistency.
  const lines = ["[PROTOCOL_PARAMS]"];
  for (const a of answers) {
    lines.push(`${a.question} ${a.answers.join(", ")}`);
  }
  const message = lines.join("\n");

  // Tie the progress indicator to the request that reviews these answers.
  sendMessage({ message, questionnaireSummary: summary });
}

window.renderQuestionsForm = renderQuestionsForm;
