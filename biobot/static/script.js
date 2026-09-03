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
let autoScrollEnabled = true;

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
}

function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarOverlay.classList.remove("active");
}

if (sidebarToggle) {
  sidebarToggle.addEventListener("click", openSidebar);
}
if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", closeSidebar);
}

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
function detectFormat(content) {
  const trimmed = content.trim();

  // Priority 1: Check for markdown fence language tag at the start
  const fenceMatch = trimmed.match(/^```(\w+)/);
  if (fenceMatch) {
    const lang = fenceMatch[1].toLowerCase();
    const aliases = { py: "python", javascript: "js", yml: "yaml" };
    return aliases[lang] || lang;
  }

  // Priority 2: Detect from content patterns
  const firstLine = trimmed.split("\n")[0];
  if (firstLine.startsWith("import ") || firstLine.startsWith("from ") ||
      firstLine.startsWith("#!/") || firstLine.startsWith("def ") ||
      firstLine.startsWith("class ")) {
    return "python";
  }
  if (firstLine.includes(",") && !firstLine.startsWith("#") &&
      !firstLine.startsWith("import") && !firstLine.startsWith("from") &&
      !firstLine.startsWith("def")) {
    return "csv";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && !trimmed.startsWith("#"))) {
    return "xml";
  }
  return "text";
}

// --- Build a styled code block with copy + download buttons ---
function buildCodeBlock(code, format = "python") {
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
        window.parseDeckFromCode(code);
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
  codeElem.textContent = code;
  pre.appendChild(codeElem);

  wrapper.appendChild(toolbar);
  wrapper.appendChild(pre);
  return wrapper;
}

// --- Create a message element ---
function addMessage(text, sender) {
  const div = document.createElement("div");
  div.className = `chat-message ${sender === "user" ? "chat-user" : "chat-bot"}`;
  chatHistoryElem.appendChild(div);
  scrollToBottom();

  if (sender === "user") {
    div.textContent = text;
    scrollToBottom();
    return div;
  }

  // For bot: initially empty, we'll stream into this div
  div._buffer = "";
  return div;
}

// --- Append chunk to bot message (handles code blocks) ---
function appendChunkToBotMessage(div, chunk) {
  div._buffer += chunk;

  // Capture the language tag from markdown fences: ```python, ```csv, ```json, etc.
  const codeBlockRegex = /```(\w*)\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  const fragments = [];

  while ((match = codeBlockRegex.exec(div._buffer)) !== null) {
    const before = div._buffer.slice(lastIndex, match.index);
    if (before) fragments.push({ type: "text", content: before });
    fragments.push({ type: "code", content: match[2], format: match[1] || "text" });
    lastIndex = codeBlockRegex.lastIndex;
  }

  const remaining = div._buffer.slice(lastIndex);
  div._buffer = remaining;

  for (const frag of fragments) {
    if (frag.type === "text") {
      div.innerHTML += escapeHtml(frag.content).replace(/\n/g, "<br>");
    } else if (frag.type === "code") {
      div.appendChild(buildCodeBlock(frag.content, frag.format));
    }
  }

  if (div._buffer && !div._buffer.startsWith("```")) {
    div.innerHTML += escapeHtml(div._buffer).replace(/\n/g, "<br>");
    div._buffer = "";
  }

  scrollToBottom();
}

