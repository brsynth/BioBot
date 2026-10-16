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
// Animation / Playback State
// ============================================================
let _animSnapshots = [];     // per-step state snapshots
let _animStepIndex = -1;     // -1 = initial state (before any step)
let _animPlaying = false;
let _animTimer = null;
let _animSpeed = 1500;       // ms per step (default 1× speed)
let _animSteps = [];         // raw steps from state

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

  // Initialize animation if steps exist
  if (state.steps && state.steps.length > 0) {
    _initAnimation(state);
  }
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

  // Slot number
  slot.innerHTML = `<span class="slot-num">${pos.id}</span>`;

  if (filled) {
    // Labware name
    slot.innerHTML += `<span class="slot-labware">${pos.labware_display || _shorten(pos.labware)}</span>`;
    if (pos.variable) slot.innerHTML += `<span class="slot-var">${pos.variable}</span>`;
    if (pos.module) slot.innerHTML += `<span class="slot-module">${pos.module}</span>`;

    // Well grid for plates, tipracks, reservoirs, tube racks
    if (pos.wells && pos.wells.rows && pos.wells.cols) {
      slot.appendChild(_renderMiniWells(pos));
    }
  } else {
    slot.innerHTML += `<span class="slot-empty-label">${pos.type === "trash" ? "Trash" : ""}</span>`;
  }

  slot.addEventListener("click", () => _selectSlot(pos.id, pos));
  slot.addEventListener("dblclick", () => _showSelector(pos.id, pos.labware || null));

  return slot;
}

// ============================================================
// Mini Well Grid Renderer
// ============================================================

function _renderMiniWells(pos) {
  const w = pos.wells;
  const rows = w.rows || 1;
  const cols = w.cols || 1;
  const isTiprack = pos.type === "tiprack";

  const filledSet = new Set(w.filled || []);
  const sourceSet = new Set(w.source || []);
  const destSet = new Set(w.destination || []);
  const tipsUsedSet = new Set(w.tips_used || []);
  const tipsAvailSet = new Set(w.tips_available || []);

  const container = document.createElement("div");
  const format = w.format || (rows * cols);
  container.className = `mini-wells wells-${format}`;
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  const rowLabels = w.row_labels || "ABCDEFGHIJKLMNOP".split("").slice(0, rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wellId = `${rowLabels[r]}${c + 1}`;
      const dot = document.createElement("div");
      dot.className = "mini-well";
      dot.title = wellId;

      if (isTiprack) {
        if (tipsUsedSet.has(wellId)) {
          dot.classList.add("tip-used");
        } else if (tipsAvailSet.has(wellId) || tipsAvailSet.size === 0) {
          dot.classList.add("tip-available");
        }
      } else {
        if (sourceSet.has(wellId)) {
          dot.classList.add("well-source");
        } else if (destSet.has(wellId)) {
          dot.classList.add("well-dest");
        } else if (filledSet.has(wellId)) {
          dot.classList.add("well-filled");
        }
      }

      container.appendChild(dot);
    }
  }

  return container;
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
  if (pos.wells) {
    const w = pos.wells;
    html += `<div class="info-row"><span class="info-label">Format:</span> ${w.format || (w.rows * w.cols)} wells (${w.rows}×${w.cols})</div>`;
    if (w.filled?.length) html += `<div class="info-row"><span class="info-label">Filled:</span> <span style="color:#4caf50">${w.filled.length} wells</span></div>`;
    if (w.source?.length) html += `<div class="info-row"><span class="info-label">Source wells:</span> <span style="color:#4488ff">${w.source.length} (${w.source.slice(0, 5).join(", ")}${w.source.length > 5 ? "..." : ""})</span></div>`;
    if (w.destination?.length) html += `<div class="info-row"><span class="info-label">Dest wells:</span> <span style="color:#ff9800">${w.destination.length} (${w.destination.slice(0, 5).join(", ")}${w.destination.length > 5 ? "..." : ""})</span></div>`;
    if (w.volume) html += `<div class="info-row"><span class="info-label">Volume/well:</span> ${w.volume}</div>`;
    if (w.total_volume) html += `<div class="info-row"><span class="info-label">Total volume:</span> ${w.total_volume}</div>`;
    if (pos.type === "tiprack") {
      const used = w.tips_used?.length || 0;
      const total = w.format || 96;
      html += `<div class="info-row"><span class="info-label">Tips:</span> ${total - used} available, ${used} used</div>`;
    }
  }
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
        // Rebuild wells based on new labware
        pos.wells = _guessWells(newLabware, pos.type);
      } else {
        pos.labware = null;
        pos.labware_display = null;
        pos.variable = null;
        pos.type = "empty";
        pos.wells = null;
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

function _guessWells(labware, type) {
  if (!labware) return null;
  const l = labware.toLowerCase();

  // Detect format from the name
  let rows = 8, cols = 12, format = 96;

  if (l.includes("384")) { rows = 16; cols = 24; format = 384; }
  else if (l.includes("96")) { rows = 8; cols = 12; format = 96; }
  else if (l.includes("48")) { rows = 6; cols = 8; format = 48; }
  else if (l.includes("24")) { rows = 4; cols = 6; format = 24; }
  else if (l.includes("12") && (type === "reservoir" || l.includes("reservoir") || l.includes("trough"))) { rows = 1; cols = 12; format = 12; }
  else if (l.includes("6") && l.includes("well")) { rows = 2; cols = 3; format = 6; }
  else if (type === "reservoir" && l.includes("1")) { rows = 1; cols = 1; format = 1; }
  else if (type === "tiprack") { rows = 8; cols = 12; format = 96; }
  else if (type === "tuberack") {
    if (l.includes("24")) { rows = 4; cols = 6; format = 24; }
    else if (l.includes("15") || l.includes("6")) { rows = 2; cols = 3; format = 6; }
    else { rows = 4; cols = 6; format = 24; }
  }

  const rowLabels = "ABCDEFGHIJKLMNOP".split("").slice(0, rows);

  const wells = {
    rows, cols, format,
    row_labels: rowLabels,
    filled: [],
    source: [],
    destination: [],
    tips_used: [],
    tips_available: [],
  };

  // For tipracks, mark all tips as available
  if (type === "tiprack") {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        wells.tips_available.push(`${rowLabels[r]}${c + 1}`);
      }
    }
  }

  return wells;
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
  // Stop animation & remove tip overlay
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  _animPlaying = false; _animSnapshots = []; _animSteps = []; _animStepIndex = -1; _animBusy = false;
  _removeTipOverlay();
  closeDeckPanel();
  _currentCode = null; _originalCode = null; _currentState = null; _originalState = null;
  _selectedSlot = null; _pendingChanges = []; _sourceCodeBlock = null;
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<p class="deck-empty-message">Generate a protocol to see the deck layout</p>';
  const bar = document.getElementById("deck-apply-bar");
  if (bar) bar.remove();
  const pbBar = document.getElementById("deck-playback-bar");
  if (pbBar) pbBar.remove();
  const pbDesc = document.getElementById("pb-step-desc");
  if (pbDesc) pbDesc.remove();
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

