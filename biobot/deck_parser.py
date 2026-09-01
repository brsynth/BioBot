"""
deck_parser.py — Extracts deck configuration from Opentrons OT-2 protocol code.

Parses Python protocol source to produce a JSON-serializable deck state:
  - slots: which labware is loaded where
  - pipettes: model, mount, associated tipracks
  - steps: transfer/aspirate/dispense actions

This parser uses regex (not AST) because the code comes from LLM output
and may not always be syntactically valid Python.
"""

import re
import json
import os
from config import get_api_key


def parse_protocol(code: str) -> dict:
    """
    Parse an Opentrons OT-2 protocol string and return a deck state dict.

    Returns:
        {
            "platform": "opentrons_ot2",
            "api_version": "2.15",
            "metadata": { ... },
            "slots": {
                "1": {"labware": "corning_96_wellplate_360ul_flat", "variable": "plate_1", "label": "Source Plate"},
                ...
            },
            "pipettes": {
                "right": {"model": "p300_single_gen2", "variable": "p300", "tipracks": ["3"]},
                ...
            },
            "modules": {
                "4": {"type": "temperature module", "variable": "temp_mod", "labware": ...},
                ...
            },
            "steps": [
                {"action": "transfer", "volume": 100, "source": "plate_1.wells()", "dest": "plate_2.wells()"},
                ...
            ]
        }
    """
    state = {
        "platform": "opentrons_ot2",
        "api_version": "",
        "metadata": {},
        "slots": {},
        "pipettes": {},
        "modules": {},
        "steps": [],
    }

    # --- API version ---
    api_match = re.search(r'apiLevel["\']?\s*[:=]\s*["\'](\d+\.\d+)', code)
    if api_match:
        state["api_version"] = api_match.group(1)

    # --- Metadata ---
    meta_match = re.search(r'metadata\s*=\s*\{([^}]+)\}', code, re.DOTALL)
    if meta_match:
        meta_str = meta_match.group(1)
        for kv in re.finditer(r'["\'](\w+)["\']\s*:\s*["\']([^"\']+)', meta_str):
            state["metadata"][kv.group(1)] = kv.group(2)

    # --- Variable name tracking (maps variable names to slot numbers) ---
    var_to_slot = {}

    # --- Load labware ---
    # Handles both single-line and multiline load_labware calls:
    #   plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 1, "Label")
    #   plate = protocol.load_labware(
    #       "corning_96_wellplate_360ul_flat",
    #       "1",
    #       label="Label",
    #   )
    # Step 1: Find all load_labware assignments with their full argument block
    labware_assign_pattern = re.compile(
        r'(\w+)\s*=\s*\w+\.load_labware\(', re.MULTILINE
    )
    for m in labware_assign_pattern.finditer(code):
        var_name = m.group(1)
        start = m.end()  # position after the opening (

        # Find matching closing paren
        depth = 1
        pos = start
        while pos < len(code) and depth > 0:
            if code[pos] == '(':
                depth += 1
            elif code[pos] == ')':
                depth -= 1
            pos += 1
        args_block = code[start:pos - 1]  # everything between ( and )

        # Step 2: Extract labware name (first quoted string)
        name_match = re.search(r'["\']([^"\']+)["\']', args_block)
        if not name_match:
            continue
        labware_name = name_match.group(1)

        # Step 3: Extract slot number — could be positional or after a comma
        # Remove the labware name from the block to find the slot
        remaining = args_block[name_match.end():]
        slot_match = re.search(r'["\']?(\d{1,2})["\']?', remaining)
        if not slot_match:
            continue
        slot = str(slot_match.group(1))

        # Step 4: Extract label — could be positional or keyword
        label = ""
        label_kw = re.search(r'label\s*=\s*["\']([^"\']*)["\']', args_block)
        if label_kw:
            label = label_kw.group(1)
        else:
            # Check for third positional string after the slot
            after_slot = remaining[slot_match.end():]
            pos_label = re.search(r'["\']([^"\']+)["\']', after_slot)
            if pos_label and not pos_label.group(1).startswith(("new_tip", "True", "False")):
                label = pos_label.group(1)

        state["slots"][slot] = {
            "labware": labware_name,
            "variable": var_name,
            "label": label,
        }
        var_to_slot[var_name] = slot

    # --- Load modules ---
    # Handles multiline: temp_mod = protocol.load_module("temperature module gen2", 4)
    module_assign_pattern = re.compile(
        r'(\w+)\s*=\s*\w+\.load_module\(', re.MULTILINE
    )
    for m in module_assign_pattern.finditer(code):
        var_name = m.group(1)
        start = m.end()
        depth = 1
        pos = start
        while pos < len(code) and depth > 0:
            if code[pos] == '(':
                depth += 1
            elif code[pos] == ')':
                depth -= 1
            pos += 1
        args_block = code[start:pos - 1]

        name_match = re.search(r'["\']([^"\']+)["\']', args_block)
        if not name_match:
            continue
        module_type = name_match.group(1)

        remaining = args_block[name_match.end():]
        slot_match = re.search(r'["\']?(\d{1,2})["\']?', remaining)
        if not slot_match:
            continue
        slot = str(slot_match.group(1))

        state["modules"][slot] = {
            "type": module_type,
            "variable": var_name,
            "labware": None,
        }

    # Labware loaded on modules:
    # plate_on_mod = temp_mod.load_labware("corning_96_wellplate_360ul_flat")
    mod_labware_pattern = re.compile(
        r'(\w+)\s*=\s*(\w+)\.load_labware\(\s*'
        r'["\']([^"\']+)["\']\s*'
        r'(?:,\s*["\']([^"\']*)["\'])?\s*\)',
        re.MULTILINE
    )
    # Build module var → slot map
    mod_var_to_slot = {v["variable"]: s for s, v in state["modules"].items()}

    for m in mod_labware_pattern.finditer(code):
        var_name = m.group(1)
        parent_var = m.group(2)
        labware_name = m.group(3)
        label = m.group(4) or ""

        if parent_var in mod_var_to_slot:
            slot = mod_var_to_slot[parent_var]
            state["modules"][slot]["labware"] = {
                "labware": labware_name,
                "variable": var_name,
                "label": label,
            }
            var_to_slot[var_name] = slot

    # --- Load pipettes ---
    # Flexible matching for various LLM output formats:
    #   p300 = protocol.load_instrument("p300_single_gen2", "right", tip_racks=[tiprack_1])
    #   p300 = protocol.load_instrument("p300_single_gen2", mount="right", tip_racks=[tiprack_1])
    #   p300 = protocol.load_instrument(\n    "p300_single_gen2", "right", tip_racks=[tiprack_1]\n)
    pipette_pattern = re.compile(
        r'(\w+)\s*=\s*\w+\.load_instrument\(\s*'
        r'["\']([^"\']+)["\']\s*,\s*'                      # pipette model
        r'(?:mount\s*=\s*)?["\']?(left|right)["\']?'        # mount
        r'[^)]*\)',                                          # rest of args until closing paren
        re.DOTALL
    )
    for m in pipette_pattern.finditer(code):
        var_name = m.group(1)
        model = m.group(2)
        mount = m.group(3)

        # Extract tipracks from the full match
        full_match = m.group(0)
        tiprack_match = re.search(r'tip_racks?\s*=\s*\[([^\]]*)\]', full_match)
        tipracks_str = tiprack_match.group(1) if tiprack_match else ""

        # Resolve tiprack variable names to slot numbers
        tiprack_vars = [t.strip() for t in tipracks_str.split(",") if t.strip()]
        tiprack_slots = [var_to_slot[v] for v in tiprack_vars if v in var_to_slot]

        state["pipettes"][mount] = {
            "model": model,
            "variable": var_name,
            "tipracks": tiprack_slots,
        }

    # --- Parse steps ---
    # Transfer: p300.transfer(100, plate_1.wells(), plate_2.wells())
    transfer_pattern = re.compile(
        r'(\w+)\.transfer\(\s*'
        r'(\d+(?:\.\d+)?)\s*,\s*'     # volume
        r'([^,]+)\s*,\s*'              # source
        r'([^,\)]+)'                    # destination
        r'(?:\s*,\s*(.+?))?'           # optional kwargs
        r'\s*\)',
        re.MULTILINE
    )
    for m in transfer_pattern.finditer(code):
        step = {
            "action": "transfer",
            "pipette": m.group(1),
            "volume": float(m.group(2)),
            "source": m.group(3).strip(),
            "dest": m.group(4).strip(),
        }
        kwargs_str = m.group(5)
        if kwargs_str:
            if "new_tip" in kwargs_str:
                tip_match = re.search(r'new_tip\s*=\s*["\'](\w+)', kwargs_str)
                if tip_match:
                    step["new_tip"] = tip_match.group(1)
            if "mix_before" in kwargs_str:
                step["mix_before"] = True
            if "mix_after" in kwargs_str:
                step["mix_after"] = True
        state["steps"].append(step)

    # Aspirate: p300.aspirate(100, plate["A1"])
    aspirate_pattern = re.compile(
        r'(\w+)\.aspirate\(\s*'
        r'(\d+(?:\.\d+)?)\s*,\s*'
        r'(.+?)\s*\)',
        re.MULTILINE
    )
    for m in aspirate_pattern.finditer(code):
        state["steps"].append({
            "action": "aspirate",
            "pipette": m.group(1),
            "volume": float(m.group(2)),
            "location": m.group(3).strip(),
        })

    # Dispense: p300.dispense(100, plate["B1"])
    dispense_pattern = re.compile(
        r'(\w+)\.dispense\(\s*'
        r'(\d+(?:\.\d+)?)\s*,\s*'
        r'(.+?)\s*\)',
        re.MULTILINE
    )
    for m in dispense_pattern.finditer(code):
        state["steps"].append({
            "action": "dispense",
            "pipette": m.group(1),
            "volume": float(m.group(2)),
            "location": m.group(3).strip(),
        })

    # --- Always include fixed trash in slot 12 ---
    if "12" not in state["slots"]:
        state["slots"]["12"] = {
            "labware": "opentrons_1_trash_1100ml_fixed",
            "variable": "fixed_trash",
            "label": "Trash",
        }

    return state


