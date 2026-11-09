/* ========================================
   BioBot — Chat UI Script
   ======================================== */

const chatListElem = document.getElementById("chat-list");
const chatHistoryElem = document.getElementById("chat-history");
const userInputElem = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const newChatBtn = document.getElementById("new-chat");

let currentChatId = null;
let isTyping = false;
let showingTrash = false;
let chatRequestController = null;
let chatRequestDone = Promise.resolve();
const chatJobs = new Map();
let chatLoadVersion = 0;
let autoScrollEnabled = true;

window.syncChatActivity = syncChatActivity;
function syncChatActivity() {
  const job = chatJobs.get(currentChatId);
  isTyping = job?.status === "running";
  chatRequestController = isTyping ? job.controller : null;
  chatRequestDone = isTyping ? job.done : Promise.resolve();
  sendBtn.disabled = isTyping;
  window.workspace?.syncActions();
  for (const row of chatListElem.children) {
    row.querySelector(".chat-status")?.remove();
    let activity = chatJobs.get(row.dataset.chatId) || {status:row.dataset.runStatus};
    if (activity?.status !== "running" && window.exportingChats?.has(row.dataset.chatId)) activity = {status:"exporting"};
    if (!activity?.status || activity.status === "read") continue;
    const dot = document.createElement("span");
    dot.className = `chat-status ${activity.status}`;
    const label = {running:"In progress", done:"Finished", error:"An issue occurred", exporting:"Generating code"}[activity.status];
    dot.title = label; dot.setAttribute("role", "img"); dot.setAttribute("aria-label", label);
    row.prepend(dot);
  }
}


// --- Auto-scroll detection ---
// Instead of trying to distinguish programmatic vs user scroll events
// (which is unreliable), we detect user scroll INTENT via input events
// (wheel, touch, pointer on scrollbar). When the user actively scrolls
// up, we disable auto-scroll. We re-enable it only when:
//   1. The user scrolls back near the bottom, OR
//   2. The user sends a new message.

let _userIsInteracting = false;

// Detect user scroll intent via input events
chatHistoryElem.addEventListener("wheel", (e) => {
  if (e.deltaY < 0) {
    // Scrolling up — user wants to read previous messages
    autoScrollEnabled = false;
  }
}, { passive: true });

chatHistoryElem.addEventListener("touchstart", () => {
  _userIsInteracting = true;
}, { passive: true });

chatHistoryElem.addEventListener("touchmove", () => {
  if (_userIsInteracting) {
    // During touch interaction, check if user scrolled away from bottom
    const distFromBottom = chatHistoryElem.scrollHeight - chatHistoryElem.scrollTop - chatHistoryElem.clientHeight;
    if (distFromBottom > 80) {
      autoScrollEnabled = false;
    }
  }
}, { passive: true });

chatHistoryElem.addEventListener("touchend", () => {
  _userIsInteracting = false;
  // Re-enable if they scrolled back to bottom
  const distFromBottom = chatHistoryElem.scrollHeight - chatHistoryElem.scrollTop - chatHistoryElem.clientHeight;
  if (distFromBottom < 60) {
    autoScrollEnabled = true;
  }
}, { passive: true });

// Also handle scrollbar dragging (mousedown on the scrollbar area)
chatHistoryElem.addEventListener("pointerdown", (e) => {
  // Detect click on scrollbar: click position is beyond the content width
  if (e.offsetX > chatHistoryElem.clientWidth) {
    _userIsInteracting = true;
  }
});

document.addEventListener("pointerup", () => {
  if (_userIsInteracting) {
    _userIsInteracting = false;
    const distFromBottom = chatHistoryElem.scrollHeight - chatHistoryElem.scrollTop - chatHistoryElem.clientHeight;
    if (distFromBottom < 60) {
      autoScrollEnabled = true;
    }
  }
});

// Periodic check: if user has somehow scrolled back to bottom, re-enable
chatHistoryElem.addEventListener("scroll", () => {
  if (!autoScrollEnabled) {
    const distFromBottom = chatHistoryElem.scrollHeight - chatHistoryElem.scrollTop - chatHistoryElem.clientHeight;
    if (distFromBottom < 30) {
      autoScrollEnabled = true;
    }
  }
});

function scrollToBottom() {
  if (!autoScrollEnabled) return;
  chatHistoryElem.scrollTop = chatHistoryElem.scrollHeight;
}

// --- Auto-resize textarea ---
userInputElem.addEventListener("input", () => {
  userInputElem.style.height = "auto";
  userInputElem.style.height = Math.min(userInputElem.scrollHeight, 200) + "px";
});

// --- Mobile sidebar toggle ---
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const sidebarToggle = document.getElementById("sidebar-toggle");

function openSidebar() {
  sidebar.classList.add("open");
  sidebarOverlay.classList.add("active");
  sidebarToggle?.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarOverlay.classList.remove("active");
  sidebarToggle?.setAttribute("aria-expanded", "false");
}

if (sidebarToggle) {
  sidebarToggle.addEventListener("click", () => sidebar.classList.contains("open") ? closeSidebar() : openSidebar());
}
if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", closeSidebar);
}

const sidebarCollapseBtn = document.getElementById("sidebar-collapse-btn");
function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle("collapsed", collapsed);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  sidebarCollapseBtn?.setAttribute("aria-expanded", String(!collapsed));
  sidebarCollapseBtn?.setAttribute("aria-label", label);
  if (sidebarCollapseBtn) sidebarCollapseBtn.title = label;
}
try { setSidebarCollapsed(localStorage.getItem("biobot-sidebar-collapsed") === "true"); } catch (_) {}
sidebarCollapseBtn?.addEventListener("click", () => {
  const collapsed = !sidebar.classList.contains("collapsed");
  setSidebarCollapsed(collapsed);
  try { localStorage.setItem("biobot-sidebar-collapsed", String(collapsed)); } catch (_) {}
});

