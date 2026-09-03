/**
 * deck_renderer.js — Interactive OT-2 Deck Visualizer
 * Phase 2: Drag-and-drop labware between slots with live code regeneration.
 */

const OT2_SLOT_POSITIONS = {
  "1":  { row: 0, col: 0 },  "2":  { row: 0, col: 1 },  "3":  { row: 0, col: 2 },
  "4":  { row: 1, col: 0 },  "5":  { row: 1, col: 1 },  "6":  { row: 1, col: 2 },
  "7":  { row: 2, col: 0 },  "8":  { row: 2, col: 1 },  "9":  { row: 2, col: 2 },
  "10": { row: 3, col: 0 },  "11": { row: 3, col: 1 },  "12": { row: 3, col: 2 },
};

const COLORS = {
  pipetteLeft: "#6b7bff", pipetteRight: "#ff9f43",
};

// --- Global State ---
let currentDeckState = null;
let selectedSlot = null;
let dragSourceSlot = null;
let originalCode = null;

// --- Helpers ---
function getShortLabwareName(name) {
  return LABWARE_DISPLAY_NAMES?.[name] || name.replace(/_/g, " ").substring(0, 22);
}
function getPipetteShortName(model) {
  return PIPETTE_DISPLAY_NAMES?.[model] || model.replace(/_/g, " ");
}
function isTrashSlot(s) { return s === "12"; }
function getLabwareIcon(name) {
  if (!name) return "";
  if (name.includes("trash")) return "🗑";
  if (name.includes("tiprack") || name.includes("filtertiprack")) return "▦";
  if (name.includes("384")) return "▣";
  if (name.includes("wellplate") || name.includes("pcr")) return "⊞";
  if (name.includes("reservoir")) return "▬";
  if (name.includes("tuberack")) return "⊡";
  if (name.includes("aluminumblock")) return "⬡";
  return "◻";
}

// ============================================================
// HTML Deck Renderer
// ============================================================

function renderDeck(deckState) {
  currentDeckState = deckState;
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  container.innerHTML = "";

  const deck = document.createElement("div");
  deck.className = "deck-grid";

  // --- Pipette mounts ---
  const pipRow = document.createElement("div");
  pipRow.className = "deck-pipette-row";
  const leftPip = deckState.pipettes?.left;
  const rightPip = deckState.pipettes?.right;

  pipRow.innerHTML = `
    <div class="deck-pipette ${leftPip ? 'filled' : ''}" style="border-color:${leftPip ? COLORS.pipetteLeft : '#3a3a3a'}" onclick="showPipetteSelector('left')">
      <span class="pipette-mount">LEFT</span>
      ${leftPip ? `<span class="pipette-model" style="color:${COLORS.pipetteLeft}">${getPipetteShortName(leftPip.model)}</span>` : '<span class="pipette-empty">Empty — click to add</span>'}
    </div>
    <div class="deck-pipette ${rightPip ? 'filled' : ''}" style="border-color:${rightPip ? COLORS.pipetteRight : '#3a3a3a'}" onclick="showPipetteSelector('right')">
      <span class="pipette-mount">RIGHT</span>
      ${rightPip ? `<span class="pipette-model" style="color:${COLORS.pipetteRight}">${getPipetteShortName(rightPip.model)}</span>` : '<span class="pipette-empty">Empty — click to add</span>'}
    </div>`;
  deck.appendChild(pipRow);

  // Collect tiprack slots
  const tiprackSlots = new Set();
  if (leftPip?.tipracks) leftPip.tipracks.forEach(s => tiprackSlots.add(s));
  if (rightPip?.tipracks) rightPip.tipracks.forEach(s => tiprackSlots.add(s));

  // --- Slot grid (rows 3→0 so top=10-12, bottom=1-3) ---
  for (let row = 3; row >= 0; row--) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "deck-slot-row";

    for (let col = 0; col < 3; col++) {
      const slotNum = Object.keys(OT2_SLOT_POSITIONS).find(
        s => OT2_SLOT_POSITIONS[s].row === row && OT2_SLOT_POSITIONS[s].col === col
      );
      if (!slotNum) continue;

      const slotData = deckState.slots?.[slotNum];
      const moduleData = deckState.modules?.[slotNum];
      const hasLabware = slotData && slotData.labware && !isTrashSlot(slotNum);
      const isTrash = isTrashSlot(slotNum);
      const isTiprack = tiprackSlots.has(slotNum);

      const slot = document.createElement("div");
      slot.className = "deck-slot";
      slot.dataset.slot = slotNum;

      if (isTrash) slot.classList.add("trash");
      else if (moduleData) slot.classList.add("module");
      else if (hasLabware) slot.classList.add("filled");
      else slot.classList.add("empty");

      if (isTiprack) slot.classList.add("tiprack");
      if (selectedSlot === slotNum) slot.classList.add("selected");

      // Drag events for filled slots (not trash)
      if (hasLabware) {
        slot.draggable = true;
        slot.addEventListener("dragstart", onDragStart);
        slot.addEventListener("dragend", onDragEnd);
      }

      // Drop target for non-trash slots
      if (!isTrash) {
        slot.addEventListener("dragover", onDragOver);
        slot.addEventListener("dragenter", onDragEnter);
        slot.addEventListener("dragleave", onDragLeave);
        slot.addEventListener("drop", onDrop);
      }

      // Click to select, double-click to change labware
      slot.addEventListener("click", () => onSlotClick(slotNum));
      if (!isTrash) {
        slot.addEventListener("dblclick", (e) => {
          e.preventDefault();
          showLabwareSelector(slotNum);
        });
      }

      // --- Slot content ---
      let content = `<span class="slot-number">${slotNum}</span>`;
      if (isTrash && slotData) {
        content += `<span class="slot-icon">🗑</span><span class="slot-labware-name trash-label">Trash</span>`;
      } else if (hasLabware) {
        content += `<span class="slot-icon">${getLabwareIcon(slotData.labware)}</span>`;
        content += `<span class="slot-labware-name">${getShortLabwareName(slotData.labware)}</span>`;
        if (slotData.label) content += `<span class="slot-label">${slotData.label}</span>`;
        content += `<span class="slot-drag-hint">drag to move</span>`;
        content += `<span class="slot-drag-hint">double-click to change</span>`;
      } else if (moduleData) {
        content += `<span class="slot-icon">⚙️</span>`;
        content += `<span class="slot-labware-name module-label">${moduleData.type.replace(/ gen\d/, "")}</span>`;
      } else {
        content += `<span class="slot-empty-label">Empty</span>`;
        content += `<span class="slot-drag-hint">double-click to add</span>`;
      }

      slot.innerHTML = content;
      rowDiv.appendChild(slot);
    }
    deck.appendChild(rowDiv);
  }

  // Step count
  const stepCount = deckState.steps?.length || 0;
  if (stepCount > 0) {
    const summary = document.createElement("div");
    summary.className = "deck-step-summary";
    summary.textContent = `${stepCount} step${stepCount > 1 ? "s" : ""} in protocol`;
    deck.appendChild(summary);
  }

  container.appendChild(deck);
  renderDeckInfo(deckState);
}

