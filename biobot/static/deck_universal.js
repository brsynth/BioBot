/**
 * deck_universal.js — Universal Deck Renderer
 *
 * The LLM extracts a JSON deck state from ANY protocol code.
 * This single renderer displays it — adapting the layout based on
 * layout_type (grid, linear, plates). No per-platform code.
 */

let _currentCode = null;
let _originalCode = null;   // saved for finding the code block by content match
let _currentState = null;
let _originalState = null;  // saved on first load for discard
let _deckAbort = null;
let _selectedSlot = null;
let _pendingChanges = [];
let _sourceCodeBlock = null;  // the specific code block element the deck was opened from  // tracks all changes before applying

// ============================================================
// Main Entry
// ============================================================

async function parseDeckFromCode(code, sourceBlock) {
  const chatId = window.currentChatId || null;
  if (_deckAbort) { _deckAbort.abort(); _deckAbort = null; }

  _currentCode = code;
  _originalCode = code;
  _selectedSlot = null;
  _pendingChanges = [];
  _sourceCodeBlock = sourceBlock || null;
  _openDeckPanel();
  _showLoading();

  _deckAbort = new AbortController();
  const parseForChat = chatId;

  try {
    const res = await fetch("/deck/visualize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: _deckAbort.signal,
    });
    _deckAbort = null;
    if (!res.ok) { _showError("Failed to generate deck"); return; }
    const state = await res.json();
    if (state.error) { _showError(state.error); return; }
    if (parseForChat && window.currentChatId !== parseForChat) return;

    _currentState = state;
    _originalState = JSON.parse(JSON.stringify(state));  // deep copy for discard
    _renderDeck(state);
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error("Deck error:", e);
    _showError("Error generating deck");
  }
}

// ============================================================
// Universal Renderer — adapts to layout_type
// ============================================================

function _renderDeck(state) {
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "deck-wrapper";

  // Title
  const title = document.createElement("div");
  title.className = "deck-title";
  title.textContent = state.platform || "Deck Layout";
  if (state.title) title.textContent += " — " + state.title;
  wrapper.appendChild(title);

  // Instruments bar — always show (even if empty, shows both empty mounts)
  wrapper.appendChild(_renderInstruments(state.instruments || []));

  // Layout
  const layoutType = state.layout_type || "grid";

  if (layoutType === "grid") {
    wrapper.appendChild(_renderGrid(state));
  } else if (layoutType === "linear") {
    wrapper.appendChild(_renderLinear(state));
  } else if (layoutType === "plates") {
    wrapper.appendChild(_renderPlates(state));
  } else {
    wrapper.appendChild(_renderGrid(state)); // fallback
  }

  // Info panel
  const info = document.createElement("div");
  info.id = "deck-info";
  info.className = "deck-info-panel";
  info.innerHTML = '<span class="deck-info-hint">Click a position for details</span>';
  wrapper.appendChild(info);

  container.appendChild(wrapper);
}

// ============================================================
// Grid Layout (OT-2 style)
// ============================================================

function _renderGrid(state) {
  const grid = state.grid || { rows: 4, cols: 3 };
  const positions = state.positions || [];

  const deck = document.createElement("div");
  deck.className = "deck-grid";
  deck.style.gridTemplateColumns = `repeat(${grid.cols}, 1fr)`;
  deck.style.gridTemplateRows = `repeat(${grid.rows}, 1fr)`;

  // Build position map
  const posMap = {};
  for (const p of positions) posMap[p.id] = p;

  // Render slots in order (top-left to bottom-right)
  const labels = grid.labels || [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      // Find position for this cell
      const pos = positions.find(p => p.row === r && p.col === c)
        || { id: labels[r * grid.cols + c] || `${r},${c}`, type: "empty" };

      const slot = _createSlot(pos);
      deck.appendChild(slot);
    }
  }

  return deck;
}

// ============================================================
// Linear Layout (Hamilton style)
// ============================================================