// --- Escape HTML ---
// Fix invalid JSON from LLMs (trailing commas before ] or })
function fixTrailingCommas(jsonStr) {
  return jsonStr.replace(/,\s*([\]}])/g, '$1');
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Format config for code blocks ---
const FORMAT_CONFIG = {
  python: { label: "python", mime: "text/x-python", ext: ".py", filename: "generated_script.py" },
  csv:    { label: "csv",    mime: "text/csv",       ext: ".csv", filename: "output.csv" },
  json:   { label: "json",   mime: "application/json", ext: ".json", filename: "output.json" },
  xml:    { label: "xml",    mime: "text/xml",       ext: ".xml", filename: "output.xml" },
  text:   { label: "text",   mime: "text/plain",     ext: ".txt", filename: "output.txt" },
};

// --- Detect content format from the text itself ---
// Uses multi-line scoring to correctly identify Python code even when it
// starts with docstrings (""") or comments (#) instead of imports.
function detectFormat(content) {
  const trimmed = content.trim();
  if (!trimmed) return "text";

  // Priority 1: markdown fence language tag
  const fenceMatch = trimmed.match(/^```(\w+)/);
  if (fenceMatch) {
    const lang = fenceMatch[1].toLowerCase();
    const aliases = { py: "python", javascript: "js", yml: "yaml" };
    return aliases[lang] || lang;
  }

  // Priority 2: shebang
  const firstLine = trimmed.split("\n")[0];
  if (/^#!.*\bpython[\d.]*\b/.test(firstLine)) return "python";

  // Priority 3: non-Python structured formats
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.includes("</") && !trimmed.startsWith("#"))) return "xml";

  // Priority 4: multi-line Python scoring — scan up to 80 lines
  const lines = trimmed.split("\n");
  const scanLimit = Math.min(lines.length, 80);
  let score = 0;
  let hasTripleQuote = false;

  for (let i = 0; i < scanLimit; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Strong signals (+3)
    if (/^(import |from \S+ import )/.test(line)) { score += 3; continue; }
    if (/^(def |class )\w/.test(line)) { score += 3; continue; }

    // Dictionary assignment (+2), independent of application/API identifiers.
    if (/^[A-Za-z_]\w*\s*=\s*\{/.test(line)) { score += 2; continue; }

    // Control flow (+1)
    if (/^(if |elif |else:|for |while |try:|except |with |return |raise )/.test(line)) { score += 1; continue; }

    // Method calls like  variable.method( (+1)
    if (/^\w+\.\w+\(/.test(line)) { score += 1; continue; }

    // Triple-quote docstrings (+1, once)
    if (!hasTripleQuote && (line.includes('"""') || line.includes("'''"))) { hasTripleQuote = true; score += 1; continue; }

    // Python comments (+0.5)
    if (line.startsWith("#") && !line.startsWith("#!")) { score += 0.5; continue; }

    // Early exit if already confident
    if (score >= 6) break;
  }

  if (score >= 3) return "python";

  // Priority 5: CSV — needs 2+ commas on first line AND 2+ data rows
  if (firstLine.includes(",")) {
    const commaCount = (firstLine.match(/,/g) || []).length;
    const csvRows = lines.filter(l => l.includes(",")).length;
    if (commaCount >= 2 && csvRows >= 2) return "csv";
  }

  return "text";
}

// Chat keeps a reference to the file; its contents are shown only below the deck.
function buildDeckLink(code) {
  const link = document.createElement("span");
  link.className = "protocol-deck-link";
  link.hidden = true;
  link._protocolCode = code;
  return link;
}

// --- Build a styled code block with copy + download buttons ---
function buildCodeBlock(code, format = "text") {
  const config = FORMAT_CONFIG[format] || FORMAT_CONFIG.text;

  const wrapper = document.createElement("div");
  wrapper.className = "code-block-wrapper";

  // Top toolbar with language label + action buttons
  const toolbar = document.createElement("div");
  toolbar.className = "code-toolbar";

  const langLabel = document.createElement("span");
  langLabel.className = "code-lang-label";
  langLabel.textContent = config.label;

  const actions = document.createElement("div");
  actions.className = "code-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "code-action-btn";
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
      setTimeout(() => {
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
      }, 1500);
    }).catch(err => console.error("Copy error:", err));
  });

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "code-action-btn";
  downloadBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download';
  downloadBtn.addEventListener("click", () => {
    const blob = new Blob([code], { type: config.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = config.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  actions.appendChild(copyBtn);
  actions.appendChild(downloadBtn);

  // Add Deck button for any code that looks like a protocol/picklist
  if (code.length > 50 && (code.includes("(") || code.includes(","))) {
    const deckBtn = document.createElement("button");
    deckBtn.className = "code-action-btn deck-action-btn";
    deckBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Deck';
    deckBtn.addEventListener("click", () => {
      if (window.parseDeckFromCode) {
        window.parseDeckFromCode(code, wrapper);
      }
    });
    actions.appendChild(deckBtn);
  }

  // Add thumbs-up button for code approval (stores working code in docs for RAG)
  if (code.length > 50) {
    const approveBtn = document.createElement("button");
    approveBtn.className = "code-action-btn approve-action-btn";
    approveBtn.title = "Mark as working. This code will be saved to improve future generations";
    approveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';

    approveBtn.addEventListener("click", async () => {
      if (approveBtn.classList.contains("approved")) return;

      try {
        const res = await fetch("/code/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, chat_id: currentChatId || "" }),
        });

        if (res.ok) {
          approveBtn.classList.add("approved");
          approveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
          approveBtn.title = "Saved as verified working code";
        }
      } catch (e) {
        console.error("Approve error:", e);
      }
    });
    actions.appendChild(approveBtn);

    // Reject button (thumbs-down) — save failed code + user remark
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "code-action-btn reject-action-btn";
    rejectBtn.title = "Report as not working. Add a note about what went wrong";
    rejectBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';

    rejectBtn.addEventListener("click", () => {
      if (rejectBtn.classList.contains("rejected")) return;
      showRejectModal(code, rejectBtn);
    });
    actions.appendChild(rejectBtn);
  }

  toolbar.appendChild(langLabel);
  toolbar.appendChild(actions);

  const pre = document.createElement("pre");
  pre.className = "code-block-pre";
  const codeElem = document.createElement("code");

  // Render line-by-line so deck animation can highlight individual lines
  const lines = code.split("\n");
  const previewLines = 8;
  for (let i = 0; i < lines.length; i++) {
    const lineDiv = document.createElement("div");
    lineDiv.className = "code-line";
    lineDiv.dataset.line = i + 1;
    lineDiv.hidden = i >= previewLines;

    const lineNum = document.createElement("span");
    lineNum.className = "code-line-num";
    lineNum.textContent = i + 1;

    const lineText = document.createElement("span");
    lineText.className = "code-line-text";
    lineText.textContent = lines[i] || " ";  // preserve empty lines

    lineDiv.appendChild(lineNum);
    lineDiv.appendChild(lineText);
    codeElem.appendChild(lineDiv);
  }

  pre.appendChild(codeElem);

  wrapper.appendChild(toolbar);
  wrapper.appendChild(pre);
  if (lines.length > previewLines) {
    const toggle = document.createElement("button");
    toggle.className = "code-action-btn code-preview-toggle";
    toggle.type = "button";
    toggle.textContent = `Show full file · ${lines.length} lines`;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      codeElem.querySelectorAll(".code-line").forEach((line, index) => {
        line.hidden = !expanded && index >= previewLines;
      });
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.textContent = expanded ? "Collapse file" : `Show full file · ${lines.length} lines`;
    });
    wrapper.appendChild(toggle);
  }
  return wrapper;
}

// --- Create a message element ---
function addMessage(text, sender, messageId = null, target = chatHistoryElem) {
  const div = document.createElement("div");
  div.className = `chat-message ${sender === "user" ? "chat-user" : "chat-bot"}`;
  target.appendChild(div);
  if (target.isConnected) scrollToBottom();

  if (sender === "user") {
    renderUserMessage(div, text, messageId);
    scrollToBottom();
    return div;
  }

  // For bot: initially empty, we'll stream into this div
  div._buffer = "";
  return div;
}

// --- Edit a saved prompt and regenerate its continuation ---
function renderUserMessage(div, text, messageId) {
  div.replaceChildren();
  const questionnaireAnswers = text.startsWith("[PROTOCOL_PARAMS]");
  div.classList.toggle("hidden", questionnaireAnswers);
  if (questionnaireAnswers) return; // Already shown in the questionnaire summary.
  const content = document.createElement("div");
  content.className = "user-message-content";
  content.textContent = text;
  div.appendChild(content);
  if (!messageId) return;

  const editBtn = document.createElement("button");
  editBtn.className = "message-edit-btn";
  editBtn.title = "Edit prompt";
  editBtn.setAttribute("aria-label", "Edit prompt");
  editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/></svg>';
  editBtn.addEventListener("click", () => {
    if (isTyping) return;
    const chatId = currentChatId;
    const textarea = document.createElement("textarea");
    textarea.className = "message-edit-input";
    textarea.setAttribute("aria-label", "Edit your prompt");
    textarea.value = content.textContent;
    const note = document.createElement("div");
    note.className = "message-edit-note";
    note.textContent = "Saving replaces the replies and messages after this prompt.";
    const actions = document.createElement("div");
    actions.className = "message-edit-actions";
    const save = document.createElement("button");
    save.className = "message-edit-btn";
    save.title = "Save & regenerate";
    save.setAttribute("aria-label", "Save & regenerate");
    save.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    save.addEventListener("click", () => {
      const edited = textarea.value.trim();
      if (!edited || isTyping || currentChatId !== chatId) return;
      const message = text.startsWith("[PROTOCOL_PARAMS]") ? "[PROTOCOL_PARAMS]\n" + edited : edited;
      sendMessage({ message, messageId, div });
    });
    const cancel = document.createElement("button");
    cancel.className = "message-edit-btn";
    cancel.title = "Cancel editing";
    cancel.setAttribute("aria-label", "Cancel editing");
    cancel.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
    cancel.addEventListener("click", () => renderUserMessage(div, text, messageId));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancel.click();
    });
    actions.append(save, cancel);
    const editor = document.createElement("div");
    editor.className = "user-message-content";
    editor.appendChild(textarea);
    div.replaceChildren(editor, note, actions);
    textarea.focus();
  });
  const copyBtn = document.createElement("button");
  copyBtn.className = "message-edit-btn";
  copyBtn.title = "Copy prompt";
  copyBtn.setAttribute("aria-label", "Copy prompt");
  copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(content.textContent);
      copyBtn.title = "Copied!";
      copyBtn.setAttribute("aria-label", "Copied!");
      setTimeout(() => {
        copyBtn.title = "Copy prompt";
        copyBtn.setAttribute("aria-label", "Copy prompt");
      }, 1500);
    } catch (error) {
      copyBtn.title = "Unable to copy. Please select the text and copy it.";
    }
  });
  const regenerateBtn = document.createElement("button");
  regenerateBtn.className = "message-edit-btn";
  regenerateBtn.title = "Regenerate response (replaces following messages)";
  regenerateBtn.setAttribute("aria-label", "Regenerate response");
  regenerateBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17"/></svg>';
  regenerateBtn.addEventListener("click", () => {
    if (isTyping) return;
    sendMessage({ message: text, messageId, div });
  });
  const actions = document.createElement("div");
  actions.className = "message-edit-actions";
  actions.append(copyBtn, editBtn, regenerateBtn);
  div.appendChild(actions);
}

// --- Append chunk to bot message (handles code blocks) ---
function appendChunkToBotMessage(div, chunk) {
  div._buffer += chunk;
  while (div._buffer) {
    const start = div._buffer.indexOf("```");
    if (start < 0) {
      // A network read may end partway through the opening fence.
      const trailing = div._buffer.match(/`{1,2}$/)?.[0] || "";
      const text = div._buffer.slice(0, div._buffer.length - trailing.length);
      if (text) div.appendChild(document.createTextNode(text));
      div._buffer = trailing;
      break;
    }
    if (start > 0) {
      div.appendChild(document.createTextNode(div._buffer.slice(0, start)));
      div._buffer = div._buffer.slice(start);
    }
    const header = div._buffer.indexOf("\n");
    if (header < 0) break;
    const end = div._buffer.indexOf("```", header + 1);
    if (end < 0) break;
    div.appendChild(buildDeckLink(div._buffer.slice(header + 1, end)));
    div._buffer = div._buffer.slice(end + 3);
  }

  if (div.isConnected) scrollToBottom();
}

function renderChatMessages(messages, target = chatHistoryElem) {
  const renderMessage = (text, sender, id) => addMessage(text, sender, id, target);
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      const msg = messages[msgIdx];
      if (msg.role === "user") {
        // Internal questionnaire submissions stay hidden; their summary is displayed on the left.
        renderMessage(msg.content || "", "user", msg.id);
      } else if (msg.role === "assistant") {
        const content = msg.content || "";

        // Skip null/empty messages
        if (!content || content === "null" || content === "None") continue;
        if (content.startsWith("Hello, I'm Biobot 🤖")) continue;

        // Skip encrypted-but-unreadable messages
        if (content.startsWith("gAAAAAB") || content === "[Message encrypted with a previous password]") {
          const botDiv = renderMessage("", "bot");
          botDiv.innerHTML = `<span style="color:#888;font-style:italic">${content.startsWith("gAAAAAB") ? "[Message from a previous session]" : content}</span>`;
          continue;
        }

        const botDiv = renderMessage("", "bot");

        // Check for structured questions (with or without markers/fences)
        if (content.includes("__QUESTIONS__:") || content.includes('"questions"')) {
          let questionsJson = content;
          if (questionsJson.includes("__QUESTIONS__:")) {
            questionsJson = questionsJson.split("__QUESTIONS__:").pop();
          }
          questionsJson = questionsJson.replace(/^```\w*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

          try {
            const questionsData = JSON.parse(fixTrailingCommas(questionsJson));
            if (questionsData.questions) {
              // Look ahead: were these questions already answered?
              const nextUserMsg = messages.slice(msgIdx + 1).find(m => m.role === "user");
              const wasAnswered = nextUserMsg && nextUserMsg.content && nextUserMsg.content.includes("[PROTOCOL_PARAMS]");

              if (wasAnswered) {
                // Show read-only summary of the answers
                const answersText = nextUserMsg.content.replace(/^\[PROTOCOL_PARAMS\]\n?/, "");
                const answerLines = answersText.split("\n").filter(l => l.trim());

                let html = `<div class="questions-summary">`;
                html += `<div class="summary-title">${escapeHtml(questionsData.message || "Your selections:")}</div>`;
                for (const line of answerLines) {
                  const qMark = line.indexOf("?");
                  if (qMark > -1) {
                    html += `<div class="summary-item"><span class="summary-q">${escapeHtml(line.substring(0, qMark + 1))}</span><span class="summary-a">${escapeHtml(line.substring(qMark + 1).trim())}</span></div>`;
                  } else {
                    html += `<div class="summary-item"><span class="summary-a">${escapeHtml(line)}</span></div>`;
                  }
                }
                html += `</div>`;
                botDiv.innerHTML = html;
              } else if (window.renderQuestionsForm) {
                // Not yet answered — show interactive form
                window.renderQuestionsForm(botDiv, questionsData);
              }
              continue;
            }
          } catch (e) {
            // Fall through to regular rendering
          }
        }

        // Check for markdown-fenced code blocks
        const codeBlockRegex = /```(\w*)\s*\n([\s\S]*?)```/g;
        let match;
        let lastIndex = 0;
        let hasCodeBlock = false;

        while ((match = codeBlockRegex.exec(content)) !== null) {
          hasCodeBlock = true;
          // Text before the code block
          const before = content.slice(lastIndex, match.index).trim();
          if (before) {
            const textP = document.createElement("p");
            textP.innerHTML = escapeHtml(before).replace(/\n/g, "<br>");
            botDiv.appendChild(textP);
          }
          // The code block itself
          botDiv.appendChild(buildDeckLink(match[2]));
          lastIndex = codeBlockRegex.lastIndex;
        }

        if (hasCodeBlock) {
          // Text after the last code block
          const after = content.slice(lastIndex).trim();
          if (after) {
            const textP = document.createElement("p");
            textP.innerHTML = escapeHtml(after).replace(/\n/g, "<br>");
            botDiv.appendChild(textP);
          }
        } else {
          // No markdown fences — try detecting format from content
          const detectedFmt = detectFormat(content);
          if (detectedFmt !== "text" && content.trim().split("\n").length > 3) {
            botDiv.appendChild(buildDeckLink(content));
          } else {
            botDiv.innerHTML = escapeHtml(content).replace(/\n/g, "<br>");
          }
        }
      }
    }
}

async function resumeChatRun(chat) {
  if (chatJobs.has(chat.chat_id)) return;
  const view = document.createElement("div"); view.className = "chat-session-view";
  const job = {view, status:"running", done:Promise.resolve(), device:chat.device};
  chatJobs.set(chat.chat_id, job);
  syncChatActivity();
  try {
    const response = await fetch(`/chat/${chat.chat_id}`);
    if (!response.ok) throw new Error("Could not reconnect to this chat.");
    const messages = await response.json();
    renderChatMessages(messages.filter(message => message.id <= chat.run.message_id), view);
    await sendMessage({resume:chat.run, chatId:chat.chat_id});
  } catch (error) {
    job.status = "error";
    addMessage(error.message, "bot", null, view);
    syncChatActivity();
  }
}

// --- Load chat history ---
async function loadChatHistory(chatId) {
  if (!chatId) return;
  const loadVersion = ++chatLoadVersion;
  currentChatId = chatId;
  window.workspace?.switchChat();
  localStorage.setItem("lastChatId", chatId);
  chatHistoryElem.innerHTML = "";
  selectChatListItem(chatId);
  closeSidebar();

  if (window.workspace?.needsDevice?.(chatId)) {
    window.clearDeckPanel?.();
    window.workspace.landing();
    syncChatActivity();
    return;
  }

  // Keep the deck frame visible while the selected chat's layout loads.
  if (window.clearDeckPanel) window.clearDeckPanel({keepOpen:true});
  window.workspace?.enterChat();
  const job = chatJobs.get(chatId);
  if (job && job.status !== "running") job.status = "read";
  if (!job || job.status !== "running") {
    fetch(`/chat/${chatId}/read`, {method:"POST"}).catch(console.error);
    const row = Array.from(chatListElem.children).find(row=>row.dataset.chatId === chatId);
    if (row) row.dataset.runStatus = "read";
  }
  syncChatActivity();
  if (job) {
    chatHistoryElem.appendChild(job.view);
    window.workspace?.restoreChat(chatId, job.device);
    return;
  }

  try {
    const res = await fetch(`/chat/${chatId}`);
    if (res.status === 404) {
      console.warn("No conversation found for this chat.");
      return;
    }
    if (!res.ok) {
      alert("Unexpected error loading chat.");
      return;
    }

    const messages = await res.json();
    if (currentChatId !== chatId || loadVersion !== chatLoadVersion) return;
    renderChatMessages(messages);
    window.workspace?.restoreChat(chatId);
  } catch (e) {
    alert(e.message);
  }
}

// --- Conversation Trash ---
function setTrashView(show) {
  showingTrash = show;
  document.querySelector(".chat-list-label").textContent = show ? "Trash" : "Recent chats";
  const button = document.getElementById("trash-btn");
  button?.classList.toggle("active", show);
  button?.setAttribute("aria-pressed", String(show));
  if (button) button.title = show ? "Show conversations" : "Open Trash";
}

async function trashChat(chatId, row) {
  row?.remove();
  try {
    const response = await fetch(`/chat/${chatId}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not move the conversation to Trash.");
    if (chatId === currentChatId) {
      chatRequestController?.abort();
      await chatRequestDone;
      localStorage.removeItem("lastChatId");
      setTrashView(false);
      const chats = await refreshChatList();
      if (chats.length) await loadChatHistory(chats[0].chat_id);
      else await createNewChat();
    } else {
      await refreshChatList();
      selectChatListItem(currentChatId);
    }
  } catch (error) {
    alert(error.message);
    await refreshChatList();
    selectChatListItem(currentChatId);
  }
}

async function restoreChat(chatId) {
  try {
    const response = await fetch(`/chat/${chatId}/restore`, { method: "POST" });
    if (!response.ok) throw new Error("Could not restore the conversation.");
    setTrashView(false);
    await refreshChatList();
    await loadChatHistory(chatId);
  } catch (error) { alert(error.message); }
}

// Close modals on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', () => {
    backdrop.closest('.modal').classList.add('hidden');
  });
});