// ============================================================
// Drag and Drop
// ============================================================

function onDragStart(e) {
  dragSourceSlot = e.currentTarget.dataset.slot;
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragSourceSlot);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".deck-slot.drop-target").forEach(s => s.classList.remove("drop-target"));
  dragSourceSlot = null;
}

function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }

function onDragEnter(e) {
  e.preventDefault();
  if (e.currentTarget.dataset.slot !== dragSourceSlot) e.currentTarget.classList.add("drop-target");
}

function onDragLeave(e) { e.currentTarget.classList.remove("drop-target"); }

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drop-target");

  const targetSlot = e.currentTarget.dataset.slot;
  const sourceSlot = e.dataTransfer.getData("text/plain");
  if (!sourceSlot || sourceSlot === targetSlot || !currentDeckState) return;
  if (isTrashSlot(targetSlot)) return;

  const sourceData = currentDeckState.slots[sourceSlot];
  const targetData = currentDeckState.slots[targetSlot];
  if (!sourceData) return;

  // Build slot_changes map for the code updater
  const slotChanges = {};
  slotChanges[sourceSlot] = targetSlot;

  // If target had labware, it's a swap
  const isSwap = targetData && targetData.labware && !isTrashSlot(sourceSlot);
  if (isSwap) {
    slotChanges[targetSlot] = sourceSlot;
  }

  // Update deck state
  currentDeckState.slots[targetSlot] = { ...sourceData };
  if (isSwap) {
    currentDeckState.slots[sourceSlot] = { ...targetData };
  } else {
    delete currentDeckState.slots[sourceSlot];
  }

  // Update tiprack refs in pipettes
  for (const mount of ["left", "right"]) {
    const pip = currentDeckState.pipettes?.[mount];
    if (pip?.tipracks) {
      pip.tipracks = pip.tipracks.map(s => {
        if (s === sourceSlot) return targetSlot;
        if (s === targetSlot) return sourceSlot;
        return s;
      });
    }
  }

  selectedSlot = null;
  renderDeck(currentDeckState);
  regenerateCode(slotChanges);
}

// ============================================================
// Slot Selection
// ============================================================

