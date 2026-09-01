/**
 * deck_params.js — Protocol Parameter Editor
 *
 * Extracts named parameters and inline values from Opentrons protocols.
 * Renders an editable panel where users can change volumes, counts, etc.
 * Updates the code coherently when parameters change.
 */

// ============================================================
// Parameter Extraction
// ============================================================

/**
 * Extract all editable parameters from a protocol code string.
 * Returns an array of parameter objects grouped by category.
 *
 * Detects:
 * - Named variables: `volume = 100  # uL`
 * - Named variables with type hints in comments
 * - Common protocol patterns (volumes, reps, speeds)
 */
function extractParameters(code) {
  if (!code) return [];

  const params = [];
  const lines = code.split("\n");
  const seenNames = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip non-assignment lines
    if (!trimmed.includes("=")) continue;
    // Skip function definitions, class defs, metadata, labware/instrument loading
    if (trimmed.startsWith("def ") || trimmed.startsWith("class ") ||
        trimmed.startsWith("metadata") || trimmed.startsWith("#") ||
        trimmed.includes("load_labware") || trimmed.includes("load_instrument") ||
        trimmed.includes("load_module") || trimmed.includes("import ")) continue;

    // Match: variable_name = numeric_value  # optional comment
    const numMatch = trimmed.match(
      /^(\w+)\s*=\s*(\d+(?:\.\d+)?)\s*(?:#\s*(.*))?$/
    );

    if (numMatch) {
      const name = numMatch[1];
      const value = parseFloat(numMatch[2]);
      const comment = (numMatch[3] || "").trim();

      // Skip well references (like `source = plate["A1"]`) that parsed incorrectly
      if (name === "i" || name === "j" || name === "x" || name === "y") continue;

      const category = detectParamCategory(name, comment, value);
      if (category === "skip") continue;

      if (!seenNames.has(name)) {
        params.push({
          name,
          value,
          comment,
          category,
          unit: detectUnit(name, comment, category),
          lineIndex: i,
          originalLine: line,
        });
        seenNames.add(name);
      }
    }
  }

  // Sort: volumes first, then counts, then others
  const order = { volume: 0, count: 1, speed: 2, other: 3 };
  params.sort((a, b) => (order[a.category] || 3) - (order[b.category] || 3));

  return params;
}


/**
 * Detect the category of a parameter from its name and comment.
 */
function detectParamCategory(name, comment, value) {
  const nameLower = name.toLowerCase();
  const commentLower = comment.toLowerCase();

  // Volume parameters
  if (nameLower.includes("volume") || nameLower.includes("vol") ||
      commentLower.includes("ul") || commentLower.includes("µl") ||
      commentLower.includes("microliter") || commentLower.includes("uL")) {
    return "volume";
  }

  // Transfer/aspiration/dispense amounts
  if (nameLower.includes("transfer") || nameLower.includes("aspirat") ||
      nameLower.includes("dispens") || nameLower.includes("amount")) {
    return "volume";
  }

  // Dilution parameters that are volumes
  if (nameLower.includes("diluent") || nameLower.includes("sample") ||
      nameLower.includes("aliquot")) {
    return "volume";
  }

  // Repetition/count parameters
  if (nameLower.includes("rep") || nameLower.includes("count") ||
      nameLower.includes("cycle") || nameLower.includes("num_") ||
      nameLower.includes("n_") || nameLower.includes("iterations") ||
      nameLower.includes("steps")) {
    return "count";
  }

  // Mix parameters
  if (nameLower.includes("mix")) {
    // mix_volume → volume, mix_reps → count
    if (nameLower.includes("vol")) return "volume";
    if (nameLower.includes("rep") || nameLower.includes("time")) return "count";
    // Bare "mix" with small value → count, large value → volume
    return value <= 20 ? "count" : "volume";
  }

  // Speed parameters
  if (nameLower.includes("speed") || nameLower.includes("rate") ||
      nameLower.includes("flow")) {
    return "speed";
  }

  // Temperature
  if (nameLower.includes("temp") || commentLower.includes("celsius") ||
      commentLower.includes("°c")) {
    return "other";
  }

  // Delay/time parameters
  if (nameLower.includes("delay") || nameLower.includes("wait") ||
      nameLower.includes("pause") || nameLower.includes("time") ||
      commentLower.includes("sec") || commentLower.includes("min")) {
    return "other";
  }

  // Heuristic: if value looks like a volume (10-1000 range with no other category)
  if (value >= 1 && value <= 1000 && !nameLower.includes("well") &&
      !nameLower.includes("row") && !nameLower.includes("col")) {
    return "volume";
  }

  // Skip loop variables, indices, and unrelated assignments
  if (nameLower === "i" || nameLower === "j" || nameLower.includes("index") ||
      nameLower.includes("range")) {
    return "skip";
  }

  return "other";
}


/**
 * Detect the unit of a parameter.
 */