// ============================================================
// Protocol Animation / Playback System (v2 — visual tips)
// ============================================================

// Action → color mapping
const ACTION_COLORS = {
  aspirate:    { fill: "#00ff99", glow: "rgba(0,255,153,0.4)", label: "ASP" },
  dispense:    { fill: "#ff9800", glow: "rgba(255,152,0,0.4)", label: "DSP" },
  transfer:    { fill: "#4488ff", glow: "rgba(68,136,255,0.4)", label: "TRF" },
  distribute:  { fill: "#4488ff", glow: "rgba(68,136,255,0.4)", label: "DST" },
  consolidate: { fill: "#4488ff", glow: "rgba(68,136,255,0.4)", label: "CON" },
  mix:         { fill: "#cc88ff", glow: "rgba(204,136,255,0.4)", label: "MIX" },
  pick_up_tip: { fill: "#aaaaaa", glow: "rgba(170,170,170,0.3)", label: "TIP" },
  pickup_tip:  { fill: "#aaaaaa", glow: "rgba(170,170,170,0.3)", label: "TIP" },
  drop_tip:    { fill: "#666666", glow: "rgba(100,100,100,0.3)", label: "DROP" },
};

// Track whether tip animation is currently running (prevents double-advance)
let _animBusy = false;

/**
 * Build variable/slot → position index lookup.
 */
function _buildPosLookup(positions) {
  const varMap = {};
  const slotMap = {};
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p.variable) varMap[p.variable.toLowerCase()] = i;
    if (p.id != null) slotMap[String(p.id).toLowerCase()] = i;
  }
  return { varMap, slotMap };
}