def deck_state_to_json(code: str) -> str:
    """Parse protocol code and return JSON string."""
    return json.dumps(parse_protocol(code), indent=2)


def generate_protocol(state: dict) -> str:
    """
    Generate an Opentrons OT-2 Python protocol from a deck state dict.
    This is the reverse of parse_protocol() — used as a fallback only.
    Prefer update_slots_in_code() which preserves the original code.
    """
    api_version = state.get("api_version", "2.15")
    metadata = state.get("metadata", {})
    slots = state.get("slots", {})
    pipettes = state.get("pipettes", {})
    modules = state.get("modules", {})
    steps = state.get("steps", [])

    lines = []
    lines.append("from opentrons import protocol_api")
    lines.append("")

    meta_parts = [f'    "apiLevel": "{api_version}"']
    for k, v in metadata.items():
        if k != "apiLevel":
            meta_parts.append(f'    "{k}": "{v}"')
    lines.append("metadata = {")
    lines.append(",\n".join(meta_parts))
    lines.append("}")
    lines.append("")
    lines.append("def run(protocol: protocol_api.ProtocolContext):")
    lines.append("")

    lines.append("    # Labware")
    for slot_num in sorted(slots.keys(), key=int):
        slot = slots[slot_num]
        if slot_num == "12":
            continue
        var = slot.get("variable", f"labware_{slot_num}")
        labware = slot.get("labware", "")
        label = slot.get("label", "")
        if label:
            lines.append(f'    {var} = protocol.load_labware("{labware}", {slot_num}, "{label}")')
        else:
            lines.append(f'    {var} = protocol.load_labware("{labware}", {slot_num})')
    lines.append("")

    if pipettes:
        lines.append("    # Pipettes")
        for mount in ["left", "right"]:
            if mount in pipettes:
                pip = pipettes[mount]
                var = pip.get("variable", f"pipette_{mount}")
                model = pip.get("model", "")
                tiprack_slots = pip.get("tipracks", [])
                tiprack_vars = []
                for ts in tiprack_slots:
                    if ts in slots:
                        tiprack_vars.append(slots[ts].get("variable", f"labware_{ts}"))
                if tiprack_vars:
                    racks_str = ", ".join(tiprack_vars)
                    lines.append(f'    {var} = protocol.load_instrument("{model}", "{mount}", tip_racks=[{racks_str}])')
                else:
                    lines.append(f'    {var} = protocol.load_instrument("{model}", "{mount}")')
        lines.append("")

    if steps:
        lines.append("    # Protocol steps")
        for step in steps:
            action = step.get("action", "")
            pip_var = step.get("pipette", "pipette")
            if action == "transfer":
                vol = step.get("volume", 0)
                src = step.get("source", "")
                dst = step.get("dest", "")
                extra = ""
                if step.get("new_tip"):
                    extra += f', new_tip="{step["new_tip"]}"'
                lines.append(f"    {pip_var}.transfer({vol}, {src}, {dst}{extra})")
            elif action == "aspirate":
                vol = step.get("volume", 0)
                loc = step.get("location", "")
                lines.append(f"    {pip_var}.aspirate({vol}, {loc})")
            elif action == "dispense":
                vol = step.get("volume", 0)
                loc = step.get("location", "")
                lines.append(f"    {pip_var}.dispense({vol}, {loc})")
    lines.append("")
    return "\n".join(lines)


