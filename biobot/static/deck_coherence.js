/**
 * deck_coherence.js — Coherence rules for deck modifications
 *
 * Ensures that when the user changes hardware on the deck, the generated
 * code stays logically valid. Handles pipette↔tiprack sync, volume
 * constraints, well format compatibility, and Echo plate rules.
 */

// ============================================================
// OT-2 Pipette Volume Ranges
// ============================================================

const PIPETTE_VOLUME_RANGE = {
  "p10_single":        { min: 1,   max: 10 },
  "p10_multi":         { min: 1,   max: 10 },
  "p20_single_gen2":   { min: 1,   max: 20 },
  "p20_multi_gen2":    { min: 1,   max: 20 },
  "p50_single":        { min: 5,   max: 50 },
  "p50_multi":         { min: 5,   max: 50 },
  "p300_single":       { min: 30,  max: 300 },
  "p300_multi":        { min: 30,  max: 300 },
  "p300_single_gen2":  { min: 20,  max: 300 },
  "p300_multi_gen2":   { min: 20,  max: 300 },
  "p1000_single":      { min: 100, max: 1000 },
  "p1000_single_gen2": { min: 100, max: 1000 },
};


// ============================================================
// OT-2 Labware Well Counts
// ============================================================

const LABWARE_WELL_COUNT = {};
// Populate from OT2_CATALOG if available
if (typeof OT2_CATALOG !== "undefined") {
  for (const [category, items] of Object.entries(OT2_CATALOG.labware || {})) {
    for (const item of items) {
      if (item.wells) LABWARE_WELL_COUNT[item.id] = item.wells;
    }
  }
}


// ============================================================
// Echo Volume Constraints
// ============================================================

const ECHO_PLATE_VOLUME_RULES = {
  // 384PP plates — standard polypropylene
  "384PP_AQ_BP":  { min_nl: 2.5,   max_nl: 500000, step_nl: 2.5,   dead_vol_nl: 15000 },
  "384PP_AQ_GP":  { min_nl: 2.5,   max_nl: 500000, step_nl: 2.5,   dead_vol_nl: 15000 },
  "384PP_AQ_SP":  { min_nl: 2.5,   max_nl: 500000, step_nl: 2.5,   dead_vol_nl: 15000 },
  "384PP_DMSO":   { min_nl: 2.5,   max_nl: 500000, step_nl: 2.5,   dead_vol_nl: 15000 },
  // 384LDV plates — low dead volume
  "384LDV_AQ_BP": { min_nl: 0.5,   max_nl: 12000,  step_nl: 2.5,   dead_vol_nl: 3000 },
  "384LDV_AQ_GP": { min_nl: 0.5,   max_nl: 12000,  step_nl: 2.5,   dead_vol_nl: 3000 },
  "384LDV_DMSO":  { min_nl: 2.5,   max_nl: 12000,  step_nl: 2.5,   dead_vol_nl: 3000 },
  // 1536 plates
  "1536LDV_DMSO": { min_nl: 2.5,   max_nl: 5000,   step_nl: 2.5,   dead_vol_nl: 1000 },
};

const ECHO_PLATE_FORMAT = {
  "384PP_AQ_BP": 384, "384PP_AQ_GP": 384, "384PP_AQ_SP": 384, "384PP_DMSO": 384,
  "384LDV_AQ_BP": 384, "384LDV_AQ_GP": 384, "384LDV_DMSO": 384,
  "1536LDV_DMSO": 1536,
  "384_Greiner": 384, "96_Generic": 96, "1536_Generic": 1536,
};

const PLATE_WELL_LIMITS = {
  96:   { rows: 8,  cols: 12 },
  384:  { rows: 16, cols: 24 },
  1536: { rows: 32, cols: 48 },
};


// ============================================================
// OT-2 Coherence Checks
// ============================================================

/**
 * Check if changing a pipette creates volume conflicts in the protocol.
 * Returns a list of warnings and suggested fixes.
 */