function _renderLinear(state) {
  const carriers = state.carriers?.items || [];
  const container = document.createElement("div");
  container.className = "deck-linear";

  if (carriers.length === 0) {
    container.innerHTML = '<span class="deck-empty-msg">No carriers detected</span>';
    return container;
  }

  for (const carrier of carriers) {
    const card = document.createElement("div");
    card.className = "deck-carrier";

    const header = document.createElement("div");
    header.className = "deck-carrier-header";
    header.innerHTML = `<span class="deck-carrier-name">${carrier.name || carrier.type}</span>
      <span class="deck-carrier-track">Track ${carrier.track || "?"}</span>`;
    card.appendChild(header);

    for (const pos of (carrier.positions || [])) {
      const slot = document.createElement("div");
      slot.className = `deck-slot ${pos.labware ? "filled" : "empty"}`;
      slot.dataset.id = `${carrier.type}_${pos.index}`;
      if (_selectedSlot === slot.dataset.id) slot.classList.add("selected");

      slot.innerHTML = `<span class="slot-num">${pos.index}</span>` +
        (pos.labware
          ? `<span class="slot-labware">${pos.labware}</span>
             ${pos.variable ? `<span class="slot-var">${pos.variable}</span>` : ""}`
          : `<span class="slot-empty-label">Empty</span>`);

      slot.addEventListener("click", () => _selectSlot(slot.dataset.id, pos));
      card.appendChild(slot);
    }

    container.appendChild(card);
  }

  return container;
}

// ============================================================
// Plates Layout (Echo style)
// ============================================================

function _renderPlates(state) {
  const plates = state.plates || {};
  const container = document.createElement("div");
  container.className = "deck-plates";

  if (plates.source) container.appendChild(_renderPlateMap(plates.source, "source"));
  if (plates.destination) container.appendChild(_renderPlateMap(plates.destination, "dest"));

  // Transfer summary
  if (plates.transfer_count) {
    const summary = document.createElement("div");
    summary.className = "deck-plate-summary";
    summary.innerHTML = `<span>${plates.transfer_count} transfers</span>` +
      (plates.volume_range ? `<span>${plates.volume_range}</span>` : "");
    container.appendChild(summary);
  }

  return container;
}

function _renderPlateMap(plate, role) {
  const format = plate.format || 96;
  const rows = format <= 96 ? 8 : 16;
  const cols = format <= 96 ? 12 : 24;
  const usedWells = new Set(plate.wells_used || []);

  const section = document.createElement("div");
  section.className = "deck-plate-section";

  const label = document.createElement("div");
  label.className = "deck-plate-label";
  label.textContent = plate.name || (role === "source" ? "Source" : "Destination");
  if (plate.type) label.textContent += ` (${plate.type})`;
  section.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "deck-well-grid";
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  const rowLabels = "ABCDEFGHIJKLMNOP";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wellId = `${rowLabels[r]}${c + 1}`;
      const well = document.createElement("div");
      well.className = "deck-well";
      if (usedWells.has(wellId)) {
        well.classList.add(role === "source" ? "well-source" : "well-dest");
      }
      well.title = wellId;
      grid.appendChild(well);
    }
  }

  section.appendChild(grid);
  return section;
}

// ============================================================
// Shared Components
// ============================================================

function _createSlot(pos) {
  const slot = document.createElement("div");
  const filled = pos.labware && pos.type !== "empty";
  slot.className = `deck-slot ${filled ? "filled" : "empty"} ${pos.type === "trash" ? "trash" : ""}`;
  slot.dataset.id = pos.id;
  if (_selectedSlot === pos.id) slot.classList.add("selected");

  slot.innerHTML = `<span class="slot-num">${pos.id}</span>`;
  if (filled) {
    slot.innerHTML += `<span class="slot-labware">${pos.labware_display || _shorten(pos.labware)}</span>`;
    if (pos.variable) slot.innerHTML += `<span class="slot-var">${pos.variable}</span>`;
    if (pos.module) slot.innerHTML += `<span class="slot-module">${pos.module}</span>`;
  } else {
    slot.innerHTML += `<span class="slot-empty-label">${pos.type === "trash" ? "Trash" : ""}</span>`;
  }

  slot.addEventListener("click", () => _selectSlot(pos.id, pos));
  slot.addEventListener("dblclick", () => _showSelector(pos.id, pos.labware || null));

  return slot;
}