def update_slots_in_code(original_code: str, slot_changes: dict) -> str:
    """
    Update slot numbers in the original code without regenerating it.
    
    slot_changes: dict mapping old_slot → new_slot, e.g. {"4": "5", "5": "4"}
    
    This preserves all variables, loops, comments, and logic — only the
    slot numbers in load_labware() and load_module() calls are changed.
    """
    code = original_code

    # Use a placeholder to avoid double-replacement
    # e.g. changing 4→5 and 5→4 would break without placeholders
    placeholder_map = {}
    for old_slot, new_slot in slot_changes.items():
        placeholder = f"__SLOT_PLACEHOLDER_{old_slot}__"
        placeholder_map[placeholder] = new_slot

        # Match load_labware(..., "4") or load_labware(..., 4) or load_labware(..., '4')
        # The slot number appears as the second argument to load_labware
        code = re.sub(
            r'(\.load_labware\([^,]+,\s*)["\']?' + re.escape(old_slot) + r'["\']?(\s*[,\)])',
            r'\g<1>' + placeholder + r'\2',
            code
        )
        # Same for load_module
        code = re.sub(
            r'(\.load_module\([^,]+,\s*)["\']?' + re.escape(old_slot) + r'["\']?(\s*[,\)])',
            r'\g<1>' + placeholder + r'\2',
            code
        )

    # Replace placeholders with actual new slot numbers
    for placeholder, new_slot in placeholder_map.items():
        code = code.replace(placeholder, new_slot)

    return code


# --- CLI usage ---
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            code = f.read()
    else:
        code = sys.stdin.read()
    print(json.dumps(parse_any(code), indent=2))


# ============================================================
# Platform Detection
# ============================================================

