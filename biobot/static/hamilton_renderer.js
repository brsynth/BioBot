/**
 * hamilton_renderer.js — Hamilton STAR Deck Visualizer
 *
 * Renders the Hamilton STAR linear worktable with carriers, positions,
 * and channel/head configuration. Supports click-to-select and
 * labware changes within carrier positions.
 */

let currentHamiltonState = null;
let originalHamiltonCode = null;
let selectedCarrierPos = null; // "carrier_var:index"

// ============================================================
// Type icons
// ============================================================

function getHamiltonIcon(type) {
  const icons = {
    tip: "▦", plate: "⊞", tube: "⊡", reservoir: "▬",
    trash: "🗑", wash: "💧", other: "◻",
  };
  return icons[type] || icons.other;
}

function getHamiltonLabwareName(typeId) {
  return HAMILTON_LABWARE_NAMES?.[typeId] || HAMILTON_CARRIER_NAMES?.[typeId] || typeId?.replace(/_/g, " ") || "Unknown";
}

// ============================================================
// Main Render
// ============================================================

function renderHamilton(state) {
  currentHamiltonState = state;
  const container = document.getElementById("deck-svg-container");
  if (!container) return;
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "hamilton-wrapper";

  // Title
  const title = document.createElement("div");
  title.className = "hamilton-title";
  title.textContent = "Hamilton STAR — Worktable";
  wrapper.appendChild(title);

  // Channels info
  const channels = state.channels || {};
  const chDiv = document.createElement("div");
  chDiv.className = "hamilton-channels";
  let chHtml = `<span class="hamilton-ch-label">Channels:</span>`;
  chHtml += `<span class="hamilton-ch-value">${channels.count || 8}× ${channels.type || "1mL CO-RE"}</span>`;
  if (state.head_96) chHtml += `<span class="hamilton-ch-badge">96 Head</span>`;
  if (state.head_384) chHtml += `<span class="hamilton-ch-badge">384 Head</span>`;
  chDiv.innerHTML = chHtml;
  wrapper.appendChild(chDiv);

  // Worktable — horizontal scrollable carrier strip
  const worktable = document.createElement("div");
  worktable.className = "hamilton-worktable";

  // Rail track line
  const trackLine = document.createElement("div");
  trackLine.className = "hamilton-track-line";
  worktable.appendChild(trackLine);

  // Carriers
  const carriers = state.carriers || [];
  if (carriers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hamilton-empty";
    empty.textContent = "No carriers detected";
    worktable.appendChild(empty);
  }

  for (const carrier of carriers) {
    worktable.appendChild(renderCarrier(carrier));
  }

  // Trash
  if (state.trash) {
    const trashDiv = document.createElement("div");
    trashDiv.className = "hamilton-carrier trash";
    trashDiv.innerHTML = `
      <div class="hamilton-carrier-header">
        <span class="hamilton-carrier-type">🗑</span>
        <span class="hamilton-carrier-name">Trash</span>
      </div>
      <div class="hamilton-carrier-rail">Rail ${state.trash.rails || "?"}</div>
    `;
    worktable.appendChild(trashDiv);
  }

  wrapper.appendChild(worktable);

  // Transfer summary
  const transfers = state.transfers || [];
  if (transfers.length > 0) {
    const tDiv = document.createElement("div");
    tDiv.className = "hamilton-transfers";
    tDiv.innerHTML = `<span class="hamilton-transfers-title">${transfers.length} step${transfers.length > 1 ? "s" : ""}</span>`;
    for (const t of transfers.slice(0, 5)) {
      tDiv.innerHTML += `<div class="hamilton-transfer-item">${t.action} ${t.volume || ""} µL — ${t.source || t.destination || ""}</div>`;
    }
    wrapper.appendChild(tDiv);
  }

  container.appendChild(wrapper);
  renderHamiltonInfo(state);
}

// ============================================================
// Carrier Rendering
// ============================================================