function onSlotClick(slotNum) {
  selectedSlot = (selectedSlot === slotNum) ? null : slotNum;
  renderDeck(currentDeckState);

  const info = document.getElementById("deck-info");
  if (!info || !currentDeckState) return;

  if (!selectedSlot) { renderDeckInfo(currentDeckState); return; }

  // Detach parameter editor before replacing info content
  const paramEditor = document.getElementById("param-editor");
  let detachedEditor = null;
  if (paramEditor) {
    detachedEditor = paramEditor;
    paramEditor.remove();
  }

  const slotData = currentDeckState.slots?.[slotNum];
  const moduleData = currentDeckState.modules?.[slotNum];
  let html = `<div class="deck-info-row"><span class="deck-info-label">Slot ${slotNum}</span></div>`;

  if (slotData && slotData.labware) {
    html += `<div class="deck-info-row">Labware: <span style="color:var(--accent)">${slotData.labware}</span></div>`;
    if (slotData.variable) html += `<div class="deck-info-row">Variable: <code>${slotData.variable}</code></div>`;
    if (slotData.label) html += `<div class="deck-info-row">Label: ${slotData.label}</div>`;
    for (const [mount, pip] of Object.entries(currentDeckState.pipettes || {})) {
      if (pip.tipracks?.includes(slotNum)) {
        html += `<div class="deck-info-row">Used by: ${mount} (${getPipetteShortName(pip.model)})</div>`;
      }
    }
  } else if (moduleData) {
    html += `<div class="deck-info-row">Module: ${moduleData.type}</div>`;
  } else {
    html += `<div class="deck-info-row" style="color:var(--text-muted)">Empty — drag labware here</div>`;
  }

  info.innerHTML = html;

  // Reattach parameter editor
  if (detachedEditor) {
    info.appendChild(detachedEditor);
  }
}

// ============================================================
// Labware / Pipette Change Selector
// ============================================================

function showLabwareSelector(slotNum) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) existing.remove();

  const slotData = currentDeckState?.slots?.[slotNum];
  const currentId = slotData?.labware || "";

  const modal = document.createElement("div");
  modal.id = "deck-selector-modal";
  modal.className = "deck-selector-modal";

  let html = `<div class="deck-selector-content">`;
  html += `<div class="deck-selector-header">`;
  html += `<h4>Slot ${slotNum} — ${slotData ? "Change" : "Add"} Labware</h4>`;
  html += `<button class="deck-selector-close" onclick="document.getElementById('deck-selector-modal').remove()">&times;</button>`;
  html += `</div>`;
  html += `<input type="text" class="deck-selector-search" placeholder="Search labware..." oninput="filterLabwareList(this.value)" autofocus />`;
  html += `<div class="deck-selector-list" id="deck-selector-list">`;

  // Remove option
  if (slotData) {
    html += `<div class="deck-selector-item remove" onclick="changeLabware('${slotNum}', null)">`;
    html += `<span class="selector-icon">❌</span><span>Remove labware</span>`;
    html += `</div>`;
  }

  for (const [category, items] of Object.entries(OT2_CATALOG.labware)) {
    html += `<div class="deck-selector-category">${category}</div>`;
    for (const item of items) {
      const isActive = item.id === currentId ? " active" : "";
      html += `<div class="deck-selector-item${isActive}" data-search="${item.name.toLowerCase()} ${item.id}" onclick="changeLabware('${slotNum}', '${item.id}')">`;
      html += `<span class="selector-icon">${getLabwareIcon(item.id)}</span>`;
      html += `<span class="selector-name">${item.name}</span>`;
      html += `<span class="selector-id">${item.id}</span>`;
      html += `</div>`;
    }
  }
  html += `</div></div>`;
  modal.innerHTML = html;

  // Close on backdrop click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);
}

function showPipetteSelector(mount) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) existing.remove();

  const pipData = currentDeckState?.pipettes?.[mount];
  const currentId = pipData?.model || "";

  const modal = document.createElement("div");
  modal.id = "deck-selector-modal";
  modal.className = "deck-selector-modal";

  let html = `<div class="deck-selector-content">`;
  html += `<div class="deck-selector-header">`;
  html += `<h4>${mount.charAt(0).toUpperCase() + mount.slice(1)} Mount — ${pipData ? "Change" : "Add"} Pipette</h4>`;
  html += `<button class="deck-selector-close" onclick="document.getElementById('deck-selector-modal').remove()">&times;</button>`;
  html += `</div>`;
  html += `<div class="deck-selector-list" id="deck-selector-list">`;

  if (pipData) {
    html += `<div class="deck-selector-item remove" onclick="changePipette('${mount}', null)">`;
    html += `<span class="selector-icon">❌</span><span>Remove pipette</span>`;
    html += `</div>`;
  }

  for (const [category, items] of Object.entries(OT2_CATALOG.pipettes)) {
    html += `<div class="deck-selector-category">${category}</div>`;
    for (const item of items) {
      const isActive = item.id === currentId ? " active" : "";
      html += `<div class="deck-selector-item${isActive}" data-search="${item.name.toLowerCase()} ${item.id}" onclick="changePipette('${mount}', '${item.id}')">`;
      html += `<span class="selector-icon">🔬</span>`;
      html += `<span class="selector-name">${item.name}</span>`;
      html += `<span class="selector-range">${item.range}</span>`;
      html += `</div>`;
    }
  }
  html += `</div></div>`;
  modal.innerHTML = html;

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);
}

