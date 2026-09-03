/**
 * echo_renderer.js — Echo 650 Acoustic Liquid Handler Visualizer
 *
 * Displays source and destination plate maps with transfer connections.
 * Click wells to see transfer details, edit volumes, add/remove transfers.
 */

// ============================================================
// Echo 650 Plate Constants
// ============================================================

const ECHO_PLATE_CONFIGS = {
  96:   { rows: 8,  cols: 12, label: "96-well" },
  384:  { rows: 16, cols: 24, label: "384-well" },
  1536: { rows: 32, cols: 48, label: "1536-well" },
};

const ECHO_SOURCE_PLATE_TYPES = [
  { id: "384PP_AQ_BP",   name: "384PP AQ BP (Polypropylene, Aqueous)",     format: 384 },
  { id: "384PP_AQ_GP",   name: "384PP AQ GP (Polypropylene, Glycerol)",    format: 384 },
  { id: "384PP_AQ_SP",   name: "384PP AQ SP (Surfactant)",                 format: 384 },
  { id: "384PP_DMSO",    name: "384PP DMSO (Polypropylene, DMSO)",         format: 384 },
  { id: "384LDV_AQ_BP",  name: "384LDV AQ BP (Low Dead Vol, Aqueous)",    format: 384 },
  { id: "384LDV_AQ_GP",  name: "384LDV AQ GP (Low Dead Vol, Glycerol)",   format: 384 },
  { id: "384LDV_DMSO",   name: "384LDV DMSO (Low Dead Vol, DMSO)",        format: 384 },
  { id: "1536LDV_DMSO",  name: "1536LDV DMSO",                            format: 1536 },
];

const ECHO_DEST_PLATE_TYPES = [
  { id: "384PP_AQ_BP",   name: "384-well Polypropylene",   format: 384 },
  { id: "384_Greiner",   name: "384-well Greiner",         format: 384 },
  { id: "96_Generic",    name: "96-well Standard",         format: 96 },
  { id: "1536_Generic",  name: "1536-well Standard",       format: 1536 },
];

const ROW_LABELS = "ABCDEFGHIJKLMNOP".split("");

// ============================================================
// Global State
// ============================================================

let currentEchoState = null;
let originalEchoCsv = null;
let selectedSourceWell = null;
let selectedDestWell = null;


// ============================================================
// Render Echo Plates
// ============================================================

function renderEcho(echoState) {
  currentEchoState = echoState;
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "echo-wrapper";

  // Title
  const title = document.createElement("div");
  title.className = "echo-title";
  title.textContent = "Echo 650 — Acoustic Transfer Map";
  wrapper.appendChild(title);

  // Plates container
  const platesDiv = document.createElement("div");
  platesDiv.className = "echo-plates";

  // Source plate
  const srcSection = document.createElement("div");
  srcSection.className = "echo-plate-section";
  srcSection.innerHTML = `
    <div class="echo-plate-header">
      <span class="echo-plate-label">Source Plate</span>
      <span class="echo-plate-type" onclick="showEchoPlateTypeSelector('source')">${echoState.source_plate.type || "Click to set type"}</span>
    </div>
  `;
  const srcGrid = renderPlateGrid(
    echoState.source_plate.format || 384,
    echoState.source_plate.wells_used || [],
    echoState.transfers,
    "source",
  );
  srcSection.appendChild(srcGrid);
  platesDiv.appendChild(srcSection);

  // Transfer arrow between plates
  const arrow = document.createElement("div");
  arrow.className = "echo-transfer-arrow";
  arrow.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
  platesDiv.appendChild(arrow);

  // Destination plate
  const dstSection = document.createElement("div");
  dstSection.className = "echo-plate-section";
  dstSection.innerHTML = `
    <div class="echo-plate-header">
      <span class="echo-plate-label">Destination Plate</span>
      <span class="echo-plate-type" onclick="showEchoPlateTypeSelector('destination')">${echoState.destination_plate.type || "Click to set type"}</span>
    </div>
  `;
  const dstGrid = renderPlateGrid(
    echoState.destination_plate.format || 384,
    echoState.destination_plate.wells_used || [],
    echoState.transfers,
    "destination",
  );
  dstSection.appendChild(dstGrid);
  platesDiv.appendChild(dstSection);

  wrapper.appendChild(platesDiv);

  // Summary
  const summary = echoState.summary || {};
  if (summary.total_transfers) {
    const sumDiv = document.createElement("div");
    sumDiv.className = "echo-summary";
    sumDiv.innerHTML = `
      <span>${summary.total_transfers} transfers</span>
      <span>Total: ${formatVolume(summary.total_volume_nl)}</span>
      <span>Range: ${formatVolume(summary.min_volume_nl)} — ${formatVolume(summary.max_volume_nl)}</span>
    `;
    wrapper.appendChild(sumDiv);
  }

  container.appendChild(wrapper);
  renderEchoInfo(echoState);
}