function renderCarrier(carrier) {
  const card = document.createElement("div");
  card.className = `hamilton-carrier ${carrier.carrier_type || "other"}`;
  card.dataset.carrierVar = carrier.variable;

  // Header
  const header = document.createElement("div");
  header.className = "hamilton-carrier-header";
  header.innerHTML = `
    <span class="hamilton-carrier-type">${getHamiltonIcon(carrier.carrier_type)}</span>
    <span class="hamilton-carrier-name">${carrier.display_name || carrier.type}</span>
  `;
  card.appendChild(header);

  // Rail position
  const railLabel = document.createElement("div");
  railLabel.className = "hamilton-carrier-rail";
  railLabel.textContent = `Rail ${carrier.rails || "?"}`;
  card.appendChild(railLabel);

  // Positions
  const posContainer = document.createElement("div");
  posContainer.className = "hamilton-positions";

  for (const pos of carrier.positions || []) {
    const posDiv = document.createElement("div");
    posDiv.className = `hamilton-position ${pos.labware_type ? "filled" : "empty"}`;
    posDiv.dataset.carrierVar = carrier.variable;
    posDiv.dataset.posIndex = pos.index;

    const posKey = `${carrier.variable}:${pos.index}`;
    if (selectedCarrierPos === posKey) posDiv.classList.add("selected");

    posDiv.addEventListener("click", () => onHamiltonPositionClick(carrier.variable, pos.index));
    posDiv.addEventListener("dblclick", () => showHamiltonLabwareSelector(carrier, pos.index));

    if (pos.labware_type) {
      posDiv.innerHTML = `
        <span class="hamilton-pos-index">${pos.index}</span>
        <span class="hamilton-pos-icon">${getHamiltonIcon(carrier.carrier_type)}</span>
        <span class="hamilton-pos-name">${getHamiltonLabwareName(pos.labware_type)}</span>
        ${pos.labware_variable ? `<span class="hamilton-pos-var">${pos.labware_variable}</span>` : ""}
      `;
    } else {
      posDiv.innerHTML = `
        <span class="hamilton-pos-index">${pos.index}</span>
        <span class="hamilton-pos-empty">Empty</span>
        <span class="hamilton-pos-hint">double-click to add</span>
      `;
    }

    posContainer.appendChild(posDiv);
  }

  card.appendChild(posContainer);
  return card;
}

// ============================================================
// Click to Select
// ============================================================

function onHamiltonPositionClick(carrierVar, posIndex) {
  const key = `${carrierVar}:${posIndex}`;
  selectedCarrierPos = (selectedCarrierPos === key) ? null : key;
  renderHamilton(currentHamiltonState);

  if (!selectedCarrierPos) {
    renderHamiltonInfo(currentHamiltonState);
    return;
  }

  const info = document.getElementById("deck-info");
  if (!info) return;

  const carrier = currentHamiltonState.carriers.find(c => c.variable === carrierVar);
  if (!carrier) return;
  const pos = carrier.positions[posIndex];
  if (!pos) return;

  let html = `<div class="deck-info-row"><span class="deck-info-label">${carrier.display_name} — Position ${posIndex}</span></div>`;
  html += `<div class="deck-info-row">Carrier: <code>${carrier.type}</code></div>`;
  html += `<div class="deck-info-row">Rail: ${carrier.rails}</div>`;

  if (pos.labware_type) {
    html += `<div class="deck-info-row">Labware: <span style="color:var(--accent)">${getHamiltonLabwareName(pos.labware_type)}</span></div>`;
    html += `<div class="deck-info-row">API name: <code>${pos.labware_type}</code></div>`;
    if (pos.labware_variable) html += `<div class="deck-info-row">Variable: <code>${pos.labware_variable}</code></div>`;
  } else {
    html += `<div class="deck-info-row" style="color:var(--text-muted)">Empty position — double-click to add labware</div>`;
  }

  info.innerHTML = html;
}

// ============================================================
// Labware Selector
// ============================================================