def detect_platform(content: str) -> str:
    """Detect which platform the content is for."""
    content_lower = content.lower()

    # OT-2: Python protocol with load_labware / protocol_api
    if "protocol_api" in content_lower or "load_labware" in content_lower or "load_instrument" in content_lower:
        return "opentrons_ot2"

    # Hamilton STAR: PyHamilton / PyLabRobot / VENUS patterns
    if "pyhamilton" in content_lower or "pylabrobot" in content_lower or \
       "starbackend" in content_lower or "stardeck" in content_lower or \
       "starletdeck" in content_lower or "hamiltoninterface" in content_lower or \
       "tip_car_" in content_lower or "plt_car_" in content_lower or \
       "assign_child_resource" in content_lower or "co-re" in content_lower or \
       ("ml_star" in content_lower and "channel" in content_lower):
        return "hamilton_star"

    # Echo: CSV picklist detection — check multiple patterns
    lines = content.strip().split("\n")
    if len(lines) >= 2:
        header = lines[0].lower()

        # Standard Echo CSV headers
        if ("source" in header and "destination" in header) or \
           ("source plate" in header and "destination plate" in header) or \
           ("source well" in header and "destination well" in header) or \
           ("source well" in header and "volume" in header):
            return "echo_650"

        # No header but data looks like well references with volumes
        first_data = lines[1] if len(lines) > 1 else lines[0]
        fields = first_data.split(",")
        if len(fields) >= 3:
            # Check if any field looks like a well reference (A1, B12, P24, etc.)
            well_pattern = re.compile(r'^[A-P]\d{1,2}$')
            well_fields = [f.strip() for f in fields if well_pattern.match(f.strip())]
            if len(well_fields) >= 2:
                return "echo_650"

    # Check for comma-heavy content with well references
    if content.count(",") > 5 and content.count("\n") > 2:
        well_pattern = re.compile(r'[A-P]\d{1,2}')
        wells_found = well_pattern.findall(content)
        if len(wells_found) > 4:
            # Check if it has volume-like numbers
            num_pattern = re.compile(r'\b\d{2,6}\b')
            nums = num_pattern.findall(content)
            if len(nums) > 2:
                return "echo_650"

    return "unknown"


def parse_any(content: str, context: str = "", api_key: str = None) -> dict:
    """
    Auto-detect platform and parse accordingly.
    
    Strategy: try regex first (fast, free). If the result is empty or
    incomplete, fall back to LLM-based parsing (slower but understands
    any code format).
    
    Args:
        content: The generated protocol code or CSV
        context: Optional consolidated query for additional context
        api_key: OpenAI API key for LLM fallback
    """
    platform = detect_platform(content)

    # --- Try regex-based parsing first ---
    state = None
    if platform == "opentrons_ot2":
        state = parse_protocol(content)
        # Check if regex found anything meaningful
        has_slots = len([s for s in state.get("slots", {}) if s != "12"]) > 0
        has_pipettes = len(state.get("pipettes", {})) > 0
        if has_slots or has_pipettes:
            return state
    elif platform == "hamilton_star":
        state = parse_hamilton(content)
        if len(state.get("carriers", [])) > 0:
            return state
    elif platform == "echo_650":
        state = parse_echo_csv(content)
        if len(state.get("transfers", [])) > 0:
            return state

    # --- Regex failed or returned empty → LLM fallback ---
    try:
        llm_state = _parse_with_llm(content, platform, context, api_key)
        if llm_state and not llm_state.get("error"):
            return llm_state
    except Exception as e:
        print(f"LLM parse fallback error: {e}", flush=True)

    # Return whatever regex gave us (even if empty)
    if state:
        return state
    return {"platform": platform or "unknown", "error": "Could not parse protocol"}


# ============================================================
# LLM-Based Parser (fallback when regex fails)
# ============================================================

_LLM_PARSE_PROMPT = """You are an expert in laboratory automation. Given a protocol code, extract the deck layout as a JSON object.

Return ONLY valid JSON. No markdown fences, no explanation.

Detect the platform and return the EXACT structure for that platform:

--- If Opentrons OT-2 ---
{
  "platform": "opentrons_ot2",
  "api_version": "<e.g. 2.15>",
  "metadata": {"protocolName": "...", "author": "..."},
  "slots": {
    "<slot_number>": {
      "labware": "<full API load name, e.g. corning_96_wellplate_360ul_flat>",
      "variable": "<variable name in code>",
      "label": "<label if any>"
    }
  },
  "pipettes": {
    "<left|right>": {
      "model": "<e.g. p300_single_gen2>",
      "variable": "<variable name>",
      "tipracks": ["<slot numbers of associated tipracks>"]
    }
  },
  "modules": {},
  "steps": [
    {"action": "<transfer|aspirate|dispense>", "volume": <number>, "source": "...", "dest": "..."}
  ]
}

IMPORTANT for OT-2:
- Slot 12 is ALWAYS trash: "12": {"labware": "opentrons_1_trash_1100ml_fixed", "variable": "trash", "label": "Trash"}
- Include ALL labware even if loaded inside lists, loops, or comprehensions
- The slot number must be a string: "1", "2", etc.
- For tipracks, the slot number in the tipracks array must match the slot where the tiprack is loaded

--- If Hamilton STAR ---
{
  "platform": "hamilton_star",
  "carriers": [
    {
      "variable": "<var name>",
      "type": "<e.g. TIP_CAR_480_A00>",
      "display_name": "<human name>",
      "carrier_type": "<tip|plate|tube|reservoir|trash>",
      "rails": <rail number>,
      "num_positions": <number>,
      "positions": [
        {"index": 0, "labware_type": "<type or null>", "labware_variable": "<var or null>"}
      ]
    }
  ],
  "channels": {"count": <8|16>, "type": "<e.g. 1mL CO-RE>", "variable": "<var>"},
  "head_96": <true|false>,
  "head_384": <true|false>,
  "trash": {"variable": "<var>", "rails": <number>},
  "parameters": [],
  "transfers": []
}

--- If Echo 650 (CSV picklist) ---
{
  "platform": "echo_650",
  "source_plate": {"name": "...", "type": "...", "wells_used": ["A1","A2"], "format": 384},
  "destination_plate": {"name": "...", "type": "...", "wells_used": ["B1","B2"], "format": 384},
  "transfers": [{"source_well": "A1", "dest_well": "B1", "volume_nl": 2500}],
  "summary": {"total_transfers": 5, "total_volume_nl": 12500, "min_volume_nl": 2500, "max_volume_nl": 2500, "unique_source_wells": 5, "unique_dest_wells": 5}
}

CRITICAL RULES:
- Return ONLY valid JSON. No extra text.
- Include every piece of labware, even inside lists or comprehensions.
- Use the exact field names shown above — the renderers depend on them.
- For steps/transfers, summarize loops (don't list every iteration).
"""


