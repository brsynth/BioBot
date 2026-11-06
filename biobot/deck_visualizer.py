"""
deck_visualizer.py — Universal LLM-Driven Deck Visualization

Sends protocol code to the LLM → gets interactive HTML for any liquid handler.
Handles code updates when the user modifies the deck through the visualization.
"""

from openai import OpenAI
from config import get_api_key, light_functions_model

VISUALIZE_PROMPT = """You are an expert in laboratory automation and liquid handling robots. You will be given protocol code or a CSV picklist.

Your task: extract the deck layout as a JSON object. Identify the platform, the deck structure, and every piece of hardware.

Return ONLY valid JSON (no markdown, no explanation) matching this exact schema:

{
  "platform": "Human-readable platform name inferred from the input",
  "layout_type": "grid | linear | plates",
  "title": "Short protocol name if available",
  "grid": {
    "rows": 1, "cols": 1,
    "labels": ["position_id"],
    "note": "Only for layout_type=grid. Derive dimensions and labels from the input; these example values are not defaults."
  },
  "positions": [
    {
      "id": "slot or position identifier (e.g. '1', 'Track 3', 'A1')",
      "labware": "Full labware API name or null if empty",
      "labware_display": "Short display name or null",
      "variable": "Variable name in code or null",
      "type": "plate | tiprack | reservoir | tuberack | module | trash | carrier | empty",
      "module": "Module name if labware sits on a module, else null",
      "row": 0, "col": 0
    }
  ],
  "instruments": [
    {
      "name": "Instrument display name from the input",
      "model": "API model name from the input",
      "mount": "left | right | channel_count | null",
      "tipracks": ["slot ids where tipracks are"]
    }
  ],
  "plates": {
    "note": "Only for layout_type=plates. null otherwise.",
    "source": {"name": "Source Plate", "type": "Plate type from input", "format": 384, "wells_used": ["A1","A2"]},
    "destination": {"name": "Dest Plate", "type": "96-well", "format": 96, "wells_used": ["A1","B1"]},
    "transfer_count": 50,
    "volume_range": "Volume range from input"
  },
  "carriers": {
    "note": "Only for layout_type=linear. null otherwise.",
    "items": [
      {"name": "Tip Carrier", "type": "Carrier type from input", "track": 3, "positions": [
        {"index": 0, "labware": "50uL tips", "variable": "tips_01"},
        {"index": 1, "labware": null}
      ]}
    ]
  }
}

RULES:
- Choose grid for a rectangular worktable, linear for carriers on tracks, or plates for source/destination well maps based on the input.
- Derive dimensions, position labels, instruments, capacities, and carrier types from the supplied protocol. Do not assume a robot from the file format.
- CRITICAL: include ALL deck positions, including empty/unused ones. For grid robots, include EVERY slot in the grid (e.g. an OT-2 has slots 1-11 plus a fixed trash in slot 12 — always return all 12 with grid rows=3, cols=4). Populate grid.labels with EVERY position id in order.
- For each position, set row and col (0-indexed) matching its physical location on the deck.
- Use null or an empty list for information that cannot be determined from the input.
- Return ONLY valid JSON. No trailing commas.
"""