function _findPosIdx(ref, lookup) {
  if (!ref) return -1;
  const lower = ref.toLowerCase();
  const bracketMatch = lower.match(/^([^[]+)\[/);
  if (bracketMatch) {
    const v = bracketMatch[1].trim();
    if (lookup.varMap[v] !== undefined) return lookup.varMap[v];
  }
  const slotMatch = lower.match(/slot\s*(\d+)/);
  if (slotMatch && lookup.slotMap[slotMatch[1]] !== undefined) return lookup.slotMap[slotMatch[1]];
  if (lookup.varMap[lower.trim()] !== undefined) return lookup.varMap[lower.trim()];
  if (lookup.slotMap[lower.trim()] !== undefined) return lookup.slotMap[lower.trim()];
  return -1;
}

/**
 * Deep-clone positions array with wells (for snapshotting).
 */
function _clonePositions(posArr) {
  return posArr.map(p => ({
    ...p,
    wells: p.wells ? {
      ...p.wells,
      filled: [...(p.wells.filled || [])],
      source: [...(p.wells.source || [])],
      destination: [...(p.wells.destination || [])],
      tips_used: [...(p.wells.tips_used || [])],
      tips_available: [...(p.wells.tips_available || [])],
    } : null,
  }));
}

/**
 * Build a CLEAN initial state — wells start with NO source/destination
 * markers. Only pre-existing liquid (filled) and tiprack status remain.
 * Also strip reservoir filled markers since reservoirs are loaded at start.
 */
function _buildCleanInitial(positions) {
  return positions.map(p => ({
    ...p,
    wells: p.wells ? {
      ...p.wells,
      filled: [...(p.wells.filled || [])],     // keep pre-loaded liquid
      source: [],                                // CLEAN — no source markers
      destination: [],                           // CLEAN — no dest markers
      tips_used: [...(p.wells.tips_used || [])],
      tips_available: [...(p.wells.tips_available || [])],
    } : null,
  }));
}

/**
 * Build per-step state snapshots starting from a CLEAN initial state.
 * Wells progressively change color only when the step that affects them runs.
 *
 * Returns array of { positions, step, stepIndex, srcIdx, dstIdx }
 */
function _buildStepSnapshots(state) {
  const steps = state.steps || [];
  if (steps.length === 0) return [];

  const positions = state.positions || [];
  const lookup = _buildPosLookup(positions);

  const snapshots = [];
  // Start from clean state — no source/dest markers
  let current = _buildCleanInitial(positions);

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const action = (step.action || "").toLowerCase();
    const wellsFrom = step.wells_from || [];
    const wellsTo = step.wells_to || [];

    current = _clonePositions(current);

    const srcIdx = _findPosIdx(step.source, lookup);
    const dstIdx = _findPosIdx(step.destination, lookup);

    if (action === "pick_up_tip" || action === "pickup_tip") {
      if (srcIdx >= 0 && current[srcIdx].wells) {
        const w = current[srcIdx].wells;
        for (const well of wellsFrom) {
          if (!w.tips_used.includes(well)) w.tips_used.push(well);
          w.tips_available = w.tips_available.filter(t => t !== well);
        }
      }
    } else if (action === "aspirate") {
      if (srcIdx >= 0 && current[srcIdx].wells) {
        const w = current[srcIdx].wells;
        for (const well of wellsFrom) {
          if (!w.source.includes(well)) w.source.push(well);
        }
      }
    } else if (action === "dispense") {
      if (dstIdx >= 0 && current[dstIdx].wells) {
        const w = current[dstIdx].wells;
        for (const well of wellsTo) {
          if (!w.destination.includes(well)) w.destination.push(well);
          if (!w.filled.includes(well)) w.filled.push(well);
        }
      }
    } else if (action === "transfer" || action === "distribute" || action === "consolidate") {
      if (srcIdx >= 0 && current[srcIdx].wells) {
        const w = current[srcIdx].wells;
        for (const well of wellsFrom) {
          if (!w.source.includes(well)) w.source.push(well);
        }
      }
      if (dstIdx >= 0 && current[dstIdx].wells) {
        const w = current[dstIdx].wells;
        for (const well of wellsTo) {
          if (!w.destination.includes(well)) w.destination.push(well);
          if (!w.filled.includes(well)) w.filled.push(well);
        }
      }
    } else if (action === "mix") {
      const idx = srcIdx >= 0 ? srcIdx : dstIdx;
      if (idx >= 0 && current[idx].wells) {
        const w = current[idx].wells;
        const wells = wellsFrom.length ? wellsFrom : wellsTo;
        for (const well of wells) {
          if (!w.source.includes(well)) w.source.push(well);
          if (!w.destination.includes(well)) w.destination.push(well);
        }
      }
    }
    // drop_tip — no well changes

    snapshots.push({ positions: current, step, stepIndex: si, srcIdx, dstIdx });
  }

  return snapshots;
}

/**
 * Initialize the animation system.
 */
function _initAnimation(state) {
  _animSteps = state.steps || [];
  _animPlaying = false;
  _animStepIndex = -1;
  _animBusy = false;
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }

  if (_animSteps.length === 0) { _animSnapshots = []; return; }

  _animSnapshots = _buildStepSnapshots(state);
  _renderPlaybackControls();
}