function _renderInstruments(instruments) {
  const bar = document.createElement("div");
  bar.className = "deck-instruments";
  for (const inst of instruments) {
    const chip = document.createElement("div");
    chip.className = "deck-instrument";
    if (_selectedSlot === `inst_${inst.mount || inst.name}`) chip.classList.add("selected");

    chip.innerHTML = `<span class="inst-name">${inst.name}</span>` +
      (inst.mount ? `<span class="inst-mount">${inst.mount}</span>` : "") +
      (inst.tipracks?.length ? `<span class="inst-tips">Tips: ${inst.tipracks.join(", ")}</span>` : "");

    // Click to select and show details
    chip.addEventListener("click", () => {
      const id = `inst_${inst.mount || inst.name}`;
      _selectedSlot = (_selectedSlot === id) ? null : id;
      _renderDeck(_currentState);

      const info = document.getElementById("deck-info");
      if (!info) return;
      if (!_selectedSlot) {
        info.innerHTML = '<span class="deck-info-hint">Click a position for details. Double-click to change.</span>';
        return;
      }
      let html = `<div class="info-row"><span class="info-label">Instrument:</span> <span style="color:#00ff99">${inst.name}</span></div>`;
      if (inst.model) html += `<div class="info-row"><span class="info-label">API name:</span> <code>${inst.model}</code></div>`;
      if (inst.mount) html += `<div class="info-row"><span class="info-label">Mount:</span> ${inst.mount}</div>`;
      if (inst.tipracks?.length) html += `<div class="info-row"><span class="info-label">Tip racks:</span> slots ${inst.tipracks.join(", ")}</div>`;
      html += `<div class="info-row" style="color:#666;font-size:0.7rem;margin-top:6px">Double-click to change</div>`;
      info.innerHTML = html;
    });

    // Double-click to open instrument selector
    chip.addEventListener("dblclick", () => {
      _showInstrumentSelector(inst);
    });

    bar.appendChild(chip);
  }

  // Add empty mount chips if only one pipette is present
  const mounts = instruments.map(i => i.mount?.toLowerCase());
  for (const mount of ["left", "right"]) {
    if (!mounts.includes(mount)) {
      const emptyChip = document.createElement("div");
      emptyChip.className = "deck-instrument empty-instrument";
      emptyChip.innerHTML = `<span class="inst-mount">${mount}</span><span class="inst-empty">Empty — double-click to add</span>`;
      emptyChip.addEventListener("dblclick", () => {
        _showInstrumentSelector({ name: "", model: "", mount: mount, tipracks: [] }, true);
      });
      bar.appendChild(emptyChip);
    }
  }

  return bar;
}

// ============================================================
// Instrument Selector
// ============================================================

async function _showInstrumentSelector(inst, isNew) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) existing.remove();

  const platform = _currentState?.platform || "Unknown";

  const modal = document.createElement("div");
  modal.id = "deck-selector-modal";
  modal.className = "deck-selector-modal";
  modal.innerHTML = `
    <div class="deck-selector-content">
      <div class="deck-selector-header">
        <h4>${isNew ? "Add Instrument" : "Change Instrument"} — ${inst.mount || ""} mount</h4>
        <button class="deck-selector-close" id="deck-selector-close-btn">&times;</button>
      </div>
      <div class="deck-selector-loading">
        <div class="deck-loading-spinner"></div>
        <span>Loading compatible instruments...</span>
      </div>
    </div>
  `;

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  document.getElementById("deck-selector-close-btn").addEventListener("click", () => modal.remove());

  try {
    const res = await fetch("/deck/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, position_type: "instrument", current: inst.model || null }),
    });

    if (!res.ok) throw new Error("Failed to load catalog");
    const catalog = await res.json();
    if (catalog.error) throw new Error(catalog.error);

    _renderInstrumentCatalog(modal, catalog, inst);
  } catch (e) {
    const content = modal.querySelector(".deck-selector-content");
    if (content) {
      content.querySelector(".deck-selector-loading").innerHTML =
        `<span style="color:#ff4d4d">Error: ${e.message}</span>`;
    }
  }
}