// --- Load chat history ---
async function loadChatHistory(chatId) {
  if (!chatId) return;
  currentChatId = chatId;
  localStorage.setItem("lastChatId", chatId);
  chatHistoryElem.innerHTML = "";
  selectChatListItem(chatId);
  closeSidebar();

  // Clear and hide deck panel when switching chats
  if (window.clearDeckPanel) window.clearDeckPanel();

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
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      const msg = messages[msgIdx];
      if (msg.role === "user") {
        // Strip [PROTOCOL_PARAMS] marker for display
        const displayContent = (msg.content || "").replace(/^\[PROTOCOL_PARAMS\]\n?/, "");
        addMessage(displayContent, "user", false);
      } else if (msg.role === "assistant") {
        const content = msg.content || "";

        // Skip null/empty messages
        if (!content || content === "null" || content === "None") continue;

        // Skip encrypted-but-unreadable messages
        if (content.startsWith("gAAAAAB") || content === "[Message encrypted with a previous password]") {
          const botDiv = addMessage("", "bot");
          botDiv.innerHTML = `<span style="color:#888;font-style:italic">${content.startsWith("gAAAAAB") ? "[Message from a previous session]" : content}</span>`;
          continue;
        }

        const botDiv = addMessage("", "bot");

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
          const format = match[1] || detectFormat(match[2]);
          botDiv.appendChild(buildCodeBlock(match[2], format));
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
          // No markdown fences — render as plain text
          botDiv.innerHTML = escapeHtml(content).replace(/\n/g, "<br>");
        }
      }
    }
  } catch (e) {
    alert(e.message);
  }
}

// --- Delete Modal ---
const deleteModal = document.getElementById("delete-modal");
const cancelDeleteBtn = document.getElementById("cancel-delete");
const confirmDeleteBtn = document.getElementById("confirm-delete");
let chatToDeleteId = null;

async function showDeleteModal(chatId) {
  chatToDeleteId = chatId;
  deleteModal.classList.remove("hidden");
}

cancelDeleteBtn.onclick = () => {
  chatToDeleteId = null;
  deleteModal.classList.add("hidden");
};

confirmDeleteBtn.onclick = async () => {
  if (!chatToDeleteId) return;
  const resp = await fetch(`/chat/${chatToDeleteId}`, { method: "DELETE" });
  if (resp.ok) {
    const updatedChats = await refreshChatList();
    if (chatToDeleteId === currentChatId) {
      localStorage.removeItem("lastChatId");
      if (updatedChats.length) {
        await loadChatHistory(updatedChats[0].chat_id);
      } else {
        await createNewChat();
      }
    }
  } else {
    alert("Error deleting chat.");
  }
  chatToDeleteId = null;
  deleteModal.classList.add("hidden");
};

// Close modals on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', () => {
    backdrop.closest('.modal').classList.add('hidden');
  });
});

// --- Refresh chat list ---
async function refreshChatList() {
  const res = await fetch("/chats");
  if (!res.ok) return [];

  const chatList = await res.json();
  chatListElem.innerHTML = "";

  for (const chat of chatList) {
    const li = document.createElement("li");
    li.dataset.chatId = chat.chat_id;

    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-name";
    nameSpan.textContent = chat.name;
    li.appendChild(nameSpan);

    const menu = document.createElement("div");
    menu.className = "chat-options";
    menu.innerHTML = `
      <span class="chat-dots">⋮</span>
      <div class="chat-menu hidden">
        <button class="rename-chat-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Rename</button>
        <button class="delete-chat-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete</button>
      </div>
    `;
    li.appendChild(menu);

    li.onclick = (e) => {
      if (!e.target.classList.contains("chat-dots") &&
          !e.target.classList.contains("delete-chat-btn") &&
          !e.target.classList.contains("rename-chat-btn")) {
        loadChatHistory(chat.chat_id);
      }
    };

    menu.querySelector(".chat-dots").onclick = (e) => {
      e.stopPropagation();
      // Close all other menus first
      document.querySelectorAll('.chat-menu').forEach(m => m.classList.add('hidden'));
      menu.querySelector(".chat-menu").classList.toggle("hidden");
    };

    menu.querySelector(".delete-chat-btn").onclick = (e) => {
      e.stopPropagation();
      showDeleteModal(chat.chat_id);
    };

    menu.querySelector(".rename-chat-btn").onclick = (e) => {
      e.stopPropagation();
      const currentName = nameSpan.textContent;
      nameSpan.innerHTML = `<input type="text" class="rename-input" value="${currentName}" />`;
      const input = nameSpan.querySelector(".rename-input");
      input.focus();
      input.select();

      const finishRename = async () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
          try {
            const res = await fetch(`/chat/${chat.chat_id}/rename`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName }),
            });
            if (!res.ok) throw new Error("Rename failed");
          } catch (err) {
            alert(err.message);
          }
        }
        nameSpan.textContent = newName || currentName;
      };

      input.addEventListener("blur", finishRename);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finishRename();
        }
      });
    };

    chatListElem.appendChild(li);
  }

  return chatList;
}