STEPS_PROMPT = """You are an expert in laboratory automation. Given protocol input (Python code, CSV picklist, HSL script, plain text instructions, or any other format) and a list of deck position IDs, extract ALL liquid-handling steps in execution order.

Return ONLY valid JSON (no markdown, no explanation) matching this schema:

{
  "steps": [
    {
      "action": "aspirate | dispense | transfer | mix | pickup_tip | drop_tip",
      "source": {"slot": "position id from the provided list", "wells": ["A1","B1"]},
      "destination": {"slot": "position id from the provided list", "wells": ["A1","B1"]},
      "volume": "e.g. 100µL",
      "description": "Human-readable step description",
      "code_lines": [10, 11]
    }
  ]
}

FORMAT-SPECIFIC GUIDANCE:

1. CSV / Picklist (e.g., Echo, Mosquito, CSV transfers):
   - Each data row is typically one transfer step.
   - Common columns: Source Well, Destination Well, Volume, Source Plate, Destination Plate.
   - Map each row to a "transfer" action. Use "source" for the source plate/well and "destination" for the destination plate/well.
   - code_lines = the 1-indexed line number of that CSV row (header is line 1, first data row is line 2, etc.).
   - Group consecutive rows with the same source well into a single step if desired, or keep them as individual transfers.
   - If the CSV has hundreds of rows, group transfers by source well or by plate region to keep steps under 50. Include code_lines for ALL grouped rows.

2. Python code (e.g., Opentrons, PyHamilton):
   - Each pipette call (aspirate, dispense, transfer, mix, pick_up_tip, drop_tip) is a step.
   - For steps inside loops (for/while), include BOTH the loop header line(s) AND the action line(s) in code_lines.
   - Multiple nested loops: include all enclosing loop headers.

3. HSL / Venus scripts:
   - Each Aspirate/Dispense/Tip pickup command is a step.
   - Map sequence names to the correct deck position IDs.

4. Plain text / other formats:
   - Extract any described liquid transfers, aspirations, dispenses, or tip operations.
   - Each described action = one step. code_lines = the line(s) describing that action.

RULES:
- source.slot and destination.slot MUST match a position id from the provided list. For CSV picklists with plate names, map the plate name to the closest matching position id.
- For pickup_tip/drop_tip: use source only. Omit destination.
- For aspirate/mix: use source only. For dispense: use destination only. For transfer: use both.
- If individual wells cannot be determined, use an empty array [].
- If no liquid handling steps exist, return {"steps": []}.
- code_lines: an array of 1-indexed line numbers from the input that produce this step. This field is REQUIRED for every step.
- For large inputs (>100 rows/lines), group related transfers into logical steps (e.g., all transfers from the same source well, or all transfers in a serial dilution). Include ALL relevant line numbers in code_lines for the group.
- Keep the total number of steps reasonable (10-50 for most protocols).
- Return ONLY valid JSON. No trailing commas.
"""

UPDATE_PROMPT = """You are an expert in laboratory automation. Given:
1. Current protocol code
2. A change the user made in the deck visualization

Update the code to reflect the change and return the updated code.

Rules:
- Change ONLY what's necessary. Keep all variables, logic, comments intact.
- Labware change: replace the old labware name globally.
- Slot change: update only the slot number.
- Pipette change: also update the tiprack to a compatible one.

Return ONLY the updated code. No explanation, no markdown fences.
"""


def _clean_llm_json(raw: str) -> str:
    """Strip markdown fences and fix trailing commas from LLM JSON output."""
    result = raw.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[1] if "\n" in result else result[3:]
    if result.endswith("```"):
        result = result[:-3].strip()
    if result.startswith("json"):
        result = result[4:].strip()
    return _fix_json(result)


def generate_visualization(code: str, api_key: str = None) -> dict:
    """Extract deck state JSON from any protocol code using the LLM.

    Uses two separate LLM calls:
    1. Extract the deck layout (positions, instruments, grid) — critical.
    2. Extract the liquid-handling steps for animation — non-critical.

    If step extraction fails, the deck still renders without animation.
    """
    import json, re
    client = OpenAI(api_key=api_key or get_api_key())

    # --- Call 1: Deck layout (critical) ---
    response = client.responses.create(
        model=light_functions_model,
        input=[
            {"role": "system", "content": VISUALIZE_PROMPT},
            {"role": "user", "content": f"Extract the deck layout from this code/CSV:\n\n{code}"}
        ],
    )

    result = _clean_llm_json(response.output_text)

    try:
        state = json.loads(result)
    except json.JSONDecodeError:
        # Last resort: try to extract a JSON object from the response
        match = re.search(r'\{[\s\S]*\}', result)
        if match:
            state = json.loads(_fix_json(match.group()))
        else:
            raise

    # --- Call 2: Steps extraction (non-critical) ---
    try:
        pos_ids = [p.get("id", "") for p in state.get("positions", [])]

        # Number each line of the code so the LLM can reference them
        numbered_code = "\n".join(
            f"{i+1}: {line}" for i, line in enumerate(code.split("\n"))
        )

        steps_user_msg = (
            f"Deck position IDs: {json.dumps(pos_ids)}\n\n"
            f"Extract the liquid-handling steps from this protocol input.\n"
            f"Each line is prefixed with its 1-indexed line number for code_lines mapping.\n\n"
            f"{numbered_code}"
        )

        steps_response = client.responses.create(
            model=light_functions_model,
            input=[
                {"role": "system", "content": STEPS_PROMPT},
                {"role": "user", "content": steps_user_msg}
            ],
        )

        steps_result = _clean_llm_json(steps_response.output_text)
        steps_data = json.loads(steps_result)
        state["steps"] = steps_data.get("steps", [])
    except Exception:
        # Steps failed — deck still works, just no animation
        state["steps"] = []

    # Include the raw code for the frontend code viewer
    state["_protocol_code"] = code

    return state