// ============================================================
// Playback Controls
// ============================================================

function _renderPlaybackControls() {
  let bar = document.getElementById("deck-playback-bar");
  if (bar) bar.remove();
  if (_animSnapshots.length === 0) return;

  const container = document.getElementById("deck-svg-container");
  if (!container) return;

  bar = document.createElement("div");
  bar.id = "deck-playback-bar";
  bar.className = "deck-playback-bar";

  const totalSteps = _animSnapshots.length;
  const currentLabel = _animStepIndex < 0 ? "Initial" : `${_animStepIndex + 1} / ${totalSteps}`;

  bar.innerHTML = `
    <div class="playback-controls">
      <button class="pb-btn pb-reset" id="pb-reset" title="Reset to initial state">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="4" y="4" width="6" height="16"/><polygon points="20,4 10,12 20,20"/>
        </svg>
      </button>
      <button class="pb-btn pb-prev" id="pb-prev" title="Previous step">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="15,18 9,12 15,6"/>
        </svg>
      </button>
      <button class="pb-btn pb-play" id="pb-play" title="Play">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </button>
      <button class="pb-btn pb-next" id="pb-next" title="Next step">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9,18 15,12 9,6"/>
        </svg>
      </button>
      <button class="pb-btn pb-end" id="pb-end" title="Jump to final state">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polygon points="4,4 14,12 4,20"/><rect x="14" y="4" width="6" height="16"/>
        </svg>
      </button>
    </div>
    <div class="playback-info">
      <span class="pb-step-label" id="pb-step-label">${currentLabel}</span>
      <div class="pb-progress-track">
        <div class="pb-progress-fill" id="pb-progress-fill" style="width:0%"></div>
        <input type="range" class="pb-scrubber" id="pb-scrubber"
          min="-1" max="${totalSteps - 1}" value="${_animStepIndex}" />
      </div>
    </div>
    <div class="playback-speed">
      <label class="pb-speed-label">Speed</label>
      <select class="pb-speed-select" id="pb-speed">
        <option value="2500" ${_animSpeed===2500?'selected':''}>0.5×</option>
        <option value="1500" ${_animSpeed===1500?'selected':''}>1×</option>
        <option value="800"  ${_animSpeed===800 ?'selected':''}>2×</option>
        <option value="400"  ${_animSpeed===400 ?'selected':''}>4×</option>
      </select>
    </div>
  `;

  container.parentElement.insertBefore(bar, container.nextSibling);

  // Step description panel
  let descPanel = document.getElementById("pb-step-desc");
  if (descPanel) descPanel.remove();
  descPanel = document.createElement("div");
  descPanel.id = "pb-step-desc";
  descPanel.className = "pb-step-desc";
  bar.parentElement.insertBefore(descPanel, bar.nextSibling);
  _updateStepDescription();

  // Wire up events
  document.getElementById("pb-reset").addEventListener("click", () => _animGoTo(-1));
  document.getElementById("pb-prev").addEventListener("click", _animPrev);
  document.getElementById("pb-play").addEventListener("click", _animTogglePlay);
  document.getElementById("pb-next").addEventListener("click", _animNext);
  document.getElementById("pb-end").addEventListener("click", () => _animGoTo(_animSnapshots.length - 1));
  document.getElementById("pb-speed").addEventListener("change", (e) => {
    _animSpeed = parseInt(e.target.value);
    if (_animPlaying) { clearInterval(_animTimer); _animTimer = setInterval(_animAutoStep, _animSpeed); }
  });
  document.getElementById("pb-scrubber").addEventListener("input", (e) => _animGoTo(parseInt(e.target.value)));
}