// --- Refresh chat list ---
async function refreshChatList() {
  const trashView = showingTrash;
  const res = await fetch(trashView ? "/chats?trashed=1" : "/chats");
  if (!res.ok) return [];

  const chatList = await res.json();
  if (trashView !== showingTrash) return [];
  chatListElem.innerHTML = "";

  for (const chat of chatList) {
    window.workspace?.rememberChat(chat);
    if (!trashView && chat.run?.status === "running") resumeChatRun(chat);
    const li = document.createElement("li");
    li.dataset.chatId = chat.chat_id;
    li.dataset.runStatus = chat.run && !chat.run.seen ? chat.run.status : "read";

    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-name";
    nameSpan.textContent = chat.name;
    const info = document.createElement("div");
    info.className = "chat-list-info";
    const titleRow = document.createElement("div");
    titleRow.className = "chat-title-row";
    titleRow.appendChild(nameSpan);
    info.appendChild(titleRow);
    const chatDevice = chat.device || chatJobs.get(chat.chat_id)?.device;
    if (chatDevice) {
      const device = document.createElement("small");
      device.className = "chat-device";
      device.textContent = chatDevice;
      info.appendChild(device);
    }
    li.appendChild(info);

    const menu = document.createElement("div");
    menu.className = "chat-options";
    menu.innerHTML = trashView
      ? `<button type="button" class="restore-chat-btn" title="Restore conversation" aria-label="Restore conversation"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button>`
      : `
      <button type="button" class="rename-chat-btn" title="Rename conversation" aria-label="Rename conversation"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button type="button" class="delete-chat-btn" title="Move to Trash" aria-label="Move to Trash"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    `;
    li.appendChild(menu);

    li.onclick = (e) => {
      if (!trashView && !e.target.closest(".chat-options, .rename-input")) loadChatHistory(chat.chat_id);
    };

    if (trashView) {
      menu.querySelector(".restore-chat-btn").onclick = event => {
        event.stopPropagation();
        restoreChat(chat.chat_id);
      };
      chatListElem.appendChild(li);
      continue;
    }

    menu.querySelector(".delete-chat-btn").onclick = (e) => {
      e.stopPropagation();
      trashChat(chat.chat_id, li);
    };

    menu.querySelector(".rename-chat-btn").onclick = (e) => {
      e.stopPropagation();
      if (nameSpan.querySelector(".rename-input")) return;
      const currentName = nameSpan.textContent;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "rename-input";
      input.value = currentName;
      input.setAttribute("aria-label", "Conversation name");
      nameSpan.replaceChildren(input);
      input.focus();
      input.select();

      let finished = false;
      const finishRename = async () => {
        if (finished) return;
        finished = true;
        const newName = input.value.trim();
        let displayedName = currentName;
        if (newName && newName !== currentName) {
          try {
            const res = await fetch(`/chat/${chat.chat_id}/rename`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName }),
            });
            if (!res.ok) throw new Error("Rename failed");
            displayedName = newName;
          } catch (err) {
            alert(err.message);
          }
        }
        nameSpan.textContent = displayedName;
        window.workspace?.rememberChat({...chat, name:displayedName});
      };

      input.addEventListener("blur", finishRename);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finishRename();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          finished = true;
          nameSpan.textContent = currentName;
        }
      });
    };

    chatListElem.appendChild(li);
  }

  if (trashView && !chatList.length) {
    const empty = document.createElement("li");
    empty.className = "chat-list-empty";
    empty.textContent = "Trash is empty";
    chatListElem.appendChild(empty);
  }
  syncChatActivity();
  selectChatListItem(currentChatId);
  window.workspace?.refreshTrash();
  return chatList;
}

