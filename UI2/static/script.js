const chatListElem = document.getElementById("chat-list");
const chatHistoryElem = document.getElementById("chat-history");
const userInputElem = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const newChatBtn = document.getElementById("new-chat");
chatHistoryElem.addEventListener("scroll", () => {
  const nearBottom = chatHistoryElem.scrollHeight - chatHistoryElem.scrollTop - chatHistoryElem.clientHeight < 50;
  autoScrollEnabled = nearBottom;
});


let currentChatId = null;
let isTyping = false;
let autoScrollEnabled = true;
userInputElem.addEventListener("input", () => {
  userInputElem.style.height = "auto";
  userInputElem.style.height = Math.min(userInputElem.scrollHeight, 300) + "px";
});


// Fonction pour échapper le HTML dans le texte (éviter injection)
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Crée un élément message, avec support du markdown code (```...```)
function addMessage(text, sender) {
  const div = document.createElement("div");
  div.className = `chat-message ${sender === "user" ? "chat-user" : "chat-bot"}`;
  chatHistoryElem.appendChild(div);
  if (autoScrollEnabled) chatHistoryElem.scrollTop = chatHistoryElem.scrollHeight;

  if (sender === "user") {
    div.textContent = text;
    if (autoScrollEnabled) chatHistoryElem.scrollTop = chatHistoryElem.scrollHeight;
    return div;
  }

  // For bot: initially empty, we'll stream into this div
  div._buffer = ""; // buffer for partial code blocks
  return div;
}

/**
 * Append a chunk to bot message div, handling code blocks (partial or complete)
 * @param div The bot message div
 * @param chunk The new text chunk
 */
function appendChunkToBotMessage(div, chunk) {
  div._buffer += chunk;

  // Regex to find complete code blocks
  const codeBlockRegex = /```(?:python)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  const fragments = [];

  // Extract complete code blocks from the buffer
  while ((match = codeBlockRegex.exec(div._buffer)) !== null) {
    const before = div._buffer.slice(lastIndex, match.index);
    if (before) fragments.push({ type: "text", content: before });
    fragments.push({ type: "code", content: match[1] });
    lastIndex = codeBlockRegex.lastIndex;
  }

  // Everything after last complete code block remains in buffer (partial code)
  const remaining = div._buffer.slice(lastIndex);
  div._buffer = remaining;

  // Append complete fragments to DOM
  for (const frag of fragments) {
    if (frag.type === "text") {
      div.innerHTML += escapeHtml(frag.content).replace(/\n/g, "<br>");
    } else if (frag.type === "code") {
      const container = document.createElement("div");
      container.style.position = "relative";

      const codeElem = document.createElement("pre");
      codeElem.innerHTML = `<code>${escapeHtml(frag.content)}</code>`;

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "📋 Copier";
      copyBtn.className = "copy-btn";
      copyBtn.style.cssText = `
        position: absolute;
        top: 6px;
        right: 6px;
        background: rgb(117,109,109);
        border: 2px solid #ccc;
        border-radius: 10px;
        font-size: 15px;
        padding: 2px 6px;
        cursor: pointer;
        z-index: 9999;
        pointer-events: auto;
      `;
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(frag.content).then(() => {
          copyBtn.textContent = "✅ Copié !";
          setTimeout(() => (copyBtn.textContent = "📋 Copier"), 1500);
        }).catch(err => {
          console.error("Erreur de copie : ", err);
          alert("Échec de la copie.");
        });
      });

      container.appendChild(copyBtn);
      container.appendChild(codeElem);
      div.appendChild(container);
    }
  }

  // If buffer has remaining text, append as normal text
  if (div._buffer && !div._buffer.startsWith("```")) {
    div.innerHTML += escapeHtml(div._buffer).replace(/\n/g, "<br>");
    div._buffer = ""; // already added
  }

  if (autoScrollEnabled) chatHistoryElem.scrollTop = chatHistoryElem.scrollHeight;
}



