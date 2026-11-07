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
let _sourceCodeBlock = null;  // the specific code block element the deck was opened from
let _libraryEditing = false;
let _libraryDraftName = "";
let _libraryBeforeEdit = null;
let _deckFitObserver = null;
let _draggedDeckArea = null;

// Animation state
let _animSteps = [];
let _animStepIndex = -1;
let _animPlaying = false;
let _animTimer = null;
let _animSpeed = 1500;
let _animBusy = false;
let _wellUsageMap = {};  // slotId → Set of well IDs used by the protocol

const ACTION_COLORS = {
  aspirate:   { fill: "#00ff99", glow: "rgba(0,255,153,0.4)", label: "Aspirate" },
  dispense:   { fill: "#ff9800", glow: "rgba(255,152,0,0.4)", label: "Dispense" },
  transfer:   { fill: "#4488ff", glow: "rgba(68,136,255,0.4)", label: "Transfer" },
  mix:        { fill: "#cc88ff", glow: "rgba(204,136,255,0.4)", label: "Mix" },
  pickup_tip: { fill: "#ffcc00", glow: "rgba(255,204,0,0.4)", label: "Pick Up Tip" },
  drop_tip:   { fill: "#ff4d4d", glow: "rgba(255,77,77,0.4)", label: "Drop Tip" },
};

// ============================================================
// Main Entry
// ============================================================

async function parseDeckFromCode(code, sourceBlock, templateId = null) {
  const chatId = typeof currentChatId !== "undefined" ? currentChatId : null;
  if (_deckAbort) { _deckAbort.abort(); _deckAbort = null; }

  _currentCode = code;
  _originalCode = code;
  _currentState = null;
  _originalState = null;
  _selectedSlot = null;
  _pendingChanges = [];
  _sourceCodeBlock = sourceBlock || null;
  _libraryEditing = false;
  _libraryBeforeEdit = null;
  _clearCodeBlockHighlights();
  _stopDeckAnimation();
  document.getElementById("deck-apply-bar")?.remove();
  _openDeckPanel();
  _showLoading();
  _renderDeckCode();

  const controller = new AbortController();
  _deckAbort = controller;
  const parseForChat = chatId;

  try {
    const res = await fetch("/deck/visualize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, chat_id: chatId, template_id: templateId }),
      signal: controller.signal,
    });
    if (_deckAbort !== controller) return;

    if (!res.ok) {
      // Try to read the actual error from the server response
      let errMsg = "Failed to generate deck";
      try {
        const errData = await res.json();
        if (errData.error) errMsg = errData.error;
      } catch (_) { /* response wasn't JSON */ }
      if (_deckAbort !== controller) return;
      console.error("Deck server error:", res.status, errMsg);
      _showError(errMsg);
      return;
    }

    const state = await res.json();
    if (state.error) { console.error("Deck state error:", state.error); _showError(state.error); return; }
    if (_deckAbort !== controller || parseForChat && currentChatId !== parseForChat) return;

    _currentState = state;
    _originalState = JSON.parse(JSON.stringify(state));  // deep copy for discard
    _renderDeck(state);
  } catch (e) {
    if (e.name === "AbortError") return;
    if (_deckAbort !== controller) return;
    console.error("Deck fetch error:", e);
    _showError("Error generating deck: " + e.message);
  } finally {
    if (_deckAbort === controller) _deckAbort = null;
  }
}

function _stopDeckAnimation() {
  _animPlaying = false;
  _animSteps = [];
  _animStepIndex = -1;
  _animBusy = false;
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  _removeTipOverlay();
}