// --- Select chat in sidebar ---
function selectChatListItem(chatId) {
  for (const li of chatListElem.children) {
    li.classList.toggle("selected", li.dataset.chatId === chatId);
  }
}

// --- Create new chat ---
async function createNewChat({persist = true} = {}) {
  chatLoadVersion++;
  setTrashView(false);
  currentChatId = null;
  localStorage.removeItem("lastChatId");
  chatHistoryElem.replaceChildren();
  window.clearDeckPanel?.();
  window.workspace?.landing();
  syncChatActivity();
  selectChatListItem(null);
  closeSidebar();
  if (persist) {
    try {await window.workspace?.ensureChat();}
    catch (error) {if (error.name !== "AbortError") alert(error.message);}
  }
}

// --- Thinking indicator ---
function addThinkingMessage(target = chatHistoryElem) {
  const div = document.createElement("div");
  div.id = "thinking-message";

  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = "Analyzing";
  div.appendChild(label);

  const indicator = window.workspace?.analyzingIcon();
  if (indicator) div.prepend(indicator);

  target.appendChild(div);
  if (target.isConnected) scrollToBottom();

  // Return a dummy interval ID for compatibility (animation is pure CSS now)
  return setInterval(() => {}, 60000);
}

// Status lines can be split or coalesced by the network. Once content starts,
// everything that follows belongs to the reply, including marker-like code text.
async function* readChatReply(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const marker = "__STATUS__:";
  let pending = "", contentStarted = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      while (!contentStarted && pending) {
        if (pending.startsWith(marker)) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          yield { type: "status", content: pending.slice(marker.length, end).trim() };
          pending = pending.slice(end + 1);
        } else if (marker.startsWith(pending)) break;
        else contentStarted = true;
      }
      if (contentStarted && pending) {
        yield { type: "content", content: pending };
        pending = "";
      }
      if (done) {
        if (pending) throw new Error("The reply was interrupted. Please retry your request.");
        break;
      }
    }
  } finally { reader.releaseLock?.(); }
}