// ============================================================
// Step Description
// ============================================================

function _updateStepDescription() {
  const descPanel = document.getElementById("pb-step-desc");
  if (!descPanel) return;

  if (_animStepIndex < 0) {
    descPanel.innerHTML = '<span class="pb-desc-initial">▶ Press Play to start protocol animation</span>';
    descPanel.className = "pb-step-desc";
    return;
  }

  const snap = _animSnapshots[_animStepIndex];
  if (!snap?.step) { descPanel.innerHTML = ""; return; }

  const step = snap.step;
  const action = (step.action || "").toLowerCase();
  const colors = ACTION_COLORS[action] || { fill: "#888", label: "?" };

  descPanel.className = "pb-step-desc active";
  descPanel.innerHTML = `
    <span class="pb-desc-action" style="background:${colors.fill}22;color:${colors.fill};border:1px solid ${colors.fill}44">
      ${(step.action || "").toUpperCase()}
    </span>
    <span class="pb-desc-text">${step.description || ""}</span>
    ${step.volume ? `<span class="pb-desc-vol">${step.volume} µL</span>` : ""}
    ${step.source ? `<span class="pb-desc-detail">From: ${step.source}</span>` : ""}
    ${step.destination ? `<span class="pb-desc-detail">To: ${step.destination}</span>` : ""}
  `;
}

// ============================================================
// Slot ↔ step reference matching
// ============================================================

function _slotMatchesRef(slotId, pos, ref) {
  if (!ref) return false;
  const lower = ref.toLowerCase();
  if (pos.variable && lower.includes(pos.variable.toLowerCase())) return true;
  if (lower.includes(String(slotId).toLowerCase())) return true;
  const m = lower.match(/slot\s*(\d+)/);
  if (m && m[1] === String(slotId)) return true;
  return false;
}

// ============================================================
// Render Mini-Wells for a snapshot position (animation version)
// Re-uses _renderMiniWells but passes the snapshot's well data
// ============================================================

function _renderMiniWellsFromSnap(pos) {
  // _renderMiniWells uses pos.wells directly, which is the snapshot
  return _renderMiniWells(pos);
}

// ============================================================
// Apply step visuals — updates wells + shows tip graphic
// ============================================================

function _applyStepVisuals(stepIndex, animate) {
  const positions = stepIndex < 0
    ? _buildCleanInitial(_originalState?.positions || _currentState?.positions || [])
    : _animSnapshots[stepIndex]?.positions;
  if (!positions) return;

  const activeStep = stepIndex >= 0 ? _animSnapshots[stepIndex].step : null;
  const action = activeStep ? (activeStep.action || "").toLowerCase() : "";
  const colors = ACTION_COLORS[action] || { fill: "#888", glow: "rgba(136,136,136,0.3)" };

  // Remove previous tip overlay
  _removeTipOverlay();

  const allSlots = document.querySelectorAll(".deck-slot[data-id]");
  for (const slotEl of allSlots) {
    const slotId = slotEl.dataset.id;
    const pos = positions.find(p => String(p.id) === slotId);
    if (!pos) continue;

    // Remove old animation classes
    slotEl.classList.remove("anim-active-src", "anim-active-dst", "anim-active-tip");

    // Highlight active slots
    if (activeStep) {
      const isSrc = _slotMatchesRef(slotId, pos, activeStep.source);
      const isDst = _slotMatchesRef(slotId, pos, activeStep.destination);
      if (action.includes("tip") && isSrc) {
        slotEl.classList.add("anim-active-tip");
      } else {
        if (isSrc) slotEl.classList.add("anim-active-src");
        if (isDst) slotEl.classList.add("anim-active-dst");
      }
    }

    // Update mini-wells from snapshot
    if (pos.wells && pos.wells.rows && pos.wells.cols) {
      const oldWells = slotEl.querySelector(".mini-wells");
      const newWells = _renderMiniWellsFromSnap(pos);

      // Highlight specific active wells with glowing ring
      if (activeStep && stepIndex >= 0) {
        _markActiveWells(newWells, pos, activeStep, colors.fill);
      }

      if (oldWells) slotEl.replaceChild(newWells, oldWells);
      else slotEl.appendChild(newWells);
    }
  }

  // Show animated tip graphic for the current step
  if (activeStep && animate && stepIndex >= 0) {
    _showTipAnimation(activeStep, colors);
  }
}