function checkPipetteVolumeCoherence(newPipetteId, deckState, code) {
  const warnings = [];
  const fixes = [];
  const range = PIPETTE_VOLUME_RANGE[newPipetteId];
  if (!range) return { warnings, fixes, updatedCode: code };

  let updatedCode = code;

  // Find all volume references in transfer/aspirate/dispense calls
  const volumeRegex = /\.(transfer|aspirate|dispense)\(\s*(\d+(?:\.\d+)?)/g;
  let match;
  const volumeIssues = [];

  while ((match = volumeRegex.exec(code)) !== null) {
    const action = match[1];
    const volume = parseFloat(match[2]);

    if (volume > range.max) {
      volumeIssues.push({ action, oldVol: volume, newVol: range.max, issue: "exceeds_max" });
    } else if (volume < range.min) {
      volumeIssues.push({ action, oldVol: volume, newVol: range.min, issue: "below_min" });
    }
  }

  if (volumeIssues.length > 0) {
    for (const issue of volumeIssues) {
      const pipName = PIPETTE_DISPLAY_NAMES?.[newPipetteId] || newPipetteId;
      if (issue.issue === "exceeds_max") {
        warnings.push(
          `${issue.action}(${issue.oldVol} µL) exceeds ${pipName} max (${range.max} µL) → adjusted to ${range.max} µL`
        );
      } else {
        warnings.push(
          `${issue.action}(${issue.oldVol} µL) below ${pipName} min (${range.min} µL) → adjusted to ${range.min} µL`
        );
      }
      // Auto-fix: replace the volume in code
      // Use a targeted replacement that matches the specific call
      const oldPattern = new RegExp(
        `(\\.(${issue.action})\\(\\s*)${issue.oldVol}`,
      );
      updatedCode = updatedCode.replace(oldPattern, `$1${issue.newVol}`);
      fixes.push({ action: issue.action, from: issue.oldVol, to: issue.newVol });
    }
  }

  return { warnings, fixes, updatedCode };
}


/**
 * Check if changing labware creates well reference conflicts.
 * Returns warnings if the new labware has fewer wells than references in the code.
 */
function checkLabwareWellCoherence(slotNum, newLabwareId, oldLabwareId, deckState, code) {
  const warnings = [];

  const oldWells = LABWARE_WELL_COUNT[oldLabwareId] || 96;
  const newWells = LABWARE_WELL_COUNT[newLabwareId] || 96;

  // If downsizing (e.g., 384 → 96), well references might become invalid
  if (newWells < oldWells) {
    const varName = deckState.slots?.[slotNum]?.variable;
    if (varName && code.includes(varName)) {
      // Check if any well references exceed the new plate dimensions
      const wellRefRegex = new RegExp(`${varName}\\s*\\[\\s*["']([A-P])(\\d{1,2})["']\\s*\\]`, 'g');
      let wellMatch;
      const limits = newWells <= 96 ? { maxRow: 7, maxCol: 12 } :
                     newWells <= 384 ? { maxRow: 15, maxCol: 24 } :
                     { maxRow: 31, maxCol: 48 };

      while ((wellMatch = wellRefRegex.exec(code)) !== null) {
        const row = wellMatch[1].charCodeAt(0) - 65;
        const col = parseInt(wellMatch[2]);
        if (row > limits.maxRow || col > limits.maxCol) {
          warnings.push(
            `Well ${wellMatch[1]}${wellMatch[2]} referenced in code is outside the ${newWells}-well plate range`
          );
        }
      }
    }
  }

  return warnings;
}


/**
 * Check if removing labware breaks references in the code.
 */
function checkRemovalCoherence(slotNum, deckState, code) {
  const warnings = [];
  const slotData = deckState.slots?.[slotNum];
  if (!slotData?.variable) return warnings;

  const varName = slotData.variable;

  // Count how many times this variable appears in the code (excluding the load_labware line)
  const lines = code.split("\n");
  let refCount = 0;
  for (const line of lines) {
    if (line.includes("load_labware")) continue;
    if (line.includes(varName)) refCount++;
  }

  if (refCount > 0) {
    warnings.push(
      `"${varName}" is referenced ${refCount} time${refCount > 1 ? "s" : ""} in the protocol steps. Removing it will break the code.`
    );
  }

  // Check if it's a tiprack used by a pipette
  for (const [mount, pip] of Object.entries(deckState.pipettes || {})) {
    if (pip.tipracks?.includes(slotNum)) {
      const pipName = PIPETTE_DISPLAY_NAMES?.[pip.model] || pip.model;
      warnings.push(
        `This tiprack is used by the ${mount} pipette (${pipName}). Removing it will leave the pipette without tips.`
      );
    }
  }

  return warnings;
}


// ============================================================
// Echo Coherence Checks
// ============================================================

/**
 * Check if Echo transfer volumes are valid for the source plate type.
 */
function checkEchoVolumeCoherence(sourceType, transfers) {
  const rules = ECHO_PLATE_VOLUME_RULES[sourceType];
  if (!rules || !transfers) return { warnings: [], fixes: [] };

  const warnings = [];
  const fixes = [];

  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const vol = t.volume_nl;

    if (vol < rules.min_nl) {
      warnings.push(
        `Transfer ${i + 1} (${t.source_well}→${t.dest_well}): ${vol} nL below min ${rules.min_nl} nL → adjusted`
      );
      fixes.push({ index: i, oldVol: vol, newVol: rules.min_nl });
      t.volume_nl = rules.min_nl;
    } else if (vol > rules.max_nl) {
      warnings.push(
        `Transfer ${i + 1} (${t.source_well}→${t.dest_well}): ${vol} nL exceeds max ${rules.max_nl} nL → adjusted`
      );
      fixes.push({ index: i, oldVol: vol, newVol: rules.max_nl });
      t.volume_nl = rules.max_nl;
    }

    // Check step size alignment (2.5 nL increments)
    if (vol % rules.step_nl !== 0) {
      const rounded = Math.round(vol / rules.step_nl) * rules.step_nl;
      if (rounded !== vol) {
        warnings.push(
          `Transfer ${i + 1}: ${vol} nL rounded to ${rounded} nL (${rules.step_nl} nL step size)`
        );
        fixes.push({ index: i, oldVol: vol, newVol: rounded });
        t.volume_nl = rounded;
      }
    }
  }

  return { warnings, fixes };
}