function filterLabwareList(query) {
  const items = document.querySelectorAll("#deck-selector-list .deck-selector-item");
  const q = query.toLowerCase();
  items.forEach(item => {
    const searchText = item.dataset.search || "";
    item.style.display = (!q || searchText.includes(q)) ? "" : "none";
  });
  // Show/hide category headers based on visible items
  document.querySelectorAll("#deck-selector-list .deck-selector-category").forEach(cat => {
    let next = cat.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains("deck-selector-category")) {
      if (next.style.display !== "none") hasVisible = true;
      next = next.nextElementSibling;
    }
    cat.style.display = hasVisible ? "" : "none";
  });
}

function changeLabware(slotNum, newLabwareId) {
  document.getElementById("deck-selector-modal")?.remove();
  if (!currentDeckState || !originalCode) return;

  const oldSlotData = currentDeckState.slots[slotNum];
  const oldId = oldSlotData?.labware;
  const oldVar = oldSlotData?.variable;
  const wasTiprack = oldId && oldId.includes("tiprack");
  const isTiprack = newLabwareId && newLabwareId.includes("tiprack");

  if (newLabwareId === null) {
    // --- REMOVE labware ---
    // Check if removal will break the code
    if (window.checkRemovalCoherence) {
      const removalWarnings = window.checkRemovalCoherence(slotNum, currentDeckState, originalCode);
      if (removalWarnings.length > 0) {
        // Show warning but still proceed — user chose to remove
        setTimeout(() => window.showCoherenceWarnings?.(removalWarnings), 300);
      }
    }

    delete currentDeckState.slots[slotNum];
    if (oldVar) {
      originalCode = removeMultilineStatement(originalCode, oldVar, "load_labware");
    }
    // If it was a tiprack, remove it from pipette tip_racks references
    if (wasTiprack) {
      for (const [mount, pip] of Object.entries(currentDeckState.pipettes || {})) {
        if (pip.tipracks) {
          pip.tipracks = pip.tipracks.filter(s => s !== slotNum);
        }
      }
    }
  } else if (oldId) {
    // --- CHANGE existing labware ---
    // Check well format compatibility before changing
    if (window.checkLabwareWellCoherence) {
      const wellWarnings = window.checkLabwareWellCoherence(slotNum, newLabwareId, oldId, currentDeckState, originalCode);
      if (wellWarnings.length > 0) {
        setTimeout(() => window.showCoherenceWarnings?.(wellWarnings), 300);
      }
    }

    currentDeckState.slots[slotNum].labware = newLabwareId;
    originalCode = originalCode.replace(
      new RegExp(oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      newLabwareId
    );

    // If changing a tiprack to a different volume, check pipette compatibility
    if (wasTiprack && isTiprack) {
      const newTipVol = getTiprackVolume(newLabwareId);
      // Check each pipette that uses this tiprack
      for (const [mount, pip] of Object.entries(currentDeckState.pipettes || {})) {
        if (!pip.tipracks?.includes(slotNum)) continue;
        const pipCompat = PIPETTE_TIP_COMPAT[pip.model] || [];
        if (newTipVol && !pipCompat.includes(newTipVol)) {
          // Tiprack is now incompatible — find the right pipette for this tiprack
          const compatPipettes = TIPRACK_PIPETTE_COMPAT[newTipVol] || [];
          // Pick the best match: same channel count, gen2 preferred
          const oldIsMulti = pip.model.includes("multi");
          const oldIsGen2 = pip.model.includes("gen2");
          let bestMatch = compatPipettes.find(p =>
            p.includes(oldIsMulti ? "multi" : "single") && p.includes("gen2")
          ) || compatPipettes.find(p =>
            p.includes(oldIsMulti ? "multi" : "single")
          ) || compatPipettes[0];

          if (bestMatch) {
            originalCode = originalCode.replace(
              new RegExp(pip.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
              bestMatch
            );
            currentDeckState.pipettes[mount].model = bestMatch;
          }
        }
      }
    }
  } else {
    // --- ADD new labware to empty slot ---
    const varName = `labware_${slotNum}`;
    currentDeckState.slots[slotNum] = {
      labware: newLabwareId,
      variable: varName,
      label: "",
    };
    const newLine = `    ${varName} = protocol.load_labware("${newLabwareId}", ${slotNum})`;
    originalCode = insertLineInCode(originalCode, newLine, "labware");

    // If adding a tiprack, check if any pipette needs it
    if (isTiprack) {
      const newTipVol = getTiprackVolume(newLabwareId);
      for (const [mount, pip] of Object.entries(currentDeckState.pipettes || {})) {
        const pipCompat = PIPETTE_TIP_COMPAT[pip.model] || [];
        if (newTipVol && pipCompat.includes(newTipVol)) {
          // This pipette can use this tiprack — add to its tip_racks
          if (!pip.tipracks) pip.tipracks = [];
          if (!pip.tipracks.includes(slotNum)) {
            pip.tipracks.push(slotNum);
            // Update the code to add the tiprack reference
            const pipVar = pip.variable;
            if (originalCode.includes(`tip_racks=[`) && originalCode.includes(pipVar)) {
              // Tiprack list already exists — append to it
              const tipRacksRegex = new RegExp(`(${pipVar}[^)]*tip_racks=\\[)([^\\]]*)`, 's');
              originalCode = originalCode.replace(tipRacksRegex, `$1$2, ${varName}`);
            }
          }
        }
      }
    }
  }

  selectedSlot = null;
  renderDeck(currentDeckState);
  updateCodeInChat(originalCode);
}

function changePipette(mount, newPipetteId) {
  document.getElementById("deck-selector-modal")?.remove();
  if (!currentDeckState || !originalCode) return;

  const oldPipData = currentDeckState.pipettes[mount];
  const oldId = oldPipData?.model;
  const oldVar = oldPipData?.variable;

  if (newPipetteId === null) {
    // --- REMOVE pipette ---
    // Check if removal will break the code
    if (oldVar && window.checkRemovalCoherence) {
      const lines = originalCode.split("\n");
      let refCount = 0;
      for (const line of lines) {
        if (line.includes("load_instrument")) continue;
        if (line.includes(oldVar)) refCount++;
      }
      if (refCount > 0) {
        setTimeout(() => window.showCoherenceWarnings?.([
          `"${oldVar}" is used ${refCount} time${refCount > 1 ? "s" : ""} in protocol steps (transfer, aspirate, dispense). Removing it will break those steps.`
        ]), 300);
      }
    }

    delete currentDeckState.pipettes[mount];
    if (oldVar) {
      originalCode = removeMultilineStatement(originalCode, oldVar, "load_instrument");
    }
    renderDeck(currentDeckState);
    updateCodeInChat(originalCode);
    return;
  }

  if (oldId) {
    // --- CHANGE existing pipette ---
    // Replace pipette model in code
    originalCode = originalCode.replace(
      new RegExp(oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      newPipetteId
    );

    // Check if existing tipracks are still compatible
    const oldTipSlots = oldPipData.tipracks || [];
    const newCompat = PIPETTE_TIP_COMPAT[newPipetteId] || [];
    const defaultTiprack = PIPETTE_DEFAULT_TIPRACK[newPipetteId];

    for (const tipSlot of oldTipSlots) {
      const tipData = currentDeckState.slots[tipSlot];
      if (!tipData) continue;
      const tipVol = getTiprackVolume(tipData.labware);
      if (tipVol && !newCompat.includes(tipVol) && defaultTiprack) {
        // Tiprack is incompatible — replace it with the correct one
        const oldTiprackName = tipData.labware;
        currentDeckState.slots[tipSlot].labware = defaultTiprack;
        originalCode = originalCode.replace(
          new RegExp(oldTiprackName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          defaultTiprack
        );
      }
    }

    currentDeckState.pipettes[mount].model = newPipetteId;

  } else {
    // --- ADD new pipette to empty mount ---
    const varName = `pipette_${mount}`;
    const defaultTiprack = PIPETTE_DEFAULT_TIPRACK[newPipetteId];

    // First check if a compatible tiprack already exists
    let compatibleTipracks = findCompatibleTipracks(newPipetteId, currentDeckState.slots);

    // If no compatible tiprack exists, add one to an empty slot
    if (compatibleTipracks.length === 0 && defaultTiprack) {
      const emptySlot = findEmptySlot(currentDeckState.slots);
      if (emptySlot) {
        const tipVar = `tiprack_${mount}`;
        currentDeckState.slots[emptySlot] = {
          labware: defaultTiprack,
          variable: tipVar,
          label: "",
        };
        // Add the tiprack to the code
        const tipLine = `    ${tipVar} = protocol.load_labware("${defaultTiprack}", ${emptySlot})`;
        originalCode = insertLineInCode(originalCode, tipLine, "labware");

        compatibleTipracks = [{ slot: emptySlot, variable: tipVar, labware: defaultTiprack }];
      }
    }

    currentDeckState.pipettes[mount] = {
      model: newPipetteId,
      variable: varName,
      tipracks: compatibleTipracks.map(t => t.slot),
    };

    // Build the load_instrument line
    let newLine;
    if (compatibleTipracks.length > 0) {
      const rackVars = compatibleTipracks.map(t => t.variable).join(", ");
      newLine = `    ${varName} = protocol.load_instrument("${newPipetteId}", "${mount}", tip_racks=[${rackVars}])`;
    } else {
      newLine = `    ${varName} = protocol.load_instrument("${newPipetteId}", "${mount}")`;
    }
    originalCode = insertLineInCode(originalCode, newLine, "instrument");
  }

  // --- Coherence: check if protocol volumes are within new pipette range ---
  if (window.checkPipetteVolumeCoherence) {
    const { warnings, updatedCode } = window.checkPipetteVolumeCoherence(newPipetteId, currentDeckState, originalCode);
    if (updatedCode) originalCode = updatedCode;
    if (warnings.length > 0) {
      setTimeout(() => window.showCoherenceWarnings?.(warnings), 300);
    }
  }

  renderDeck(currentDeckState);
  updateCodeInChat(originalCode);
}

/**
 * Find tipracks on the deck that are compatible with a given pipette.
 */
function findCompatibleTipracks(pipetteId, slots) {
  const compatibleVolumes = PIPETTE_TIP_COMPAT[pipetteId] || [];
  const result = [];
  for (const [slotNum, slotData] of Object.entries(slots || {})) {
    if (!slotData?.labware) continue;
    const lw = slotData.labware.toLowerCase();
    if (!lw.includes("tiprack")) continue;
    if (compatibleVolumes.some(vol => lw.includes(vol))) {
      result.push({ slot: slotNum, variable: slotData.variable || `labware_${slotNum}`, labware: slotData.labware });
    }
  }
  return result;
}

// Pipette → compatible tip volumes
const PIPETTE_TIP_COMPAT = {
  "p20_single_gen2": ["10ul", "20ul"], "p20_multi_gen2": ["10ul", "20ul"],
  "p300_single_gen2": ["200ul", "300ul"], "p300_multi_gen2": ["200ul", "300ul"],
  "p1000_single_gen2": ["1000ul"],
  "p10_single": ["10ul"], "p10_multi": ["10ul"],
  "p50_single": ["200ul", "300ul"], "p50_multi": ["200ul", "300ul"],
  "p300_single": ["200ul", "300ul"], "p300_multi": ["200ul", "300ul"],
  "p1000_single": ["1000ul"],
};

// Pipette → preferred default tiprack (first choice when auto-adding)
const PIPETTE_DEFAULT_TIPRACK = {
  "p20_single_gen2": "opentrons_96_tiprack_20ul",
  "p20_multi_gen2": "opentrons_96_tiprack_20ul",
  "p300_single_gen2": "opentrons_96_tiprack_300ul",
  "p300_multi_gen2": "opentrons_96_tiprack_300ul",
  "p1000_single_gen2": "opentrons_96_tiprack_1000ul",
  "p10_single": "opentrons_96_tiprack_10ul",
  "p10_multi": "opentrons_96_tiprack_10ul",
  "p50_single": "opentrons_96_tiprack_300ul",
  "p50_multi": "opentrons_96_tiprack_300ul",
  "p300_single": "opentrons_96_tiprack_300ul",
  "p300_multi": "opentrons_96_tiprack_300ul",
  "p1000_single": "opentrons_96_tiprack_1000ul",
};

// Tiprack → compatible pipette volumes (reverse mapping)
const TIPRACK_PIPETTE_COMPAT = {
  "10ul": ["p10_single", "p10_multi", "p20_single_gen2", "p20_multi_gen2"],
  "20ul": ["p20_single_gen2", "p20_multi_gen2"],
  "200ul": ["p50_single", "p50_multi", "p300_single", "p300_multi", "p300_single_gen2", "p300_multi_gen2"],
  "300ul": ["p50_single", "p50_multi", "p300_single", "p300_multi", "p300_single_gen2", "p300_multi_gen2"],
  "1000ul": ["p1000_single", "p1000_single_gen2"],
};

/**
 * Find the first empty slot on the deck (excluding slot 12 trash).
 */
function findEmptySlot(slots) {
  for (const slotNum of ["1","2","3","4","5","6","7","8","9","10","11"]) {
    if (!slots[slotNum]) return slotNum;
  }
  return null;
}

/**
 * Get the tiprack volume key from a tiprack labware name.
 * e.g. "opentrons_96_tiprack_300ul" → "300ul"
 */
function getTiprackVolume(labwareName) {
  const match = labwareName.match(/(\d+ul)/);
  return match ? match[1] : null;
}

/**
 * Find which pipettes on the deck use a specific tiprack slot.
 */
function findPipettesUsingTiprack(slotNum, pipettes) {
  const result = [];
  for (const [mount, pip] of Object.entries(pipettes || {})) {
    if (pip.tipracks?.includes(slotNum)) {
      result.push({ mount, ...pip });
    }
  }
  return result;
}

/**
 * Remove a multiline statement from code.
 * Finds the line starting with `varName = ...methodName(` and removes
 * everything through the matching closing `)`.
 */
function removeMultilineStatement(code, varName, methodName) {
  const lines = code.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    // Check if this line starts the statement we want to remove
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith(varName) && lines[i].includes(methodName + "(")) {
      // Count parens to find the end of the statement
      let parenDepth = 0;
      let j = i;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === "(") parenDepth++;
          if (ch === ")") parenDepth--;
        }
        j++;
        if (parenDepth <= 0) break;
      }
      // Skip lines i through j-1 (the entire statement)
      // Also skip a trailing blank line if present
      if (j < lines.length && lines[j].trim() === "") j++;
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Insert a new line of code into the protocol at the right position.
 * - "labware" lines go after the last existing load_labware call (including multiline)
 * - "instrument" lines go after the last existing load_instrument call (including multiline)
 * - If neither exists, insert after "def run(..."
 */
function insertLineInCode(code, newLine, type) {
  const lines = code.split("\n");
  let insertIdx = -1;
  const searchTerm = type === "labware" ? "load_labware(" : "load_instrument(";

  // Find the last occurrence of the target method and skip past its closing paren
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(searchTerm)) {
      // Found the start — now find the closing paren
      let parenDepth = 0;
      let j = i;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === "(") parenDepth++;
          if (ch === ")") parenDepth--;
        }
        j++;
        if (parenDepth <= 0) break;
      }
      insertIdx = j;
      break;
    }
  }

  // Fallback: insert after "def run(" line
  if (insertIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("def run(")) {
        insertIdx = i + 1;
        break;
      }
    }
  }

  // Final fallback: append at end
  if (insertIdx === -1) insertIdx = lines.length;

  lines.splice(insertIdx, 0, newLine);
  return lines.join("\n");
}

