/**
 * questions_renderer.js — Stepper Question UI for BioBot
 *
 * Shows questions one at a time like a wizard:
 *   Q1: select answer → Next →
 *   Q2: select answer → Next →
 *   Q3: select answer → Submit →
 *   All answers compiled into one message → code generates
 */

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

    // "Other" option
    if (q.allow_other !== false) {
      const otherLabel = document.createElement("label");
      otherLabel.className = "question-option other-option";

      const otherInput = document.createElement("input");
      otherInput.name = `q_${q.id}`;
      otherInput.value = "__other__";
      otherInput.dataset.label = "Other";
      otherInput.type = q.type === "multiple" ? "checkbox" : "radio";

      const otherSpan = document.createElement("span");
      otherSpan.className = "option-label";
      otherSpan.textContent = "Other:";

      const otherText = document.createElement("input");
      otherText.type = "text";
      otherText.className = "other-text-input";
      otherText.placeholder = "Type here...";
      otherText.dataset.qid = q.id;
      otherText.disabled = true;

      otherInput.addEventListener("change", () => {
        otherText.disabled = !otherInput.checked;
        if (otherInput.checked) otherText.focus();
      });

      if (q.type === "single") {
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
      otherLabel.appendChild(otherSpan);
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

    if (i < questions.length - 1) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "q-next-btn";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        if (validateSlide(slide)) goToQuestion(i + 1, form);
      });
      navRow.appendChild(nextBtn);
    } else {
      const submitBtn = document.createElement("button");
      submitBtn.className = "q-submit-btn";
      submitBtn.textContent = "Generate Protocol";
      submitBtn.addEventListener("click", () => {
        if (validateSlide(slide)) submitAllAnswers(form, parentDiv, questions);
      });
      navRow.appendChild(submitBtn);
    }

    slide.appendChild(navRow);
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


function submitAllAnswers(form, parentDiv, questions) {
  const slides = form.querySelectorAll(".question-slide");
  const answers = [];

  for (const slide of slides) {
    const qid = slide.dataset.qid;
    const questionText = slide.querySelector(".question-label").textContent;
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
  summary.innerHTML += `<div class="summary-generating"><span class="rag-spinner"></span> Generating protocol...</div>`;
  form.appendChild(summary);

  // Build the message from answers — prefix with marker to skip sufficiency check
  const lines = ["[PROTOCOL_PARAMS]"];
  for (const a of answers) {
    lines.push(`${a.question} ${a.answers.join(", ")}`);
  }
  const message = lines.join("\n");

  // Send as a regular user message
  const input = document.getElementById("user-input");
  if (input) {
    input.value = message;
    if (typeof sendMessage === "function") {
      sendMessage();
    }
  }
}

window.renderQuestionsForm = renderQuestionsForm;