def _parse_with_llm(code: str, platform_hint: str = "", context: str = "", api_key: str = None) -> dict:
    """
    Use GPT-4o-mini to extract deck state from protocol code.
    Returns the same JSON structures that the regex parsers return,
    so the existing renderers work without changes.
    """
    from openai import OpenAI

    key = api_key or os.environ.get("API_KEY") or get_api_key()
    client = OpenAI(api_key=key)

    user_msg = f"Extract the deck layout from this protocol code:\n\n{code}"
    if context:
        user_msg += f"\n\nAdditional context about what the user requested:\n{context}"
    if platform_hint and platform_hint != "unknown":
        user_msg += f"\n\nDetected platform hint: {platform_hint}"

    try:
        response = client.responses.create(
            model="gpt-4o-mini",
            input=[
                {"role": "system", "content": _LLM_PARSE_PROMPT},
                {"role": "user", "content": user_msg}
            ],
        )

        result = response.output_text.strip()

        # Clean markdown fences if present
        if result.startswith("```"):
            result = result.split("\n", 1)[1] if "\n" in result else result[3:]
        if result.endswith("```"):
            result = result[:-3].strip()
        if result.lstrip().startswith("json"):
            result = result.lstrip()[4:].strip()

        state = json.loads(result)

        # Ensure trash slot for OT-2
        if state.get("platform") == "opentrons_ot2":
            if "12" not in state.get("slots", {}):
                state.setdefault("slots", {})["12"] = {
                    "labware": "opentrons_1_trash_1100ml_fixed",
                    "variable": "trash",
                    "label": "Trash",
                }

        return state

    except json.JSONDecodeError as e:
        print(f"LLM parse JSON error: {e}", flush=True)
        return {"platform": platform_hint or "unknown", "error": f"JSON parse failed: {e}"}
    except Exception as e:
        print(f"LLM parse error: {e}", flush=True)
        return {"platform": platform_hint or "unknown", "error": str(e)}


# ============================================================
# Hamilton STAR Parser
# ============================================================