// --- Send message ---
async function sendMessage(edit = {}) {
  const input = document.getElementById("user-input");
  const message = edit.message || input.value.trim();
  if (!edit.resume && (!message || isTyping || window.workspace?.busy)) return;
  if (!edit.resume && await window.workspace?.startDevice(message)) return;
  if (!edit.resume && !currentChatId) {
    try { await window.workspace?.ensureChat(); }
    catch (error) { if (error.name !== "AbortError") alert(error.message); return; }
  }
  if (!edit.resume && (!currentChatId || isTyping)) return;
  if (!edit.resume) window.workspace?.enterChat();
  const chatId = edit.chatId || currentChatId;
  const requestController = new AbortController();
  let finishChatRequest;
  const view = chatJobs.get(chatId)?.view || document.createElement("div");
  view.className = "chat-session-view";
  if (!chatJobs.has(chatId)) {
    view.append(...chatHistoryElem.childNodes);
    chatHistoryElem.appendChild(view);
  }
  const resumedDevice = chatJobs.get(chatId)?.device;
  const job = {view, controller:requestController, status:"running", done:new Promise(resolve => finishChatRequest = resolve)};
  chatJobs.set(chatId, job);
  syncChatActivity();
  const addReply = (text, sender, id) => addMessage(text, sender, id, view);
  const deckLayout = edit.resume ? undefined : window.workspace?.generationLayout();
  const device = edit.resume ? resumedDevice : window.workspace?.deviceContext;
  job.device = device;


  // User just sent a message — re-enable auto-scroll
  autoScrollEnabled = true;

  const userDiv = edit.resume ? null : edit.messageId ? edit.div : addReply(message, "user");
  if (edit.resume) { /* The saved prompt is already in this view. */ }
  else if (!edit.messageId) {
    input.value = "";
    input.style.height = "auto";
  } else {
    let next = userDiv.nextElementSibling;
    while (next) {
      const following = next.nextElementSibling;
      next.remove();
      next = following;
    }
    if (window.clearDeckPanel) window.clearDeckPanel({keepOpen:true});
  }

  const thinkingInterval = addThinkingMessage(view);

  let botDiv = null;
  let firstChunkReceived = false;
  let statusDiv = null;
  let isRagResponse = false;
  let finalRagCode = null;
  let replyBuffer = "";
  let replyMode = null;

  try {
    const res = await fetch(`/chat/${chatId}/stream`, edit.resume ? {signal:requestController.signal} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, message_id: edit.messageId, deck_layout: deckLayout, device }),
      signal: requestController.signal,
    });

    // Handle session expiration — show message, then redirect to login
    if (res.status === 401) {
      clearInterval(thinkingInterval);
      const thinkingElem = view.querySelector("#thinking-message");
      if (thinkingElem) thinkingElem.remove();

      job.status = "error";
      const errorData = await res.json().catch(() => ({ error: "Session expired" }));
      const botDiv = addReply("", "bot");
      appendChunkToBotMessage(botDiv, errorData.error || "Your session has expired. Redirecting to login...");

      setTimeout(() => {
        window.location.href = "/login";
      }, 3000);
      return;
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || "Unable to send your prompt.");
    }
    const messageId = Number(res.headers.get("X-User-Message-Id"));
    job.runId = res.headers.get("X-Chat-Run-Id");
    if (userDiv) renderUserMessage(userDiv, message, messageId || edit.messageId);
    if (!res.body) throw new Error("No response body");

    for await (const part of readChatReply(res.body)) {
      if (part.type === "status") {
        if (part.content.startsWith("__DEVICE__:")) {
          const device = part.content.slice("__DEVICE__:".length);
          window.preloadHardwareCatalog?.(device);
          job.device = device;
          if (currentChatId === chatId) window.workspace?.deviceDetected(device);
          continue;
        }
        edit.questionnaireSummary?.querySelector(".summary-generating")?.remove();
        isRagResponse = true;
        clearInterval(thinkingInterval);
        view.querySelector("#thinking-message")?.remove();
        if (!statusDiv) {
          statusDiv = document.createElement("div");
          statusDiv.className = "rag-status";
          view.appendChild(statusDiv);
        }
        statusDiv.replaceChildren();
        const spinner = window.workspace?.analyzingIcon() || document.createElement("span");
        if (!window.workspace) spinner.className = "rag-spinner";
        statusDiv.append(spinner, document.createTextNode(part.content));
        scrollToBottom();
        continue;
      }
      if (!firstChunkReceived) {
        edit.questionnaireSummary?.querySelector(".summary-generating")?.remove();
        firstChunkReceived = true;
        clearInterval(thinkingInterval);
        view.querySelector("#thinking-message")?.remove();
        statusDiv?.remove();
        botDiv = addReply("", "bot");
      }
      if (part.content.includes("__FAILED_CODE__:")) job.status = "error";
      replyBuffer += part.content;
      if (!replyMode) {
        const markers = ["__QUESTIONS__:", "__FAILED_CODE__:"];
        if (markers.some(marker => marker.startsWith(replyBuffer) && marker !== replyBuffer)) continue;
        replyMode = replyBuffer.startsWith(markers[0]) ? "questions"
          : replyBuffer.startsWith(markers[1]) ? "failed" : isRagResponse ? "code" : "text";
      }
      if (replyMode === "text") {
        appendChunkToBotMessage(botDiv, replyBuffer);
        replyBuffer = "";
      }
    }

    if (!firstChunkReceived) throw new Error("No answer was received. Please retry your request.");
    if (replyMode === "text" && botDiv._buffer && !botDiv._buffer.startsWith("```")) {
      botDiv.appendChild(document.createTextNode(botDiv._buffer));
      botDiv._buffer = "";
    }
    if (replyMode === "questions") {
      const questions = JSON.parse(fixTrailingCommas(replyBuffer.slice("__QUESTIONS__:".length)));
      window.renderQuestionsForm(botDiv, questions);
    } else if (replyMode === "failed") {
      job.status = "error";
      const [message, code] = replyBuffer.slice("__FAILED_CODE__:".length).split("___CODE_SEP___");
      const paragraph = document.createElement("p");
      paragraph.textContent = message.trim();
      botDiv.appendChild(paragraph);
      if (code) botDiv.appendChild(buildDeckLink(code));
    } else if (replyMode === "code") {
      botDiv.appendChild(buildDeckLink(replyBuffer));
      finalRagCode = replyBuffer;
    } else if (!replyMode) {
      throw new Error("The reply was interrupted. Please retry your request.");
    }
    edit.questionnaireSummary?.querySelector(".summary-generating")?.remove();
    statusDiv?.remove();
    if (!finalRagCode) {
      const links = botDiv.querySelectorAll(".protocol-deck-link");
      finalRagCode = links.length ? links[links.length - 1]._protocolCode : null;
    }
    // Open the completed file immediately, before waiting for the chat-list refresh.
    if (currentChatId === chatId && finalRagCode && window.parseDeckFromCode) {
      const links = botDiv.querySelectorAll(".protocol-deck-link");
      const link = links.length ? links[links.length - 1] : null;
      window.parseDeckFromCode(finalRagCode, link);
    }
    await refreshChatList();
    if (requestController.signal.aborted) return;
    selectChatListItem(currentChatId);

  } catch (err) {
    job.status = "error";
    if (err.name === "AbortError") return;
    clearInterval(thinkingInterval);
    const thinkingElem = view.querySelector("#thinking-message");
    if (thinkingElem) thinkingElem.remove();

    const errorDiv = addReply("", "bot");
    appendChunkToBotMessage(errorDiv, "Error: " + err.message);
    console.error(err);
  } finally {
    edit.questionnaireSummary?.querySelector(".summary-generating")?.remove();
    statusDiv?.remove();
    clearInterval(thinkingInterval);
    view.querySelector("#thinking-message")?.remove();
    if (job.status === "running") job.status = "done";
    finishChatRequest();
    syncChatActivity();
  }
}