// --- Select chat in sidebar ---
function selectChatListItem(chatId) {
  for (const li of chatListElem.children) {
    li.classList.toggle("selected", li.dataset.chatId === chatId);
  }
}

// --- Create new chat ---
async function createNewChat() {
  try {
    const res = await fetch("/chat", { method: "POST" });
    if (!res.ok) throw new Error("Error creating chat");

    const data = await res.json();
    currentChatId = data.chat_id;
    localStorage.setItem("lastChatId", currentChatId);

    chatHistoryElem.innerHTML = "";

    const botDiv = addMessage("", "bot");
    appendChunkToBotMessage(
      botDiv,
      "Hello, I'm Biobot 🤖 — your assistant specialized in lab automation."
    );

    await refreshChatList();
    selectChatListItem(currentChatId);
    closeSidebar();
  } catch (e) {
    alert(e.message);
  }
}

// --- Thinking indicator ---
function addThinkingMessage() {
  const div = document.createElement("div");
  div.className = "chat-message chat-bot";
  div.id = "thinking-message";

  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = "Analyzing";
  div.appendChild(label);

  const dotsContainer = document.createElement("span");
  dotsContainer.className = "thinking-dots";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "thinking-dot";
    dot.style.animationDelay = `${i * 0.15}s`;
    dotsContainer.appendChild(dot);
  }
  div.appendChild(dotsContainer);

  chatHistoryElem.appendChild(div);
  scrollToBottom();

  // Return a dummy interval ID for compatibility (animation is pure CSS now)
  return setInterval(() => {}, 60000);

  let count = 0;
  const interval = setInterval(() => {
    count = (count + 1) % 4;
    dots.textContent = ".".repeat(count || 1);
  }, 400);

  return interval;
}

// --- Typewriter effect for large chunks ---
function typewriterAppend(div, text, delay = 18) {
  const words = text.split(/(?<=\s)|(?=\s)/);
  let i = 0;
  function next() {
    if (i >= words.length) return;
    appendChunkToBotMessage(div, words[i++]);
    setTimeout(next, delay);
  }
  next();
}