// ============================================================
// Code Regeneration
// ============================================================

async function regenerateCode(slotChanges) {
  if (!currentDeckState || !originalCode) return;
  try {
    const res = await fetch("/deck/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        original_code: originalCode,
        slot_changes: slotChanges || {},
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.code) {
      originalCode = data.code;  // Update so next drag uses the latest code
      updateCodeInChat(data.code);
    }
  } catch (e) {
    console.error("Code regeneration error:", e);
  }
}

function updateCodeInChat(newCode) {
  const codeBlocks = document.querySelectorAll(".code-block-pre code");
  if (codeBlocks.length === 0) return;
  const lastBlock = codeBlocks[codeBlocks.length - 1];
  lastBlock.textContent = newCode;
  const wrapper = lastBlock.closest(".code-block-wrapper");
  if (wrapper) {
    wrapper.classList.add("code-updated");
    setTimeout(() => wrapper.classList.remove("code-updated"), 1500);
  }
}

// ============================================================
// Deck Info
// ============================================================

function renderDeckInfo(deckState) {
  const info = document.getElementById("deck-info");
  if (!info) return;
  let html = "";
  if (deckState.metadata?.protocolName)
    html += `<div class="deck-info-row"><span class="deck-info-label">Protocol:</span> ${deckState.metadata.protocolName}</div>`;
  if (deckState.api_version)
    html += `<div class="deck-info-row"><span class="deck-info-label">API:</span> v${deckState.api_version}</div>`;
  if (deckState.steps?.length) {
    html += `<div class="deck-info-row"><span class="deck-info-label">Steps:</span></div>`;
    for (const step of deckState.steps.slice(0, 5))
      html += `<div class="deck-info-step">${step.action} ${step.volume}µL</div>`;
    if (deckState.steps.length > 5)
      html += `<div class="deck-info-step">...and ${deckState.steps.length - 5} more</div>`;
  }
  html += `<div class="deck-info-hint">Drag labware between slots to rearrange</div>`;
  info.innerHTML = html;

  // Render parameter editor below the info
  if (originalCode && window.renderParameterEditor) {
    window.renderParameterEditor(originalCode);
  }
}

