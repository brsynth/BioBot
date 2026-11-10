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
let _selectedWell = null;
let _pendingChanges = [];
const _plateSlotRoles = new Map();
const WELL_LIQUID_COLORS = ["#83b6d5", "#b2a0d7", "#83bfa9", "#e2bf79", "#d899b5"];
let _sourceCodeBlock = null;  // the specific code block element the deck was opened from
let _libraryEditing = false;
let _libraryDraftName = "";
let _libraryBeforeEdit = null;
let _deckFitObserver = null;
let _draggedDeckArea = null;
let _applyingChanges = false;
let _parameterAbort = null;

// Animation state
let _animSteps = [];
let _animStepIndex = -1;
let _animPlaying = false;
let _animTimer = null;
let _animSpeed = 1500;
let _animBusy = false;

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
  _parameterAbort?.abort();
  const chatId = typeof currentChatId !== "undefined" ? currentChatId : null;
  if (_deckAbort) { _deckAbort.abort(); _deckAbort = null; }

  _currentCode = code;
  _originalCode = code;
  const previousState = _currentState;
  _renderProtocolParameters({});
  const parametersError = document.getElementById("protocol-parameters-error");
  if (parametersError) parametersError.textContent = "";
  _originalState = null;
  _selectedSlot = null;
  _pendingChanges = [];
  _sourceCodeBlock = sourceBlock || null;
  _libraryEditing = false;
  _libraryBeforeEdit = null;
  _clearCodeBlockHighlights();
  _stopDeckAnimation();
  _renderApplyBar();
  _openDeckPanel();
  _showLoading(!!previousState);
  _renderDeckCode();

  const controller = new AbortController();
  _deckAbort = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {timedOut = true; controller.abort();}, 90000);
  const retry = () => parseDeckFromCode(code, sourceBlock, templateId);
  const container = document.getElementById("deck-svg-container");
  if (container) container.inert = true;
  window.workspace?.syncActions();
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
      _currentState = null; _showError(errMsg, retry);
      return;
    }

    const state = await res.json();
    if (_deckAbort !== controller || parseForChat && currentChatId !== parseForChat) return;
    if (state.error) { console.error("Deck state error:", state.error); _currentState = null; _showError(state.error, retry); return; }

    _currentState = state;
    _originalState = JSON.parse(JSON.stringify(state));  // deep copy for discard
    _renderDeck(state);
    if (state._parameters_pending) _loadProtocolParameters(code, state, chatId);
  } catch (e) {
    if (_deckAbort !== controller || e.name === "AbortError" && !timedOut) return;
    console.error("Deck fetch error:", e);
    _currentState = null;
    _showError(timedOut ? "Loading the deck timed out. Please try again." : "Could not load the deck: " + e.message, retry);
  } finally {
    clearTimeout(timeout);
    if (_deckAbort === controller) {
      _deckAbort = null;
      if (container) container.inert = false;
      window.workspace?.syncActions();
    }
  }
}

async function _loadProtocolParameters(code, state, chatId) {
  const controller = new AbortController();
  _parameterAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch("/deck/visualize", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code, chat_id: chatId, refresh_parameters: true}),
      signal: controller.signal,
    });
    const updated = await response.json();
    if (!response.ok) throw new Error(updated.error || "Could not load protocol parameters.");
    if (_currentState !== state) return;
    if (controller.signal.aborted) throw new Error("Protocol details update timed out.");
    state.parameters = updated.parameters || [];
    state.parameter_constraints = updated.parameter_constraints || [];
    state._parameters_pending = false;
    state.steps = updated.steps || [];
    state.initial_wells = updated.initial_wells || [];
    state._playback_pending = false;
    // Upgrade learned geometry without overwriting hardware the user has edited.
    for (const target of [state, _originalState].filter(Boolean)) {
      for (const position of target.positions || []) {
        const fresh = (updated.positions || []).find(item => String(item.id) === String(position.id) && item.labware === position.labware);
        if (!fresh) continue;
        for (const key of ["well_count", "well_rows", "well_columns", "aspect_ratio"]) {
          if (fresh[key] != null) position[key] = fresh[key];
        }
      }
      if (target === _originalState || _pendingChanges.every(change => change.type === "set_parameter")) {
        target.plates = JSON.parse(JSON.stringify(updated.plates || target.plates || {}));
      }
    }
    if (_originalState) {
      _originalState.parameters = JSON.parse(JSON.stringify(state.parameters));
      _originalState.parameter_constraints = JSON.parse(JSON.stringify(state.parameter_constraints));
      _originalState.steps = JSON.parse(JSON.stringify(state.steps));
      _originalState.initial_wells = JSON.parse(JSON.stringify(state.initial_wells));
      _originalState._playback_pending = false;
      _originalState._parameters_pending = false;
    }
    for (const change of _pendingChanges.filter(item => item.type === "set_parameter")) {
      const parameter = state.parameters.find(item => item.id === change.parameter_id || item.label === change.label);
      if (parameter) {
        change.parameter_id = parameter.id;
        change.old_value = parameter.value;
        parameter.value = change.new_value;
      }
    }
    const playbackIndex = _animStepIndex, wasPlaying = _animPlaying;
    _renderDeck(state);
    if (playbackIndex >= 0) _animGoTo(playbackIndex);
    if (wasPlaying) _animTogglePlay();
  } catch (error) {
    if (_currentState !== state) return;
    state._parameters_pending = false;
    if (state.steps?.length) state._playback_pending = false;
    _renderProtocolParameters(state);
    const message = document.getElementById("protocol-parameters-error");
    const panel = document.getElementById("protocol-parameters");
    if (message && panel) {panel.hidden = false; message.textContent = "Protocol details could not be updated. Reopen the protocol to retry.";}
    const playback = document.getElementById("anim-playback-bar");
    if (playback && state._playback_pending) {
      const desc = document.getElementById("anim-step-desc");
      if (desc) desc.textContent = "Playback could not be updated.";
      const retry = _libraryButton("Retry", () => parseDeckFromCode(_currentCode, _sourceCodeBlock));
      playback.appendChild(retry);
    }
  } finally {
    clearTimeout(timeout);
    if (_parameterAbort === controller) _parameterAbort = null;
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
  if (window.workspace?.readOnly) return;
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
    hint.textContent = "Editing a private copy. Adjust the physical layout below; double-click hardware to change defaults.";
    controls.appendChild(hint);
    _renderLayoutEditor(controls, state);
    return;
  }
  const label = document.createElement("label");
  label.textContent = "Device layout library";
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
  select.addEventListener("change", () => _currentCode
    ? parseDeckFromCode(_currentCode, _sourceCodeBlock, select.value)
    : window.workspace?.chooseDevice(state.platform, select.value));
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
  _closeWellDetails();
  _plateSlotRoles.clear();
  _hideDeckTooltip();
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  _renderProtocolParameters(state);
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "deck-wrapper";

  // Title
  const title = document.createElement("div");
  title.className = "deck-title";
  title.textContent = state.platform || "Deck Layout";
  wrapper.appendChild(title);
  const libraryPanel = document.getElementById("deck-library-panel");
  libraryPanel?.replaceChildren();
  _renderLibraryControls(libraryPanel || wrapper, state);
  // Instrument editing belongs with device settings, not above the deck.
  if (libraryPanel) {
    const instruments = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Instruments";
    instruments.append(summary, _renderInstruments(state.instruments || []));
    libraryPanel.appendChild(instruments);
  }

  // Layout
  const layoutType = state.layout_type || "grid";
  const frame = document.createElement("div");
  frame.className = "deck-device-frame";
  frame.dataset.layout = layoutType;
  wrapper.appendChild(frame);

  if (layoutType === "grid") {
    frame.appendChild(_renderGrid(state));
  } else if (layoutType === "linear") {
    frame.appendChild(_renderLinear(state));
  } else if (layoutType === "plates") {
    frame.appendChild(_renderPlates(state));
  } else {
    frame.appendChild(_renderGrid(state)); // fallback
  }

  // Info panel
  const info = document.createElement("div");
  info.id = "deck-info";
  info.className = "deck-info-panel";
  info.innerHTML = '<span class="deck-info-hint">Drag hardware to rearrange · Select an empty position to add</span>';
  frame.appendChild(info);

  container.appendChild(wrapper);

  // Animation system — init when steps exist
  _initAnimation(state);
  _paintProtocolWells(state, -1);
  _watchDeckFit();
  preloadHardwareCatalog(state.platform);
  window.workspace?.deckChanged(state);
  _renderApplyBar();
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
  deck.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  deck.style.gridTemplateRows = `repeat(${rows}, auto)`;

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
      // Let a padding-free cell size the row; the hardware fits inside it.
      const cell = document.createElement("div");
      cell.className = "deck-grid-cell";
      cell.style.aspectRatio = slot.style.aspectRatio;
      cell.appendChild(slot);
      deck.appendChild(cell);
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
// Plates Layout (source→destination transfers)
// ============================================================