/**
 * Check if Echo well references are valid for the plate format.
 */
function checkEchoWellCoherence(plateFormat, transfers, role) {
  const warnings = [];
  const limits = PLATE_WELL_LIMITS[plateFormat];
  if (!limits) return warnings;

  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const well = role === "source" ? t.source_well : t.dest_well;
    const match = well.match(/^([A-P])(\d{1,2})$/);
    if (!match) continue;

    const row = match[1].charCodeAt(0) - 65;
    const col = parseInt(match[2]);

    if (row >= limits.rows || col > limits.cols || col < 1) {
      warnings.push(
        `Transfer ${i + 1}: Well ${well} is outside ${plateFormat}-well plate range (max: ${String.fromCharCode(64 + limits.rows)}${limits.cols})`
      );
    }
  }

  return warnings;
}


/**
 * Validate an Echo plate type change and return warnings.
 */
function validateEchoPlateChange(plateRole, newTypeId, echoState) {
  const warnings = [];

  const newFormat = ECHO_PLATE_FORMAT[newTypeId];
  const oldFormat = plateRole === "source"
    ? echoState.source_plate.format
    : echoState.destination_plate.format;

  // Check well format compatibility
  if (newFormat && newFormat < oldFormat) {
    const wellWarnings = checkEchoWellCoherence(
      newFormat,
      echoState.transfers,
      plateRole
    );
    warnings.push(...wellWarnings);
  }

  // Check volume constraints for source plate changes
  if (plateRole === "source") {
    const { warnings: volWarnings } = checkEchoVolumeCoherence(newTypeId, echoState.transfers);
    warnings.push(...volWarnings);
  }

  return warnings;
}


// ============================================================
// Warning Display
// ============================================================

/**
 * Show coherence warnings to the user in the deck info panel.
 */
function showCoherenceWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;

  const info = document.getElementById("deck-info");
  if (!info) return;

  let html = `<div class="coherence-warnings">`;
  html += `<div class="coherence-header">⚠ Adjustments made:</div>`;
  for (const w of warnings) {
    html += `<div class="coherence-warning">${w}</div>`;
  }
  html += `</div>`;

  // Append to existing info content
  info.innerHTML += html;

  // Auto-hide after 8 seconds
  setTimeout(() => {
    const warningDiv = info.querySelector(".coherence-warnings");
    if (warningDiv) {
      warningDiv.style.transition = "opacity 0.5s";
      warningDiv.style.opacity = "0";
      setTimeout(() => warningDiv.remove(), 500);
    }
  }, 15000);
}


// ============================================================
// Expose
// ============================================================

window.checkPipetteVolumeCoherence = checkPipetteVolumeCoherence;
window.checkLabwareWellCoherence = checkLabwareWellCoherence;
window.checkRemovalCoherence = checkRemovalCoherence;
window.checkEchoVolumeCoherence = checkEchoVolumeCoherence;
window.checkEchoWellCoherence = checkEchoWellCoherence;
window.validateEchoPlateChange = validateEchoPlateChange;
window.showCoherenceWarnings = showCoherenceWarnings;
window.PIPETTE_VOLUME_RANGE = PIPETTE_VOLUME_RANGE;
window.ECHO_PLATE_VOLUME_RULES = ECHO_PLATE_VOLUME_RULES;