function formatVolume(nl) {
  if (nl >= 1000) return (nl / 1000).toFixed(1) + " µL";
  return nl + " nL";
}


// ============================================================
// Plate Grid Renderer
// ============================================================

function renderPlateGrid(format, usedWells, transfers, role) {
  const config = ECHO_PLATE_CONFIGS[format] || ECHO_PLATE_CONFIGS[384];
  const grid = document.createElement("div");
  grid.className = `echo-grid echo-grid-${format}`;

  const usedSet = new Set(usedWells);

  // Build a map of well → total volume for coloring intensity
  const wellVolumes = {};
  for (const t of transfers || []) {
    const well = role === "source" ? t.source_well : t.dest_well;
    wellVolumes[well] = (wellVolumes[well] || 0) + t.volume_nl;
  }
  const maxVol = Math.max(...Object.values(wellVolumes), 1);

  // Column headers
  const headerRow = document.createElement("div");
  headerRow.className = "echo-grid-row echo-grid-header";
  headerRow.appendChild(createCell("", "echo-cell-corner"));
  for (let c = 1; c <= config.cols; c++) {
    headerRow.appendChild(createCell(c, "echo-cell-header"));
  }
  grid.appendChild(headerRow);

  // Well rows
  for (let r = 0; r < config.rows; r++) {
    const row = document.createElement("div");
    row.className = "echo-grid-row";

    // Row label
    row.appendChild(createCell(ROW_LABELS[r], "echo-cell-rowlabel"));

    for (let c = 1; c <= config.cols; c++) {
      const wellId = ROW_LABELS[r] + c;
      const isUsed = usedSet.has(wellId);
      const vol = wellVolumes[wellId] || 0;
      const intensity = isUsed ? Math.max(0.3, vol / maxVol) : 0;

      const cell = document.createElement("div");
      cell.className = "echo-well";
      cell.dataset.well = wellId;
      cell.dataset.role = role;

      if (isUsed) {
        cell.classList.add("used");
        const color = role === "source" ? `rgba(0, 255, 153, ${intensity})` : `rgba(100, 180, 255, ${intensity})`;
        cell.style.backgroundColor = color;
      }

      const isSelected = (role === "source" && selectedSourceWell === wellId) ||
                         (role === "destination" && selectedDestWell === wellId);
      if (isSelected) cell.classList.add("selected");

      cell.addEventListener("click", () => onEchoWellClick(wellId, role));

      cell.title = isUsed ? `${wellId}: ${formatVolume(vol)}` : wellId;
      grid.appendChild(cell); // append directly for CSS grid

      row.appendChild(cell);
    }
    grid.appendChild(row);
  }

  return grid;
}

function createCell(text, className) {
  const cell = document.createElement("div");
  cell.className = className;
  cell.textContent = text;
  return cell;
}


// ============================================================
// Well Click — Show Transfer Details
// ============================================================

function onEchoWellClick(wellId, role) {
  if (role === "source") {
    selectedSourceWell = (selectedSourceWell === wellId) ? null : wellId;
    selectedDestWell = null;
  } else {
    selectedDestWell = (selectedDestWell === wellId) ? null : wellId;
    selectedSourceWell = null;
  }

  renderEcho(currentEchoState);

  const info = document.getElementById("deck-info");
  if (!info || !currentEchoState) return;

  const selected = role === "source" ? selectedSourceWell : selectedDestWell;
  if (!selected) { renderEchoInfo(currentEchoState); return; }

  // Find transfers involving this well
  const relatedTransfers = currentEchoState.transfers.filter(t =>
    role === "source" ? t.source_well === selected : t.dest_well === selected
  );

  let html = `<div class="deck-info-row"><span class="deck-info-label">${role === "source" ? "Source" : "Destination"} Well ${selected}</span></div>`;

  if (relatedTransfers.length === 0) {
    html += `<div class="deck-info-row" style="color:var(--text-muted)">No transfers</div>`;
  } else {
    html += `<div class="deck-info-row">${relatedTransfers.length} transfer${relatedTransfers.length > 1 ? "s" : ""}:</div>`;
    for (const t of relatedTransfers) {
      const other = role === "source" ? t.dest_well : t.source_well;
      const direction = role === "source" ? "→" : "←";
      html += `<div class="deck-info-step">${direction} ${other}: ${formatVolume(t.volume_nl)}</div>`;
    }
    const totalVol = relatedTransfers.reduce((s, t) => s + t.volume_nl, 0);
    html += `<div class="deck-info-row">Total: ${formatVolume(totalVol)}</div>`;
  }

  info.innerHTML = html;
}


// ============================================================
// Plate Type Selector
// ============================================================