/**
 * Mark active wells with a colored ring for the current step.
 */
function _markActiveWells(container, pos, step, color) {
  const wellsFrom = step.wells_from || [];
  const wellsTo = step.wells_to || [];
  const dots = container.querySelectorAll(".mini-well");
  const rows = pos.wells.rows || 1;
  const cols = pos.wells.cols || 1;
  const rowLabels = pos.wells.row_labels || "ABCDEFGHIJKLMNOP".split("").slice(0, rows);

  dots.forEach((dot, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const wellId = `${rowLabels[r]}${c + 1}`;

    const isFrom = wellsFrom.includes(wellId) && _slotMatchesRef(String(pos.id), pos, step.source);
    const isTo = wellsTo.includes(wellId) && _slotMatchesRef(String(pos.id), pos, step.destination);

    if (isFrom || isTo) {
      dot.classList.add("well-anim-active");
      dot.style.boxShadow = `0 0 6px ${color}, 0 0 2px ${color}`;
      dot.style.borderColor = color;
    }
  });
}

// ============================================================
// Tip / Pipette Graphic Overlay
// ============================================================

function _removeTipOverlay() {
  const existing = document.getElementById("anim-tip-overlay");
  if (existing) existing.remove();
}

/**
 * Show the pipette tip graphic hovering over the active slot.
 * The tip body fills with color to show aspiration / dispense.
 */
function _showTipAnimation(step, colors) {
  const action = (step.action || "").toLowerCase();
  const container = document.getElementById("deck-svg-container");
  if (!container) return;

  // Find the target slot element
  const targetRef = step.source || step.destination;
  if (!targetRef) return;

  let targetSlot = null;
  const allSlots = container.querySelectorAll(".deck-slot[data-id]");
  for (const slot of allSlots) {
    const pos = (_currentState?.positions || []).find(p => String(p.id) === slot.dataset.id);
    if (pos && _slotMatchesRef(slot.dataset.id, pos, targetRef)) {
      targetSlot = slot;
      break;
    }
  }
  // For transfer: show on destination
  if (action === "transfer" || action === "distribute" || action === "consolidate") {
    const dstRef = step.destination;
    if (dstRef) {
      for (const slot of allSlots) {
        const pos = (_currentState?.positions || []).find(p => String(p.id) === slot.dataset.id);
        if (pos && _slotMatchesRef(slot.dataset.id, pos, dstRef)) {
          targetSlot = slot;
          break;
        }
      }
    }
  }

  if (!targetSlot) return;

  // Create tip overlay positioned on the target slot
  const overlay = document.createElement("div");
  overlay.id = "anim-tip-overlay";
  overlay.className = "anim-tip-overlay";

  // Determine animation class
  let animClass = "tip-idle";
  let fillHeight = "0%";
  let fillColor = colors.fill;

  if (action === "aspirate") {
    animClass = "tip-aspirate";
    fillHeight = "70%";   // tip fills up
  } else if (action === "dispense") {
    animClass = "tip-dispense";
    fillHeight = "0%";    // tip empties
  } else if (action === "transfer" || action === "distribute" || action === "consolidate") {
    animClass = "tip-transfer";
    fillHeight = "40%";
  } else if (action === "mix") {
    animClass = "tip-mix";
    fillHeight = "50%";
  } else if (action === "pick_up_tip" || action === "pickup_tip") {
    animClass = "tip-pickup";
    fillColor = "#ccc";
  } else if (action === "drop_tip") {
    animClass = "tip-drop";
    fillColor = "#666";
  }

  const volLabel = step.volume ? `${step.volume} µL` : "";

  overlay.innerHTML = `
    <div class="tip-graphic ${animClass}">
      <div class="tip-body">
        <div class="tip-liquid" style="height:${fillHeight};background:${fillColor}"></div>
      </div>
      <div class="tip-nozzle" style="border-top-color:${fillColor}"></div>
      ${volLabel ? `<div class="tip-vol-label" style="color:${fillColor}">${volLabel}</div>` : ""}
    </div>
  `;

  // Position the overlay on the target slot
  const slotRect = targetSlot.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  overlay.style.position = "absolute";
  overlay.style.left = (slotRect.left - containerRect.left + slotRect.width / 2 - 20) + "px";
  overlay.style.top = (slotRect.top - containerRect.top - 52) + "px";
  overlay.style.zIndex = "100";

  // Make sure container is relative
  container.style.position = "relative";
  container.appendChild(overlay);

  // For transfer, show movement from src to dst
  if ((action === "transfer" || action === "distribute" || action === "consolidate") && step.source && step.destination) {
    _animateTipMovement(overlay, step, container, allSlots, colors);
  }
}