def parse_hamilton(code: str) -> dict:
    """
    Parse a Hamilton STAR protocol (PyLabRobot/PyHamilton style) and return
    a visualization state.
    
    Returns:
        {
            "platform": "hamilton_star",
            "carriers": [
                {
                    "variable": "tip_car",
                    "type": "TIP_CAR_480_A00",
                    "display_name": "Tip Carrier",
                    "carrier_type": "tip",
                    "rails": 3,
                    "num_positions": 5,
                    "positions": [
                        {"index": 0, "labware_type": "...", "labware_variable": "tips_01"},
                        {"index": 1, "labware_type": null},
                        ...
                    ]
                }
            ],
            "channels": {"count": 8, "type": "1mL", "variable": "lh"},
            "head_96": false,
            "head_384": false,
            "trash": {"variable": "trash", "rails": 32},
            "parameters": [],
            "transfers": []
        }
    """
    state = {
        "platform": "hamilton_star",
        "carriers": [],
        "channels": {"count": 8, "type": "1mL CO-RE", "variable": "lh"},
        "head_96": False,
        "head_384": False,
        "trash": None,
        "parameters": [],
        "transfers": [],
    }

    carrier_vars = {}  # variable_name → carrier info

    # --- Detect carrier creation ---
    # Pattern: tip_car = TIP_CAR_480_A00(name="tip carrier")
    # Pattern: plt_car = PLT_CAR_L5AC_A00(name="plate carrier")
    carrier_pattern = re.compile(
        r'(\w+)\s*=\s*([A-Z_]+\w*)\(\s*name\s*=\s*["\']([^"\']*)["\']',
        re.MULTILINE
    )
    for m in carrier_pattern.finditer(code):
        var_name = m.group(1)
        carrier_type = m.group(2)
        display_name = m.group(3)

        # Determine carrier category from the type name
        ctype = carrier_type.upper()
        if "TIP" in ctype:
            cat = "tip"
        elif "PLT" in ctype or "PLATE" in ctype:
            cat = "plate"
        elif "TUBE" in ctype or "RACK" in ctype:
            cat = "tube"
        elif "TRASH" in ctype:
            cat = "trash"
        elif "TROUGH" in ctype or "RES" in ctype:
            cat = "reservoir"
        else:
            cat = "other"

        # Determine number of positions (most Hamilton carriers have 5)
        num_pos = 5
        if "1" in carrier_type and "CAR" in carrier_type:
            num_pos = 1

        carrier = {
            "variable": var_name,
            "type": carrier_type,
            "display_name": display_name,
            "carrier_type": cat,
            "rails": 0,
            "num_positions": num_pos,
            "positions": [{"index": i, "labware_type": None, "labware_variable": None} for i in range(num_pos)],
        }
        carrier_vars[var_name] = carrier
        state["carriers"].append(carrier)

    # --- Detect labware loaded into carrier positions ---
    # Pattern: tip_car[0] = hamilton_96_tiprack_1000uL_filter(name="tips_01")
    labware_pattern = re.compile(
        r'(\w+)\[(\d+)\]\s*=\s*(\w+)\(\s*name\s*=\s*["\']([^"\']*)["\']',
        re.MULTILINE
    )
    for m in labware_pattern.finditer(code):
        carrier_var = m.group(1)
        pos_index = int(m.group(2))
        labware_type = m.group(3)
        labware_name = m.group(4)

        if carrier_var in carrier_vars:
            carrier = carrier_vars[carrier_var]
            if pos_index < len(carrier["positions"]):
                carrier["positions"][pos_index] = {
                    "index": pos_index,
                    "labware_type": labware_type,
                    "labware_variable": labware_name,
                }

    # --- Detect rail assignments ---
    # Pattern: lh.deck.assign_child_resource(tip_car, rails=3)
    # Pattern: deck.assign_child_resource(tip_car, rails=3)
    rails_pattern = re.compile(
        r'\.assign_child_resource\(\s*(\w+)\s*,\s*rails\s*=\s*(\d+)',
        re.MULTILINE
    )
    for m in rails_pattern.finditer(code):
        carrier_var = m.group(1)
        rails = int(m.group(2))
        if carrier_var in carrier_vars:
            carrier_vars[carrier_var]["rails"] = rails

    # --- Detect trash ---
    # Pattern: trash = ... Trash(name="trash")
    trash_match = re.search(r'(\w+)\s*=\s*\w*Trash\w*\(\s*name\s*=\s*["\']([^"\']*)', code)
    if trash_match:
        state["trash"] = {"variable": trash_match.group(1), "rails": 0}
        # Check for rail assignment
        trash_rails = re.search(r'assign_child_resource\(\s*' + trash_match.group(1) + r'\s*,\s*rails\s*=\s*(\d+)', code)
        if trash_rails:
            state["trash"]["rails"] = int(trash_rails.group(1))

    # --- Detect channels ---
    if "96" in code and ("probe" in code.lower() or "head" in code.lower()):
        state["head_96"] = True
    if "384" in code and ("probe" in code.lower() or "head" in code.lower() or "multiprobe" in code.lower()):
        state["head_384"] = True

    # Count channels from the code
    channel_match = re.search(r'(\d+)\s*(?:channel|ch\b)', code.lower())
    if channel_match:
        state["channels"]["count"] = int(channel_match.group(1))

    # --- Detect transfers ---
    # PyLabRobot style: lh.aspirate(tiprack["A1:C1"], vols=[100, 100, 100])
    aspirate_pattern = re.compile(
        r'(\w+)\.aspirate\(\s*(\w+(?:\[.+?\])?)\s*,\s*(?:vols?\s*=\s*\[([^\]]+)\]|(\d+(?:\.\d+)?))',
        re.MULTILINE
    )
    for m in aspirate_pattern.finditer(code):
        vols = m.group(3) or m.group(4) or "0"
        state["transfers"].append({
            "action": "aspirate",
            "source": m.group(2),
            "volume": vols.split(",")[0].strip() if "," in vols else vols,
        })

    dispense_pattern = re.compile(
        r'(\w+)\.dispense\(\s*(\w+(?:\[.+?\])?)\s*,\s*(?:vols?\s*=\s*\[([^\]]+)\]|(\d+(?:\.\d+)?))',
        re.MULTILINE
    )
    for m in dispense_pattern.finditer(code):
        vols = m.group(3) or m.group(4) or "0"
        state["transfers"].append({
            "action": "dispense",
            "destination": m.group(2),
            "volume": vols.split(",")[0].strip() if "," in vols else vols,
        })

    # Sort carriers by rail position
    state["carriers"].sort(key=lambda c: c.get("rails", 0))

    return state


# ============================================================
# Echo 650 CSV Picklist Parser
# ============================================================