function _renderInstrumentCatalog(modal, catalog, inst) {
  const content = modal.querySelector(".deck-selector-content");
  content.querySelector(".deck-selector-loading").remove();

  // Search
  const search = document.createElement("input");
  search.type = "text";
  search.className = "deck-selector-search";
  search.placeholder = "Search instruments...";
  search.addEventListener("input", () => _filterCatalog(content, search.value));
  content.querySelector(".deck-selector-header").after(search);

  // Mount selector
  const mountDiv = document.createElement("div");
  mountDiv.className = "instrument-mount-selector";
  mountDiv.innerHTML = `
    <span class="deck-selector-category">Mount</span>
    <div class="mount-options">
      <label class="mount-option ${inst.mount === "left" ? "active" : ""}">
        <input type="radio" name="inst_mount" value="left" ${inst.mount === "left" ? "checked" : ""} /> Left
      </label>
      <label class="mount-option ${inst.mount === "right" ? "active" : ""}">
        <input type="radio" name="inst_mount" value="right" ${inst.mount === "right" ? "checked" : ""} /> Right
      </label>
    </div>
  `;
  content.appendChild(mountDiv);

  // Handle mount toggle styling
  mountDiv.querySelectorAll("input[name='inst_mount']").forEach(radio => {
    radio.addEventListener("change", () => {
      mountDiv.querySelectorAll(".mount-option").forEach(l => l.classList.remove("active"));
      radio.closest(".mount-option").classList.add("active");
    });
  });

  // Remove option if instrument exists
  if (inst.model) {
    const removeBtn = document.createElement("div");
    removeBtn.className = "deck-selector-item remove";
    removeBtn.innerHTML = `<span style="color:#ff4d4d">✕ Remove instrument</span>`;
    removeBtn.addEventListener("click", () => {
      modal.remove();
      _applyInstrumentChange(inst, null, null);
    });
    content.appendChild(removeBtn);
  }

  // Instrument items
  const list = document.createElement("div");
  list.className = "deck-selector-list";

  for (const cat of (catalog.categories || [])) {
    const catDiv = document.createElement("div");
    catDiv.className = "deck-selector-category";
    catDiv.textContent = cat.name;
    list.appendChild(catDiv);

    for (const item of (cat.items || [])) {
      const itemDiv = document.createElement("div");
      itemDiv.className = `deck-selector-item ${item.id === inst.model ? "active" : ""}`;
      itemDiv.dataset.search = `${item.name} ${item.id} ${item.detail || ""}`.toLowerCase();
      itemDiv.innerHTML = `
        <span class="selector-name">${item.name}</span>
        <span class="selector-detail">${item.detail || ""}</span>
        <span class="selector-id">${item.id}</span>
      `;
      itemDiv.addEventListener("click", () => {
        const selectedMount = content.querySelector("input[name='inst_mount']:checked")?.value || inst.mount;
        modal.remove();
        _applyInstrumentChange(inst, item.id, selectedMount);
      });
      list.appendChild(itemDiv);
    }
  }

  content.appendChild(list);

  // Custom instrument input
  const customDiv = document.createElement("div");
  customDiv.className = "deck-selector-custom";
  customDiv.innerHTML = `
    <span class="deck-selector-category">Custom Instrument</span>
    <div class="custom-input-row">
      <input type="text" class="deck-selector-custom-input" id="custom-inst-input"
             placeholder="Enter instrument API name..." />
      <button class="custom-apply-btn" id="custom-inst-btn">Apply</button>
    </div>
  `;
  content.appendChild(customDiv);

  document.getElementById("custom-inst-btn").addEventListener("click", () => {
    const val = document.getElementById("custom-inst-input").value.trim();
    if (val) {
      const selectedMount = content.querySelector("input[name='inst_mount']:checked")?.value || inst.mount;
      modal.remove();
      _applyInstrumentChange(inst, val, selectedMount);
    }
  });

  setTimeout(() => search.focus(), 100);
}