// --- Event Listeners ---
sendBtn.addEventListener("click", sendMessage);
userInputElem.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

newChatBtn.addEventListener("click", createNewChat);
document.getElementById("trash-btn")?.addEventListener("click", async () => {
  setTrashView(!showingTrash);
  await refreshChatList();
  selectChatListItem(currentChatId);
});

document.getElementById("logout-btn").addEventListener("click", () => {
  try { sessionStorage.removeItem("biobot-questionnaire-answers"); } catch (_) {}
  window.location.href = "/logout";
});

// --- Reject Modal ---
function showRejectModal(code, rejectBtn) {
  const existing = document.getElementById("reject-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "reject-modal";
  modal.className = "reject-modal";

  modal.innerHTML = `
    <div class="reject-modal-content">
      <div class="reject-modal-header">
        <h4>Report Issue</h4>
        <button class="reject-modal-close" onclick="document.getElementById('reject-modal').remove()">&times;</button>
      </div>
      <p class="reject-modal-desc">Describe what went wrong when you tested this code on your machine. Your feedback helps improve future generations.</p>
      <textarea id="reject-remark" class="reject-textarea" rows="5" placeholder="e.g. 'Labware not found on slot 3' or 'Pipette exceeded max volume' or 'Script crashed at line 42'"></textarea>
      <div class="reject-modal-actions">
        <button class="reject-cancel-btn" onclick="document.getElementById('reject-modal').remove()">Cancel</button>
        <button class="reject-submit-btn" id="reject-submit-btn">Submit Report</button>
      </div>
    </div>
  `;

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);
  setTimeout(() => document.getElementById("reject-remark")?.focus(), 100);

  document.getElementById("reject-submit-btn").addEventListener("click", async () => {
    const remark = document.getElementById("reject-remark").value.trim();
    if (!remark) {
      document.getElementById("reject-remark").style.borderColor = "#ff4d4d";
      document.getElementById("reject-remark").placeholder = "Please describe the issue before submitting...";
      return;
    }

    const submitBtn = document.getElementById("reject-submit-btn");
    submitBtn.textContent = "Submitting...";
    submitBtn.disabled = true;

    try {
      const res = await fetch("/code/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, remark, chat_id: currentChatId || "" }),
      });

      if (res.ok) {
        rejectBtn.classList.add("rejected");
        rejectBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#ff4d4d" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
        rejectBtn.title = "Reported as not working";
        modal.remove();
      } else {
        submitBtn.textContent = "Error — try again";
        submitBtn.disabled = false;
      }
    } catch (e) {
      console.error("Reject error:", e);
      submitBtn.textContent = "Error — try again";
      submitBtn.disabled = false;
    }
  });
}