function _renderPlates(state) {
  const plates = state.plates || {};
  const positions = state.positions || [];
  const container = document.createElement("div");
  container.className = "deck-plates";
  // Facing plates (destination held above the source) are drawn as they sit: destination on top.
  if (state.arrangement === "facing") container.classList.add("facing");

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
    _plateSlotRoles.set(String(slotId), new Set(["source"]));
    const source = _renderPlateMap(plates.source, "source", slotId, srcPos);
    source.classList?.add("plate-source");
    container.appendChild(source);
  }
  if (plates.destination) {
    const dstPos = _findPlatePos("dest") || platePosns.find(p => !usedIds.has(p.id)) || platePosns[1];
    const slotId = dstPos?.id || "destination";
    if (dstPos) usedIds.add(dstPos.id);
    if (!_plateSlotRoles.has(String(slotId))) _plateSlotRoles.set(String(slotId), new Set());
    _plateSlotRoles.get(String(slotId)).add("destination");
    const destination = _renderPlateMap(plates.destination, "dest", slotId, dstPos);
    destination.classList?.add("plate-dest");
    container.appendChild(destination);
    if (state.arrangement === "facing") {
      const gap = document.createElement("div");
      gap.className = "deck-plates-gap"; gap.textContent = "↑ ↑ ↑"; gap.title = "Transfer from the source plate up to the destination plate";
      container.appendChild(gap);
    }
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
  const geometry = {...posData, ...plate};
  const declared = Number.isInteger(geometry.well_rows) && geometry.well_rows > 0
    && Number.isInteger(geometry.well_columns) && geometry.well_columns > 0 && geometry.well_rows * geometry.well_columns === format;
  const rows = declared ? geometry.well_rows : 0;
  const cols = declared ? geometry.well_columns : 0;

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
  const roleLabel = document.createElement("span");
  roleLabel.className = "slot-role";
  roleLabel.textContent = role === "source" ? "Source" : "Destination";
  section.appendChild(roleLabel);
  section.appendChild(header);
  const count = document.createElement("span");
  count.className = "slot-well-count";
  section.appendChild(count);
  if (!declared) {
    count.textContent = `${format ? `${format} wells · ` : ""}Well layout unspecified`;
    _bindDeckArea(section, slotId, posData || {fixed:true,labware:plate.type || plateName,type:"plate"});
    return section;
  }

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

      grid.appendChild(well);
    }
  }

  gridCol.appendChild(grid);
  gridWrapper.appendChild(gridCol);
  section.appendChild(gridWrapper);

  _bindDeckArea(section, slotId, posData || { fixed: true, labware: plate.type || plateName, type: "plate" });

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

function _deckRole(pos) {
  if (pos.role) return String(pos.role);
  const type = _deckAreaType(pos.type, pos.labware);
  if (type === "tiprack") return "Tips";
  const roles = new Set();
  for (const step of _currentState?.steps || []) {
    const action = String(step.action || "transfer").toLowerCase();
    if (["aspirate", "transfer"].includes(action) && String(step.source?.slot) === String(pos.id)) roles.add("Source");
    if (["dispense", "transfer"].includes(action) && String(step.destination?.slot) === String(pos.id)) roles.add("Destination");
  }
  return [...roles].join(" / ") || type.charAt(0).toUpperCase() + type.slice(1);
}

function _createSlot(pos) {
  const slot = document.createElement("div");
  const filled = !!pos.labware;
  const slotType = _deckAreaType(pos.type, pos.labware);
  slot.className = `deck-slot ${filled ? "filled" : "empty"} ${slotType}`;
  slot.dataset.id = pos.id;
  const ratio = Number(pos.aspect_ratio);
  slot.style.aspectRatio = Number.isFinite(ratio) && ratio >= 0.1 && ratio <= 10 ? String(ratio) : "1.5";
  if (_selectedSlot === pos.id) slot.classList.add("selected");

  // Slot number badge
  slot.innerHTML = `<span class="slot-number">${pos.id}</span>`;

  if (filled) {
    // Module badge if applicable
    if (pos.module) {
      slot.innerHTML += `<span class="slot-module-badge">${pos.module}</span>`;
    }

    const role = document.createElement("span");
    role.className = "slot-role";
    role.textContent = _deckRole(pos);
    slot.appendChild(role);
    const name = document.createElement("span");
    name.className = "slot-labware-name";
    name.textContent = pos.labware_display || _shorten(pos.labware);
    slot.appendChild(name);
    slot.innerHTML += _renderSlotInterior(slotType, pos);
    if (["plate", "tiprack", "tuberack"].includes(slotType)) slot.innerHTML += '<span class="slot-well-count"></span>';
  } else {
    slot.innerHTML += `<span class="slot-icon">${slotType === "trash" ? "🗑" : "+"}</span>`;
    slot.innerHTML += `<span class="slot-empty-label">${slotType === "trash" ? "Trash" : "Empty"}</span>`;
  }

  _bindDeckArea(slot, pos.id, pos);

  return slot;
}

function _renderSlotInterior(type, pos) {
  type = _deckAreaType(type, pos.labware);
  const visual = _renderHardwareVisual(pos.visual);
  if (visual && !["plate", "tiprack", "tuberack"].includes(type)) return visual;
  if (type === "plate") {
    return _renderMiniPlate(pos, "mini-well");
  }
  if (type === "tiprack") {
    return _renderMiniPlate(pos, "mini-tip");
  }
  if (type === "reservoir") {
    return `<div class="slot-reservoir-visual">
      <div class="reservoir-trough"></div>
    </div>`;
  }
  if (type === "tuberack") {
    return _renderMiniPlate(pos, "mini-tube");
  }
  if (type === "trash") {
    return `<div class="slot-trash-visual">🗑</div>`;
  }
  // module or unknown
  return `<div class="slot-icon">⬡</div>`;
}

function _renderHardwareVisual(visual) {
  if (!Array.isArray(visual?.parts)) return "";
  const shapes = visual.parts.slice(0, 24).map(part => {
    if (!part || !["rect", "ellipse"].includes(part.shape)) return "";
    const {x, y, width, height} = part;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0
        || width <= 0 || height <= 0 || x + width > 100 || y + height > 100) return "";
    const tone = ["body", "inset", "accent"].includes(part.tone) ? part.tone : "body";
    const attrs = `class="hardware-${tone}" vector-effect="non-scaling-stroke"`;
    if (part.shape === "ellipse") return `<ellipse ${attrs} cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}"/>`;
    const radius = Number.isFinite(part.radius) ? Math.max(0, Math.min(part.radius, width / 2, height / 2)) : 0;
    return `<rect ${attrs} x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/>`;
  }).join("");
  return shapes ? `<svg class="slot-hardware-visual" viewBox="0 0 100 100" role="img" aria-label="Hardware schematic">${shapes}</svg>` : "";
}