// ============================================================
// Parsing & Panel Controls
// ============================================================

function extractCodeFromMessage(content) {
  const m = content.match(/```python\s*\n([\s\S]*?)```/);
  if (m) return m[1];
  if (content.includes("protocol_api") || content.includes("load_labware")) return content;
  return null;
}

/**
 * Save the current deck state to the database for the active chat.
 */
let _deckParseAbort = null;

/**
 * Parse deck from code and display it.
 * Shows loading indicator, parses via /deck/parse (regex + LLM fallback),
 * checks chat hasn't changed, then renders.
 */
async function parseDeckFromCode(code) {
  const chatId = window.currentChatId || null;

  if (_deckParseAbort) {
    _deckParseAbort.abort();
    _deckParseAbort = null;
  }

  try {
    originalCode = code;

    _showDeckLoading();

    _deckParseAbort = new AbortController();
    const parseForChat = chatId;

    const res = await fetch("/deck/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: _deckParseAbort.signal,
    });

    _deckParseAbort = null;

    if (!res.ok) { _hideDeckLoading(); return null; }
    const state = await res.json();
    if (state.error) { _hideDeckLoading(); return null; }

    // Check user hasn't switched chats during parse
    if (parseForChat && window.currentChatId !== parseForChat) return null;

    _renderDeckState(state, code);
    return state;

  } catch (e) {
    if (e.name === "AbortError") return null;
    console.error("Deck parse error:", e);
    _hideDeckLoading();
  }
  return null;
}