// --- Send message ---
async function sendMessage() {
  const input = document.getElementById("user-input");
  const message = input.value.trim();
  if (!message || !currentChatId) return;

  // User just sent a message — re-enable auto-scroll
  autoScrollEnabled = true;

  addMessage(message, "user");
  input.value = "";
  input.style.height = "auto";

  const thinkingInterval = addThinkingMessage();

  let apiKey = localStorage.getItem("userApiKey") || "";
  let botDiv = null;
  let firstChunkReceived = false;
  let statusDiv = null;
  let isRagResponse = false;
  let finalRagCode = null;

  try {
    const res = await fetch(`/chat/${currentChatId}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, api_key: apiKey }),
    });

    // Handle session expiration — show message, then redirect to login
    if (res.status === 401) {
      clearInterval(thinkingInterval);
      const thinkingElem = document.getElementById("thinking-message");
      if (thinkingElem) thinkingElem.remove();

      const errorData = await res.json().catch(() => ({ error: "Session expired" }));
      const botDiv = addMessage("", "bot");
      appendChunkToBotMessage(botDiv, errorData.error || "Your session has expired. Redirecting to login...");

      setTimeout(() => {
        window.location.href = "/login";
      }, 3000);
      return;
    }

    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const parts = chunk.split("__STATUS__:");

      const contentPart = parts[0];
      const statusParts = parts.slice(1);

      for (const statusText of statusParts) {
        if (!statusText.trim()) continue;

        isRagResponse = true;

        clearInterval(thinkingInterval);
        const thinkingElem = document.getElementById("thinking-message");
        if (thinkingElem) thinkingElem.remove();

        if (!statusDiv) {
          statusDiv = document.createElement("div");
          statusDiv.className = "chat-message chat-bot rag-status";
          chatHistoryElem.appendChild(statusDiv);
        }
        statusDiv.innerHTML = `<span class="rag-spinner"></span>${statusText.trim()}`;
        scrollToBottom();
      }

      if (contentPart) {
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          clearInterval(thinkingInterval);
          const thinkingElem = document.getElementById("thinking-message");
          if (thinkingElem) thinkingElem.remove();
          if (statusDiv) { statusDiv.remove(); statusDiv = null; }
          botDiv = addMessage("", "bot");
        }

        // --- Structured questions from sufficiency check ---
        if (contentPart.includes("__QUESTIONS__:")) {
          const questionsJson = contentPart.split("__QUESTIONS__:").pop().trim();
          try {
            const questionsData = JSON.parse(fixTrailingCommas(questionsJson));
            if (window.renderQuestionsForm) {
              window.renderQuestionsForm(botDiv, questionsData);
            }
          } catch (e) {
            appendChunkToBotMessage(botDiv, questionsJson);
          }
        }
        // --- RAG failure: message + code ---
        else if (contentPart.includes("__FAILED_CODE__:")) {
          const failedContent = contentPart.split("__FAILED_CODE__:").pop();
          const sepParts = failedContent.split("___CODE_SEP___");
          const message = (sepParts[0] || "").trim();
          const code = (sepParts[1] || "").trim();

          if (message) {
            const msgP = document.createElement("p");
            msgP.textContent = message;
            msgP.style.marginBottom = "12px";
            botDiv.appendChild(msgP);
          }
          if (code) {
            botDiv.appendChild(buildCodeBlock(code, detectFormat(code)));
          }
          isRagResponse = false;
        }
        // --- RAG success: raw output ---
        else if (isRagResponse) {
          botDiv.appendChild(buildCodeBlock(contentPart, detectFormat(contentPart)));
          // Store final code — deck will be parsed ONCE after streaming completes
          finalRagCode = contentPart;
        }
        // --- Normal streaming (general/out) ---
        else {
          if (contentPart.length > 120) {
            typewriterAppend(botDiv, contentPart);
          } else {
            appendChunkToBotMessage(botDiv, contentPart);
          }
        }
      }
    }

    await refreshChatList();
    selectChatListItem(currentChatId);

    // Parse deck ONCE after streaming is fully complete (final code only)
    if (finalRagCode && window.parseDeckFromCode && finalRagCode.length > 50) {
      window.parseDeckFromCode(finalRagCode);
    }

  } catch (err) {
    clearInterval(thinkingInterval);
    const thinkingElem = document.getElementById("thinking-message");
    if (thinkingElem) thinkingElem.remove();

    const errorDiv = addMessage("", "bot");
    appendChunkToBotMessage(errorDiv, "Error: Unable to get a response. Please try again.");
    console.error(err);
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

document.getElementById("logout-btn").addEventListener("click", () => {
  window.location.href = "/logout";
});

// Close menus on outside click
document.addEventListener('click', () => {
  document.querySelectorAll('.chat-menu').forEach(m => m.classList.add('hidden'));
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

  let lastChatId = localStorage.getItem("lastChatId");
  if (!lastChatId || !chats.find(c => c.chat_id === lastChatId)) {
    lastChatId = chats.length ? chats[chats.length - 1].chat_id : null;
  }

  if (lastChatId) {
    await loadChatHistory(lastChatId);
  } else {
    await createNewChat();
  }

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