function _libraryButton(label, action) {
  const button = document.createElement("button");
  button.className = "code-action-btn";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function _libraryNotice(message) {
  let notice = document.getElementById("deck-library-notice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "deck-library-notice";
    notice.setAttribute("role", "alert");
    document.querySelector(".deck-library-controls")?.appendChild(notice);
  }
  notice.textContent = message;
}

function _renderLibraryControls(wrapper, state) {
  const library = state._library;
  if (!library) return;
  const controls = document.createElement("div");
  controls.className = "deck-library-controls";
  wrapper.appendChild(controls);
  if (_libraryEditing) {
    const name = document.createElement("input");
    name.className = "deck-library-name";
    name.setAttribute("aria-label", "Name for your deck copy");
    name.maxLength = 120;
    name.value = _libraryDraftName;
    name.addEventListener("input", () => _libraryDraftName = name.value);
    controls.append(name, _libraryButton("Save copy", _saveLibraryCopy), _libraryButton("Cancel", () => {
      _libraryEditing = false;
      _currentState = _libraryBeforeEdit;
      _libraryBeforeEdit = null;
      _pendingChanges = [];
      _renderDeck(_currentState);
    }));
    const hint = document.createElement("p");
    hint.textContent = "Editing a private copy. Adjust the physical layout below; double-click hardware to change defaults. Protocol contents stay tied to their code.";
    controls.appendChild(hint);
    _renderLayoutEditor(controls, state);
    return;
  }
  const label = document.createElement("label");
  label.textContent = "Deck library";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Choose a device deck from the library");
  for (const item of library.alternatives) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.name} · ${item.author}${!item.is_default && !item.published ? " (private)" : ""}`;
    option.selected = item.id === library.selected.id;
    select.appendChild(option);
  }
  select.disabled = _pendingChanges.length > 0;
  select.addEventListener("change", () => parseDeckFromCode(_currentCode, _sourceCodeBlock, select.value));
  label.appendChild(select);
  const edit = _libraryButton("Edit a copy", () => {
    _stopDeckAnimation();
    _clearCodeBlockHighlights();
    _libraryBeforeEdit = _currentState;
    _libraryEditing = true;
    _libraryDraftName = `${library.selected.name} copy`;
    _currentState = JSON.parse(JSON.stringify(library.layout));
    _currentState._library = library;
    _pendingChanges = [];
    _renderDeck(_currentState);
  });
  edit.disabled = _pendingChanges.length > 0;
  controls.append(label, edit);
  if (library.selected.owner_id === Number(document.body.dataset.userId) && !library.selected.published) {
    controls.appendChild(_libraryButton("Publish", _publishLibraryDeck));
  }
}

function _renderLayoutEditor(parent, state) {
  const editor = document.createElement("div");
  editor.className = "deck-layout-editor";
  function field(label, value, change, min = 0) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = min;
    input.step = 1;
    input.value = value ?? "";
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (!Number.isInteger(next) || next < min || next > (state.layout_type === "grid" ? 128 : 4096)) {
        _libraryNotice("Enter a valid positive whole number within the layout's size limits.");
        input.value = value ?? "";
        return;
      }
      change(next);
      if (state.grid && state.positions) {
        state.grid.labels = Array.from({ length: state.grid.rows * state.grid.cols }, () => null);
        for (const pos of state.positions) state.grid.labels[pos.row * state.grid.cols + pos.col] = pos.id;
      }
      _renderDeck(state);
    });
    wrapper.appendChild(input);
    editor.appendChild(wrapper);
  }
  if (state.layout_type === "grid") {
    field("Rows", state.grid.rows, value => state.grid.rows = value, 1);
    field("Columns", state.grid.cols, value => state.grid.cols = value, 1);
    for (const pos of state.positions || []) {
      field(`${pos.id} row`, pos.row + 1, value => pos.row = value - 1, 1);
      field(`${pos.id} column`, pos.col + 1, value => pos.col = value - 1, 1);
    }
  } else if (state.layout_type === "linear") {
    for (const carrier of state.carriers?.items || []) {
      field(`${carrier.name || carrier.type} track`, carrier.track, value => carrier.track = value);
    }
  } else {
    for (const role of ["source", "destination"]) {
      state.plates ||= {};
      state.plates[role] ||= {};
      field(`${role} well count`, state.plates[role].format, value => state.plates[role].format = value, 1);
    }
  }
  parent.appendChild(editor);
}

let _librarySaving = false;
async function _saveLibraryCopy() {
  if (_librarySaving) return;
  _librarySaving = true;
  const state = _currentState;
  try {
    const response = await fetch("/deck/library", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: state._library.selected.id, name: _libraryDraftName, layout: state }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save the deck copy.");
    if (_currentState === state) await parseDeckFromCode(_currentCode, _sourceCodeBlock, result.id);
  } catch (error) {
    if (_currentState === state) _libraryNotice(error.message);
  } finally { _librarySaving = false; }
}

async function _publishLibraryDeck() {
  if (_librarySaving) return;
  _librarySaving = true;
  const state = _currentState;
  try {
    const response = await fetch(`/deck/library/${state._library.selected.id}/publish`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not publish this deck.");
    if (_currentState === state) await parseDeckFromCode(_currentCode, _sourceCodeBlock, result.id);
  } catch (error) {
    if (_currentState === state) _libraryNotice(error.message);
  } finally { _librarySaving = false; }
}

// ============================================================
// Universal Renderer — adapts to layout_type
// ============================================================

function _renderDeck(state) {
  _hideDeckTooltip();
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
  _renderLibraryControls(wrapper, state);

  // Instruments bar — always show (even if empty, shows both empty mounts)
  wrapper.appendChild(_renderInstruments(state.instruments || []));

  // Build well-usage map from steps: slotId → Set of well IDs
  // This lets us show filled wells on the initial deck render
  _wellUsageMap = {};
  if (state.steps && state.steps.length > 0) {
    for (const step of state.steps) {
      if (step.source?.slot && step.source.wells) {
        if (!_wellUsageMap[step.source.slot]) _wellUsageMap[step.source.slot] = new Set();
        for (const w of step.source.wells) _wellUsageMap[step.source.slot].add(w);
      }
      if (step.destination?.slot && step.destination.wells) {
        if (!_wellUsageMap[step.destination.slot]) _wellUsageMap[step.destination.slot] = new Set();
        for (const w of step.destination.wells) _wellUsageMap[step.destination.slot].add(w);
      }
    }
  }

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
  info.innerHTML = '<span class="deck-info-hint">Hover for details · Drag hardware to an empty position · Click Empty to add</span>';
  wrapper.appendChild(info);

  container.appendChild(wrapper);

  // Animation system — init when steps exist
  if (state.steps && state.steps.length > 0) {
    _initAnimation(state);
    _applyStepVisuals(-1, false);  // Bug 2 fix: show clean initial state immediately
  }
  _watchDeckFit();
  preloadHardwareCatalog(state.platform);
}

// ============================================================
// Grid Layout
// ============================================================

function _renderGrid(state) {
  const positions = state.positions ||= [];
  const grid = state.grid || {};
  const labels = grid.labels || [];

  // Determine grid dimensions:
  // 1. Use explicit grid.rows/cols if provided
  // 2. Otherwise infer from labels count or position row/col values
  // 3. Ensure grid is large enough for ALL labels and ALL positions
  let rows = grid.rows || 1;
  let cols = grid.cols || 1;

  // If we have labels, ensure grid fits them all
  if (labels.length > 0 && (!grid.rows || !grid.cols)) {
    cols = Math.ceil(Math.sqrt(labels.length));
    rows = Math.ceil(labels.length / cols);
  }

  // Ensure grid covers all positions with row/col
  for (const p of positions) {
    if (p.row != null) rows = Math.max(rows, p.row + 1);
    if (p.col != null) cols = Math.max(cols, p.col + 1);
  }

  // Ensure grid covers all labels
  if (labels.length > rows * cols) {
    cols = Math.ceil(Math.sqrt(labels.length));
    rows = Math.ceil(labels.length / cols);
  }

  const deck = document.createElement("div");
  deck.className = "deck-grid";
  deck.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  deck.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // Build lookup maps by id AND by row,col
  const posById = {};
  const posByRC = {};
  for (const p of positions) {
    posById[String(p.id)] = p;
    if (p.row != null && p.col != null) posByRC[`${p.row},${p.col}`] = p;
  }

  // Render ALL grid cells
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const label = labels[idx] || null;

      // Find position: by row/col first, then by label id
      let pos = posByRC[`${r},${c}`];
      if (!pos && label) pos = posById[String(label)];

      // If no position found, create an empty slot with the label or index
      if (!pos) {
        if (labels.length && !label) {
          const gap = document.createElement("div");
          gap.className = "deck-grid-gap";
          deck.appendChild(gap);
          continue;
        }
        pos = { id: label || `${idx + 1}`, type: "empty" };
        positions.push(pos);
      }

      // Assign row/col so animation can locate slots
      if (pos.row == null) pos.row = r;
      if (pos.col == null) pos.col = c;

      const slot = _createSlot(pos);
      deck.appendChild(slot);
    }
  }

  return deck;
}

// ============================================================
// Linear Layout
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
      const slot = _createSlot({ ...pos, id: `${carrier.type}_${pos.index}` });
      card.appendChild(slot);
    }

    container.appendChild(card);
  }

  return container;
}

// ============================================================
// Plates Layout (Echo, picklists, source→dest transfers)
// ============================================================

function _renderPlates(state) {
  const plates = state.plates || {};
  const positions = state.positions || [];
  const container = document.createElement("div");
  container.className = "deck-plates";

  // Match positions to source/dest plates by checking variable/labware names
  // Only match positions whose type is "plate" (not tipracks, trash, etc.)
  const platePosns = positions.filter(p => p.type === "plate" ||
    plates.source && String(p.id).toLowerCase().includes("source") ||
    plates.destination && String(p.id).toLowerCase().includes("dest"));
  const nonPlatePosns = positions.filter(p => !platePosns.includes(p));

  function _findPlatePos(keyword) {
    return platePosns.find(p =>
      (p.variable || "").toLowerCase().includes(keyword)
    ) || platePosns.find(p =>
      (p.labware_display || p.labware || "").toLowerCase().includes(keyword)
    ) || platePosns.find(p =>
      (p.id || "").toLowerCase().includes(keyword)
    );
  }

  const usedIds = new Set();

  if (plates.source) {
    const srcPos = _findPlatePos("source") || platePosns[0];
    const slotId = srcPos?.id || "source";
    if (srcPos) usedIds.add(srcPos.id);
    container.appendChild(_renderPlateMap(plates.source, "source", slotId, srcPos));
  }
  if (plates.destination) {
    const dstPos = _findPlatePos("dest") || platePosns.find(p => !usedIds.has(p.id)) || platePosns[1];
    const slotId = dstPos?.id || "destination";
    if (dstPos) usedIds.add(dstPos.id);
    container.appendChild(_renderPlateMap(plates.destination, "dest", slotId, dstPos));
  }

  // Render non-plate positions (tipracks, trash, etc.) — NOT the plate positions
  // we already rendered above
  const extras = nonPlatePosns.concat(
    platePosns.filter(p => !usedIds.has(p.id))
  );
  if (extras.length > 0) {
    const extrasDiv = document.createElement("div");
    extrasDiv.className = "deck-plates-extras";
    for (const pos of extras) {
      extrasDiv.appendChild(_createSlot(pos));
    }
    container.appendChild(extrasDiv);
  }

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

function _renderPlateMap(plate, role, slotId, posData) {
  const format = Number.isInteger(plate.format) && plate.format > 0 ? plate.format : null;
  // Standard rectangular aspect ratio, derived from the declared well count.
  const rows = format ? Math.max(1, Math.round(Math.sqrt(format * 2 / 3))) : 0;
  const cols = rows ? Math.ceil(format / rows) : 0;
  const usedWells = new Set(plate.wells_used || []);

  // The section acts as a "slot" for the animation system
  const section = document.createElement("div");
  section.className = `deck-plate-section deck-slot filled plate`;
  section.dataset.id = slotId;
  if (_selectedSlot === slotId) section.classList.add("selected");

  // Header with plate info
  const header = document.createElement("div");
  header.className = "deck-plate-header";
  const plateName = plate.name || (role === "source" ? "Source Plate" : "Destination Plate");
  header.innerHTML = `
    <span class="deck-plate-name">${plateName}</span>
    ${format ? `<span class="deck-plate-format">${format}-well</span>` : ""}
  `;
  section.appendChild(header);

  // Row labels + well grid wrapper
  const gridWrapper = document.createElement("div");
  gridWrapper.className = "deck-plate-grid-wrapper";

  // Row labels (A, B, C, ...)
  const rowLabelCol = document.createElement("div");
  rowLabelCol.className = "deck-plate-row-labels";
  const rowLabels = Array.from({ length: rows }, (_, index) => {
    let label = "", number = index + 1;
    while (number > 0) { number--; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
    return label;
  });
  for (let r = 0; r < rows; r++) {
    const lbl = document.createElement("div");
    lbl.className = "deck-plate-row-label";
    lbl.textContent = rowLabels[r];
    rowLabelCol.appendChild(lbl);
  }
  gridWrapper.appendChild(rowLabelCol);

  // Well grid
  const gridCol = document.createElement("div");
  gridCol.className = "deck-plate-grid-col";

  // Column labels (1, 2, 3, ...)
  const colLabelRow = document.createElement("div");
  colLabelRow.className = "deck-plate-col-labels";
  colLabelRow.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  for (let c = 0; c < cols; c++) {
    const lbl = document.createElement("div");
    lbl.className = "deck-plate-col-label";
    lbl.textContent = c + 1;
    colLabelRow.appendChild(lbl);
  }
  gridCol.appendChild(colLabelRow);

  const grid = document.createElement("div");
  grid.className = "deck-well-grid";
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r * cols + c >= format) continue;
      const wellId = `${rowLabels[r]}${c + 1}`;
      const well = document.createElement("div");
      well.className = "deck-well";
      well.dataset.well = wellId;

      if (usedWells.has(wellId)) {
        well.classList.add(role === "source" ? "well-source" : "well-dest");
      }

      _bindDeckTooltip(well, [`Well: ${wellId}`, `Plate: ${plateName}`,
        `Status: ${usedWells.has(wellId) ? "Used" : "Empty"}`]);

      grid.appendChild(well);
    }
  }

  gridCol.appendChild(grid);
  gridWrapper.appendChild(gridCol);
  section.appendChild(gridWrapper);

  _bindDeckArea(section, slotId, posData || { fixed: true, labware: plate.type || plateName, type: "plate" }, [
    `Plate: ${plateName}`,
    plate.type && `Labware: ${plate.type}`,
    `Format: ${format ? `${format}-well (${rows}×${cols})` : "Not specified"}`,
    format && `Wells used: ${usedWells.size} of ${format}`,
  ]);

  return section;
}

// ============================================================
// Shared Components
// ============================================================

function _deckAreaType(type, labware) {
  const key = String(type || "").toLowerCase().replace(/[\s_-]/g, "");
  if (key.endsWith("plate")) return "plate";
  if (key.endsWith("trash")) return "trash";
  if (!key || key === "labware" || key === "empty" && labware) return _guessType(labware);
  return key;
}

function _createSlot(pos) {
  const slot = document.createElement("div");
  const filled = !!pos.labware;
  const slotType = _deckAreaType(pos.type, pos.labware);
  slot.className = `deck-slot ${filled ? "filled" : "empty"} ${slotType}`;
  slot.dataset.id = pos.id;
  if (_selectedSlot === pos.id) slot.classList.add("selected");

  // Slot number badge
  slot.innerHTML = `<span class="slot-number">${pos.id}</span>`;

  if (filled) {
    // Module badge if applicable
    if (pos.module) {
      slot.innerHTML += `<span class="slot-module-badge">${pos.module}</span>`;
    }

    // One muted label above the hardware; implementation details live in the tooltip.
    slot.innerHTML += `<span class="slot-labware-name ${slotType === "trash" ? "trash-label" : ""} ${slotType === "module" ? "module-label" : ""}">${pos.labware_display || _shorten(pos.labware)}</span>`;
    slot.innerHTML += _renderSlotInterior(slotType, pos);
  } else {
    slot.innerHTML += `<span class="slot-icon">${slotType === "trash" ? "🗑" : "+"}</span>`;
    slot.innerHTML += `<span class="slot-empty-label">${slotType === "trash" ? "Trash" : "Empty"}</span>`;
  }

  _bindDeckArea(slot, pos.id, pos);

  return slot;
}

function _renderSlotInterior(type, pos) {
  type = _deckAreaType(type, pos.labware);
  if (type === "plate") {
    return _renderMiniPlate(pos, 8, 12, "mini-well");
  }
  if (type === "tiprack") {
    return _renderMiniPlate(pos, 8, 12, "mini-tip");
  }
  if (type === "reservoir") {
    return `<div class="slot-reservoir-visual">
      <div class="reservoir-trough"></div>
    </div>`;
  }
  if (type === "tuberack") {
    return _renderMiniPlate(pos, 4, 6, "mini-tube");
  }
  if (type === "trash") {
    return `<div class="slot-trash-visual">🗑</div>`;
  }
  // module or unknown
  return `<div class="slot-icon">⬡</div>`;
}

function _renderMiniPlate(pos, rows, cols, wellClass) {
  // Determine grid from labware name heuristics
  const lw = (pos.labware || "").toLowerCase();
  if (lw.includes("384")) { rows = 16; cols = 24; }
  else if (lw.includes("24")) { rows = 4; cols = 6; }
  else if (lw.includes("12")) { rows = 3; cols = 4; }
  else if (lw.includes("6") && !lw.includes("96") && !lw.includes("16")) { rows = 2; cols = 3; }

  // Get wells used by the protocol for this slot
  const usedWells = _wellUsageMap[pos.id] || new Set();

  let html = `<div class="slot-mini-grid" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">`;
  const rowLabels = Array.from({ length: rows }, (_, index) => {
    let label = "", number = index + 1;
    while (number > 0) { number--; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
    return label;
  });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wellId = `${rowLabels[r]}${c + 1}`;
      const usedClass = usedWells.has(wellId) ? " well-used" : "";
      html += `<div class="${wellClass} deck-well${usedClass}" data-well="${wellId}"></div>`;
    }
  }
  html += `</div>`;
  return html;
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

    chip.tabIndex = 0;
    _bindDeckTooltip(chip, [inst.name, inst.model, inst.mount && `Mount: ${inst.mount}`,
      inst.tipracks?.length && `Tip racks: ${inst.tipracks.join(", ")}`, "Double-click to change"]);

    // Double-click to open instrument selector
    chip.addEventListener("dblclick", () => {
      _showInstrumentSelector(inst);
    });

    bar.appendChild(chip);
  }

  // Only offer empty mounts already established by this device's instruments.
  if (!instruments.length) {
    const add = _libraryButton("Add instrument", () => _showInstrumentSelector({ name: "", model: "", mount: null, tipracks: [] }, true));
    bar.appendChild(add);
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

function _hideDeckTooltip() {
  document.getElementById("deck-area-tooltip")?.remove();
}

function _bindDeckTooltip(area, lines) {
  let suppressed = false;
  function show(event) {
    if (suppressed || _draggedDeckArea !== null) return;
    _hideDeckTooltip();
    const tip = document.createElement("div");
    tip.id = "deck-area-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = lines.filter(Boolean).join("\n");
    document.body.appendChild(tip);
    const rect = area.getBoundingClientRect();
    const x = event.clientX ?? rect.left, y = event.clientY ?? rect.bottom;
    tip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(y + 12, window.innerHeight - tip.offsetHeight - 8))}px`;
  }
  area.addEventListener("pointerenter", show);
  area.addEventListener("focus", show);
  area.addEventListener("pointerleave", () => { suppressed = false; _hideDeckTooltip(); });
  area.addEventListener("blur", _hideDeckTooltip);
  area.addEventListener("pointerdown", () => { suppressed = true; _hideDeckTooltip(); });
}

function _fixedDeckArea(pos) {
  return pos.fixed || pos.module || ["trash", "module"].includes(_deckAreaType(pos.type, pos.labware))
    || /^fixed(?:[\s_-]|$)/i.test(pos.type || "");
}

function _movableDeckArea(pos) {
  return !!pos.labware && !_fixedDeckArea(pos);
}

function _bindDeckArea(area, id, pos, details = []) {
  const empty = !pos.labware && !_fixedDeckArea(pos);
  const movable = _movableDeckArea(pos);
  area.tabIndex = 0;
  if (empty || movable) {
    area.setAttribute("role", "button");
    area.setAttribute("aria-label", `${empty ? "Add hardware" : pos.labware_display || pos.labware} at position ${id}`);
  }
  if (!empty) _bindDeckTooltip(area, [
    `Position: ${id}`, pos.labware_display || pos.labware,
    pos.labware_display && pos.labware !== pos.labware_display && `Labware: ${pos.labware}`,
    pos.variable && `Variable: ${pos.variable}`, pos.module && `Module: ${pos.module}`,
    pos.type && `Type: ${pos.type}`, ...details,
    movable ? "Drag to an empty position · Double-click to change" : null,
  ]);
  function activate() {
    _hideDeckTooltip();
    if (empty) _showSelector(id, null);
  }
  area.addEventListener("click", activate);
  area.addEventListener("keydown", event => {
    if (event.target !== area || (!empty && !movable) || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    _hideDeckTooltip();
    _showSelector(id, pos.labware || null);
  });
  area.addEventListener("dblclick", () => {
    if (movable) { _hideDeckTooltip(); _showSelector(id, pos.labware); }
  });
  area.draggable = movable;
  area.addEventListener("dragstart", event => {
    if (!movable) { event.preventDefault(); return; }
    _hideDeckTooltip();
    _draggedDeckArea = String(id);
    event.dataTransfer.setData("text/plain", String(id));
    event.dataTransfer.effectAllowed = "move";
  });
  area.addEventListener("dragend", () => {
    _draggedDeckArea = null;
    _hideDeckTooltip();
    document.querySelectorAll(".deck-drop-target").forEach(node => node.classList.remove("deck-drop-target"));
  });
  area.addEventListener("dragover", event => {
    if (!empty || _draggedDeckArea === null || _draggedDeckArea === String(id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    area.classList.add("deck-drop-target");
  });
  area.addEventListener("dragleave", () => area.classList.remove("deck-drop-target"));
  area.addEventListener("drop", event => {
    event.preventDefault();
    area.classList.remove("deck-drop-target");
    const source = _draggedDeckArea;
    _draggedDeckArea = null;
    if (empty && source !== null) _moveDeckArea(source, String(id));
  });
}

function _moveDeckArea(from, to) {
  if (!_currentState || from === to) return;
  const entries = (_currentState.positions || []).map(pos => [String(pos.id), pos]);
  for (const carrier of _currentState.carriers?.items || []) {
    for (const pos of carrier.positions || []) entries.push([`${carrier.type}_${pos.index}`, pos]);
  }
  const source = entries.find(([id]) => id === from)?.[1];
  const target = entries.find(([id]) => id === to)?.[1];
  if (!source || !target || !_movableDeckArea(source) || target.labware || _fixedDeckArea(target)) return;
  _stopDeckAnimation();
  const change = { type: "move_labware", from_slot: from, to_slot: to,
    labware: source.labware, variable: source.variable || null };
  for (const key of ["labware", "labware_display", "variable", "type"]) {
    target[key] = source[key];
    source[key] = key === "type" ? "empty" : null;
  }
  for (const step of _currentState.steps || []) {
    for (const role of ["source", "destination"]) {
      if (String(step[role]?.slot) === from) step[role].slot = to;
    }
  }
  for (const instrument of _currentState.instruments || []) {
    instrument.tipracks = (instrument.tipracks || []).map(id => String(id) === from ? to : id);
  }
  if (!_libraryEditing) _pendingChanges.push(change);
  _selectedSlot = null;
  _renderDeck(_currentState);
  _renderApplyBar();
}

// ============================================================
// Selector Modal — LLM-driven catalog
// ============================================================

const _hardwareCatalogs = new Map();
const _hardwareCatalogRequests = new Map();

function preloadHardwareCatalog(platform) {
  if (typeof platform === "string" && platform.trim()) _loadHardwareCatalog(platform).catch(() => {});
}

function _loadHardwareCatalog(platform) {
  const key = platform.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (_hardwareCatalogs.has(key)) return Promise.resolve(_hardwareCatalogs.get(key));
  if (_hardwareCatalogRequests.has(key)) return _hardwareCatalogRequests.get(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const request = (async () => {
    const response = await fetch("/deck/catalog", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, position_type: "labware", current: null }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Failed to load catalog");
    const catalog = await response.json();
    if (catalog.error || !Array.isArray(catalog.categories)) throw new Error("Invalid hardware catalog");
    _hardwareCatalogs.set(key, catalog);
    return catalog;
  })().finally(() => {
    clearTimeout(timeout);
    _hardwareCatalogRequests.delete(key);
  });
  _hardwareCatalogRequests.set(key, request);
  return request;
}

function _closeDeckSelector(modal) {
  modal?.remove();
}

async function _showSelector(slotId, currentLabware) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) _closeDeckSelector(existing);

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

  modal.addEventListener("click", (e) => { if (e.target === modal) _closeDeckSelector(modal); });
  document.body.appendChild(modal);
  document.getElementById("deck-selector-close-btn").addEventListener("click", () => _closeDeckSelector(modal));

  // Editing stays available while suggestions load, or if the lookup fails.
  const list = _renderCatalog(modal, { categories: [] }, slotId, currentLabware);
  list.innerHTML = '<div class="deck-selector-loading"><div class="deck-loading-spinner"></div><span>Loading compatible hardware...</span></div>';
  try {
    const catalog = await _loadHardwareCatalog(platform);
    if (!modal.isConnected) return;
    _renderCatalogItems(list, catalog, modal, slotId, currentLabware);
    _filterCatalog(modal, modal.querySelector(".deck-selector-search").value);
  } catch (e) {
    if (!modal.isConnected) return;
    list.textContent = e.name === "AbortError"
      ? "Hardware lookup timed out. Enter custom labware below or reopen to retry."
      : "Could not load suggested hardware. Enter custom labware below or reopen to retry.";
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
    removeBtn.addEventListener("click", () => { _closeDeckSelector(modal); _applyChange(slotId, null, currentLabware); });
    content.appendChild(removeBtn);
  }

  const list = document.createElement("div");
  list.className = "deck-selector-list";
  _renderCatalogItems(list, catalog, modal, slotId, currentLabware);
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
    if (val) { _closeDeckSelector(modal); _applyChange(slotId, val, currentLabware); }
  });
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = customInput.value.trim();
      if (val) { _closeDeckSelector(modal); _applyChange(slotId, val, currentLabware); }
    }
  });

  setTimeout(() => search.focus(), 100);
  return list;
}

function _renderCatalogItems(list, catalog, modal, slotId, currentLabware) {
  list.replaceChildren();
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
      itemDiv.addEventListener("click", () => { _closeDeckSelector(modal); _applyChange(slotId, item.id, currentLabware); });
      list.appendChild(itemDiv);
    }
  }

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

  if (_libraryEditing || _pendingChanges.length === 0) {
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
  if (_libraryEditing || _pendingChanges.length === 0) return;
  const state = _currentState;
  const applyBtn = document.getElementById("deck-apply-btn");
  if (applyBtn) { applyBtn.textContent = "Applying..."; applyBtn.disabled = true; }
  try {
    const response = await fetch("/deck/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: _currentCode, changes: _pendingChanges,
        chat_id: typeof currentChatId !== "undefined" ? currentChatId : null,
        template_id: state._library?.selected.id }),
    });
    const result = await response.json();
    if (!response.ok || !result.code || !result.state) throw new Error(result.error || "Could not apply these changes.");
    if (_currentState !== state) return;
    _currentCode = result.code;
    _currentState = result.state;
    _originalState = JSON.parse(JSON.stringify(result.state));
    _updateSourceCodeBlock(result.code);
    _originalCode = result.code;
    _pendingChanges = [];
    _selectedSlot = null;
    _renderDeck(_currentState);
    document.getElementById("deck-apply-bar")?.remove();
  } catch (error) {
    if (_currentState === state) _libraryNotice(error.message);
  } finally {
    if (applyBtn) { applyBtn.textContent = "Apply Changes"; applyBtn.disabled = false; }
  }
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

function _fitDeck() {
  const panel = document.getElementById("deck-panel");
  const container = document.getElementById("deck-svg-container");
  const wrapper = container?.querySelector(".deck-wrapper");
  if (!wrapper) return;
  if (!panel || panel.classList.contains("hidden")) return;
  const width = Math.max(1, container.clientWidth - 24);
  const height = Math.max(1, container.clientHeight - 24);
  wrapper.style.width = `${Math.max(320, width)}px`;
  const naturalWidth = wrapper.scrollWidth, naturalHeight = wrapper.scrollHeight;
  if (!naturalWidth || !naturalHeight) return;
  const scale = Math.min(1, width / naturalWidth, height / naturalHeight);
  wrapper.style.transform = `scale(${scale})`;
  wrapper.style.left = `${12 + (width - naturalWidth * scale) / 2}px`;
  wrapper.style.top = `${12 + (height - naturalHeight * scale) / 2}px`;
}

function _watchDeckFit() {
  _deckFitObserver?.disconnect();
  _fitDeck();
  const container = document.getElementById("deck-svg-container");
  if (!container || typeof ResizeObserver === "undefined") return;
  _deckFitObserver = new ResizeObserver(_fitDeck);
  _deckFitObserver.observe(container);
  const wrapper = container.querySelector(".deck-wrapper");
  if (wrapper) _deckFitObserver.observe(wrapper);
}

function _ensureDeckSplitter() {
  const panel = document.getElementById("deck-panel");
  const code = panel?.querySelector(".deck-code-panel");
  if (!code || panel.querySelector(".deck-splitter")) return;
  const splitter = document.createElement("div");
  splitter.className = "deck-splitter";
  splitter.tabIndex = 0;
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-label", "Resize deck and code panes");
  splitter.setAttribute("aria-orientation", "horizontal");
  splitter.setAttribute("aria-controls", "deck-svg-container deck-code-view");
  splitter.setAttribute("aria-valuemin", "0");
  splitter.setAttribute("aria-valuemax", "100");
  code.before(splitter);
  let startY = 0, startHeight = 0;
  function resize(height) {
    const header = panel.querySelector(".deck-panel-header");
    const available = panel.clientHeight - header.offsetHeight - splitter.offsetHeight;
    const minimum = Math.min(80, available / 2);
    const value = Math.max(minimum, Math.min(height, available - minimum));
    panel.style.setProperty("--deck-code-height", `${value}px`);
    splitter.setAttribute("aria-valuenow", String(Math.round(100 * (available - value) / available)));
    _fitDeck();
  }
  splitter.addEventListener("pointerdown", event => {
    event.preventDefault();
    startY = event.clientY;
    startHeight = code.getBoundingClientRect().height;
    splitter.focus();
    splitter.setPointerCapture(event.pointerId);
  });
  splitter.addEventListener("pointermove", event => {
    if (splitter.hasPointerCapture(event.pointerId)) resize(startHeight + startY - event.clientY);
  });
  splitter.addEventListener("pointerup", event => {
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  });
  splitter.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    resize(event.key === "Home" ? panel.clientHeight : event.key === "End" ? 0
      : code.getBoundingClientRect().height + (event.key === "ArrowUp" ? 24 : -24));
  });
}

function _renderDeckCode() {
  const panel = document.getElementById("deck-panel");
  const view = document.getElementById("deck-code-view");
  if (!view || !panel || view._displayedCode === _currentCode) return;
  view.replaceChildren();
  view._displayedCode = _currentCode;
  if (!_currentCode) {
    view.textContent = "Open a protocol to view its code.";
    return;
  }
  const block = buildCodeBlock(_currentCode, detectFormat(_currentCode));
  const expand = block.querySelector(".code-preview-toggle");
  if (expand?.getAttribute("aria-expanded") === "false") expand.click();
  expand?.remove();
  block.querySelector(".deck-action-btn")?.remove();
  view.appendChild(block);
}

function _setDeckFullscreen(expanded) {
  const panel = document.getElementById("deck-panel");
  if (!panel) return;
  panel.classList.toggle("deck-fullscreen", expanded);
  panel.setAttribute("role", expanded ? "dialog" : "complementary");
  if (expanded) panel.setAttribute("aria-modal", "true");
  else panel.removeAttribute("aria-modal");
  for (const id of ["sidebar", "chat-panel"]) {
    const background = document.getElementById(id);
    if (background) background.inert = expanded;
  }
  const button = document.getElementById("deck-fullscreen-btn");
  const label = expanded ? "Exit deck full screen" : "Expand deck to full screen";
  button?.setAttribute("aria-pressed", String(expanded));
  button?.setAttribute("aria-label", label);
  if (button) button.title = label;
  _ensureDeckSplitter();
  _renderDeckCode();
  _watchDeckFit();
}

function _openDeckPanel() {
  const panel = document.getElementById("deck-panel");
  const chat = document.getElementById("chat-panel");
  const btn = document.getElementById("deck-toggle-btn");
  if (panel) panel.classList.remove("hidden");
  if (chat) chat.classList.add("with-deck");
  if (btn) btn.classList.add("active");
  _ensureResizeHandle();
  _ensureDeckSplitter();
  _renderDeckCode();
}
function closeDeckPanel() {
  _hideDeckTooltip();
  _draggedDeckArea = null;
  _setDeckFullscreen(false);
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
function toggleProtocolDeck(code, sourceLink) {
  if (_currentCode === code && _sourceCodeBlock === sourceLink) toggleDeckPanel();
  else parseDeckFromCode(code, sourceLink);
}
function clearDeckPanel() {
  if (_deckAbort) { _deckAbort.abort(); _deckAbort = null; }
  closeDeckPanel();
  _currentCode = null; _originalCode = null; _currentState = null; _originalState = null;
  _selectedSlot = null; _pendingChanges = []; _sourceCodeBlock = null;
  _libraryEditing = false; _libraryBeforeEdit = null;
  // Animation cleanup
  _animSteps = []; _animStepIndex = -1; _animPlaying = false; _animBusy = false;
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  const playbar = document.getElementById("anim-playback-bar");
  if (playbar) playbar.remove();
  _removeTipOverlay();
  // Clear any code block highlights in the chat
  _clearCodeBlockHighlights();
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<p class="deck-empty-message">Generate a protocol to see the deck layout</p>';
  const bar = document.getElementById("deck-apply-bar");
  if (bar) bar.remove();
  const view = document.getElementById("deck-code-view");
  if (view) { view.replaceChildren(); view._displayedCode = undefined; }
}

// ============================================================
// Update the Source Code Block in Chat
// ============================================================

function _updateSourceCodeBlock(newCode) {
  // Try the stored reference first
  let block = _sourceCodeBlock;
  if (block?._protocolCode !== undefined) {
    block._protocolCode = newCode;
    _renderDeckCode();
    return;
  }

  // Fallback: find the code block whose content matches our original code
  if (!block) {
    const allBlocks = document.querySelectorAll("#chat-history .protocol-deck-link, #chat-history .code-block-wrapper");
    for (const b of allBlocks) {
      const codeEl = b.querySelector("code");
      if (_originalCode && (b._protocolCode || codeEl?.textContent || "").trim() === _originalCode.trim()) {
        block = b;
        break;
      }
    }
  }

  // Last resort fallback: last code block in the chat
  if (!block) {
    const allBlocks = document.querySelectorAll("#chat-history .protocol-deck-link, #chat-history .code-block-wrapper");
    if (allBlocks.length) block = allBlocks[allBlocks.length - 1];
  }

  if (!block) {
    console.warn("Could not find source code block to update");
    return;
  }

  // Rebuild actions and line previews against the new full file.
  const replacement = buildDeckLink(newCode);
  block.replaceWith(replacement);
  _sourceCodeBlock = replacement;
  _renderDeckCode();
  replacement.classList.add("code-updated");
  setTimeout(() => replacement.classList.remove("code-updated"), 1500);
}

function _showLoading() {
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<div class="deck-loading"><div class="deck-loading-spinner"></div><span>Loading deck...</span><span class="deck-loading-sub">Saved device layouts are reused automatically</span></div>';
}
function _showError(msg) {
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  const message = document.createElement("p");
  message.className = "deck-empty-message";
  message.textContent = msg;
  container.replaceChildren(message);
}

// ============================================================
// Code Block Highlighting — sync chat code lines with animation
// ============================================================

function _clearCodeBlockHighlights() {
  const preview = document.getElementById("deck-code-view")?.querySelector(".code-block-wrapper");
  for (const block of [_sourceCodeBlock, preview].filter(Boolean)) {
    block.querySelectorAll(".code-line.code-line-active, .code-line.code-line-loop").forEach(el => {
      el.classList.remove("code-line-active", "code-line-loop");
    });
  }
}

function _highlightCodeBlockLines(codeLines) {
  const block = document.getElementById("deck-code-view")?.querySelector(".code-block-wrapper");
  if (!block || !codeLines || !Array.isArray(codeLines) || codeLines.length === 0) {
    _clearCodeBlockHighlights();
    return;
  }

  // Clear previous highlights
  _clearCodeBlockHighlights();

  // Playback reveals the full file so its active lines remain visible.
  block.querySelector('.code-preview-toggle[aria-expanded="false"]')?.click();

  // Last line = action (red), earlier lines = loop headers (blue)
  const actionLine = codeLines[codeLines.length - 1];
  const loopLines = codeLines.slice(0, -1);

  // Apply loop header highlights (blue)
  for (const ln of loopLines) {
    const lineEl = block.querySelector(`.code-line[data-line="${ln}"]`);
    if (lineEl) lineEl.classList.add("code-line-loop");
  }

  // Apply action line highlight (red)
  const actionEl = block.querySelector(`.code-line[data-line="${actionLine}"]`);
  if (actionEl) {
    actionEl.classList.add("code-line-active");
    // Scroll the code block so the active line is visible
    const pre = block.querySelector(".code-block-pre");
    if (pre) _revealCodeLine(pre, actionEl);
  }
}

function _revealCodeLine(pre, line) {
  const viewport = pre.getBoundingClientRect(), target = line.getBoundingClientRect();
  const top = pre.scrollTop + target.top - viewport.top - pre.clientTop
    - (pre.clientHeight - target.height) / 2;
  pre.scrollTo({ top: Math.max(0, Math.min(top, pre.scrollHeight - pre.clientHeight)), behavior: "instant" });
}

// ============================================================
// Animation System — Protocol Step Playback
// ============================================================

function _initAnimation(state) {
  _animSteps = state.steps || [];
  _animStepIndex = -1;
  _animPlaying = false;
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  _animBusy = false;
  if (_animSteps.length > 0) _renderPlaybackControls();
}

function _renderPlaybackControls() {
  let bar = document.getElementById("anim-playback-bar");
  if (bar) bar.remove();

  const panel = document.getElementById("deck-panel");
  if (!panel) return;

  bar = document.createElement("div");
  bar.id = "anim-playback-bar";
  bar.className = "anim-playback-bar";

  // Step description
  const desc = document.createElement("div");
  desc.id = "anim-step-desc";
  desc.className = "anim-step-desc";
  desc.innerHTML = '<span class="anim-step-idle">Press play to animate protocol steps</span>';
  bar.appendChild(desc);

  // Controls row
  const controls = document.createElement("div");
  controls.className = "anim-controls-row";

  // Transport buttons
  const transport = document.createElement("div");
  transport.className = "anim-transport";

  const btnFirst = _makeAnimBtn("⏮", "First step", () => _animGoTo(0));
  const btnPrev  = _makeAnimBtn("◀", "Previous step", () => _animPrev());
  const btnPlay  = _makeAnimBtn("▶", "Play / Pause", () => _animTogglePlay());
  btnPlay.id = "anim-play-btn";
  const btnNext  = _makeAnimBtn("▶", "Next step", () => _animNext());
  btnNext.classList.add("anim-btn-next");
  const btnLast  = _makeAnimBtn("⏭", "Last step", () => _animGoTo(_animSteps.length - 1));

  transport.append(btnFirst, btnPrev, btnPlay, btnNext, btnLast);
  controls.appendChild(transport);

  // Scrubber
  const scrubber = document.createElement("input");
  scrubber.type = "range";
  scrubber.id = "anim-scrubber";
  scrubber.className = "anim-scrubber";
  scrubber.min = -1;
  scrubber.max = _animSteps.length - 1;
  scrubber.value = _animStepIndex;
  scrubber.addEventListener("input", (e) => _animGoTo(parseInt(e.target.value)));
  controls.appendChild(scrubber);

  // Counter
  const counter = document.createElement("span");
  counter.id = "anim-counter";
  counter.className = "anim-counter";
  counter.textContent = `— / ${_animSteps.length}`;
  controls.appendChild(counter);

  // Speed selector
  const speed = document.createElement("select");
  speed.id = "anim-speed";
  speed.className = "anim-speed-select";
  [
    { label: "0.5×", value: 2500 },
    { label: "1×",   value: 1500 },
    { label: "2×",   value: 800  },
    { label: "4×",   value: 400  },
  ].forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === _animSpeed) o.selected = true;
    speed.appendChild(o);
  });
  speed.addEventListener("change", (e) => {
    _animSpeed = parseInt(e.target.value);
    if (_animPlaying) {
      clearInterval(_animTimer);
      _animTimer = setInterval(_animAutoStep, _animSpeed);
    }
  });
  controls.appendChild(speed);
  bar.appendChild(controls);

  // Insert into the deck container, before the info panel
  const container = document.getElementById("deck-svg-container");
  const wrapper = container ? container.querySelector(".deck-wrapper") : null;
  const info = wrapper ? wrapper.querySelector("#deck-info") : null;
  if (info && wrapper) {
    wrapper.insertBefore(bar, info);
  } else if (container) {
    container.appendChild(bar);
  } else {
    panel.appendChild(bar);
  }
}

function _makeAnimBtn(icon, title, onClick) {
  const btn = document.createElement("button");
  btn.className = "anim-btn";
  btn.title = title;
  btn.innerHTML = `<span>${icon}</span>`;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---- Step visuals ----

function _applyStepVisuals(stepIndex, animate) {
  const container = document.getElementById("deck-svg-container");
  if (!container) return;

  // Clear previous highlights
  container.querySelectorAll(".slot-anim-highlight").forEach(el => {
    el.classList.remove("slot-anim-highlight");
    el.style.removeProperty("--anim-color");
    el.style.removeProperty("--anim-glow");
  });
  container.querySelectorAll(".well-anim-active").forEach(el => {
    el.classList.remove("well-anim-active");
    el.style.removeProperty("--anim-color");
  });
  _removeTipOverlay();

  if (stepIndex < 0 || stepIndex >= _animSteps.length) {
    _updateStepDescription(null);
    _clearCodeBlockHighlights();
    return;
  }

  const step = _animSteps[stepIndex];
  const actionKey = (step.action || "transfer").toLowerCase().replace(/[\s-]+/g, "_");
  const colors = ACTION_COLORS[actionKey] || ACTION_COLORS.transfer;

  // Highlight source slot + wells
  if (step.source && step.source.slot) {
    _highlightSlot(container, step.source.slot, colors, step.source.wells);
  }

  // Highlight destination slot + wells
  if (step.destination && step.destination.slot) {
    _highlightSlot(container, step.destination.slot, colors, step.destination.wells);
  }

  // Tip animation
  if (animate) _showTipAnimation(step, colors);

  _updateStepDescription(step, colors);

  // Highlight corresponding lines in the chat code block
  _highlightCodeBlockLines(step.code_lines);
}

function _highlightSlot(container, slotId, colors, wells) {
  // Find slot by data-id
  const slot = container.querySelector(`.deck-slot[data-id="${slotId}"]`);
  if (slot) {
    slot.classList.add("slot-anim-highlight");
    slot.style.setProperty("--anim-color", colors.fill);
    slot.style.setProperty("--anim-glow", colors.glow);
  }

  // Highlight individual wells — both in plates layout AND mini-grids inside slots
  // Falls back to container-wide search if no slot found (e.g. mismatched IDs)
  if (wells && wells.length > 0) {
    const searchRoot = slot || container;
    for (const wellId of wells) {
      const well = searchRoot.querySelector(`.deck-well[data-well="${wellId}"]`)
                || container.querySelector(`.deck-well[data-well="${wellId}"]`)
                || container.querySelector(`.deck-well[title="${wellId}"]`);
      if (well) {
        well.classList.add("well-anim-active");
        well.style.setProperty("--anim-color", colors.fill);
      }
    }
  }
}

function _updateStepDescription(step, colors) {
  const desc = document.getElementById("anim-step-desc");
  if (!desc) return;

  if (!step) {
    desc.innerHTML = '<span class="anim-step-idle">Press play to animate protocol steps</span>';
    return;
  }

  const actionKey = (step.action || "transfer").toLowerCase().replace(/[\s-]+/g, "_");
  const c = colors || ACTION_COLORS[actionKey] || ACTION_COLORS.transfer;
  const label = c.label || step.action || "Step";

  let html = `<span class="anim-action-badge" style="background:${c.fill};color:#000">${label}</span> `;
  html += `<span class="anim-step-text">${step.description || ""}</span>`;
  if (step.volume) {
    html += ` <span class="anim-step-vol">${step.volume}</span>`;
  }
  desc.innerHTML = html;
}

// ---- Tip overlay ----

function _removeTipOverlay() {
  document.querySelectorAll(".anim-tip-overlay").forEach(el => el.remove());
}

function _showTipAnimation(step, colors) {
  _removeTipOverlay();

  const container = document.getElementById("deck-svg-container");
  if (!container) return;

  const actionKey = (step.action || "").toLowerCase().replace(/[\s-]+/g, "_");
  const targetSlotId = step.source?.slot || step.destination?.slot;
  if (!targetSlotId) return;

  // Find target slot element
  const allSlots = container.querySelectorAll(".deck-slot[data-id]");
  let targetEl = null;
  for (const s of allSlots) {
    if (s.dataset.id === targetSlotId) { targetEl = s; break; }
  }
  if (!targetEl) return;

  const containerRect = container.getBoundingClientRect();
  const slotRect = targetEl.getBoundingClientRect();

  // Create tip overlay
  const overlay = document.createElement("div");
  overlay.className = `anim-tip-overlay tip-${actionKey}`;
  overlay.innerHTML = `
    <div class="tip-body" style="border-color:${colors.fill}">
      <div class="tip-liquid" style="background:${colors.fill}"></div>
    </div>
    <div class="tip-nozzle" style="background:${colors.fill}"></div>
    ${step.volume ? `<div class="tip-vol-label">${step.volume}</div>` : ""}
  `;

  // Bug 1 fix: account for scroll offset
  overlay.style.position = "absolute";
  overlay.style.left = (slotRect.left - containerRect.left + container.scrollLeft + slotRect.width / 2 - 20) + "px";
  overlay.style.top  = (slotRect.top  - containerRect.top  + container.scrollTop  - 52) + "px";
  overlay.style.zIndex = "50";
  overlay.style.pointerEvents = "none";

  container.style.position = "relative";
  container.appendChild(overlay);

  // Transfer: animate tip from source to destination
  if (actionKey === "transfer" && step.source?.slot && step.destination?.slot && step.source.slot !== step.destination.slot) {
    _animateTipMovement(overlay, step, container, allSlots, colors);
  }
}

function _animateTipMovement(overlay, step, container, allSlots, colors) {
  let srcEl = null, dstEl = null;
  for (const s of allSlots) {
    if (s.dataset.id === step.source.slot)      srcEl = s;
    if (s.dataset.id === step.destination.slot)  dstEl = s;
  }
  if (!srcEl || !dstEl) return;

  const containerRect = container.getBoundingClientRect();
  const scrollL = container.scrollLeft;
  const scrollT = container.scrollTop;

  const srcRect = srcEl.getBoundingClientRect();
  const dstRect = dstEl.getBoundingClientRect();

  const srcX = srcRect.left - containerRect.left + scrollL + srcRect.width / 2 - 20;
  const srcY = srcRect.top  - containerRect.top  + scrollT - 52;
  const dstX = dstRect.left - containerRect.left + scrollL + dstRect.width / 2 - 20;
  const dstY = dstRect.top  - containerRect.top  + scrollT - 52;

  // Start at source
  overlay.style.left = srcX + "px";
  overlay.style.top  = srcY + "px";
  overlay.style.transition = `left ${_animSpeed * 0.4}ms ease-in-out, top ${_animSpeed * 0.4}ms ease-in-out`;

  // Move to destination after short delay
  setTimeout(() => {
    overlay.style.left = dstX + "px";
    overlay.style.top  = dstY + "px";
  }, _animSpeed * 0.2);
}

// ---- Transport controls ----

function _animNext() {
  if (_animBusy) return;
  if (_animStepIndex < _animSteps.length - 1) {
    _animBusy = true;
    _animStepIndex++;
    _applyStepVisuals(_animStepIndex, true);
    _updatePlaybackUI();
    setTimeout(() => { _animBusy = false; }, 300);
  }
}

function _animPrev() {
  if (_animBusy) return;
  if (_animStepIndex > -1) {
    _animBusy = true;
    _animStepIndex--;
    _applyStepVisuals(_animStepIndex, _animStepIndex >= 0);
    _updatePlaybackUI();
    setTimeout(() => { _animBusy = false; }, 300);
  }
}

function _animGoTo(idx) {
  if (_animBusy) return;
  idx = Math.max(-1, Math.min(idx, _animSteps.length - 1));
  _animStepIndex = idx;
  _applyStepVisuals(_animStepIndex, _animStepIndex >= 0);
  _updatePlaybackUI();
}

function _animTogglePlay() {
  if (_animPlaying) {
    _animPlaying = false;
    if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  } else {
    _animPlaying = true;
    if (_animStepIndex >= _animSteps.length - 1) _animStepIndex = -1;
    _animTimer = setInterval(_animAutoStep, _animSpeed);
    _animAutoStep();
  }
  _updatePlaybackUI();
}

function _animAutoStep() {
  if (_animStepIndex >= _animSteps.length - 1) {
    _animPlaying = false;
    if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
    _updatePlaybackUI();
    return;
  }
  _animNext();
}

function _updatePlaybackUI() {
  const playBtn = document.getElementById("anim-play-btn");
  if (playBtn) {
    playBtn.querySelector("span").textContent = _animPlaying ? "⏸" : "▶";
    playBtn.title = _animPlaying ? "Pause" : "Play";
  }

  const scrubber = document.getElementById("anim-scrubber");
  if (scrubber) scrubber.value = _animStepIndex;

  const counter = document.getElementById("anim-counter");
  if (counter) {
    counter.textContent = _animStepIndex >= 0
      ? `${_animStepIndex + 1} / ${_animSteps.length}`
      : `— / ${_animSteps.length}`;
  }
}

// ============================================================
// Resizable Deck Panel (Bug 3 fix)
// ============================================================

function _ensureResizeHandle() {
  const panel = document.getElementById("deck-panel");
  if (!panel || panel.querySelector(".deck-resize-handle")) return;

  const handle = document.createElement("div");
  handle.className = "deck-resize-handle";
  panel.prepend(handle);

  let startX = 0, startW = 0;

  function onMouseDown(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    panel.classList.add("resizing");
    handle.classList.add("active");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    const dx = startX - e.clientX;  // drag left = wider
    const newW = Math.max(320, Math.min(startW + dx, window.innerWidth * 0.8));
    panel.style.width = newW + "px";
  }

  function onMouseUp() {
    panel.classList.remove("resizing");
    handle.classList.remove("active");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  handle.addEventListener("mousedown", onMouseDown);
}

// Init
document.addEventListener("DOMContentLoaded", () => {
  const t = document.getElementById("deck-toggle-btn");
  const c = document.getElementById("deck-close-btn");
  const f = document.getElementById("deck-fullscreen-btn");
  if (t) t.addEventListener("click", toggleDeckPanel);
  if (c) c.addEventListener("click", closeDeckPanel);
  if (f) f.addEventListener("click", () => {
    _setDeckFullscreen(!document.getElementById("deck-panel").classList.contains("deck-fullscreen"));
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && document.getElementById("deck-panel")?.classList.contains("deck-fullscreen")) {
      event.preventDefault();
      _setDeckFullscreen(false);
    }
  });
});

window.parseDeckFromCode = parseDeckFromCode;
window.preloadHardwareCatalog = preloadHardwareCatalog;
window.clearDeckPanel = clearDeckPanel;
window.toggleDeckPanel = toggleDeckPanel;
window.toggleProtocolDeck = toggleProtocolDeck;