/**
 * Show loading state in the deck panel.
 */
function _showDeckLoading() {
  const panel = document.getElementById("deck-panel");
  const chatPanel = document.getElementById("chat-panel");
  const toggleBtn = document.getElementById("deck-toggle-btn");

  // Open the panel
  if (panel) panel.classList.remove("hidden");
  if (chatPanel) chatPanel.classList.add("with-deck");
  if (toggleBtn) toggleBtn.classList.add("active");

  // Show loading in the SVG container
  const container = document.getElementById("deck-svg-container");
  if (container) {
    container.innerHTML = `
      <div class="deck-loading">
        <div class="deck-loading-spinner"></div>
        <span>Generating deck...</span>
        <span class="deck-loading-sub">This may take a few seconds</span>
      </div>`;
  }

  // Clear info panel
  const info = document.getElementById("deck-info");
  if (info) info.innerHTML = "";
}

/**
 * Hide loading state (on error or discard).
 */
function _hideDeckLoading() {
  const container = document.getElementById("deck-svg-container");
  if (container && container.querySelector(".deck-loading")) {
    container.innerHTML = '<p class="deck-empty-message">Generate a protocol to see the deck layout</p>';
  }
}

/**
 * Route the deck state to the correct platform renderer and open the panel.
 */
function _renderDeckState(state, code) {
  // Route to the correct renderer based on platform
  if (state.platform === "echo_650") {
    if (window.handleEchoParse) window.handleEchoParse(state, code);
    return;
  }

  if (state.platform === "hamilton_star") {
    if (window.handleHamiltonParse) window.handleHamiltonParse(state, code);
    return;
  }

  // OT-2 path
  const hasContent = Object.keys(state.slots || {}).length > 1 ||
                     Object.keys(state.pipettes || {}).length > 0;
  if (hasContent) {
    const headerTitle = document.querySelector(".deck-panel-header h3");
    if (headerTitle) headerTitle.textContent = "OT-2 Deck";

    selectedSlot = null;
    renderDeck(state);
    const panel = document.getElementById("deck-panel");
    if (panel) panel.classList.remove("hidden");
    const chatPanel = document.getElementById("chat-panel");
    if (chatPanel) chatPanel.classList.add("with-deck");
    const toggleBtn = document.getElementById("deck-toggle-btn");
    if (toggleBtn) toggleBtn.classList.add("active");
  }
}