function showHamiltonLabwareSelector(carrier, posIndex) {
  const existing = document.getElementById("deck-selector-modal");
  if (existing) existing.remove();

  const pos = carrier.positions[posIndex];
  const currentId = pos?.labware_type || "";

  // Determine which labware category to show based on carrier type
  const modal = document.createElement("div");
  modal.id = "deck-selector-modal";
  modal.className = "deck-selector-modal";

  let html = `<div class="deck-selector-content">`;
  html += `<div class="deck-selector-header">`;
  html += `<h4>${carrier.display_name} — Position ${posIndex}</h4>`;
  html += `<button class="deck-selector-close" onclick="document.getElementById('deck-selector-modal').remove()">&times;</button>`;
  html += `</div>`;
  html += `<input type="text" class="deck-selector-search" placeholder="Search..." oninput="filterHamiltonLabware(this.value)" autofocus />`;
  html += `<div class="deck-selector-list" id="deck-selector-list">`;

  if (currentId) {
    html += `<div class="deck-selector-item remove" onclick="changeHamiltonLabware('${carrier.variable}', ${posIndex}, null)">`;
    html += `<span class="selector-icon">❌</span><span>Remove labware</span></div>`;
  }

  for (const [category, items] of Object.entries(HAMILTON_CATALOG.labware)) {
    html += `<div class="deck-selector-category">${category}</div>`;
    for (const item of items) {
      const isActive = item.id === currentId ? " active" : "";
      html += `<div class="deck-selector-item${isActive}" data-search="${item.name.toLowerCase()} ${item.id.toLowerCase()}" onclick="changeHamiltonLabware('${carrier.variable}', ${posIndex}, '${item.id}')">`;
      html += `<span class="selector-icon">${getHamiltonIcon(carrier.carrier_type)}</span>`;
      html += `<span class="selector-name">${item.name}</span>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;
  modal.innerHTML = html;
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function filterHamiltonLabware(query) {
  const items = document.querySelectorAll("#deck-selector-list .deck-selector-item");
  const q = query.toLowerCase();
  items.forEach(item => {
    const s = item.dataset.search || "";
    item.style.display = (!q || s.includes(q)) ? "" : "none";
  });
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

function changeHamiltonLabware(carrierVar, posIndex, newLabwareId) {
  document.getElementById("deck-selector-modal")?.remove();
  if (!currentHamiltonState || !originalHamiltonCode) return;

  const carrier = currentHamiltonState.carriers.find(c => c.variable === carrierVar);
  if (!carrier) return;
  const pos = carrier.positions[posIndex];
  if (!pos) return;

  const oldId = pos.labware_type;

  if (newLabwareId === null) {
    pos.labware_type = null;
    pos.labware_variable = null;
  } else if (oldId) {
    // Replace old labware with new in code
    originalHamiltonCode = originalHamiltonCode.replace(
      new RegExp(oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      newLabwareId
    );
    pos.labware_type = newLabwareId;
  } else {
    pos.labware_type = newLabwareId;
    pos.labware_variable = `labware_${carrierVar}_${posIndex}`;
  }

  selectedCarrierPos = null;
  renderHamilton(currentHamiltonState);
  if (window.updateCodeInChat) window.updateCodeInChat(originalHamiltonCode);
}

// ============================================================
// Info Panel
// ============================================================

function renderHamiltonInfo(state) {
  const info = document.getElementById("deck-info");
  if (!info) return;

  let html = "";
  const carrierCount = state.carriers?.length || 0;
  const filledPositions = (state.carriers || []).reduce((sum, c) =>
    sum + (c.positions || []).filter(p => p.labware_type).length, 0);

  html += `<div class="deck-info-row"><span class="deck-info-label">Carriers:</span> ${carrierCount}</div>`;
  html += `<div class="deck-info-row"><span class="deck-info-label">Loaded positions:</span> ${filledPositions}</div>`;
  html += `<div class="deck-info-row"><span class="deck-info-label">Channels:</span> ${state.channels?.count || 8}× ${state.channels?.type || "1mL"}</div>`;
  html += `<div class="deck-info-hint">Click a position for details. Double-click to change labware.</div>`;
  info.innerHTML = html;
}

// ============================================================
// Entry Point
// ============================================================

function handleHamiltonParse(state, code) {
  currentHamiltonState = state;
  originalHamiltonCode = code;
  selectedCarrierPos = null;

  const headerTitle = document.querySelector(".deck-panel-header h3");
  if (headerTitle) headerTitle.textContent = "Hamilton STAR";

  renderHamilton(state);

  const panel = document.getElementById("deck-panel");
  const chatPanel = document.getElementById("chat-panel");
  const toggleBtn = document.getElementById("deck-toggle-btn");
  if (panel) panel.classList.remove("hidden");
  if (chatPanel) chatPanel.classList.add("with-deck");
  if (toggleBtn) toggleBtn.classList.add("active");
}

// Expose
window.handleHamiltonParse = handleHamiltonParse;
window.changeHamiltonLabware = changeHamiltonLabware;
window.filterHamiltonLabware = filterHamiltonLabware;