function _renderMiniPlate(pos, wellClass) {
  // Prefer declared geometry; older bindings can still identify a named well count.
  const namedCount = String(pos.labware || "").match(/(?:^|[_ -])(\d+)[_ -]?(?:well|tip|tube)/i);
  const count = Number(pos.well_count || pos.format || namedCount?.[1]);
  if (!Number.isInteger(count) || count <= 0 || count > 4096) return _renderHardwareVisual(pos.visual) || '<span class="slot-well-count">Well layout unspecified</span>';
  const declared = Number.isInteger(pos.well_rows) && pos.well_rows > 0
    && Number.isInteger(pos.well_columns) && pos.well_columns > 0 && pos.well_rows * pos.well_columns === count;
  if (!declared) return _renderHardwareVisual(pos.visual) || `<span class="slot-well-count">${count} wells · Well layout unspecified</span>`;
  const rows = pos.well_rows;
  const cols = pos.well_columns;

  let html = `<svg class="slot-mini-grid" viewBox="0 0 ${cols} ${rows}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="${count} wells">`;
  const rowLabels = Array.from({ length: rows }, (_, index) => {
    let label = "", number = index + 1;
    while (number > 0) { number--; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
    return label;
  });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (count > 0 && r * cols + c >= count) continue;
      const wellId = `${rowLabels[r]}${c + 1}`;
      html += `<circle class="${wellClass} deck-well" data-well="${wellId}" cx="${c + 0.5}" cy="${r + 0.5}" r="0.36" vector-effect="non-scaling-stroke"></circle>`;
    }
  }
  html += `</svg>`;
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
      (inst.tipracks?.length ? `<span class="inst-tips">Tip rack positions: ${inst.tipracks.join(", ")}</span>` : "");

    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-label", `Change ${inst.name}${inst.mount ? ` on ${inst.mount}` : ""}`);
    chip.addEventListener("keydown", event => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); _showInstrumentSelector(inst); }
    });

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
  if (window.workspace?.readOnly) return;
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

function _instrumentMounts(catalog, instrument) {
  return [...new Set([
    ...(Array.isArray(catalog.mounts) ? catalog.mounts : []),
    ...(_currentState?.mounts || []),
    ...(_currentState?.instruments || []).map(item => item.mount),
    instrument.mount,
  ].filter(value => typeof value === "string" && value.trim()))];
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

  // Mount identifiers come from the device/catalog, never a built-in robot layout.
  const mounts = _instrumentMounts(catalog, inst);
  const mountLabel = document.createElement("label");
  mountLabel.className = "instrument-mount-selector";
  mountLabel.textContent = "Mount";
  const mountInput = document.createElement(mounts.length ? "select" : "input");
  mountInput.name = "inst_mount";
  mountInput.setAttribute("aria-label", "Instrument mount");
  if (mounts.length) {
    for (const mount of mounts) {
      const option = document.createElement("option");
      option.value = option.textContent = mount;
      mountInput.appendChild(option);
    }
  } else {
    mountInput.type = "text";
    mountInput.placeholder = "Mount identifier, if required";
  }
  mountInput.value = inst.mount || mounts[0] || "";
  mountLabel.appendChild(mountInput);
  content.appendChild(mountLabel);

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
        const selectedMount = content.querySelector("[name='inst_mount']")?.value.trim() || inst.mount;
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
      const selectedMount = content.querySelector("[name='inst_mount']")?.value.trim() || inst.mount;
      modal.remove();
      _applyInstrumentChange(inst, val, selectedMount);
    }
  });

  setTimeout(() => search.focus(), 100);
}