function toggleDeckPanel() {
  const panel = document.getElementById("deck-panel");
  const chat = document.getElementById("chat-panel");
  const btn = document.getElementById("deck-toggle-btn");
  if (!panel || !chat) return;
  const hidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !hidden);
  chat.classList.toggle("with-deck", hidden);
  if (btn) btn.classList.toggle("active", hidden);
}

function closeDeckPanel() {
  const panel = document.getElementById("deck-panel");
  const chat = document.getElementById("chat-panel");
  const btn = document.getElementById("deck-toggle-btn");
  if (panel) panel.classList.add("hidden");
  if (chat) chat.classList.remove("with-deck");
  if (btn) btn.classList.remove("active");
}

function clearDeckPanel() {
  // Abort any in-flight parse request
  if (_deckParseAbort) {
    _deckParseAbort.abort();
    _deckParseAbort = null;
  }

  closeDeckPanel();
  currentDeckState = null; selectedSlot = null; originalCode = null;
  const c = document.getElementById("deck-svg-container");
  if (c) c.innerHTML = '<p class="deck-empty-message">Generate a protocol to see the deck layout</p>';
  const i = document.getElementById("deck-info");
  if (i) i.innerHTML = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const toggleBtn = document.getElementById("deck-toggle-btn");
  const closeBtn = document.getElementById("deck-close-btn");
  if (toggleBtn) toggleBtn.addEventListener("click", toggleDeckPanel);
  if (closeBtn) closeBtn.addEventListener("click", closeDeckPanel);
});

window.parseDeckFromCode = parseDeckFromCode;
window.extractCodeFromMessage = extractCodeFromMessage;
window.clearDeckPanel = clearDeckPanel;
window.toggleDeckPanel = toggleDeckPanel;
window.updateCodeInChat = updateCodeInChat;

// Expose state for deck_params.js
Object.defineProperty(window, 'originalCode', {
  get() { return originalCode; },
  set(v) { originalCode = v; },
  configurable: true,
});
Object.defineProperty(window, 'currentDeckState', {
  get() { return currentDeckState; },
  set(v) { currentDeckState = v; },
  configurable: true,
});