function _applyInstrumentChange(oldInst, newModel, newMount) {
  if (!_currentState) return;
  if (!_currentState.instruments) _currentState.instruments = [];

  const targetMount = newMount || oldInst.mount;

  if (newModel) {
    _pendingChanges.push({
      type: "change_instrument",
      mount: oldInst.mount,
      old_model: oldInst.model || null,
      new_model: newModel,
      new_mount: targetMount,
    });

    // Remove any existing instrument on the target mount first
    _currentState.instruments = _currentState.instruments.filter(i => i.mount !== targetMount);

    // If changing mount (e.g. left → right), also remove from old mount
    if (oldInst.mount && oldInst.mount !== targetMount) {
      _currentState.instruments = _currentState.instruments.filter(i => i.mount !== oldInst.mount);
    }

    // Add the new instrument
    _currentState.instruments.push({
      name: newModel.replace(/_/g, " "),
      model: newModel,
      mount: targetMount,
      tipracks: oldInst.tipracks || [],
    });
  } else {
    _pendingChanges.push({
      type: "remove_instrument",
      mount: oldInst.mount,
      old_model: oldInst.model,
    });

    // Remove from local state
    _currentState.instruments = _currentState.instruments.filter(i => i.mount !== oldInst.mount);
  }

  _selectedSlot = null;
  _renderDeck(_currentState);
  _renderApplyBar();
}

function _selectSlot(id, pos) {
  _selectedSlot = (_selectedSlot === id) ? null : id;
  _renderDeck(_currentState);

  const info = document.getElementById("deck-info");
  if (!info) return;
  if (!_selectedSlot) {
    info.innerHTML = '<span class="deck-info-hint">Click a position for details. Double-click to change.</span>';
    return;
  }

  let html = `<div class="info-row"><span class="info-label">Position:</span> ${pos.id}</div>`;
  if (pos.labware) html += `<div class="info-row"><span class="info-label">Labware:</span> <span style="color:#00ff99">${pos.labware_display || pos.labware}</span></div>`;
  if (pos.labware && pos.labware !== pos.labware_display) html += `<div class="info-row"><span class="info-label">API name:</span> <code>${pos.labware}</code></div>`;
  if (pos.variable) html += `<div class="info-row"><span class="info-label">Variable:</span> <code>${pos.variable}</code></div>`;
  if (pos.module) html += `<div class="info-row"><span class="info-label">Module:</span> ${pos.module}</div>`;
  if (pos.type) html += `<div class="info-row"><span class="info-label">Type:</span> ${pos.type}</div>`;
  info.innerHTML = html;
}

// ============================================================
// Selector Modal — LLM-driven catalog
// ============================================================

async function _showSelector(slotId, currentLabware) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) existing.remove();

  const platform = _currentState?.platform || "Unknown";

  const modal = document.createElement("div");
  modal.id = "deck-selector-modal";
  modal.className = "deck-selector-modal";
  modal.innerHTML = `
    <div class="deck-selector-content">
      <div class="deck-selector-header">
        <h4>Position ${slotId}</h4>
        <button class="deck-selector-close" id="deck-selector-close-btn">&times;</button>
      </div>
      <div class="deck-selector-loading">
        <div class="deck-loading-spinner"></div>
        <span>Loading compatible hardware...</span>
      </div>
    </div>
  `;

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  document.getElementById("deck-selector-close-btn").addEventListener("click", () => modal.remove());

  // Fetch catalog from LLM
  try {
    const res = await fetch("/deck/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, position_type: "labware", current: currentLabware }),
    });

    if (!res.ok) throw new Error("Failed to load catalog");
    const catalog = await res.json();
    if (catalog.error) throw new Error(catalog.error);

    _renderCatalog(modal, catalog, slotId, currentLabware);
  } catch (e) {
    const content = modal.querySelector(".deck-selector-content");
    if (content) {
      content.querySelector(".deck-selector-loading").innerHTML =
        `<span style="color:#ff4d4d">Error: ${e.message}</span>`;
    }
  }
}