function detectUnit(name, comment, category) {
  const commentLower = comment.toLowerCase();

  if (commentLower.includes("ul") || commentLower.includes("µl") ||
      commentLower.includes("microliter")) return "µL";
  if (commentLower.includes("ml")) return "mL";
  if (commentLower.includes("nl")) return "nL";
  if (commentLower.includes("sec")) return "s";
  if (commentLower.includes("min")) return "min";
  if (commentLower.includes("°c") || commentLower.includes("celsius")) return "°C";
  if (commentLower.includes("mm/s") || commentLower.includes("ul/s")) return "µL/s";

  // Infer from category
  if (category === "volume") return "µL";
  if (category === "count") return "×";
  if (category === "speed") return "µL/s";

  return "";
}


// ============================================================
// Parameter UI Rendering
// ============================================================

/**
 * Render the parameter editor panel inside the deck info area.
 */
function renderParameterEditor(code) {
  const params = extractParameters(code);
  if (params.length === 0) return;

  const container = document.getElementById("deck-info");
  if (!container) return;

  // Don't replace existing content, append parameter editor
  let editorDiv = document.getElementById("param-editor");
  if (!editorDiv) {
    editorDiv = document.createElement("div");
    editorDiv.id = "param-editor";
    container.appendChild(editorDiv);
  }

  let html = `<div class="param-editor-header">
    <span class="param-editor-title">Protocol Parameters</span>
    <span class="param-editor-subtitle">Edit values to update the code</span>
  </div>`;

  // Group by category
  const groups = {};
  for (const p of params) {
    const cat = p.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(p);
  }

  const categoryLabels = {
    volume: "Volumes",
    count: "Repetitions & Counts",
    speed: "Speed & Flow",
    other: "Other Parameters",
  };

  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="param-category">${categoryLabels[cat] || cat}</div>`;

    for (const p of items) {
      const displayName = p.name.replace(/_/g, " ");
      const step = p.category === "count" ? "1" : p.category === "volume" ? "0.5" : "0.1";
      const min = p.category === "count" ? "1" : "0";

      html += `<div class="param-row" data-param-name="${p.name}">
        <div class="param-label">
          <span class="param-name">${displayName}</span>
          ${p.comment ? `<span class="param-comment">${p.comment}</span>` : ""}
        </div>
        <div class="param-input-group">
          <input type="number" 
                 class="param-input" 
                 value="${p.value}" 
                 step="${step}"
                 min="${min}"
                 data-param-name="${p.name}"
                 data-original-value="${p.value}"
                 onchange="onParamChange('${p.name}', this.value, ${p.value})"
                 onkeydown="if(event.key==='Enter'){this.blur()}" />
          <span class="param-unit">${p.unit}</span>
        </div>
      </div>`;
    }
  }

  editorDiv.innerHTML = html;
}


// ============================================================
// Parameter Update Logic
// ============================================================

/**
 * Called when a parameter value is changed by the user.
 * Updates the code and runs coherence checks.
 */
function onParamChange(paramName, newValueStr, oldValue) {
  const newValue = parseFloat(newValueStr);
  if (isNaN(newValue) || newValue === oldValue) return;
  if (!window.originalCode) return;

  let code = window.originalCode;

  // Replace the variable assignment line
  // Match: paramName = oldValue (with any whitespace/comment)
  const assignRegex = new RegExp(
    `^(\\s*${paramName}\\s*=\\s*)${escapeRegex(String(oldValue))}(\\s*(?:#.*)?)$`,
    "m"
  );

  if (assignRegex.test(code)) {
    code = code.replace(assignRegex, `$1${newValue}$2`);
  } else {
    // Fallback: try a simpler replacement
    code = code.replace(
      new RegExp(`(${paramName}\\s*=\\s*)${escapeRegex(String(oldValue))}`),
      `$1${newValue}`
    );
  }

  // --- Coherence checks ---
  const warnings = [];

  // Check volume against pipette range
  const params = extractParameters(code);
  const param = params.find(p => p.name === paramName);

  if (param && param.category === "volume" && window.PIPETTE_VOLUME_RANGE) {
    // Find which pipette is active
    const deckState = window.currentDeckState;
    if (deckState) {
      for (const [mount, pip] of Object.entries(deckState.pipettes || {})) {
        const range = window.PIPETTE_VOLUME_RANGE[pip.model];
        if (range) {
          if (newValue > range.max) {
            warnings.push(`${paramName} (${newValue} µL) exceeds ${pip.model} max (${range.max} µL)`);
          } else if (newValue < range.min && newValue > 0) {
            warnings.push(`${paramName} (${newValue} µL) below ${pip.model} min (${range.min} µL)`);
          }
        }
      }
    }
  }

  // Check count parameters are positive integers
  if (param && param.category === "count") {
    if (newValue < 1) {
      warnings.push(`${paramName} must be at least 1`);
    } else if (!Number.isInteger(newValue)) {
      warnings.push(`${paramName} should be a whole number`);
    }
  }

  if (warnings.length > 0 && window.showCoherenceWarnings) {
    window.showCoherenceWarnings(warnings);
  }

  // Update
  window.originalCode = code;
  if (window.updateCodeInChat) window.updateCodeInChat(code);

  // Update the data-original-value so the next change uses the correct old value
  const input = document.querySelector(`.param-input[data-param-name="${paramName}"]`);
  if (input) input.dataset.originalValue = String(newValue);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ============================================================
// Expose
// ============================================================

window.extractParameters = extractParameters;
window.renderParameterEditor = renderParameterEditor;
window.onParamChange = onParamChange;