function showEchoPlateTypeSelector(plateRole) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) existing.remove();

  const types = plateRole === "source" ? ECHO_SOURCE_PLATE_TYPES : ECHO_DEST_PLATE_TYPES;
  const currentType = plateRole === "source"
    ? currentEchoState?.source_plate?.type
    : currentEchoState?.destination_plate?.type;

  const modal = document.createElement("div");
  modal.id = "deck-selector-modal";
  modal.className = "deck-selector-modal";

  let html = `<div class="deck-selector-content">`;
  html += `<div class="deck-selector-header">`;
  html += `<h4>${plateRole === "source" ? "Source" : "Destination"} Plate Type</h4>`;
  html += `<button class="deck-selector-close" onclick="document.getElementById('deck-selector-modal').remove()">&times;</button>`;
  html += `</div>`;
  html += `<div class="deck-selector-list">`;

  for (const type of types) {
    const isActive = type.id === currentType ? " active" : "";
    html += `<div class="deck-selector-item${isActive}" onclick="changeEchoPlateType('${plateRole}', '${type.id}', ${type.format})">`;
    html += `<span class="selector-icon">⊞</span>`;
    html += `<span class="selector-name">${type.name}</span>`;
    html += `<span class="selector-range">${type.format}-well</span>`;
    html += `</div>`;
  }

  html += `</div></div>`;
  modal.innerHTML = html;
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function changeEchoPlateType(plateRole, typeId, format) {
  document.getElementById("deck-selector-modal")?.remove();
  if (!currentEchoState || !originalEchoCsv) return;

  // --- Coherence: validate plate change ---
  if (window.validateEchoPlateChange) {
    const warnings = window.validateEchoPlateChange(plateRole, typeId, currentEchoState);
    if (warnings.length > 0) {
      setTimeout(() => window.showCoherenceWarnings?.(warnings), 300);
    }
  }

  // --- Coherence: check and fix volumes for source plate changes ---
  if (plateRole === "source" && window.checkEchoVolumeCoherence) {
    const { fixes } = window.checkEchoVolumeCoherence(typeId, currentEchoState.transfers);
    // Volume fixes are applied directly to the transfers array by the check function
    // Now update the CSV to reflect the fixed volumes
    if (fixes.length > 0) {
      // Rebuild CSV from corrected transfers
      const lines = originalEchoCsv.split("\n");
      const hasHeader = lines[0] && lines[0].toLowerCase().includes("source");
      const dataStart = hasHeader ? 1 : 0;

      for (const fix of fixes) {
        const lineIdx = dataStart + fix.index;
        if (lineIdx < lines.length) {
          // Replace the volume in the CSV line
          lines[lineIdx] = lines[lineIdx].replace(
            String(fix.oldVol),
            String(fix.newVol)
          );
        }
      }
      originalEchoCsv = lines.join("\n");
    }
  }

  if (plateRole === "source") {
    const oldType = currentEchoState.source_plate.type;
    currentEchoState.source_plate.type = typeId;
    currentEchoState.source_plate.format = format;
    if (oldType) {
      originalEchoCsv = originalEchoCsv.replace(new RegExp(oldType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), typeId);
    }
  } else {
    const oldType = currentEchoState.destination_plate.type;
    currentEchoState.destination_plate.type = typeId;
    currentEchoState.destination_plate.format = format;
    if (oldType) {
      originalEchoCsv = originalEchoCsv.replace(new RegExp(oldType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), typeId);
    }
  }

  renderEcho(currentEchoState);
  if (window.updateCodeInChat) window.updateCodeInChat(originalEchoCsv);
}


// ============================================================
// Info Panel
// ============================================================

function renderEchoInfo(echoState) {
  const info = document.getElementById("deck-info");
  if (!info) return;

  let html = "";
  if (echoState.source_plate.name) {
    html += `<div class="deck-info-row"><span class="deck-info-label">Source:</span> ${echoState.source_plate.name}</div>`;
  }
  if (echoState.destination_plate.name) {
    html += `<div class="deck-info-row"><span class="deck-info-label">Dest:</span> ${echoState.destination_plate.name}</div>`;
  }
  html += `<div class="deck-info-hint">Click wells to see transfer details. Click plate type to change.</div>`;
  info.innerHTML = html;
}


// ============================================================
// Integration with deck_renderer.js
// ============================================================

/**
 * Called from parseDeckFromCode — routes to Echo renderer if platform is echo_650.
 */
function handleEchoParse(echoState, csvContent) {
  currentEchoState = echoState;
  originalEchoCsv = csvContent;
  selectedSourceWell = null;
  selectedDestWell = null;

  // Update deck panel header
  const headerTitle = document.querySelector(".deck-panel-header h3");
  if (headerTitle) headerTitle.textContent = "Echo 650";

  renderEcho(echoState);

  // Always show the panel
  const panel = document.getElementById("deck-panel");
  const chatPanel = document.getElementById("chat-panel");
  const toggleBtn = document.getElementById("deck-toggle-btn");
  if (panel) panel.classList.remove("hidden");
  if (chatPanel) chatPanel.classList.add("with-deck");
  if (toggleBtn) toggleBtn.classList.add("active");
}

// Expose
window.handleEchoParse = handleEchoParse;
window.showEchoPlateTypeSelector = showEchoPlateTypeSelector;
window.changeEchoPlateType = changeEchoPlateType;