BATCH_UPDATE_PROMPT = """You are an expert in laboratory automation. Given:
1. Current protocol code for a liquid handler
2. A list of changes the user made on the deck

Apply ALL changes to the code and return the updated version.

Rules:
- Apply every change in the list.
- Handle coherence: if a pipette changes, update the tiprack. If a tiprack changes, check the pipette is compatible. If volumes exceed the new pipette range, adjust them.
- For labware changes: replace the old API name with the new one everywhere it appears.
- For additions: add the appropriate load statement in the right place.
- For removals: remove or comment out the load statement and warn if it's referenced elsewhere.
- Keep all other code intact — variables, logic, comments, structure.

Return ONLY the updated code. No explanation, no markdown fences.
"""


def update_code_from_changes(code: str, changes: list, api_key: str = None) -> str:
    """Apply batched deck changes to protocol code using one LLM call."""
    import json
    client = OpenAI(api_key=api_key or get_api_key())

    changes_desc = json.dumps(changes, indent=2)

    response = client.responses.create(
        model=light_functions_model,
        input=[
            {"role": "system", "content": BATCH_UPDATE_PROMPT},
            {"role": "user", "content": f"Current code:\n\n{code}\n\nChanges to apply:\n{changes_desc}"}
        ],
    )

    result = response.output_text.strip()
    for fence in ["```python", "```csv", "```hsl", "```"]:
        result = result.replace(fence, "")
    return result.strip()


CATALOG_PROMPT = """You are an expert in laboratory automation. Given a liquid handler platform and a position on the deck, return a list of compatible hardware that can be placed there.

Return ONLY valid JSON matching this schema:

{
  "categories": [
    {
      "name": "Category Name",
      "items": [
        {"id": "api_load_name", "name": "Human-readable name", "detail": "Short description (volume, wells, etc.)"}
      ]
    }
  ]
}

RULES:
- Return real, accurate hardware that is compatible with the specified platform.
- Group by category (e.g., "Tip Racks", "Well Plates", "Reservoirs", "Tube Racks", "Modules").
- Include the correct API load names that the platform actually uses in code.
- For pipettes/instruments: include model names, volume ranges, and mount options.
- Include 5-15 items per category — the most commonly used ones.
- For the "detail" field: include key specs (volume, well count, dimensions).
- If changing an instrument (pipette/channel), return instrument options instead of labware.
- Return ONLY the JSON. No markdown, no explanation.
"""


def get_catalog(platform: str, position_type: str = "labware",
                current: str = None, api_key: str = None) -> dict:
    """Ask the LLM for compatible hardware options for a given platform and position."""
    import json
    client = OpenAI(api_key=api_key or get_api_key())

    prompt = f"Platform: {platform}\n"
    prompt += f"I need to {'change' if current else 'add'} {position_type} options.\n"
    if current:
        prompt += f"Currently loaded: {current}\n"
    prompt += "Return compatible options for this platform."

    response = client.responses.create(
        model=light_functions_model,
        input=[
            {"role": "system", "content": CATALOG_PROMPT},
            {"role": "user", "content": prompt}
        ],
    )

    return json.loads(_clean_llm_json(response.output_text))


def _fix_json(s: str) -> str:
    """Fix common LLM JSON issues: trailing commas."""
    import re
    return re.sub(r',\s*([\]}])', r'\1', s)