def parse_echo_csv(content: str) -> dict:
    """
    Parse an Echo 650 CSV picklist and return a visualization state.

    Handles multiple CSV formats:
    - Standard: Source Plate Name, Source Plate Type, Source Well, Destination Plate Name,
                Destination Plate Type, Destination Well, Transfer Volume (nL)
    - Simple:   Source Well, Destination Well, Transfer Volume
    - With headers or without

    Returns:
        {
            "platform": "echo_650",
            "source_plate": {
                "name": "SourcePlate1",
                "type": "384PP_AQ_BP",
                "wells_used": ["A1", "A2", ...],
                "format": 384
            },
            "destination_plate": {
                "name": "DestinationPlate1",
                "type": "384PP_AQ_BP",
                "wells_used": ["B1", "B2", ...],
                "format": 384
            },
            "transfers": [
                {"source_well": "A1", "dest_well": "B1", "volume_nl": 15000},
                ...
            ],
            "summary": {
                "total_transfers": 5,
                "total_volume_nl": 75000,
                "min_volume_nl": 15000,
                "max_volume_nl": 15000,
                "unique_source_wells": 5,
                "unique_dest_wells": 5
            }
        }
    """
    state = {
        "platform": "echo_650",
        "source_plate": {
            "name": "",
            "type": "",
            "wells_used": [],
            "format": 384,
        },
        "destination_plate": {
            "name": "",
            "type": "",
            "wells_used": [],
            "format": 384,
        },
        "transfers": [],
        "summary": {},
    }

    lines = content.strip().split("\n")
    if not lines:
        return state

    # Detect header row and column mapping
    header_line = lines[0]
    col_map = _detect_echo_columns(header_line)

    # If first line looks like a header, skip it
    data_start = 1 if col_map["has_header"] else 0

    source_wells = set()
    dest_wells = set()
    volumes = []

    for line in lines[data_start:]:
        line = line.strip()
        if not line:
            continue

        fields = _split_csv_line(line)
        if len(fields) < max(col_map["indices"].values()) + 1:
            continue

        transfer = {}

        # Source plate info
        if "source_plate_name" in col_map["indices"]:
            src_name = fields[col_map["indices"]["source_plate_name"]].strip()
            if src_name and not state["source_plate"]["name"]:
                state["source_plate"]["name"] = src_name

        if "source_plate_type" in col_map["indices"]:
            src_type = fields[col_map["indices"]["source_plate_type"]].strip()
            if src_type and not state["source_plate"]["type"]:
                state["source_plate"]["type"] = src_type

        # Destination plate info
        if "dest_plate_name" in col_map["indices"]:
            dst_name = fields[col_map["indices"]["dest_plate_name"]].strip()
            if dst_name and not state["destination_plate"]["name"]:
                state["destination_plate"]["name"] = dst_name

        if "dest_plate_type" in col_map["indices"]:
            dst_type = fields[col_map["indices"]["dest_plate_type"]].strip()
            if dst_type and not state["destination_plate"]["type"]:
                state["destination_plate"]["type"] = dst_type

        # Wells and volume
        src_well_idx = col_map["indices"].get("source_well")
        dst_well_idx = col_map["indices"].get("dest_well")
        vol_idx = col_map["indices"].get("volume")

        if src_well_idx is not None and dst_well_idx is not None:
            src_well = fields[src_well_idx].strip()
            dst_well = fields[dst_well_idx].strip()

            vol = 0
            if vol_idx is not None:
                try:
                    vol = float(fields[vol_idx].strip())
                except (ValueError, IndexError):
                    vol = 0

            transfer = {
                "source_well": src_well,
                "dest_well": dst_well,
                "volume_nl": vol,
            }
            state["transfers"].append(transfer)
            source_wells.add(src_well)
            dest_wells.add(dst_well)
            volumes.append(vol)

    # Determine plate format from wells
    state["source_plate"]["format"] = _detect_plate_format(source_wells)
    state["destination_plate"]["format"] = _detect_plate_format(dest_wells)
    state["source_plate"]["wells_used"] = sorted(source_wells, key=_well_sort_key)
    state["destination_plate"]["wells_used"] = sorted(dest_wells, key=_well_sort_key)

    # Summary
    if volumes:
        state["summary"] = {
            "total_transfers": len(state["transfers"]),
            "total_volume_nl": sum(volumes),
            "min_volume_nl": min(volumes),
            "max_volume_nl": max(volumes),
            "unique_source_wells": len(source_wells),
            "unique_dest_wells": len(dest_wells),
        }

    return state


def _detect_echo_columns(header_line: str) -> dict:
    """Detect column positions from a CSV header line."""
    fields = [f.strip().lower() for f in header_line.split(",")]

    col_map = {"has_header": False, "indices": {}}

    # Check if this looks like a header
    header_keywords = ["source", "destination", "well", "volume", "plate"]
    if any(kw in " ".join(fields) for kw in header_keywords):
        col_map["has_header"] = True

        for i, f in enumerate(fields):
            if "source" in f and "plate" in f and "name" in f:
                col_map["indices"]["source_plate_name"] = i
            elif "source" in f and "plate" in f and "type" in f:
                col_map["indices"]["source_plate_type"] = i
            elif "source" in f and "well" in f:
                col_map["indices"]["source_well"] = i
            elif "destination" in f and "plate" in f and "name" in f:
                col_map["indices"]["dest_plate_name"] = i
            elif "destination" in f and "plate" in f and "type" in f:
                col_map["indices"]["dest_plate_type"] = i
            elif "destination" in f and "well" in f:
                col_map["indices"]["dest_well"] = i
            elif "volume" in f or "transfer" in f and "volume" in f:
                col_map["indices"]["volume"] = i
    else:
        # No header — assume standard Echo format:
        # SourcePlateName, SourcePlateType, SourceWell, DestPlateName, DestPlateType, DestWell, Volume
        if len(fields) >= 7:
            col_map["indices"] = {
                "source_plate_name": 0, "source_plate_type": 1, "source_well": 2,
                "dest_plate_name": 3, "dest_plate_type": 4, "dest_well": 5,
                "volume": 6,
            }
        elif len(fields) >= 3:
            # Simple: SourceWell, DestWell, Volume
            col_map["indices"] = {"source_well": 0, "dest_well": 1, "volume": 2}

    return col_map