function _renderCatalog(modal, catalog, slotId, currentLabware) {
  const content = modal.querySelector(".deck-selector-content");
  const loading = content.querySelector(".deck-selector-loading");
  loading.remove();

  // Search
  const search = document.createElement("input");
  search.type = "text";
  search.className = "deck-selector-search";
  search.placeholder = "Search...";
  search.addEventListener("input", () => _filterCatalog(content, search.value));
  content.querySelector(".deck-selector-header").after(search);

  // Remove option if currently filled
  if (currentLabware) {
    const removeBtn = document.createElement("div");
    removeBtn.className = "deck-selector-item remove";
    removeBtn.innerHTML = `<span style="color:#ff4d4d">✕ Remove labware</span>`;
    removeBtn.addEventListener("click", () => { modal.remove(); _applyChange(slotId, null, currentLabware); });
    content.appendChild(removeBtn);
  }

  // Categories and items
  const list = document.createElement("div");
  list.className = "deck-selector-list";

  for (const cat of (catalog.categories || [])) {
    const catDiv = document.createElement("div");
    catDiv.className = "deck-selector-category";
    catDiv.textContent = cat.name;
    list.appendChild(catDiv);

    for (const item of (cat.items || [])) {
      const itemDiv = document.createElement("div");
      itemDiv.className = `deck-selector-item ${item.id === currentLabware ? "active" : ""}`;
      itemDiv.dataset.search = `${item.name} ${item.id} ${item.detail || ""}`.toLowerCase();
      itemDiv.innerHTML = `
        <span class="selector-name">${item.name}</span>
        <span class="selector-detail">${item.detail || ""}</span>
        <span class="selector-id">${item.id}</span>
      `;
      itemDiv.addEventListener("click", () => { modal.remove(); _applyChange(slotId, item.id, currentLabware); });
      list.appendChild(itemDiv);
    }
  }

  content.appendChild(list);

  // Custom labware input at the bottom
  const customDiv = document.createElement("div");
  customDiv.className = "deck-selector-custom";
  customDiv.innerHTML = `
    <span class="deck-selector-category">Custom Labware</span>
    <div class="custom-input-row">
      <input type="text" class="deck-selector-custom-input" id="custom-labware-input"
             placeholder="Enter custom labware API name..." />
      <button class="custom-apply-btn" id="custom-apply-btn">Apply</button>
    </div>
    <span class="custom-hint">Use this for custom or non-standard labware definitions</span>
  `;
  content.appendChild(customDiv);

  const customInput = content.querySelector("#custom-labware-input");
  const customBtn = content.querySelector("#custom-apply-btn");

  customBtn.addEventListener("click", () => {
    const val = customInput.value.trim();
    if (val) { modal.remove(); _applyChange(slotId, val, currentLabware); }
  });
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = customInput.value.trim();
      if (val) { modal.remove(); _applyChange(slotId, val, currentLabware); }
    }
  });

  setTimeout(() => search.focus(), 100);
}

function _filterCatalog(content, query) {
  const q = query.toLowerCase();
  content.querySelectorAll(".deck-selector-item").forEach(item => {
    if (item.classList.contains("remove")) return;
    item.style.display = (!q || (item.dataset.search || "").includes(q)) ? "" : "none";
  });
  content.querySelectorAll(".deck-selector-category").forEach(cat => {
    let next = cat.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains("deck-selector-category")) {
      if (next.style.display !== "none" && next.classList.contains("deck-selector-item")) hasVisible = true;
      next = next.nextElementSibling;
    }
    cat.style.display = hasVisible ? "" : "none";
  });
}

function _applyChange(slotId, newLabware, oldLabware) {
  if (!_currentCode || !_currentState) return;

  // Track the change
  if (newLabware && oldLabware) {
    _pendingChanges.push({ type: "change_labware", slot: slotId, old: oldLabware, new: newLabware });
  } else if (newLabware && !oldLabware) {
    _pendingChanges.push({ type: "add_labware", slot: slotId, new: newLabware });
  } else if (!newLabware && oldLabware) {
    _pendingChanges.push({ type: "remove_labware", slot: slotId, old: oldLabware });
  }

  // Update local state visually (instant)
  const positions = _currentState.positions || [];
  for (const pos of positions) {
    if (pos.id === slotId) {
      if (newLabware) {
        pos.labware = newLabware;
        pos.labware_display = _shorten(newLabware);
        pos.type = _guessType(newLabware);
      } else {
        pos.labware = null;
        pos.labware_display = null;
        pos.variable = null;
        pos.type = "empty";
      }
      break;
    }
  }

  // Also check carriers (for linear layout)
  if (_currentState.carriers?.items) {
    for (const carrier of _currentState.carriers.items) {
      for (const cpos of (carrier.positions || [])) {
        if (`${carrier.type}_${cpos.index}` === slotId) {
          cpos.labware = newLabware || null;
          if (!newLabware) cpos.variable = null;
          break;
        }
      }
    }
  }

  _selectedSlot = null;
  _renderDeck(_currentState);
  _renderApplyBar();
}