/**
 * Animate tip from source → destination for transfer steps.
 */
function _animateTipMovement(overlay, step, container, allSlots, colors) {
  let srcSlot = null, dstSlot = null;
  const positions = _currentState?.positions || [];

  for (const slot of allSlots) {
    const pos = positions.find(p => String(p.id) === slot.dataset.id);
    if (!pos) continue;
    if (_slotMatchesRef(slot.dataset.id, pos, step.source)) srcSlot = slot;
    if (_slotMatchesRef(slot.dataset.id, pos, step.destination)) dstSlot = slot;
  }
  if (!srcSlot || !dstSlot) return;

  const containerRect = container.getBoundingClientRect();
  const srcRect = srcSlot.getBoundingClientRect();
  const dstRect = dstSlot.getBoundingClientRect();

  // Start at source
  const srcX = srcRect.left - containerRect.left + srcRect.width / 2 - 20;
  const srcY = srcRect.top - containerRect.top - 52;
  const dstX = dstRect.left - containerRect.left + dstRect.width / 2 - 20;
  const dstY = dstRect.top - containerRect.top - 52;

  overlay.style.left = srcX + "px";
  overlay.style.top = srcY + "px";

  // Fill tip at source
  const liquid = overlay.querySelector(".tip-liquid");
  if (liquid) {
    liquid.style.height = "70%";
    liquid.style.background = colors.fill;
  }

  // Animate movement to destination
  const duration = Math.min(_animSpeed * 0.5, 600);
  overlay.style.transition = `left ${duration}ms ease-in-out, top ${duration}ms ease-in-out`;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.style.left = dstX + "px";
      overlay.style.top = dstY + "px";

      // After arriving, empty the tip
      setTimeout(() => {
        if (liquid) {
          liquid.style.transition = "height 0.3s ease";
          liquid.style.height = "0%";
        }
      }, duration);
    });
  });
}

// ============================================================
// Navigation
// ============================================================

function _animGoTo(stepIndex, animate) {
  if (_animBusy) return;
  const maxIdx = _animSnapshots.length - 1;
  _animStepIndex = Math.max(-1, Math.min(stepIndex, maxIdx));
  _applyStepVisuals(_animStepIndex, animate !== false);
  _updatePlaybackUI();
  _updateStepDescription();
}

function _animAutoStep() {
  if (_animBusy) return;
  if (_animStepIndex >= _animSnapshots.length - 1) {
    if (_animPlaying) _animTogglePlay();
    return;
  }
  _animGoTo(_animStepIndex + 1, true);
}

function _animNext() {
  if (_animStepIndex >= _animSnapshots.length - 1) return;
  _animGoTo(_animStepIndex + 1, true);
}

function _animPrev() {
  if (_animStepIndex <= -1) return;
  _animGoTo(_animStepIndex - 1, true);
}

function _animTogglePlay() {
  _animPlaying = !_animPlaying;

  if (_animPlaying) {
    if (_animStepIndex >= _animSnapshots.length - 1) _animGoTo(-1, false);
    _animTimer = setInterval(_animAutoStep, _animSpeed);
  } else {
    if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  }

  _updatePlaybackUI();
}

function _updatePlaybackUI() {
  const totalSteps = _animSnapshots.length;
  const label = document.getElementById("pb-step-label");
  const fill = document.getElementById("pb-progress-fill");
  const scrubber = document.getElementById("pb-scrubber");
  const playBtn = document.getElementById("pb-play");

  if (label) label.textContent = _animStepIndex < 0 ? "Initial" : `Step ${_animStepIndex + 1} / ${totalSteps}`;
  if (fill) fill.style.width = `${_animStepIndex < 0 ? 0 : ((_animStepIndex + 1) / totalSteps * 100)}%`;
  if (scrubber) scrubber.value = _animStepIndex;
  if (playBtn) {
    playBtn.className = `pb-btn pb-play ${_animPlaying ? 'playing' : ''}`;
    playBtn.title = _animPlaying ? "Pause" : "Play";
    playBtn.innerHTML = _animPlaying
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
  }
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