def _split_csv_line(line: str) -> list:
    """Split a CSV line handling quoted fields."""
    fields = []
    current = ""
    in_quotes = False
    for ch in line:
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == ',' and not in_quotes:
            fields.append(current)
            current = ""
        else:
            current += ch
    fields.append(current)
    return fields


def _detect_plate_format(wells: set) -> int:
    """Detect plate format (96, 384, 1536) from well references."""
    if not wells:
        return 384  # default for Echo
    max_row = 0
    max_col = 0
    for well in wells:
        match = re.match(r'([A-P])(\d{1,2})', well)
        if match:
            row = ord(match.group(1)) - ord('A') + 1
            col = int(match.group(2))
            max_row = max(max_row, row)
            max_col = max(max_col, col)

    if max_row > 16 or max_col > 24:
        return 1536
    elif max_row > 8 or max_col > 12:
        return 384
    else:
        return 96


def _well_sort_key(well: str):
    """Sort wells by row then column: A1, A2, ..., B1, B2, ..."""
    match = re.match(r'([A-P])(\d{1,2})', well)
    if match:
        return (ord(match.group(1)), int(match.group(2)))
    return (0, 0)


def update_echo_csv(original_csv: str, changes: dict) -> str:
    """
    Update an Echo CSV picklist with changes.

    changes can contain:
    - "modify": [{"index": 0, "volume_nl": 25000}, ...] — change transfer volume
    - "remove": [0, 3, 5] — remove transfers by index
    - "add": [{"source_well": "A6", "dest_well": "B6", "volume_nl": 15000}] — add transfers
    - "source_plate_type": "384LDV_AQ_BP" — change source plate type
    - "dest_plate_type": "384PP_AQ_GP" — change destination plate type
    """
    lines = original_csv.strip().split("\n")
    if not lines:
        return original_csv

    col_map = _detect_echo_columns(lines[0])
    data_start = 1 if col_map["has_header"] else 0
    header = lines[0] if col_map["has_header"] else None

    data_lines = lines[data_start:]

    # Remove transfers (process in reverse to keep indices stable)
    if "remove" in changes:
        for idx in sorted(changes["remove"], reverse=True):
            if 0 <= idx < len(data_lines):
                data_lines.pop(idx)

    # Modify transfer volumes
    if "modify" in changes:
        vol_idx = col_map["indices"].get("volume")
        for mod in changes["modify"]:
            idx = mod.get("index", -1)
            if 0 <= idx < len(data_lines) and vol_idx is not None:
                fields = _split_csv_line(data_lines[idx])
                if len(fields) > vol_idx:
                    fields[vol_idx] = str(mod.get("volume_nl", fields[vol_idx]))
                    data_lines[idx] = ",".join(fields)

    # Add new transfers
    if "add" in changes:
        for new_transfer in changes["add"]:
            # Build a new line matching the existing format
            if header and col_map["indices"]:
                # Use the format from the first existing data line as a template
                if data_lines:
                    template_fields = _split_csv_line(data_lines[0])
                    new_fields = template_fields.copy()

                    if "source_well" in col_map["indices"]:
                        new_fields[col_map["indices"]["source_well"]] = new_transfer.get("source_well", "A1")
                    if "dest_well" in col_map["indices"]:
                        new_fields[col_map["indices"]["dest_well"]] = new_transfer.get("dest_well", "A1")
                    if "volume" in col_map["indices"]:
                        new_fields[col_map["indices"]["volume"]] = str(new_transfer.get("volume_nl", 0))

                    data_lines.append(",".join(new_fields))
                else:
                    data_lines.append(f"{new_transfer.get('source_well','A1')},{new_transfer.get('dest_well','A1')},{new_transfer.get('volume_nl',0)}")
            else:
                data_lines.append(f"{new_transfer.get('source_well','A1')},{new_transfer.get('dest_well','A1')},{new_transfer.get('volume_nl',0)}")

    # Change plate types globally
    result_lines = data_lines
    if "source_plate_type" in changes:
        src_type_idx = col_map["indices"].get("source_plate_type")
        if src_type_idx is not None:
            for i, line in enumerate(result_lines):
                fields = _split_csv_line(line)
                if len(fields) > src_type_idx:
                    fields[src_type_idx] = changes["source_plate_type"]
                    result_lines[i] = ",".join(fields)

    if "dest_plate_type" in changes:
        dst_type_idx = col_map["indices"].get("dest_plate_type")
        if dst_type_idx is not None:
            for i, line in enumerate(result_lines):
                fields = _split_csv_line(line)
                if len(fields) > dst_type_idx:
                    fields[dst_type_idx] = changes["dest_plate_type"]
                    result_lines[i] = ",".join(fields)

    # Reassemble
    all_lines = []
    if header:
        all_lines.append(header)
    all_lines.extend(result_lines)
    return "\n".join(all_lines)