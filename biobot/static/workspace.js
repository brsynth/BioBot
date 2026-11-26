/* Device-first workspace. */
(() => {
  const deviceSelect = document.getElementById("device-select");
  const protocolList = document.getElementById("protocol-list");
  const dialog = document.getElementById("save-protocol-dialog");
  const nameInput = document.getElementById("protocol-name");
  const copyButton = document.getElementById("protocol-copy-btn");
  const saveButton = document.getElementById("protocol-save-btn");
  const downloadButton = document.getElementById("protocol-download-btn");
  const actions = document.getElementById("protocol-actions");
  const notice = document.getElementById("protocol-notice");
  const chats = new Map();
  let selectedDevice = "", protocolName = "", sourceProtocol = null, creating = null, deviceRequest = null, pageVersion = 0;
  let landingSelection = null, editingDevice = false, protocolDraft = "", landingChecking = false;
  let noticeTimer, libraryProtocol = null, exportRunning = false, exportReady = false, exportCurrent = false;
  // Errors and warnings belong to their chat: kept per chat until closed, shown again on return.
  let noticeChat = null;
  const chatNotices = new Map();
  function showNotice(message, persist = false) {
    clearTimeout(noticeTimer);
    noticeChat = typeof currentChatId !== "undefined" ? currentChatId : null;
    if (persist && message) chatNotices.set(noticeChat, message);
    else if (!message) chatNotices.delete(noticeChat);
    notice.textContent = message;
    if (message && persist) {  // errors and warnings stay until closed
      const close = document.createElement("button");
      close.type = "button"; close.className = "notice-close"; close.textContent = "×"; close.setAttribute("aria-label", "Dismiss");
      close.addEventListener("click", () => showNotice(""));
      notice.appendChild(close);
    }
    if (message && !persist) noticeTimer = setTimeout(() => { notice.textContent = ""; }, 5000);
  }

  let nameEditor = null;
  function activeItem() {
    if (libraryProtocol) return {...libraryProtocol, type:"protocol"};
    if (currentChatId) return {id:currentChatId, name:chats.get(currentChatId)?.name || "New chat", type:"chat"};
    return null;
  }
  function syncNameActions() {
    const item = activeItem();
    const heading = document.getElementById("deck-heading");
    if (nameEditor && (nameEditor.id !== item?.id || nameEditor.type !== item?.type)) nameEditor.cancel();
    if (!nameEditor) heading.textContent = item?.name || "Your deck";
    for (const action of ["rename", "trash"]) {
      const button = document.getElementById(`deck-name-${action}`);
      button.disabled = !item;
      const label = action === "rename" ? `Rename ${item?.type || "chat"}` : `Move ${item?.type || "chat"} to Trash`;
      button.title = label; button.setAttribute("aria-label", label);
    }
  }
  document.getElementById("deck-name-rename").addEventListener("click", () => {
    const item = activeItem();
    if (!item || nameEditor) return;
    const heading = document.getElementById("deck-heading");
    const input = document.createElement("input");
    input.className = "rename-input"; input.value = item.name; input.maxLength = 120;
    input.setAttribute("aria-label", `${item.type === "chat" ? "Chat" : "Protocol"} name`);
    let finished = false;
    const close = () => {input.remove(); heading.hidden = false; nameEditor = null;};
    const finish = async (cancel = false) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      close();
      if (!cancel && name && name !== item.name) {
        try {
          if (item.type === "protocol") {
            await json(`/protocols/${item.id}`, {...post({name}), method:"PATCH"});
            if (libraryProtocol?.id === item.id) {libraryProtocol.name = name; protocolName = name;}
            await refreshProtocols();
          } else {
            await json(`/chat/${item.id}/rename`, post({name}));
            await refreshChatList();
          }
        } catch (error) {showNotice(error.message);}
      }
      syncNameActions();
    };
    nameEditor = {id:item.id, type:item.type, cancel:()=>{finished = true; close();}};
    heading.hidden = true; document.getElementById("deck-name").appendChild(input);
    input.focus(); input.select();
    input.addEventListener("blur", () => finish());
    input.addEventListener("keydown", event => {
      if (["Enter", "Escape"].includes(event.key)) {event.preventDefault(); finish(event.key === "Escape");}
    });
  });
  document.getElementById("deck-name-trash").addEventListener("click", async () => {
    const item = activeItem();
    if (!item) return;
    if (item.type === "chat") {await trashChat(item.id); return;}
    try {
      await json(`/protocols/${item.id}`, {method:"DELETE"});
      if (libraryProtocol?.id === item.id) await createNewChat({persist:false});
      await refreshProtocols(); showNotice("Protocol moved to Trash.");
    } catch (error) {showNotice(error.message);}
  });

  async function json(url, options = {}) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error(`Server error (${response.status}). Please try again.`); }  // e.g. an HTML error page
    if (!response.ok) throw new Error(data.error || "Please try again.");
    return data;
  }
  const post = data => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  function analyzingIcon() {
    const icon = document.querySelector(".liquid-handler-logo").cloneNode(true);
    icon.classList.remove("hero-logo");
    icon.classList.add("is-analyzing");
    icon.setAttribute("aria-hidden", "true");
    icon.removeAttribute("aria-label");
    return icon;
  }
  function say(text) {const node = addMessage("", "bot"); node.textContent = text; return node;}
  function leaveProtocol() {
    libraryProtocol = null;
    try {localStorage.removeItem("lastProtocolId");} catch (_) {}
    document.body.classList.remove("protocol-library-view");
    document.getElementById("protocol-edit-chat-btn").hidden = true;
    document.getElementById("deck-heading").textContent = "Your deck";
    for (const row of protocolList.children) row.classList.remove("selected");
  }
  document.getElementById("inspector-toggle")?.addEventListener("click", () => {
    const inspector = document.getElementById("deck-inspector");
    window.setInspectorVisible?.(inspector.hidden);
  });
  function renderLandingQuestion() {
    const protocolStep = !!landingSelection?.attached && !editingDevice;
    document.body.dataset.landingStep = protocolStep ? "protocol" : "device";
    document.getElementById("landing-question").textContent = protocolStep ? "What protocol would you like to prepare?" : "On what device?";
    document.getElementById("landing-device-attachment").hidden = !protocolStep;
    document.getElementById("landing-device-name").textContent = landingSelection?.name || "";
    userInputElem.setAttribute("aria-label", protocolStep ? "Describe your protocol" : "Device manufacturer, model or description");
  }
  function attachLandingDevice(selection) {
    if (landingSelection !== selection || !document.body.classList.contains("landing")) return;
    if (!selection.attached) {
      selection.attached = true; editingDevice = false;
      userInputElem.value = protocolDraft; userInputElem.style.height = "auto";
    }
    landingChecking = false; sendBtn.disabled = false;
    renderLandingQuestion(); userInputElem.focus();
  }
  document.getElementById("landing-device-attachment")?.addEventListener("click", () => {
    if (!landingSelection) return;
    protocolDraft = userInputElem.value;
    editingDevice = true;
    renderLandingQuestion(); userInputElem.value = landingSelection.name;
    window.landingEquipment?.editDevice?.(); userInputElem.focus(); userInputElem.select();
  });
  async function selectLandingDevice(name, trusted = false, prompt = name) {
    landingSelection?.controller.abort();
    const selection = landingSelection = {name, controller:new AbortController(), attached:false};
    let identify;
    selection.identified = new Promise(resolve => {identify = resolve;});
    landingChecking = !trusted;
    let timedOut = false;
    const timeout = setTimeout(() => {timedOut = true; selection.controller.abort();}, 90000);
    const status = document.getElementById("device-choice-status");
    status.classList.remove("is-error"); status.textContent = "Checking device…";
    showModelChoices([]); if(window.landingEquipment?.beginCheck)window.landingEquipment.beginCheck();
    else window.landingEquipment?.dismissSearch();
    if (trusted) attachLandingDevice(selection);
    selection.preparation = (async () => {
      try {
        const ready = await resolveDevice("/devices/validate", {...post({device:name, prompt}), signal:selection.controller.signal}, async (message, result) => {
          if (landingSelection !== selection) return;
          selection.chatId = result.chat_id || selection.chatId;
          selection.name = result.name || selection.name;
          attachLandingDevice(selection);
          identify(result);
          if (document.body.classList.contains("landing")) status.textContent = "Preparing your device in the background. You can describe the protocol now.";
          if (result.chat_id) await refreshChatList();
        });
        if (landingSelection !== selection) return null;
        if (ready.incomplete) {
          if (document.body.classList.contains("landing")) {
            landingSelection = null; editingDevice = false; renderLandingQuestion();
            status.textContent = "Choose an exact physical model below.";
            showModelChoices(ready.options || ready.choices);
          }
          return null;
        }
        selection.name = ready.name; selection.ready = ready;
        attachLandingDevice(selection);
        identify(ready);
        if (document.body.classList.contains("landing")) status.textContent = "Device ready.";
        return ready;
      } catch (error) {
        if (landingSelection === selection && (timedOut || error.name !== "AbortError")) {
          status.classList.add("is-error");
          status.textContent = timedOut && selection.chatId
            ? "Device preparation continues in the background. Open History to follow it, or describe your protocol here."
            : timedOut ? "Checking the device took too long. Please select it again to retry." : error.message;
        }
        return null;
      } finally {
        identify(null);
        clearTimeout(timeout);
        if (landingSelection === selection) {landingChecking = false; sendBtn.disabled = isTyping;}
      }
    })();
    return selection.preparation;
  }
  function enterChat() {
    leaveProtocol(); document.body.classList.remove("landing"); userInputElem.placeholder = ""; userInputElem.setAttribute("aria-label", "Message BioBot"); userInputElem.wrap = "off";
    window.ensureDeckWorkspace?.();
  }
  function landing() {
    leaveProtocol();
    window.floatingChat?.detach();
    window.setInspectorVisible?.(false);
    pageVersion++; creating = null;
    deviceRequest?.abort(); deviceRequest = null;
    selectedDevice = ""; protocolName = ""; sourceProtocol = null;
    landingSelection?.controller.abort(); landingSelection = null; editingDevice = false; protocolDraft = ""; landingChecking = false;
    document.body.classList.add("landing");
    renderLandingQuestion();
    deviceSelect.value = "";
    userInputElem.value = ""; userInputElem.style.height = "auto";
    userInputElem.placeholder = ""; userInputElem.setAttribute("aria-label", "Device manufacturer, model or description"); userInputElem.wrap = "off";
    showNotice("");
    document.getElementById("device-choice-status").textContent = ""; deviceSelect.disabled = false;
    sendBtn.disabled = false;
    syncActions();
  }
  async function ensureChat() {
    if (currentChatId) return currentChatId;
    const version = pageVersion;
    if (!creating) creating = json("/chat", post({ protocol_id: sourceProtocol, device: selectedDevice, prepare_device: !!landingSelection?.attached })).then(async data => {
      if (version !== pageVersion) throw new DOMException("Chat changed", "AbortError");
      currentChatId = data.chat_id;
      localStorage.setItem("lastChatId", currentChatId);
      await refreshChatList();
      if (version !== pageVersion) throw new DOMException("Chat changed", "AbortError");
      selectChatListItem(currentChatId);
      return data.chat_id;
    }).finally(() => {if (version === pageVersion) creating = null;});
    return creating;
  }
  async function refreshCatalogStatus() {
    const status = document.getElementById("device-catalog-status");
    if (!status) return;
    try {
      const catalog = await json("/devices/catalog");
      const counts = catalog.counts || {}, ready = counts.ready || 0;
      const pending = (counts.queued || 0) + (counts.building || 0);
      status.textContent = pending || ["discovering", "building"].includes(catalog.status)
        ? `Building local device database · ${ready} ready${pending ? ` · ${pending} being prepared` : ""}. You can request a device now.`
        : catalog.status === "complete" ? `Local device database · ${ready} ready. Other devices are discovered on request.`
        : catalog.status === "failed" ? `Device database build interrupted · ${ready} ready. You can still request a device.`
        : "The local device database will start building when an API key is available.";
      if (catalog.status !== "complete" || pending) setTimeout(refreshCatalogStatus, 3000);
    } catch (_) { /* Catalog progress must not prevent opening a device. */ }
  }
  async function refreshDevices() {
    const devices = await json("/devices");
    deviceSelect.replaceChildren(new Option("Selected device", ""));
    for (const device of devices) deviceSelect.appendChild(new Option(device, device));
    if (selectedDevice && !devices.includes(selectedDevice)) deviceSelect.appendChild(new Option(selectedDevice, selectedDevice));
    deviceSelect.value = selectedDevice;

  }
  // All landing selections attach a device; the protocol answer opens the chat.
  function deviceBubble(device, trusted = true) {
    const bubble = document.createElement("button");
    bubble.type = "button"; bubble.className = "device-bubble"; bubble.textContent = device;
    bubble.addEventListener("click", () => document.body.classList.contains("landing") ? selectLandingDevice(device, trusted) : chooseDevice(device, null, trusted));
    return bubble;
  }
  function showModelChoices(options) {
    const models = (options || []).flatMap(option => ["series", "family"].includes(option.kind) ? option.members : [option]);
    const names = [...new Set(models.map(option => typeof option === "string" ? option : option.name))];
    document.getElementById("device-model-choices")?.replaceChildren(...names.map(name => deviceBubble(name, true)));
  }
  function chooseSeries(series) {
    window.landingEquipment?.beginCheck();
    document.getElementById("device-choice-status").textContent = `${series.name}. Choose an exact model below; only the selected model will be registered.`;
    showModelChoices(series.members);
  }
  async function resolveDevice(url, options, onProgress) {
    let result = await json(url, options);
    if (result.incomplete || !result.catalog_job) return result;
    const job = result.catalog_job;
    while (result.status !== "ready") {
      if (result.incomplete) return result;
      if (result.status === "failed") throw Error(result.error || "Could not prepare this device. Please retry.");
      await onProgress(result.message || "This device is being added to the local database…", result);
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const abort = () => {clearTimeout(timer); reject(new DOMException("Aborted", "AbortError"));};
        const timer = setTimeout(() => {options.signal.removeEventListener("abort", abort); resolve();}, 1000);
        options.signal.addEventListener("abort", abort, {once:true});
      });
      result = await json(`/devices/discovery/${encodeURIComponent(job)}`, {signal:options.signal});
    }
    return url.endsWith("/device") || url === "/devices/validate" ? json(url, options) : result;
  }

  async function chooseDevice(device, templateId = null, trusted = false) {
    if (document.body.classList.contains("landing")) return selectLandingDevice(device, trusted);
    if (isTyping && !templateId) return;
    deviceRequest?.abort();
    const controller = new AbortController();
    let timedOut = false, progress = null, enteredDeck = false;
    const status = document.getElementById("device-choice-status");
    const timeout = setTimeout(() => {timedOut = true; controller.abort();}, 90000);
    deviceRequest = controller;
    sendBtn.disabled = true; deviceSelect.disabled = true;
    try {
      selectedDevice = device;
      enterChat(); enteredDeck = true; status.textContent = "";
      userInputElem.value = ""; userInputElem.style.height = "auto";
      window.openDeviceWorkspace?.();
      progress = document.createElement("div");
      progress.className = "rag-status";
      progress.append(analyzingIcon(), document.createTextNode("Opening your device…"));
      chatHistoryElem.appendChild(progress);
      const chatId = await ensureChat();
      if (deviceRequest !== controller) return;
      const state = await resolveDevice(`/chat/${chatId}/device`, {...post({device, template_id:templateId}), signal:controller.signal}, message => {
        if (deviceRequest === controller) progress.replaceChildren(analyzingIcon(), document.createTextNode(message));
      });
      if (currentChatId !== chatId || deviceRequest !== controller) return;
      if (state.incomplete) {
        landing();
        currentChatId = null;
        localStorage.removeItem?.("lastChatId");
        userInputElem.value = device;
        status.textContent = "Choose an exact physical model below.";
        showModelChoices(state.options);
        return;
      }
      selectedDevice = state.platform;
      window.showDeviceDeck(state);
      if (!chatHistoryElem.querySelector(".chat-message")) say(`Your ${selectedDevice} workspace is ready. What would you like to prepare?`);
      await Promise.all([refreshDevices(), refreshChatList()]);
      selectChatListItem(chatId);
      userInputElem.focus();
    } catch (error) {
      if (deviceRequest === controller && (timedOut || error.name !== "AbortError")) {
        const message = timedOut
          ? "Device preparation continues in the background. Open this chat from History to follow it." : error.message;
        if (!enteredDeck) {status.classList.add("is-error"); status.textContent = message; userInputElem.focus();}
        else {window.showDeckLoadError?.(message, () => chooseDevice(device, templateId)); say(message);}
      }
    } finally {
      clearTimeout(timeout); progress?.remove();
      if (deviceRequest === controller) {deviceRequest = null; sendBtn.disabled = isTyping; deviceSelect.disabled = false;}
      syncActions();
    }
  }
  function deviceDetected(device) {
    selectedDevice = device;
    // Protocol generation owns the deck from this point. Do not race its result.
    const protocol = window.getWorkspaceProtocol?.();
    if (!protocol?.code && !protocol?.layout && !deviceRequest && currentChatId) {
      chooseDetectedDevice(device);
    }
  }
  async function chooseDetectedDevice(device) {
    const chatId = currentChatId;
    try {
      const state = await json(`/chat/${chatId}/device`, post({ device }));
      if (currentChatId === chatId && !window.getWorkspaceProtocol?.().code) window.showDeviceDeck(state);
      if (currentChatId === chatId) await refreshDevices();
    } catch (error) { console.warn("Device preview:", error.message); }
  }
  function syncActions() {
    syncNameActions();
    const protocol = window.getWorkspaceProtocol?.();
    const disabled = !protocol?.code || protocol.pending || isTyping;
    copyButton.disabled = disabled; saveButton.disabled = disabled || !!libraryProtocol;
    // The code must match the deck: unapplied edits make it stale (Generate enabled, its icons greyed); undoing them restores both.
    downloadButton.disabled = !protocol?.code || isTyping || exportRunning || protocol.invalid
      || (protocol.pending && !protocol.edited) || (exportReady && !protocol.edited);
    const stale = !exportCurrent || !!protocol?.edited || !protocol?.code || !!deviceRequest;  // nothing usable while a device opens
    for (const id of ["export-copy", "export-save"]) { const icon = document.getElementById(id); if (icon) icon.disabled = stale; }
    document.getElementById("export-download")?.classList.toggle("is-disabled", stale);
    saveButton.hidden = !!libraryProtocol;
    for (const id of ["protocol-view-download", "protocol-view-copy"]) {
      const icon = document.getElementById(id);
      if (icon) icon.hidden = !libraryProtocol;
    }
    sendBtn.disabled = isTyping || !!libraryProtocol || !!deviceRequest || !!(protocol?.code && protocol.pending);
  }
  function deckChanged(state) {
    foldParameters?.(!!foldedChats()[currentChatId], false);
    if (noticeChat !== currentChatId) {
      const kept = chatNotices.get(currentChatId);
      clearTimeout(noticeTimer); notice.textContent = ""; noticeChat = currentChatId;
      if (kept) showNotice(kept, true);
    }
    if (window.getWorkspaceProtocol?.()?.code !== exportChecked) pollExport(false, false);
    if (state && !libraryProtocol) window.floatingChat?.attach();
    if (state?.platform) {
      selectedDevice = state.platform;
      if (!Array.from(deviceSelect.options).some(option => option.value === selectedDevice)) deviceSelect.appendChild(new Option(selectedDevice, selectedDevice));
      deviceSelect.value = selectedDevice;
    }
    syncActions();
  }
  function formatDate(value) {
    const date = new Date(value || "");
    return isNaN(date) ? "" : date.toLocaleString(undefined, {day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"});
  }
  async function refreshProtocols() {
    const protocols = await json("/protocols");
    protocolList.replaceChildren();
    for (const protocol of protocols) {
      const row = document.createElement("li");
      row.className = "saved-protocol-row";
      row.dataset.protocolId = protocol.id;
      if (libraryProtocol?.id === protocol.id) row.classList.add("selected");
      const info = document.createElement("div");
      info.className = "saved-protocol-info";
      const button = document.createElement("button");
      button.className = "saved-protocol-link";
      const title = document.createElement("span"); title.textContent = protocol.name;
      const device = document.createElement("small"); device.textContent = [protocol.device_name, formatDate(protocol.created_at)].filter(Boolean).join(" · ");
      button.append(title, device);
      button.addEventListener("click", () => openProtocol(protocol.id));
      info.appendChild(button);
      const controls = document.createElement("div");
      controls.className = "chat-options";
      for (const action of ["Rename", "Remove"]) {
        const control = document.createElement("button");
        control.type = "button";
        control.className = action === "Rename" ? "rename-chat-btn" : "delete-chat-btn";
        control.title = `${action} protocol`;
        control.setAttribute("aria-label", control.title);
        control.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${action === "Rename"
          ? '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'
          : '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'}</svg>`;
        control.addEventListener("click", async () => {
          if (action === "Remove") {
            control.disabled = true;
            try {
              await json(`/protocols/${protocol.id}`, {method: "DELETE"});
              if (sourceProtocol === protocol.id) sourceProtocol = null;
              if (libraryProtocol?.id === protocol.id) await createNewChat({persist:false});
              await refreshProtocols();
              showNotice("Protocol moved to Trash.");
            } catch (error) {showNotice(error.message); control.disabled = false;}
            return;
          }
          if (button.hidden) return;
          const input = document.createElement("input");
          input.className = "rename-input";
          input.value = protocol.name; input.maxLength = 120;
          input.setAttribute("aria-label", "Protocol name");
          button.hidden = true; info.appendChild(input); input.focus(); input.select();
          let finished = false;
          const finish = async (cancel = false) => {
            if (finished) return;
            finished = true;
            const name = input.value.trim();
            if (!cancel && name && name !== protocol.name) {
              try {
                const renamed = await json(`/protocols/${protocol.id}`, {...post({name}), method: "PATCH"});
                if (sourceProtocol === protocol.id || libraryProtocol?.id === protocol.id) protocolName = renamed.name;
                if (libraryProtocol?.id === protocol.id) {
                  libraryProtocol.name = renamed.name;
                  document.getElementById("deck-heading").textContent = renamed.name;
                }
                protocol.name = renamed.name; title.textContent = renamed.name;
              } catch (error) {showNotice(error.message);}
            }
            input.remove(); button.hidden = false;
          };
          input.addEventListener("blur", () => finish());
          input.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault(); finish(event.key === "Escape");
            }
          });
        });
        controls.appendChild(control);
      }
      row.append(info, controls); protocolList.appendChild(row);
    }
    if (!protocols.length) {
      const empty = document.createElement("li"); empty.className = "library-empty";
      empty.textContent = "Protocols you save will appear here."; protocolList.appendChild(empty);
    }
    await refreshTrash();
  }
  async function refreshTrash() {
    const list = document.getElementById("trash-list");
    if (!list) return;
    try {
      const [chats, protocols] = await Promise.all([json("/chats?trashed=1"), json("/protocols?trashed=1")]);
      list.replaceChildren();
      const items = [...chats.map(chat => ({...chat, id:chat.chat_id, type:"chat"})),
                     ...protocols.map(protocol => ({...protocol, type:"protocol"}))];
      items.sort((a,b) => (Date.parse(b.deleted_at) || 0) - (Date.parse(a.deleted_at) || 0));
      for (const item of items) {
        const row = document.createElement("li"); row.className = "trash-row";
        const name = document.createElement("span"); name.className = "trash-name"; name.textContent = item.name; name.title = item.name;
        const badge = document.createElement("span"); badge.className = `trash-badge ${item.type}`; badge.textContent = item.type;
        const date = document.createElement("small"); date.className = "trash-date"; date.textContent = formatDate(item.deleted_at);
        date.title = item.deleted_at ? `Moved to Trash ${new Date(item.deleted_at).toLocaleString()}` : "";
        const restore = document.createElement("button"); restore.type = "button"; restore.className = "restore-chat-btn";
        restore.title = `Restore ${item.type}`; restore.setAttribute("aria-label", `Restore ${item.type} “${item.name}”`);
        restore.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg>';
        restore.addEventListener("click", async () => {
          restore.disabled = true;
          try {
            await json(`/${item.type === "chat" ? "chat" : "protocols"}/${item.id}/restore`, post({}));
            if (item.type === "chat") await refreshChatList();
            else await refreshProtocols();
            await refreshTrash();
          } catch (error) {showNotice(error.message); restore.disabled = false;}
        });
        const info = document.createElement("div"); info.className = "trash-info"; info.append(name, date);
        row.append(info, badge, restore); list.appendChild(row);
      }
      if (!list.children.length) {
        const empty = document.createElement("li"); empty.className = "library-empty"; empty.textContent = "Trash is empty."; list.appendChild(empty);
      }
    } catch (error) {showNotice(error.message);}
  }
  async function openProtocol(id) {
    const version = ++pageVersion;
    creating = null;
    try {
      const protocol = await json(`/protocols/${id}`);
      if (version !== pageVersion) return;
      await createNewChat({persist:false});
      libraryProtocol = {...protocol, id};
      try {localStorage.setItem("lastProtocolId", id);} catch (_) {}
      protocolName = protocol.name; selectedDevice = protocol.device_name;
      document.body.classList.remove("landing");
      document.body.classList.add("protocol-library-view");
      document.getElementById("deck-heading").textContent = protocol.name;
      document.getElementById("protocol-edit-chat-btn").hidden = false;
      for (const row of protocolList.children) row.classList.toggle("selected", row.dataset.protocolId === id);
      await window.parseDeckFromCode(protocol.code);
      syncActions();
    } catch (error) { alert(error.message); }
  }
  document.getElementById("protocol-edit-chat-btn").addEventListener("click", async () => {
    if (!libraryProtocol) return;
    const protocol = libraryProtocol;
    await createNewChat({persist:false});
    enterChat(); protocolName = protocol.name; selectedDevice = protocol.device_name; sourceProtocol = protocol.id;
    try {
      await ensureChat();
      say(`Editing a copy of “${protocol.name}”. Describe the changes you would like to make.`);
      await window.parseDeckFromCode(protocol.code);
    } catch (error) {if (error.name !== "AbortError") showNotice(error.message);}
  });
  function switchChat() {
    leaveProtocol();
    window.floatingChat?.detach();
    window.setInspectorVisible?.(false);
    pageVersion++; creating = null; deviceRequest?.abort(); deviceRequest = null;
    protocolName = ""; sourceProtocol = null; selectedDevice = "";
  }
  function restoreChat(chatId, device) {
    pageVersion++;
    deviceRequest?.abort(); deviceRequest = null;
    selectedDevice = device || chats.get(chatId)?.device || "";
    deviceSelect.value = selectedDevice;
    const links = chatHistoryElem.querySelectorAll(".protocol-deck-link");
    if (links.length) {const link = links[links.length - 1]; window.parseDeckFromCode(link._protocolCode, link);}
    else if (selectedDevice) {
      if (isTyping) chooseDetectedDevice(selectedDevice);
      else chooseDevice(selectedDevice);
    }
  }
  deviceSelect.addEventListener("change", () => {
    if (deviceSelect.value) chooseDevice(deviceSelect.value);
  });
  // Saved-protocol view: download or copy the protocol as saved.
  document.getElementById("protocol-view-copy")?.addEventListener("click", () => copyButton.click());
  document.getElementById("protocol-view-download")?.addEventListener("click", () => {
    const code = window.getWorkspaceProtocol?.()?.code;
    if (!code) return;
    const format = FORMAT_CONFIG[detectFormat(code)] || FORMAT_CONFIG.text;
    const link = document.createElement("a");
    const name = (libraryProtocol?.name || protocolName || "protocol").replace(/[\\/:*?"<>|]/g, "_");
    link.href = URL.createObjectURL(new Blob([code], {type: format.mime}));
    link.download = name.endsWith(format.ext) ? name : name + format.ext;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  copyButton.addEventListener("click", async () => {
    try {await navigator.clipboard.writeText(window.getWorkspaceProtocol().code); showNotice("Protocol copied.");}
    catch (_) {showNotice("Could not copy the protocol. Please try again.");}
  });
  // Export runs on the server; the page only polls it, so the deck stays usable
  // and leaving the chat does not lose the job.
  const exportSpinner = document.getElementById("export-spinner");
  const exportLink = document.getElementById("export-download");
  const exportStep = document.getElementById("export-step");
  // The parameters pane folds to its title, separately in each chat (remembered in this browser).
  const parametersPane = document.getElementById("protocol-parameters"), parametersToggle = document.getElementById("parameters-toggle");
  function foldedChats() {
    try { return JSON.parse(localStorage.getItem("biobot-parameters-folded-chats") || "{}"); } catch (_) { return {}; }
  }
  function foldParameters(folded, remember = true) {
    parametersPane?.classList.toggle("collapsed", folded);
    const fields = document.getElementById("protocol-parameter-fields");
    if (fields) fields.hidden = folded;
    parametersToggle?.setAttribute("aria-expanded", String(!folded));
    if (!remember) return;
    const chats = foldedChats();
    if (folded) chats[currentChatId] = true; else delete chats[currentChatId];
    try { localStorage.setItem("biobot-parameters-folded-chats", JSON.stringify(chats)); } catch (_) {}
  }
  parametersToggle?.addEventListener("click", () => foldParameters(!parametersPane.classList.contains("collapsed")));
  const debugLogs = document.getElementById("debug-logs");  // admins only
  // Admin access: users request it; admins approve or reject pending requests in Settings.
  document.getElementById("admin-request-btn")?.addEventListener("click", async event => {
    try { await json("/admin/request", post({})); event.target.outerHTML = '<p class="admin-status">Admin access requested — awaiting approval.</p>'; }
    catch (error) { showNotice(error.message); }
  });
  async function refreshAdminRequests() {
    const box = document.getElementById("admin-requests");
    if (!box) return;
    let users;
    try { users = await json("/admin/requests"); } catch (_) { return; }
    for (const badge of document.querySelectorAll("[data-admin-count]")) {
      badge.hidden = !users.length; badge.textContent = users.length > 9 ? "9+" : String(users.length);
    }
    clearTimeout(refreshAdminRequests.timer);
    refreshAdminRequests.timer = setTimeout(refreshAdminRequests, 60000);
    box.replaceChildren();
    if (!users.length) box.innerHTML = '<p class="admin-status">No pending requests.</p>';
    for (const user of users) {
      const row = document.createElement("div"); row.className = "admin-request";
      const who = document.createElement("span"); who.textContent = `${user.first_name || ""} ${user.last_name || ""} (${user.email}) requests admin access`;
      row.appendChild(who);
      for (const [label, approve] of [["Approve", true], ["Reject", false]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "btn"; button.textContent = label;
        button.addEventListener("click", async () => {
          try { await json(`/admin/requests/${user.id}`, post({approve})); refreshAdminRequests(); } catch (error) { showNotice(error.message); }
        });
        row.appendChild(button);
      }
      box.appendChild(row);
    }
  }
  refreshAdminRequests();
  if (debugLogs) {
    try { debugLogs.checked = localStorage.getItem("biobot-debug-logs") === "1"; } catch (_) {}
    debugLogs.addEventListener("change", () => {
      try { localStorage.setItem("biobot-debug-logs", debugLogs.checked ? "1" : "0"); } catch (_) {}
    });
  }
  const exportCopy = document.getElementById("export-copy"), exportSave = document.getElementById("export-save");
  let exportCode = null, revertTo = null;
  const exportRevert = document.getElementById("export-revert");
  exportRevert?.addEventListener("click", () => {
    if (!revertTo || !confirm("Go back to the protocol of the last generated code? Changes made since then (chat or parameters) will be lost.")) return;
    window.restoreProtocol?.(revertTo);
  });
  exportCopy?.addEventListener("click", async () => {
    try {await navigator.clipboard.writeText(exportCode); showNotice("Code copied.");}
    catch (_) {showNotice("Could not copy the code. Please try again.");}
  });
  exportSave?.addEventListener("click", () => saveButton.click());
  window.exportingChats = new Set();
  async function refreshExportingChats() {
    try { window.exportingChats = new Set((await json("/protocol/exports")).running); } catch (_) { return; }
    window.syncChatActivity?.();
    if (window.exportingChats.size) setTimeout(refreshExportingChats, 3000);
  }
  function showExportProgress(job) {
    exportRunning = job?.state === "running";
    exportReady = job?.state === "done";  // code for this exact protocol exists; a chat change or a parameter edit makes a new protocol
    if (exportSpinner) exportSpinner.hidden = !exportRunning;
    if (exportStep) { exportStep.hidden = !exportRunning; exportStep.textContent = exportRunning ? job.step || "" : ""; }
    syncActions();
  }
  let exportTimer = null, exportChecked = null;
  async function pollExport(start, deliver) {
    const protocol = window.getWorkspaceProtocol?.()?.code;
    clearTimeout(exportTimer);
    exportChecked = protocol;
    showDownload(null);
    showExportProgress(null);
    revertTo = null;
    if (exportRevert) exportRevert.hidden = true;
    if (!protocol) return;
    let job;
    try { job = await json("/protocol/export", post({protocol, chat_id: currentChatId, start, debug: debugLogs?.checked === true || localStorage.getItem("biobot-debug-logs") === "1"})); }
    catch (error) { if (deliver) showNotice(`Code generation failed: ${error.message}`, true); return; }
    if (window.getWorkspaceProtocol?.()?.code !== protocol) return;  // the user moved on; checked again on return
    showExportProgress(job);
    if (start && job.state === "running") refreshExportingChats();
    if (job.state === "running") exportTimer = setTimeout(() => pollExport(false, true), 3000);
    else if (job.state === "error" && deliver) showNotice(`Code generation failed: ${job.error}`, true);
    else if (job.state === "done") { showDownload(job.code); if (deliver && job.warning) showNotice(job.warning, true); }
    if (job.state !== "done" && job.previous) showDownload(job.previous.code, false);
    revertTo = job.state !== "done" ? job.previous?.protocol || null : null;
    if (exportRevert) exportRevert.hidden = !revertTo;
  }
  // A ready file is offered as a link next to the Share icon.
  function showDownload(code, current = true) {
    exportCode = code;
    exportCurrent = !!code && current;
    // Always shown; usable only once code matching the current protocol exists.
    for (const icon of [exportCopy, exportSave]) if (icon) { icon.hidden = false; icon.disabled = !exportCurrent; }
    exportLink?.classList.toggle("is-disabled", !exportCurrent);
    exportLink?.setAttribute("aria-disabled", String(!exportCurrent));
    if (!exportLink) return;
    if (String(exportLink.href || "").startsWith("blob:")) URL.revokeObjectURL(exportLink.href);
    exportLink.hidden = false;
    exportLink.removeAttribute("href");
    if (!code) return;
    const format = FORMAT_CONFIG[detectFormat(code)] || FORMAT_CONFIG.text;
    const name = (protocolName || "protocol").replace(/[\\/:*?"<>|]/g, "_");
    exportLink.href = URL.createObjectURL(new Blob([code], {type: format.mime}));
    exportLink.download = name.endsWith(format.ext) ? name : name + format.ext;
  }
  downloadButton.addEventListener("click", async () => {
    // Unapplied deck or parameter edits are applied first, so the code matches what is shown.
    if (window.getWorkspaceProtocol?.()?.edited) {
      await window.applyDeckEdits?.();
      if (window.getWorkspaceProtocol?.()?.pending) return;
    }
    pollExport(true, true);
  });
  refreshExportingChats();
  actions.addEventListener("click", event => {
    if (event.target.closest("button")) actions.open = false;
  });
  actions.addEventListener("keydown", event => {
    if (event.key === "Escape") actions.open = false;
  });
  document.addEventListener?.("click", event => {
    if (!actions.contains(event.target)) actions.open = false;
  });
  saveButton.addEventListener("click", () => {
    nameInput.value = protocolName;
    document.getElementById("protocol-save-error").textContent = "";
    dialog.showModal(); nameInput.focus();
  });
  document.getElementById("protocol-save-cancel").addEventListener("click", () => dialog.close());
  document.getElementById("save-protocol-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try {
      const protocol = window.getWorkspaceProtocol();
      if (!protocol.code || protocol.pending || isTyping) throw new Error("Finish applying your changes before saving.");
      const saved = await json("/protocols", post({ name: nameInput.value.trim(), code: protocol.code, device: selectedDevice }));
      protocolName = saved.name;
      dialog.close(); showNotice(`Saved “${protocolName}” to your protocols.`);
      document.querySelector(".protocol-library").open = true;
      await refreshProtocols();
    } catch (error) {document.getElementById("protocol-save-error").textContent = error.message;}
    finally {button.disabled = false;}
  });
  window.workspace = { async restoreProtocol() {
      let id;
      try {id = localStorage.getItem("lastProtocolId");} catch (_) {}
      if (!id) return false;
      await openProtocol(id);
      if (!libraryProtocol) {try {localStorage.removeItem("lastProtocolId");} catch (_) {}}
      return !!libraryProtocol;
    }, needsDevice(chatId) {
      const chat = chats.get(chatId);
      return !!chat && !chat.device && chat.has_messages === false && !chat.run;
    }, switchChat, refreshTrash, landing, enterChat, ensureChat, analyzingIcon, chooseDevice, selectLandingDevice, chooseSeries, deviceDetected,
    clearDeviceChoices() {
      if (deviceRequest) return;
      if (!landingSelection?.attached || editingDevice) document.getElementById("device-choice-status").textContent = "";
      showModelChoices([]);
    },
    deckChanged, syncActions, restoreChat, rememberChat: chat => {chats.set(chat.chat_id, chat); syncNameActions();},
    confirmLayout() { window.confirmDeviceLayout(); showNotice("Deck layout ready. It will be included in your next request."); },
    async startDevice(message) {
      if (!document.body.classList.contains("landing")) return false;
      if (!message.trim()) return true;
      if (landingSelection?.attached && !editingDevice) {
        const selection = landingSelection;
        selectedDevice = selection.name;
        currentChatId = selection.chatId || null;
        try {
          await ensureChat();
          const chatId = currentChatId;
          enterChat();
          window.openDeviceWorkspace?.();
          selection.preparation.then(ready => {
            if (ready && currentChatId === chatId && !window.getWorkspaceProtocol?.()?.code) chooseDetectedDevice(ready.name);
          });
          return false; // The second answer is sent as the first protocol prompt.
        } catch (error) {
          const status = document.getElementById("device-choice-status");
          status.classList.add("is-error"); status.textContent = error.message;
          return true;
        }
      }
      const device = message.trim() || deviceSelect.value;
      if (!device) return true;
      const saved=window.landingEquipment?.resolve(device);
      const preparation = selectLandingDevice(saved?.name || device, !!saved, message);
      const selection = landingSelection;
      const identified = await selection.identified;
      if (selection !== landingSelection) return true;
      if (identified?.has_protocol_request && selection.attached) return window.workspace.startDevice(message);
      await preparation;
      return true;
    },
    generationLayout() {
      const state = window.getWorkspaceProtocol?.().layout;
      if (!state) return undefined;
      const {platform, layout_type, workspace, grid, positions, instruments, plates, carriers} = state;
      return {platform, layout_type, workspace, grid, positions:positions?.filter(pos => pos.configurable !== false),
        instruments:instruments?.filter(item => item.configurable !== false), plates, carriers};
    },
    get choosingDevice() {return !landingSelection?.attached || editingDevice;},
    get readOnly() {return !!libraryProtocol;},
    get deviceContext() {return selectedDevice;},
    get busy() {const protocol = window.getWorkspaceProtocol?.(); return !!libraryProtocol || landingChecking || !!deviceRequest || !!(protocol?.code && protocol.pending);} };
  Promise.all([refreshDevices(), refreshProtocols()]).catch(error => {showNotice(error.message);});
  refreshCatalogStatus();
})();