// ============================================================
// Apply Changes Bar
// ============================================================

function _renderApplyBar() {
  let bar = document.getElementById("deck-apply-bar");

  if (_pendingChanges.length === 0) {
    if (bar) bar.remove();
    return;
  }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "deck-apply-bar";
    bar.className = "deck-apply-bar";
    const container = document.getElementById("deck-svg-container");
    if (container) container.parentElement.appendChild(bar);
  }

  const count = _pendingChanges.length;
  bar.innerHTML = `
    <div class="apply-bar-info">
      <span class="apply-bar-count">${count} change${count > 1 ? "s" : ""}</span>
      <span class="apply-bar-hint">pending</span>
    </div>
    <div class="apply-bar-actions">
      <button class="apply-bar-discard" id="deck-discard-btn">Discard</button>
      <button class="apply-bar-apply" id="deck-apply-btn">Apply Changes</button>
    </div>
  `;

  document.getElementById("deck-discard-btn").addEventListener("click", _discardChanges);
  document.getElementById("deck-apply-btn").addEventListener("click", _commitChanges);
}

function _discardChanges() {
  _pendingChanges = [];
  // Restore from the saved original state — no LLM call needed
  if (_originalState) {
    _currentState = JSON.parse(JSON.stringify(_originalState));
  }
  _selectedSlot = null;
  _renderDeck(_currentState);
  const bar = document.getElementById("deck-apply-bar");
  if (bar) bar.remove();
}

async function _commitChanges() {
  if (_pendingChanges.length === 0) return;

  const applyBtn = document.getElementById("deck-apply-btn");
  if (applyBtn) { applyBtn.textContent = "Applying..."; applyBtn.disabled = true; }

  // Step 1: Apply locally via string replacement (instant, always works)
  let updatedCode = _currentCode;
  for (const c of _pendingChanges) {
    if ((c.type === "change_labware") && c.old && c.new) {
      updatedCode = updatedCode.split(c.old).join(c.new);
    }
    if ((c.type === "change_instrument") && c.old_model && c.new_model) {
      updatedCode = updatedCode.split(c.old_model).join(c.new_model);
    }
    if ((c.type === "change_instrument") && c.mount && c.new_mount && c.mount !== c.new_mount) {
      // Swap mount in code: mount="left" → mount="right"
      const mountRe = new RegExp(`(mount\\s*=\\s*["'])${c.mount}(["'])`, 'g');
      updatedCode = updatedCode.replace(mountRe, `$1${c.new_mount}$2`);
    }
  }

  // Step 2: Try LLM for coherence (tiprack sync, volume adjust) — non-blocking enhancement
  try {
    const res = await fetch("/deck/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: _currentCode, changes: _pendingChanges }),
    });
    if (res.ok) {
      const result = await res.json();
      // Use LLM code only if it looks valid (not empty, not an error message)
      if (result.code && result.code.length > 50 && !result.error) {
        updatedCode = result.code;
      }
      if (result.state && result.state.positions) {
        _currentState = result.state;
      }
    }
  } catch (e) {
    // LLM failed — local replacement is already done, continue
  }

  // Step 3: Commit
  _currentCode = updatedCode;
  _updateSourceCodeBlock(updatedCode);
  _pendingChanges = [];
  _selectedSlot = null;
  _renderDeck(_currentState);

  const bar = document.getElementById("deck-apply-bar");
  if (bar) bar.remove();
}

function _guessType(labware) {
  if (!labware) return "empty";
  const l = labware.toLowerCase();
  if (l.includes("tiprack") || l.includes("tip_rack") || l.includes("tips")) return "tiprack";
  if (l.includes("reservoir") || l.includes("trough")) return "reservoir";
  if (l.includes("tube") || l.includes("rack")) return "tuberack";
  if (l.includes("trash")) return "trash";
  return "plate";
}

function _shorten(name) {
  if (!name) return "";
  return name.length > 25 ? name.substring(0, 22) + "..." : name;
}

// ============================================================
// Panel Management
// ============================================================