// Charger l'historique d'un chat
async function loadChatHistory(chatId) {
  if (!chatId) return;
  currentChatId = chatId;
  localStorage.setItem("lastChatId", chatId);
  chatHistoryElem.innerHTML = "";
  selectChatListItem(chatId);

  try {
    const res = await fetch(`/chat/${chatId}`);
    if (res.status === 404) {
      console.warn("Aucune conversation enregistrée pour ce chat.");
      return;
    }
    if (!res.ok) {
      alert("Erreur inattendue lors du chargement du chat.");
      return;
    }

    const messages = await res.json();

    // Afficher tous les messages
    for (const msg of messages) {
      if (msg.role === "user") {
        addMessage(msg.content, "user", false);
      } else if (msg.role === "assistant") {
        const botDiv = addMessage("", "bot"); // create empty div
        appendChunkToBotMessage(botDiv, msg.content); // fill it
      }
    }

  } catch (e) {
    alert(e.message);
  }
}


// Variables globales pour la modal
const deleteModal = document.getElementById("delete-modal");
const cancelDeleteBtn = document.getElementById("cancel-delete");
const confirmDeleteBtn = document.getElementById("confirm-delete");
let chatToDeleteId = null;

async function showDeleteModal(chatId) {
  chatToDeleteId = chatId;
  deleteModal.classList.remove("hidden");
}

// Annuler suppression
cancelDeleteBtn.onclick = () => {
  chatToDeleteId = null;
  deleteModal.classList.add("hidden");
};

// Confirmer suppression
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
    alert("Erreur lors de la suppression.");
  }
  chatToDeleteId = null;
  deleteModal.classList.add("hidden");
};