// --- Init ---
(async function init() {
  const chats = await refreshChatList();
  const lastChatId = localStorage.getItem("lastChatId");
  if (await window.workspace?.restoreProtocol()) { /* Reopen the fixed library snapshot. */ }
  else if (lastChatId && chats.some(chat=>chat.chat_id === lastChatId)) await loadChatHistory(lastChatId);
  else await createNewChat({persist:false});

  // --- Settings Modal ---
  const settingsBtn = document.getElementById("settings-btn");
  const modal = document.getElementById("settings-modal");

  const firstNameInput = document.getElementById("profile-first-name");
  const lastNameInput = document.getElementById("profile-last-name");
  const emailInput = document.getElementById("profile-email");
  const apiKeyInput = document.getElementById("api_key");
  const countryInput = document.getElementById("profile-country");
  const editBtn = document.getElementById("edit-profile");
  const saveBtn = document.getElementById("save-profile");
  const closeBtn = document.getElementById("close-profile");
  const notificationModal = document.getElementById("notification-modal");
  const notificationText = document.getElementById("notification-text");
  const notificationOkBtn = document.getElementById("notification-ok-btn");

  function showNotification(message) {
    notificationText.textContent = message;
    notificationModal.classList.remove("hidden");
  }

  notificationOkBtn.addEventListener("click", () => {
    notificationModal.classList.add("hidden");
  });

  settingsBtn.addEventListener("click", async () => {
    modal.classList.remove("hidden");

    try {
      const res = await fetch("/user/profile");
      if (!res.ok) throw new Error("Error loading profile");

      const data = await res.json();
      firstNameInput.value = data.first_name;
      lastNameInput.value = data.last_name;
      emailInput.value = data.email;
      apiKeyInput.value = data.api_key || "";
      countryInput.value = data.country;

      [firstNameInput, lastNameInput, emailInput, countryInput, apiKeyInput].forEach(i => i.disabled = true);
      saveBtn.classList.add("hidden");
      editBtn.classList.remove("hidden");
    } catch (err) {
      alert(err.message);
    }
  });

  editBtn.addEventListener("click", () => {
    [firstNameInput, lastNameInput, emailInput, countryInput, apiKeyInput].forEach(i => i.disabled = false);
    editBtn.classList.add("hidden");
    saveBtn.classList.remove("hidden");
  });

  saveBtn.addEventListener("click", async () => {
    const payload = {
      first_name: firstNameInput.value,
      last_name: lastNameInput.value,
      email: emailInput.value,
      country: countryInput.value,
      api_key: apiKeyInput.value || ""
    };
    localStorage.setItem("userApiKey", payload.api_key);

    try {
      const res = await fetch("/user/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");

      showNotification("Your profile has been updated!");
      modal.classList.add("hidden");
    } catch (err) {
      alert(err.message);
    }
  });

  closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
})();