function _openDeckPanel() {
  const panel = document.getElementById("deck-panel");
  const chat = document.getElementById("chat-panel");
  const btn = document.getElementById("deck-toggle-btn");
  if (panel) panel.classList.remove("hidden");
  if (chat) chat.classList.add("with-deck");
  if (btn) btn.classList.add("active");
}
function closeDeckPanel() {
  const panel = document.getElementById("deck-panel");
  const chat = document.getElementById("chat-panel");
  const btn = document.getElementById("deck-toggle-btn");
  if (panel) panel.classList.add("hidden");
  if (chat) chat.classList.remove("with-deck");
  if (btn) btn.classList.remove("active");
}
function toggleDeckPanel() {
  const panel = document.getElementById("deck-panel");
  if (panel) panel.classList.contains("hidden") ? _openDeckPanel() : closeDeckPanel();
}
function clearDeckPanel() {
  if (_deckAbort) { _deckAbort.abort(); _deckAbort = null; }
  closeDeckPanel();
  _currentCode = null; _originalCode = null; _currentState = null; _originalState = null;
  _selectedSlot = null; _pendingChanges = []; _sourceCodeBlock = null;
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<p class="deck-empty-message">Generate a protocol to see the deck layout</p>';
  const bar = document.getElementById("deck-apply-bar");
  if (bar) bar.remove();
}

// ============================================================
// Update the Source Code Block in Chat
// ============================================================

function _updateSourceCodeBlock(newCode) {
  // Try the stored reference first
  let block = _sourceCodeBlock;

  // Fallback: find the code block whose content matches our original code
  if (!block) {
    const allBlocks = document.querySelectorAll(".code-block-wrapper");
    for (const b of allBlocks) {
      const codeEl = b.querySelector("code");
      if (codeEl && _originalCode && codeEl.textContent.trim() === _originalCode.trim()) {
        block = b;
        break;
      }
    }
  }

  // Last resort fallback: last code block in the chat
  if (!block) {
    const allBlocks = document.querySelectorAll("#chat-history .code-block-wrapper");
    if (allBlocks.length) block = allBlocks[allBlocks.length - 1];
  }

  if (!block) {
    console.warn("Could not find source code block to update");
    return;
  }

  // Update the code text
  const codeElem = block.querySelector("code");
  if (codeElem) {
    codeElem.textContent = newCode;
  }

  // Update the copy button closure
  const copyBtn = block.querySelector(".copy-action-btn");
  if (copyBtn) {
    const newCopy = copyBtn.cloneNode(true);
    newCopy.addEventListener("click", () => {
      navigator.clipboard.writeText(newCode).then(() => {
        const original = newCopy.innerHTML;
        newCopy.textContent = "Copied!";
        setTimeout(() => { newCopy.innerHTML = original; }, 1500);
      });
    });
    copyBtn.parentNode.replaceChild(newCopy, copyBtn);
  }

  // Update the deck button closure
  const deckBtn = block.querySelector(".deck-action-btn");
  if (deckBtn) {
    const newDeck = deckBtn.cloneNode(true);
    newDeck.addEventListener("click", () => {
      if (window.parseDeckFromCode) window.parseDeckFromCode(newCode, block);
    });
    deckBtn.parentNode.replaceChild(newDeck, deckBtn);
  }

  // Store reference for future updates
  _sourceCodeBlock = block;

  // Flash green to confirm update
  block.classList.add("code-updated");
  setTimeout(() => block.classList.remove("code-updated"), 1500);
}
function _showLoading() {
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<div class="deck-loading"><div class="deck-loading-spinner"></div><span>Generating deck...</span><span class="deck-loading-sub">This may take a few seconds</span></div>';
}
function _showError(msg) {
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = `<p class="deck-empty-message" style="color:#ff4d4d">${msg}</p>`;
}

// Init
document.addEventListener("DOMContentLoaded", () => {
  const t = document.getElementById("deck-toggle-btn");
  const c = document.getElementById("deck-close-btn");
  if (t) t.addEventListener("click", toggleDeckPanel);
  if (c) c.addEventListener("click", closeDeckPanel);
});

window.parseDeckFromCode = parseDeckFromCode;
window.clearDeckPanel = clearDeckPanel;
window.toggleDeckPanel = toggleDeckPanel;