// Actualiser la liste des chats dans la sidebar
async function refreshChatList() {
  const res = await fetch("/chats");
  if (!res.ok) return [];

  const chatList = await res.json();
  chatListElem.innerHTML = "";

  for (const chat of chatList) {
    const li = document.createElement("li");
    li.dataset.chatId = chat.chat_id;

    // Span pour le nom du chat
    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-name";
    nameSpan.textContent = chat.name;
    li.appendChild(nameSpan);

    // Menu
    const menu = document.createElement("div");
    menu.className = "chat-options";
    menu.innerHTML = `
      <span class="chat-dots">⋮</span>
      <div class="chat-menu hidden">
        <button class="rename-chat-btn">✏️ Rename</button>
        <button class="delete-chat-btn">🗑️ Delete</button>
      </div>
    `;
    li.appendChild(menu);

    // Sélection du chat
    li.onclick = (e) => {
      if (!e.target.classList.contains("chat-dots") &&
          !e.target.classList.contains("delete-chat-btn") &&
          !e.target.classList.contains("rename-chat-btn")) {
        loadChatHistory(chat.chat_id);
      }
    };

    // Toggle menu
    menu.querySelector(".chat-dots").onclick = (e) => {
      e.stopPropagation();
      menu.querySelector(".chat-menu").classList.toggle("hidden");
    };

    // Supprimer chat
    menu.querySelector(".delete-chat-btn").onclick = (e) => {
      e.stopPropagation();
      showDeleteModal(chat.chat_id);
    };

    // Renommer chat
    menu.querySelector(".rename-chat-btn").onclick = (e) => {
      e.stopPropagation();
      const currentName = nameSpan.textContent;
      // Remplacer le texte par un input uniquement
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
            if (!res.ok) throw new Error("Erreur lors du renommage");
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

// Sélection visuelle d'un chat dans la liste
function selectChatListItem(chatId) {
  for (const li of chatListElem.children) {
    li.classList.toggle("selected", li.dataset.chatId === chatId);
  }
}

// Créer un nouveau chat
async function createNewChat() {
  try {
    const res = await fetch("/chat", { method: "POST" });
    if (!res.ok) throw new Error("Erreur création chat");

    const data = await res.json();
    currentChatId = data.chat_id;
    localStorage.setItem("lastChatId", currentChatId);

    chatHistoryElem.innerHTML = "";

    const botDiv = addMessage("", "bot");
    appendChunkToBotMessage(
      botDiv,
      "Hello, I'm Biobot 🤖 — your assistant specialized in lab automation..."
    );

    await refreshChatList();
    selectChatListItem(currentChatId);

  } catch (e) {
    alert(e.message);
  }
}


function addThinkingMessage() {
  const div = document.createElement("div");
  div.className = "chat-message chat-bot"; // même style que le bot
  div.id = "thinking-message";

  const dots = document.createElement("span");
  dots.textContent = "...";
  dots.style.display = "inline-block";
  dots.style.marginLeft = "2px";
  div.appendChild(dots);

  chatHistoryElem.appendChild(div);
  chatHistoryElem.scrollTop = chatHistoryElem.scrollHeight;

  let count = 0;
  const interval = setInterval(() => {
    count = (count + 1) % 4;
    dots.textContent = ".".repeat(count);
    if (chatHistoryElem.scrollHeight - chatHistoryElem.scrollTop - chatHistoryElem.clientHeight < 50) {
      chatHistoryElem.scrollTop = chatHistoryElem.scrollHeight;
    }
  }, 500);

  return interval; // pour pouvoir stopper l’animation plus tard
}

// Envoyer un message utilisateur au backend
async function sendMessage() {
  const input = document.getElementById("user-input");
  const message = input.value.trim();
  if (!message || !currentChatId) return;

  // Add user message
  addMessage(message, "user");
  input.value = "";

  // Show thinking indicator
  const thinkingInterval = addThinkingMessage();

  let apiKey = localStorage.getItem("userApiKey") || "";

  let botDiv = null;
  let firstChunkReceived = false;

  try {
    const res = await fetch(`/chat/${currentChatId}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, api_key: apiKey }),
    });

    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);

      // FIRST CHUNK → remove thinking + create bot div
      if (!firstChunkReceived) {
        firstChunkReceived = true;

        // Stop thinking animation
        clearInterval(thinkingInterval);
        const thinkingElem = document.getElementById("thinking-message");
        if (thinkingElem) thinkingElem.remove();

        // Create real bot message div
        botDiv = addMessage("", "bot");
      }

      appendChunkToBotMessage(botDiv, chunk);
    }

    await refreshChatList();
    selectChatListItem(currentChatId);

  } catch (err) {
    clearInterval(thinkingInterval);
    const thinkingElem = document.getElementById("thinking-message");
    if (thinkingElem) thinkingElem.remove();

    const errorDiv = addMessage("", "bot");
    appendChunkToBotMessage(errorDiv, "\nErreur lors de la réponse du bot.");
    console.error(err);
  }
}





// Event listeners
sendBtn.addEventListener("click", sendMessage);
userInputElem.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

newChatBtn.addEventListener("click", createNewChat);

document.getElementById("logout-btn").addEventListener("click", () => {
  // Redirection vers la route logout
  window.location.href = "/logout";
});

// Init page : créer un chat si aucun et charger liste
(async function init() {
  const chats = await refreshChatList(); // récupère la liste actuelle

  // Cherche le dernier chat stocké en localStorage qui existe encore
  let lastChatId = localStorage.getItem("lastChatId");
  if (!lastChatId || !chats.find(c => c.chat_id === lastChatId)) {
    // si le lastChatId n'existe pas ou n'existe plus, on prend le premier chat existant
    lastChatId = chats.length ? chats[chats.length - 1].chat_id : null;
  }

  if (lastChatId) {
    await loadChatHistory(lastChatId);
  } else {
    // Aucun chat existant, on crée un nouveau
    await createNewChat();
  }

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

  // Cacher la modale quand on clique sur OK
  notificationOkBtn.addEventListener("click", () => {
      notificationModal.classList.add("hidden");
  });


  // Ouvrir la modale et charger les données utilisateur
  settingsBtn.addEventListener("click", async () => {
      modal.classList.remove("hidden");


      try {
          const res = await fetch("/user/profile");
          if (!res.ok) throw new Error("Erreur récupération profil");

          const data = await res.json();
          firstNameInput.value = data.first_name;
          lastNameInput.value = data.last_name;
          emailInput.value = data.email;
          apiKeyInput.value = data.api_key || ""; // vide si aucune clé définie
          countryInput.value = data.country;

          [firstNameInput, lastNameInput, emailInput, countryInput].forEach(i => i.disabled = true);
          apiKeyInput.disabled = true; // au départ désactivé
          saveBtn.classList.add("hidden");
          editBtn.classList.remove("hidden");
      } catch (err) {
          alert(err.message);
      }
  });

  // Activer modification
  editBtn.addEventListener("click", () => {
      [firstNameInput, lastNameInput, emailInput, countryInput].forEach(i => i.disabled = false);
      apiKeyInput.disabled = false;
      editBtn.classList.add("hidden");
      saveBtn.classList.remove("hidden");
  });

  // Sauvegarder modifications
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
          if (!res.ok) throw new Error(data.error || "Erreur mise à jour");

          showNotification("Profil mis à jour !");
          modal.classList.add("hidden");
      } catch (err) {
          alert(err.message);
      }
  });

  // Fermer modale
  closeBtn.addEventListener("click", () => modal.classList.add("hidden"));


})();