function _applyInstrumentChange(oldInst, newModel, newMount) {
  if (window.workspace?.readOnly) return;
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

    // An unspecified mount is not a shared physical location.
    _currentState.instruments = _currentState.instruments.filter(i =>
      i !== oldInst && (targetMount == null || i.mount !== targetMount));

    // Add the new instrument
    _currentState.instruments.push({
      name: oldInst.name || newModel.replace(/_/g, " "),
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
    _currentState.instruments = _currentState.instruments.filter(i => i !== oldInst);
  }

  _selectedSlot = null;
  _renderDeck(_currentState);
  _renderApplyBar();
}

function _hideDeckTooltip() {
  document.getElementById("deck-area-tooltip")?.remove();
}

function _fixedDeckArea(pos) {
  return pos.fixed || pos.module || ["trash", "module"].includes(_deckAreaType(pos.type, pos.labware))
    || /^fixed(?:[\s_-]|$)/i.test(pos.type || "");
}

function _movableDeckArea(pos) {
  return !!pos.labware && !_fixedDeckArea(pos);
}

function _bindDeckArea(area, id, pos) {
  if (window.workspace?.readOnly) return;
  const empty = !pos.labware && !_fixedDeckArea(pos);
  const movable = _movableDeckArea(pos);
  if (movable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "deck-slot-remove";
    remove.title = "Remove item";
    remove.setAttribute("aria-label", `Remove ${pos.labware_display || pos.labware} from position ${id}`);
    remove.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14H5V6m4 0V3h6v3"/></svg>';
    remove.addEventListener("click", event => {
      event.stopPropagation(); _stopDeckAnimation(); _applyChange(id, null, pos.labware);
    });
    area.appendChild(remove);
  }
  area.tabIndex = 0;
  if (empty || movable) {
    area.setAttribute("role", empty ? "button" : "group");
    area.setAttribute("aria-label", `${empty ? "Add hardware" : pos.labware_display || pos.labware} at position ${id}`);
  }
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
  let dragFromContents = false;
  area.addEventListener("pointerdown", event => {
    dragFromContents = !!event.target.closest(".slot-mini-grid, .deck-plate-grid-wrapper, button");
    if (dragFromContents && !event.target.closest("button")) event.preventDefault();
  });
  area.addEventListener("dragstart", event => {
    if (!movable || dragFromContents) { event.preventDefault(); return; }
    _hideDeckTooltip();
    _draggedDeckArea = String(id);
    event.dataTransfer.setData("text/plain", String(id));
    event.dataTransfer.effectAllowed = "move";
    // The browser's own snapshot is clipped by the scaled deck: drag an unclipped copy at the on-screen size.
    if (!area.getBoundingClientRect || !area.cloneNode || !event.dataTransfer.setDragImage) return;
    const box = area.getBoundingClientRect();
    const ghost = area.cloneNode(true);
    Object.assign(ghost.style, {position:"fixed", top:"-10000px", left:"0", width:`${box.width}px`, height:`${box.height}px`,
      margin:"0", transform:"none", pointerEvents:"none"});
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, event.clientX - box.left, event.clientY - box.top);
    setTimeout(() => ghost.remove(), 0);
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
  if (window.workspace?.readOnly) return;
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
  for (const key of ["labware", "labware_display", "variable", "type", "role", "well_count", "well_rows", "well_columns", "aspect_ratio", "visual"]) {
    target[key] = source[key];
    delete source[key];
  }
  source.type = "empty";
  for (const well of _currentState.initial_wells || []) {
    if (String(well.slot) === from) well.slot = to;
  }
  for (const step of _currentState.steps || []) {
    for (const role of ["source", "destination"]) {
      if (String(step[role]?.slot) === from) step[role].slot = to;
    }
    for (const item of [...(step.well_updates || []), ...(step.volume_changes || [])]) {
      if (String(item.slot) === from) item.slot = to;
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
  if (window.workspace?.readOnly) return;
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
      itemDiv.addEventListener("click", () => { _closeDeckSelector(modal); _applyChange(slotId, item.id, currentLabware, item); });
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

function _applyChange(slotId, newLabware, oldLabware, hardware = {}) {
  if (window.workspace?.readOnly) return;
  if (!_currentState) return;

  for (const role of _plateSlotRoles.get(String(slotId)) || []) {
    const plate = _currentState.plates?.[role];
    if (!plate) continue;
    if (!newLabware) delete _currentState.plates[role];
    else Object.assign(plate, {type:newLabware, format:hardware.well_count || null,
      well_rows:hardware.well_rows || null, well_columns:hardware.well_columns || null});
  }

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
  function geometry(pos) {
    delete pos.visual;
    if (hardware.visual && typeof hardware.visual === "object") pos.visual = hardware.visual;
    for (const key of ["well_count", "well_rows", "well_columns", "aspect_ratio"]) {
      delete pos[key];
      if (Number.isFinite(hardware[key]) && hardware[key] > 0) pos[key] = hardware[key];
    }
    const type = _deckAreaType(hardware.type, hardware.name || newLabware);
    pos.type = ["plate", "tiprack", "tuberack", "reservoir", "module", "trash"].includes(type)
      ? type : _guessType(hardware.name || newLabware);
  }
  for (const pos of positions) {
    if (pos.id === slotId) {
      if (newLabware) {
        pos.labware = newLabware;
        pos.labware_display = hardware.name || _shorten(newLabware);
        geometry(pos);
      } else {
        pos.labware = null;
        pos.labware_display = null;
        pos.variable = null;
        pos.type = "empty";
        for (const key of ["well_count", "well_rows", "well_columns", "aspect_ratio", "visual"]) delete pos[key];
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
          geometry(cpos);
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

function _parameterNumberSpec(parameter) {
  if (parameter.type === "text") return null;
  if (parameter.type === "number") return parameter;
  const original = _originalState?.parameters?.find(item => item.id === parameter.id) || parameter;
  const quantity = String(original.value).match(/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?\s*([a-zµμ%][a-zµμ%/0-9^ .-]*)?$/i);
  if (!quantity) return null;
  const unit = (quantity[1] || "").trim();
  return {unit, units: {[unit]: 1}};
}

function _validateProtocolParameters(state, fields) {
  const values = new Map(), inputs = new Map();
  let error = "";
  for (const input of fields.querySelectorAll("input")) {
    const parameter = state.parameters.find(item => item.id === input.dataset.parameterId);
    if (!parameter) continue;
    inputs.set(parameter.id, input);
    let message = input.value.trim() ? "" : "Enter a value.";
    const spec = _parameterNumberSpec(parameter);
    if (spec && !message) {
      const value = parseQuestionQuantity(input.value, spec);
      if (!Number.isFinite(value)) message = `Enter a number${spec.unit ? ` with a compatible unit (${Object.keys(spec.units || {}).join(", ")})` : " without units"}.`;
      else if (spec.integer && !Number.isInteger(value)) message = "Enter a whole number.";
      else values.set(parameter.id, value);
    }
    input.setCustomValidity?.(message);
    input.setAttribute("aria-invalid", String(!!message));
    if (message && !error) error = `${parameter.label}: ${message}`;
  }
  const compare = {lt:(a,b)=>a<b, lte:(a,b)=>a<=b, gt:(a,b)=>a>b, gte:(a,b)=>a>=b, eq:(a,b)=>a===b};
  for (const constraint of state.parameter_constraints || []) {
    const left = values.get(constraint.left);
    const right = typeof constraint.right === "number" ? constraint.right : values.get(constraint.right);
    if (left === undefined || right === undefined || !compare[constraint.operator]) continue;
    if (!compare[constraint.operator](left, right)) {
      const message = constraint.message || "These parameter values conflict.";
      inputs.get(constraint.left)?.setCustomValidity?.(message);
      inputs.get(constraint.left)?.setAttribute("aria-invalid", "true");
      if (!error) error = message;
    }
  }
  const notice = document.getElementById("protocol-parameters-error");
  if (notice) notice.textContent = error;
  return !error;
}

function _renderProtocolParameters(state) {
  const panel = document.getElementById("protocol-parameters");
  const fields = document.getElementById("protocol-parameter-fields");
  if (!panel || !fields) return;
  const parameters = !_libraryEditing && _currentCode ? state.parameters || [] : [];
  const instruments = !_libraryEditing ? (state.instruments || []).filter(item => item.model) : [];
  panel.hidden = parameters.length === 0 && instruments.length === 0 && !state._parameters_pending;
  fields.replaceChildren();
  if (state._parameters_pending && parameters.length === 0 && instruments.length === 0) fields.textContent = "Loading protocol parameters…";
  for (const instrument of instruments) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    const name = instrument.name || "Instrument";
    text.textContent = `${name.charAt(0).toUpperCase() + name.slice(1)} type${instrument.mount ? ` (${instrument.mount})` : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-button protocol-instrument-parameter";
    button.textContent = instrument.model.replace(/_/g, " ");
    button.setAttribute("aria-label", `Change ${text.textContent}`);
    button.setAttribute("aria-haspopup", "dialog");
    button.disabled = _applyingChanges || !!window.workspace?.readOnly;
    button.addEventListener("click", () => _showInstrumentSelector(instrument));
    label.append(text, button);
    fields.appendChild(label);
  }
  for (const parameter of parameters) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = parameter.label;
    const input = document.createElement("input");
    input.type = "text";
    input.value = parameter.value;
    input.required = true;
    input.maxLength = 1000;
    input.disabled = _applyingChanges;
    input.readOnly = !!window.workspace?.readOnly;
    input.dataset.parameterId = parameter.id;
    function updateParameter() {
      const value = input.value.trim();
      _validateProtocolParameters(state, fields);
      const original = _originalState?.parameters?.find(item => item.id === parameter.id) || parameter;
      _pendingChanges = _pendingChanges.filter(change => change.type !== "set_parameter" || change.parameter_id !== parameter.id);
      if (value !== original.value) _pendingChanges.push({type: "set_parameter", parameter_id: parameter.id,
        label: parameter.label, old_value: original.value, new_value: value});
      parameter.value = value;
      _renderApplyBar();
    }
    input.addEventListener("input", updateParameter);
    input.addEventListener("change", () => { input.value = input.value.trim(); updateParameter(); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); _commitChanges(); }
    });
    label.append(text, input);
    fields.appendChild(label);
  }
  if (parameters.length) _validateProtocolParameters(state, fields);
}

function _renderApplyBar() {
  window.workspace?.syncActions();
  const discard = document.getElementById("deck-discard-btn");
  const apply = document.getElementById("deck-apply-btn");
  const disabled = !!window.workspace?.readOnly || _libraryEditing || _applyingChanges || _pendingChanges.length === 0;
  if (discard) discard.disabled = disabled;
  _trackEditHistory();
  if (apply) {
    apply.disabled = disabled || !!document.getElementById("protocol-parameter-fields")?.querySelector("input:invalid");
    apply.textContent = _applyingChanges ? "Applying…" : "Apply";
  }
}

// Undo/redo of unapplied edits (deck and parameters). Each entry is a snapshot of the pending changes and the
// deck state; quick successive changes (typing) form one step. Loading another deck or protocol starts afresh.
let _editUndo = [], _editRedo = [], _editLast = null, _editDeck = null, _editTime = 0, _editRestoring = false;
function _editSnapshot() {
  return {pending: JSON.stringify(_pendingChanges), state: JSON.stringify(_currentState)};
}
function _trackEditHistory() {
  const deck = `${_currentCode}\u0000${_currentState?.platform}`;
  if (deck !== _editDeck || !_currentState) {
    _editUndo = []; _editRedo = []; _editDeck = deck; _editLast = _currentState ? _editSnapshot() : null;
  } else if (!_editRestoring) {
    const now = _editSnapshot();
    if (now.pending !== _editLast?.pending) {
      if (Date.now() - _editTime > 800) _editUndo.push(_editLast);
      _editRedo = []; _editTime = Date.now();
    }
    _editLast = now;
  }
  const bar = document.getElementById("deck-history");
  if (bar) bar.hidden = !_currentState || !!window.workspace?.readOnly || _libraryEditing;
  const undo = document.getElementById("deck-undo"), redo = document.getElementById("deck-redo");
  if (undo) undo.disabled = _applyingChanges || !_editUndo.length;
  if (redo) redo.disabled = _applyingChanges || !_editRedo.length;
}
function _stepEditHistory(direction) {
  const from = direction < 0 ? _editUndo : _editRedo, to = direction < 0 ? _editRedo : _editUndo;
  if (_applyingChanges || !from.length) return;
  to.push(_editSnapshot());
  const target = from.pop();
  _pendingChanges = JSON.parse(target.pending);
  _currentState = JSON.parse(target.state);
  _editLast = target;
  _editRestoring = true;
  try { _renderDeck(_currentState); _renderApplyBar(); } finally { _editRestoring = false; }
  _trackEditHistory();
}

function _discardChanges() {
  _pendingChanges = [];
  const parametersError = document.getElementById("protocol-parameters-error");
  if (parametersError) parametersError.textContent = "";
  // Restore from the saved original state — no LLM call needed
  if (_originalState) {
    _currentState = JSON.parse(JSON.stringify(_originalState));
  }
  _selectedSlot = null;
  _renderDeck(_currentState);
  _renderApplyBar();
}

function _adoptProtocol(code, state) {
  _currentCode = code;
  _currentState = state;
  _originalState = JSON.parse(JSON.stringify(state));
  _updateSourceCodeBlock(code);
  _originalCode = code;
  _pendingChanges = [];
  _selectedSlot = null;
  _renderDeck(_currentState);
  _renderApplyBar();
}

// Go back to a previous protocol, e.g. the one the last code was generated from.
async function _restoreProtocol(code) {
  if (!_currentCode || _applyingChanges) return;
  const state = _currentState;
  _applyingChanges = true;
  _setDeckBusy(true);
  _renderApplyBar();
  try {
    const response = await fetch("/deck/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({code, original: _currentCode, template_id: state?._library?.selected.id,
        chat_id: typeof currentChatId !== "undefined" ? currentChatId : null}),
    });
    const result = await response.json();
    if (!response.ok || !result.state) throw new Error(result.error || "Could not restore the protocol.");
    if (_currentState === state) _adoptProtocol(result.code, result.state);
  } catch (error) {
    _libraryNotice(error.message);
  } finally {
    _applyingChanges = false;
    _setDeckBusy(false);
    _renderApplyBar();
  }
}

// While changes are applied, the deck is greyed out and ignores input.
function _setDeckBusy(busy) {
  const deck = document.querySelector("#deck-panel .deck-workspace");
  deck?.classList.toggle("deck-busy", busy);
  deck?.setAttribute("aria-busy", String(busy));
  deck?.querySelector(".deck-busy-bubbles")?.remove();
  if (!busy || !deck) return;
  _pauseAnimation();
  const bubbles = document.createElement("div");
  bubbles.className = "deck-busy-bubbles";
  bubbles.setAttribute("role", "status");
  bubbles.setAttribute("aria-label", "Applying changes");
  bubbles.innerHTML = "<span></span><span></span><span></span>";
  deck.appendChild(bubbles);
}

async function _commitChanges() {
  if (window.workspace?.readOnly) return;
  if (_libraryEditing || _applyingChanges || _pendingChanges.length === 0) return;
  const invalidParameter = document.getElementById("protocol-parameter-fields")?.querySelector("input:invalid");
  if (invalidParameter) { invalidParameter.reportValidity(); return; }
  if (!_currentCode) {
    window.workspace?.confirmLayout();
    return;
  }
  const state = _currentState;
  _applyingChanges = true;
  _setDeckBusy(true);
  _renderProtocolParameters(state);
  window.workspace?.syncActions();
  _renderApplyBar();
  let updateError = null;
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
    _adoptProtocol(result.code, result.state);
  } catch (error) {
    updateError = error.message;
    if (_currentState === state) {
      _libraryNotice(error.message);
      const parametersError = document.getElementById("protocol-parameters-error");
      if (parametersError) parametersError.textContent = error.message;
    }
  } finally {
    _applyingChanges = false;
    _setDeckBusy(false);
    if (_currentState) _renderProtocolParameters(_currentState);
    if (updateError && _currentState === state) {
      const parametersError = document.getElementById("protocol-parameters-error");
      if (parametersError) parametersError.textContent = updateError;
    }
    window.workspace?.syncActions();
    _renderApplyBar();
  }
}

function _guessType(labware) {
  if (!labware) return "empty";
  const l = labware.toLowerCase().replace(/[\s-]+/g, "_");
  if (l.includes("module")) return "module";
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
  wrapper.style.top = "0px";
  const layout = wrapper.querySelector?.(".deck-grid, .deck-linear, .deck-plates");
  const workspace = container.parentElement;
  if (layout && workspace) {
    const box = layout.getBoundingClientRect(), bounds = workspace.getBoundingClientRect();
    workspace.style.setProperty("--deck-center-y", `${box.top - bounds.top + box.height / 2}px`);
  }
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
  const description = _currentCode ? _currentState?.title || "" : "";
  if (!view || !panel || (view._displayedCode === _currentCode && view._description === description)) return;
  view.replaceChildren();
  view._displayedCode = _currentCode;
  view._description = description;
  if (description) {
    const summary = document.createElement("p");
    summary.className = "deck-code-description";
    summary.textContent = description;
    view.appendChild(summary);
  }
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
  window.floatingChat?.attach();
  if (btn) {
    btn.classList.add("active");
    btn.disabled = false;
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Hide deck");
  }
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
  if (btn) {
    btn.classList.remove("active");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Show deck");
  }
}
function toggleDeckPanel() {
  const panel = document.getElementById("deck-panel");
  if (panel) panel.classList.contains("hidden") ? _openDeckPanel() : closeDeckPanel();
}
function toggleProtocolDeck(code, sourceLink) {
  if (_currentCode === code && _sourceCodeBlock === sourceLink) toggleDeckPanel();
  else parseDeckFromCode(code, sourceLink);
}
function clearDeckPanel({keepOpen = false} = {}) {
  _closeWellDetails();
  document.getElementById("deck-library-panel")?.replaceChildren();
  _parameterAbort?.abort(); _parameterAbort = null;
  if (_deckAbort) { _deckAbort.abort(); _deckAbort = null; }
  closeDeckPanel();
  const deckContainer = document.getElementById("deck-svg-container");
  if (deckContainer) deckContainer.inert = false;
  _currentCode = null; _originalCode = null; _currentState = null; _originalState = null;
  const deckToggle = document.getElementById("deck-toggle-btn");
  if (deckToggle) deckToggle.disabled = true;
  _selectedSlot = null; _pendingChanges = []; _sourceCodeBlock = null;
  _libraryEditing = false; _libraryBeforeEdit = null;
  const parameters = document.getElementById("protocol-parameters");
  if (parameters) parameters.hidden = true;
  const parametersError = document.getElementById("protocol-parameters-error");
  if (parametersError) parametersError.textContent = "";
  // Animation cleanup
  _animSteps = []; _animStepIndex = -1; _animPlaying = false; _animBusy = false;
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  const playbar = document.getElementById("anim-playback-bar");
  if (playbar) playbar.remove();
  _removeTipOverlay();
  // Clear any code block highlights in the chat
  _clearCodeBlockHighlights();
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<p class="deck-empty-message">Your deck will take shape as you prepare the protocol.</p>';
  _renderApplyBar();
  const view = document.getElementById("deck-code-view");
  if (view) { view.replaceChildren(); view._displayedCode = undefined; }
  if (keepOpen) _openDeckPanel();
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

function _showLoading(keepDeck = false) {
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  if (keepDeck) {
    container.querySelector(".deck-loading-inline")?.remove();
    const notice = document.createElement("div");
    notice.className = "deck-loading-inline"; notice.textContent = "Updating deck…";
    container.appendChild(notice);
    return;
  }
  container.innerHTML = '<div class="deck-loading"><div class="deck-loading-spinner"></div><span>Loading deck...</span><span class="deck-loading-sub">Saved device layouts are reused automatically</span></div>';
}
function _showError(msg, retry) {
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  const message = document.createElement("p");
  message.className = "deck-empty-message";
  message.textContent = msg;
  container.replaceChildren(message);
  if (retry) container.appendChild(_libraryButton("Retry loading deck", retry));
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
  document.getElementById("anim-playback-bar")?.remove();
  _animSteps = state.steps || [];
  _animStepIndex = -1;
  _animPlaying = false;
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
  _animBusy = false;
  if (_animSteps.length > 0 || state._playback_pending) _renderPlaybackControls(state._playback_pending && !_animSteps.length);
}

function _renderPlaybackControls(pending = false) {
  let bar = document.getElementById("anim-playback-bar");
  if (bar) bar.remove();

  const panel = document.getElementById("deck-panel");
  const frame = panel?.querySelector(".deck-device-frame");
  if (!frame) return;

  bar = document.createElement("div");
  bar.id = "anim-playback-bar";
  bar.className = "anim-playback-bar";

  // Step description
  const desc = document.createElement("div");
  desc.id = "anim-step-desc";
  desc.className = "anim-step-desc";
  desc.textContent = pending ? "Updating saved playback…" : "Press play to animate protocol steps";
  desc.setAttribute("role", "status");
  bar.appendChild(desc);

  // Controls row
  const controls = document.createElement("div");
  controls.className = "anim-controls-row";

  // Transport buttons
  const transport = document.createElement("div");
  transport.className = "anim-transport";

  const btnFirst = _makeAnimBtn("⏮", "Restart preview", () => { _pauseAnimation(); _animGoTo(-1); });
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
  scrubber.setAttribute("aria-label", "Protocol playback position");
  scrubber.addEventListener("input", (e) => { _pauseAnimation(); _animGoTo(parseInt(e.target.value)); });
  controls.appendChild(scrubber);

  // Counter
  const counter = document.createElement("span");
  counter.id = "anim-counter";
  counter.className = "anim-counter";
  counter.textContent = `— / ${_animSteps.length}`;
  controls.appendChild(counter);

  // Cycle through playback rates with one button.
  const speed = document.createElement("button");
  speed.type = "button";
  speed.id = "anim-speed";
  speed.className = "anim-speed-button";
  const rates = [0.5, 1, 2, 4];
  let rateIndex = Math.max(0, rates.indexOf(1500 / _animSpeed));
  function speedLabel() {
    speed.textContent = `${rates[rateIndex]}×`;
    speed.setAttribute("aria-label", `Playback speed ${rates[rateIndex]}×; next ${rates[(rateIndex + 1) % rates.length]}×`);
  }
  speedLabel();
  speed.addEventListener("click", () => {
    rateIndex = (rateIndex + 1) % rates.length;
    _animSpeed = 1500 / rates[rateIndex];
    speedLabel();
    if (_animPlaying) {
      clearInterval(_animTimer);
      _animTimer = setInterval(_animAutoStep, _animSpeed);
    }
  });
  controls.appendChild(speed);
  if (pending) {
    for (const control of [...transport.children, scrubber, speed]) control.disabled = true;
  }
  bar.appendChild(controls);

  frame.appendChild(bar);
}

function _makeAnimBtn(icon, title, onClick) {
  const btn = document.createElement("button");
  btn.className = "anim-btn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = `<span>${icon}</span>`;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---- Step visuals ----

// Rebuild from the beginning so seeking and replay never leave stale well colors.
// Explicit protocol updates handle emptying; unknown source volumes stay unknown.
function _protocolWellState(state, stepIndex) {
  const slots = new Map();
  const get = slot => {const id=String(slot); if (!slots.has(id)) slots.set(id,new Map()); return slots.get(id);};
  const steps = state.steps || [];
  for (const step of steps) {
    for (const [role, endpoint] of [["source",step.source],["destination",step.destination]]) {
      if (endpoint?.slot == null) continue;
      const wells=get(endpoint.slot);
      for (const well of endpoint.wells || []) if (!wells.has(well)) wells.set(well,{occupied:role==="source",role});
    }
  }
  for (const item of state.initial_wells || []) {
    if (item.slot == null || typeof item.well !== "string") continue;
    get(item.slot).set(item.well,{...item,occupied:item.occupied ?? item.volume_ul>0,role:item.role || "source"});
  }
  let channels = null;
  for (const step of steps.slice(0,Math.max(0,stepIndex+1))) {
    const action=String(step.action || "transfer").toLowerCase().replace(/[\s-]+/g,"_");
    if (action === "pickup_tip" && step.source?.wells?.length) channels = step.source.wells.length;
    if (action === "drop_tip") channels = null;
    const changes = new Map();
    for (const item of step.volume_changes || []) {
      if (item.slot != null && typeof item.well === "string" && Number.isFinite(item.delta_ul)) {
        changes.set(JSON.stringify([String(item.slot), item.well]), item.delta_ul);
      }
    }
    // Older saved playback stores per-channel quantities as unit-bearing labels.
    const volume = Number.isFinite(step.volume_ul) ? step.volume_ul
      : typeof step.volume === "string" && /[a-zµμ]+\s*$/i.test(step.volume)
        ? parseQuestionQuantity(step.volume, {unit:"µL", units:{nL:0.001, mL:1000, L:1000000}}) : NaN;
    if (Number.isFinite(volume) && volume >= 0) {
      const count = channels || Math.max(step.source?.wells?.length || 0, step.destination?.wells?.length || 0);
      for (const [role, actions, sign] of [["source", ["aspirate", "transfer"], -1], ["destination", ["dispense", "transfer"], 1]]) {
        const endpoint = step[role], wells = endpoint?.wells || [];
        if (!actions.includes(action) || endpoint?.slot == null || !wells.length || count % wells.length !== 0) continue;
        for (const well of wells) {
          const key = JSON.stringify([String(endpoint.slot), well]);
          if (!changes.has(key)) changes.set(key, sign * volume * count / wells.length);
        }
      }
    }
    // Carry known totals through resolved liquid movements; never invent unknown starting volumes.
    for (const [role, actions] of [["source", ["aspirate", "transfer"]], ["destination", ["dispense", "transfer"]]]) {
      const endpoint = step[role];
      if (!actions.includes(action) || endpoint?.slot == null) continue;
      for (const well of endpoint.wells || []) {
        const value = get(endpoint.slot).get(well);
        if (value) {
          const before = Number.isFinite(value.volume_ul) ? value.volume_ul : value.occupied === false ? 0 : NaN;
          const delta = changes.get(JSON.stringify([String(endpoint.slot), well]));
          delete value.volume_ul; delete value.liquids;
          const after = before + delta;
          if (Number.isFinite(after) && after >= -1e-9) {
            value.volume_ul = Math.max(0, after);
            value.occupied = value.volume_ul > 0;
          }
        }
      }
    }
    if (action === "pickup_tip" && step.source?.slot != null) {
      for (const well of step.source.wells || []) get(step.source.slot).set(well,{occupied:false,role:"tip"});
    }
    if (["transfer","dispense"].includes(action) && step.destination?.slot != null) {
      for (const well of step.destination.wells || []) {
        const wells = get(step.destination.slot), previous = wells.get(well) || {};
        wells.set(well,{...previous,occupied:Number.isFinite(previous.volume_ul) ? previous.volume_ul > 0 : true,role:"destination"});
      }
    }
    for (const item of step.well_updates || []) {
      if (item.slot == null || typeof item.well !== "string") continue;
      const wells=get(item.slot), previous=wells.get(item.well) || {};
      wells.set(item.well,{...previous,...item,occupied:item.occupied ?? (Number.isFinite(item.volume_ul)?item.volume_ul>0:previous.occupied)});
    }
  }
  return slots;
}

function _paintProtocolWells(state, stepIndex) {
  const container=document.getElementById("deck-svg-container");
  if (!container) return;
  const contents=_protocolWellState(state,stepIndex);
  container.querySelectorAll(".deck-slot[data-id]").forEach(slot=>{
    const wells=slot.querySelectorAll(".deck-well"), values=contents.get(String(slot.dataset.id));
    let occupied=0;
    const tips=slot.classList.contains("tiprack");
    wells.forEach(well=>{
      const value=values?.get(well.dataset.well), present=value?.occupied ?? tips;
      well.classList.toggle("well-occupied",present);
      well.classList.toggle("well-source",present&&!tips&&value?.role!=="destination");
      well.classList.toggle("well-dest",present&&!tips&&value?.role==="destination");
      well.setAttribute("aria-label",`${well.dataset.well}: ${tips?(present?"tip present":"tip removed"):(present?"liquid present":"empty")}${Number.isFinite(value?.volume_ul)?` · ${_formatWellVolume(value.volume_ul)}`:""}`);
      well.setAttribute("role", "button");
      well.setAttribute("tabindex", "0");
      const selected = _selectedWell?.slot === String(slot.dataset.id) && _selectedWell?.well === well.dataset.well;
      well.setAttribute("aria-pressed", String(selected));
      well.classList.toggle("well-selected", selected);
      if (!well._detailsBound) {
        const inspect = event => {
          if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          _selectedWell = {slot:String(slot.dataset.id), well:well.dataset.well};
          _paintProtocolWells(_currentState || state, _animStepIndex);
        };
        well.addEventListener("click", inspect);
        well.addEventListener("keydown", inspect);
        well.addEventListener("dblclick", event => event.stopPropagation());
        well._detailsBound = true;
      }
      if (present) occupied++;
    });
    const count=slot.querySelector(".slot-well-count");
    if (count && wells.length) {
      count.textContent=`${occupied} / ${wells.length} ${tips?"tips present":"with liquid"}`;
      slot.setAttribute("aria-description",count.textContent);
    }
  });
  if (_selectedWell) _renderWellDetails(state, contents);
}

function _closeWellDetails() {
  _selectedWell = null;
  const panel = document.getElementById("well-details");
  if (panel) { panel.hidden = true; panel.replaceChildren(); }
  document.getElementById("deck-svg-container")?.querySelectorAll(".well-selected").forEach(well => {
    well.classList.remove("well-selected"); well.setAttribute("aria-pressed", "false");
  });
}

function _renderWellDetails(state, contents) {
  const panel = document.getElementById("well-details");
  if (!panel || !_selectedWell) return;
  const {slot, well} = _selectedWell;
  const positions = [...(state.positions || [])];
  for (const carrier of state.carriers?.items || []) {
    for (const pos of carrier.positions || []) positions.push({...pos, id:`${carrier.type}_${pos.index}`});
  }
  const pos = positions.find(pos => String(pos.id) === slot);
  const value = contents.get(slot)?.get(well);
  const tips = _deckAreaType(pos?.type, pos?.labware) === "tiprack";
  const present = value?.occupied ?? tips;
  panel.replaceChildren(); panel.hidden = false;
  const header = document.createElement("div"); header.className = "well-details-header";
  if (!panel._dragBound) { _bindWellCardDrag(panel, panel); panel._dragBound = true; }
  const title = document.createElement("h3"); title.textContent = `Well ${well}`;
  const close = document.createElement("button"); close.type = "button"; close.textContent = "×";
  close.setAttribute("aria-label", "Close well contents"); close.addEventListener("click", _closeWellDetails);
  header.append(title, close); panel.appendChild(header);
  function line(text) { const p = document.createElement("p"); p.textContent = text; panel.appendChild(p); }
  line(`${pos?.labware_display || pos?.labware || "Plate"} · Position ${slot}`);
  const coordinates = /^([A-Za-z]+)(\d+)$/.exec(well);
  if (coordinates) line(`Row ${coordinates[1].toUpperCase()} · Column ${coordinates[2]}`);
  const drawing = document.createElement("div"); drawing.className = "well-detail-drawing";
  drawing.innerHTML = _wellDetailDrawing(value, tips, present); panel.appendChild(drawing);
  if (present && !tips) {
    const legend = document.createElement("div"); legend.className = "well-liquid-legend";
    for (const [index, liquid] of _wellLiquidParts(value).entries()) {
      const row = document.createElement("div"); row.className = "well-liquid-label";
      const swatch = document.createElement("span"); swatch.className = "well-liquid-swatch";
      swatch.style.background = WELL_LIQUID_COLORS[index % WELL_LIQUID_COLORS.length];
      const label = document.createElement("span"); label.textContent = `${liquid.name}: ${_formatWellVolume(liquid.volume_ul)}`;
      row.append(swatch, label); legend.appendChild(row);
    }
    drawing.appendChild(legend);
  }
  if (tips) { line(present ? "Tip present" : "No tip"); return; }
  if (present) line("Liquid composition · schematic");
  line(present ? "Liquid present" : "Empty");
  if (Number.isFinite(value?.volume_ul)) line(`Total volume: ${_formatWellVolume(value.volume_ul)}`);
  else if (present) line("Total volume unknown");
  if (present && !value?.liquids?.length) line("Liquid composition not specified in the protocol.");
}

function _formatWellVolume(volume) {
  return Number.isFinite(volume) ? `${Number(volume.toPrecision(4)).toLocaleString("en", {maximumSignificantDigits:4, useGrouping:false})} µL` : "volume unknown";
}

function _wellLiquidParts(value) {
  const liquids = Array.isArray(value?.liquids) ? value.liquids.filter(item => typeof item?.name === "string") : [];
  return liquids.length ? liquids : [{name:"Liquid", volume_ul:value?.volume_ul}];
}

function _wellDetailDrawing(value, tips, present) {
  const outline = 'fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"';
  if (tips) return `<svg viewBox="0 0 180 130" role="img" aria-label="${present ? "Tip present" : "Empty tip position"}">${present
    ? `<path d="M65 10h50l-9 55-12 52h-8L74 65Z" fill="#d6b578" stroke="currentColor" stroke-width="2"/><path d="M65 22h50" ${outline}/>`
    : `<ellipse cx="90" cy="65" rx="30" ry="18" ${outline}/>`}</svg>`;
  const liquids = _wellLiquidParts(value);
  const known = liquids.length > 0 && liquids.every(item => Number.isFinite(item.volume_ul) && item.volume_ul >= 0);
  const total = known ? liquids.reduce((sum, item) => sum + item.volume_ul, 0) : 0;
  let bands = "", bottom = 114;
  if (present) {
    for (const [index, liquid] of (liquids.length ? liquids : [{}]).entries()) {
      const height = known && total > 0 ? 100 * liquid.volume_ul / total : 100 / liquids.length;
      bottom -= height;
      bands += `<rect x="50" y="${bottom}" width="80" height="${height}" fill="${WELL_LIQUID_COLORS[index % WELL_LIQUID_COLORS.length]}"/>`;
    }
  }
  return `<svg viewBox="36 4 108 124" role="img" aria-label="${present ? "Well liquid composition, schematic bands" : "Empty well"}"><defs><clipPath id="well-detail-interior"><path d="M50 14h80v88q0 12-12 12H62q-12 0-12-12Z"/></clipPath></defs><g clip-path="url(#well-detail-interior)">${bands}</g><path d="M50 14v88q0 12 12 12h56q12 0 12-12V14M44 14h12m68 0h12" ${outline}/></svg>`;
}

function _bindWellCardDrag(handle, panel) {
  let drag = null;
  handle.tabIndex = 0;
  handle.setAttribute("aria-label", "Move well information · Arrow keys to reposition");
  function place(x, y) {
    const bounds = panel.parentElement.getBoundingClientRect(), size = panel.getBoundingClientRect();
    Object.assign(panel.style, {left:`${Math.max(8, Math.min(x, bounds.width - size.width - 8))}px`,
      top:`${Math.max(8, Math.min(y, bounds.height - size.height - 8))}px`, right:"auto", transform:"none"});
  }
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    _pauseAnimation();
    const box = panel.getBoundingClientRect(), bounds = panel.parentElement.getBoundingClientRect();
    drag = {x:event.clientX, y:event.clientY, left:box.left - bounds.left, top:box.top - bounds.top};
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (drag) place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  });
  for (const name of ["pointerup", "pointercancel"]) handle.addEventListener(name, () => {drag = null;});
  handle.addEventListener("keydown", event => {
    if (event.target !== handle) return;
    const move = {ArrowLeft:[-16,0], ArrowRight:[16,0], ArrowUp:[0,-16], ArrowDown:[0,16]}[event.key];
    if (!move) return;
    event.preventDefault();
    const box = panel.getBoundingClientRect(), bounds = panel.parentElement.getBoundingClientRect();
    place(box.left - bounds.left + move[0], box.top - bounds.top + move[1]);
  });
}

function _applyStepVisuals(stepIndex, animate) {
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  _paintProtocolWells(_currentState || {steps:_animSteps},stepIndex);

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
  const slot = container.querySelector(`.deck-slot[data-id="${slotId}"]`);
  if (!slot) return;
  slot.classList.add("slot-anim-highlight");
  slot.style.setProperty("--anim-color", colors.fill);
  slot.style.setProperty("--anim-glow", colors.glow);

  // Well identifiers repeat across hardware: never search outside this slot.
  for (const wellId of wells || []) {
    const well = slot.querySelector(`.deck-well[data-well="${wellId}"]`);
    if (well) {
      well.classList.add("well-anim-active");
      well.style.setProperty("--anim-color", colors.fill);
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

// Facing plates mean contactless transfer (e.g. acoustic): a droplet rises from the source well to the
// destination well instead of a pipette moving.
function _showDropletAnimation(step, colors, container) {
  if (!step.source?.slot || !step.destination?.slot) return;
  const slot = id => [...container.querySelectorAll(".deck-slot[data-id]")].find(s => s.dataset.id === String(id));
  const point = (id, wells) => {
    const area = slot(id);
    return area?.querySelector(`.deck-well[data-well="${wells?.[0]}"]`) || area;
  };
  const from = point(step.source.slot, step.source.wells), to = point(step.destination.slot, step.destination.wells);
  if (!from || !to) return;
  const box = container.getBoundingClientRect(), a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const drop = document.createElement("div");
  drop.className = "anim-tip-overlay anim-droplet";
  drop.innerHTML = `<span class="droplet" style="background:${colors.fill}"></span>${step.volume ? `<span class="tip-vol-label">${step.volume}</span>` : ""}`;
  Object.assign(drop.style, {position:"absolute", zIndex:"50", pointerEvents:"none",
    left:`${a.left - box.left + container.scrollLeft + a.width / 2}px`, top:`${a.top - box.top + container.scrollTop + a.height / 2}px`});
  container.style.position = "relative";
  container.appendChild(drop);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  requestAnimationFrame(() => { drop.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`; });
}

function _showTipAnimation(step, colors) {
  _removeTipOverlay();

  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  if (_currentState?.arrangement === "facing") { _showDropletAnimation(step, colors, container); return; }

  const actionKey = (step.action || "").toLowerCase().replace(/[\s-]+/g, "_");
  // A tip drop without a declared trash goes to the deck's own trash position.
  const trash = actionKey === "drop_tip" && (_currentState?.positions || []).find(pos => _deckAreaType(pos.type, pos.labware) === "trash");
  const targetSlotId = String(step.source?.slot || step.destination?.slot || trash?.id || "");
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
      ${step.volume ? `<div class="tip-vol-label">${step.volume}</div>` : ""}
    </div>
    <div class="tip-nozzle" style="background:${colors.fill}"></div>
  `;

  // Bug 1 fix: account for scroll offset
  overlay.style.position = "absolute";
  overlay.style.left = (slotRect.left - containerRect.left + container.scrollLeft + slotRect.width / 2 - 36) + "px";
  overlay.style.top  = (slotRect.top  - containerRect.top  + container.scrollTop  - 62) + "px";
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
  idx = Math.max(-1, Math.min(idx, _animSteps.length - 1));
  _animStepIndex = idx;
  _applyStepVisuals(_animStepIndex, _animStepIndex >= 0);
  _updatePlaybackUI();
}

function _pauseAnimation() {
  _animPlaying = false;
  if (_animTimer) clearInterval(_animTimer);
  _animTimer = null;
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
    playBtn.setAttribute("aria-label", playBtn.title);
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
  document.getElementById("deck-discard-btn")?.addEventListener("click", _discardChanges);
  document.getElementById("deck-undo")?.addEventListener("click", () => _stepEditHistory(-1));
  document.getElementById("deck-redo")?.addEventListener("click", () => _stepEditHistory(1));
  document.addEventListener("keydown", event => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z" || event.target.closest?.("input, textarea, [contenteditable]")) return;
    event.preventDefault();
    _stepEditHistory(event.shiftKey ? 1 : -1);
  });
  document.getElementById("deck-apply-btn")?.addEventListener("click", _commitChanges);
  // Keep focus in a parameter box while pressing Discard/Apply: blurring it re-validates and can shift the buttons mid-click.
  for (const id of ["deck-apply-btn", "deck-discard-btn"]) document.getElementById(id)?.addEventListener("mousedown", event => event.preventDefault());
  _renderApplyBar();
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
window.restoreProtocol = _restoreProtocol;
window.getWorkspaceProtocol = () => ({code: _currentCode, pending: !!_deckAbort || _pendingChanges.length > 0 || _libraryEditing || _applyingChanges
  || !!document.getElementById("protocol-parameter-fields")?.querySelector("input:invalid"),
  layout: _currentState ? JSON.parse(JSON.stringify(_currentState)) : null});
window.openDeviceWorkspace = () => { _openDeckPanel(); _showLoading(); };
window.ensureDeckWorkspace = () => { _openDeckPanel(); };
window.showDeckLoadError = (message, retry) => _showError(message, retry);
window.showDeviceDeck = state => {
  clearDeckPanel();
  _currentState = state;
  _originalState = JSON.parse(JSON.stringify(state));
  _openDeckPanel();
  _renderDeck(state);
};
window.confirmDeviceLayout = () => {
  _pendingChanges = [];
  _originalState = JSON.parse(JSON.stringify(_currentState));
  _renderApplyBar();
};
window.preloadHardwareCatalog = preloadHardwareCatalog;
window.clearDeckPanel = clearDeckPanel;
window.toggleDeckPanel = toggleDeckPanel;
window.toggleProtocolDeck = toggleProtocolDeck;
