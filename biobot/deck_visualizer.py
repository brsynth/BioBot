"""
deck_visualizer.py — Universal LLM-Driven Deck Visualization

Sends protocol code to the LLM → gets interactive HTML for any liquid handler.
Handles code updates when the user modifies the deck through the visualization.
"""

from openai import OpenAI
from config import get_api_key, light_functions_model

VISUALIZE_PROMPT = """You are an expert in laboratory automation and liquid handling robots. You will be given protocol code or a CSV picklist.

Your task: extract the deck layout as a JSON object WITH well-level detail. Identify the platform, hardware, and which wells contain liquid or are used in the protocol (in its initial state)

Return ONLY valid JSON (no markdown, no explanation) matching this exact schema:

{
  "platform": "Human-readable platform name",
  "layout_type": "grid | linear | plates",
  "title": "Short protocol name if available",
  "grid": {
    "rows": 4, "cols": 3,
    "labels": ["1","2","3","4","5","6","7","8","9","10","11","12"]
  },
  "positions": [
    {
      "id": "slot or position identifier",
      "labware": "Full labware API name or null if empty",
      "labware_display": "Short display name or null",
      "variable": "Variable name in code or null",
      "type": "plate | tiprack | reservoir | tuberack | module | trash | carrier | empty",
      "module": "Module name if on a module, else null",
      "row": 0, "col": 0,
      "wells": {
        "rows": 8, "cols": 12,
        "format": 96,
        "row_labels": ["A","B","C","D","E","F","G","H"],
        "filled": ["A1","A2","A3"],
        "source": ["A1","A2"],
        "destination": ["B1","B2","B3"],
        "tips_used": [],
        "tips_available": ["A1","A2","A3"],
        "volume": "100 µL per well (or total for reservoirs)",
        "total_volume": "9600 µL total"
      }
    }
  ],
  "instruments": [
    {
      "name": "Instrument display name",
      "model": "API model name",
      "mount": "left | right | null",
      "tipracks": ["slot ids"]
    }
  ],
  "steps": [
    {
      "action": "aspirate | dispense | transfer | mix | pick_up_tip | drop_tip",
      "source": "variable[well]",
      "destination": "variable[well]",
      "volume": 100,
      "wells_from": ["A1"],
      "wells_to": ["B1"],
      "description": "Short human-readable description"
    }
  ],
  "plates": {
    "note": "Only for layout_type=plates. null otherwise.",
    "source": {"name": "Source", "type": "384PP", "format": 384, "wells_used": ["A1"]},
    "destination": {"name": "Dest", "type": "96-well", "format": 96, "wells_used": ["A1"]},
    "transfer_count": 50,
    "volume_range": "2.5 - 500 nL"
  },
  "carriers": {
    "note": "Only for layout_type=linear. null otherwise.",
    "items": [
      {"name": "Tip Carrier", "type": "TIP_CAR_480", "track": 3, "positions": [
        {"index": 0, "labware": "50uL tips", "variable": "tips_01"},
        {"index": 1, "labware": null}
      ]}
    ]
  }
}

WELL-LEVEL RULES:
- For plates: set wells.rows, cols, format. filled=wells with liquid at start. source=aspiration wells. destination=dispense wells. Expand row/column references to individual wells.
- For tip racks: wells.rows=8, cols=12, format=96. tips_available=all wells initially. tips_used=consumed tips.
- For reservoirs: 1-well→rows=1,cols=1. 12-well→rows=1,cols=12.
- For tube racks: rows/cols based on format.
- For trash/empty: wells=null
- For volumes: extract from the code (transfer volumes, load_liquid volumes, define_liquid volumes). Set wells.volume = per-well volume string. Set wells.total_volume = total across all wells.
- Include steps array with every protocol action in order.

GENERAL RULES:
- OT-2: layout_type="grid", 4x3, slots 1-11 + trash 12.
- Hamilton: layout_type="linear", use carriers.
- Echo: layout_type="plates", use plates object.
- Include ALL positions including empty ones.
- CSV input = likely Echo picklist.
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


def generate_visualization(code: str, api_key: str = None) -> dict:
    """Extract deck state JSON from any protocol code using the LLM."""
    import json
    client = OpenAI(api_key=api_key or get_api_key())

    response = client.responses.create(
        model=light_functions_model,
        input=[
            {"role": "system", "content": VISUALIZE_PROMPT},
            {"role": "user", "content": f"Extract the deck layout from this code/CSV:\n\n{code}"}
        ],
    )

    result = response.output_text.strip()

    # Clean markdown fences
    if result.startswith("```"):
        result = result.split("\n", 1)[1] if "\n" in result else result[3:]
    if result.endswith("```"):
        result = result[:-3].strip()
    if result.startswith("json"):
        result = result[4:].strip()

    # Fix trailing commas
    result = _fix_json(result)

    return json.loads(result)


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

    result = response.output_text.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[1] if "\n" in result else result[3:]
    if result.endswith("```"):
        result = result[:-3].strip()
    if result.startswith("json"):
        result = result[4:].strip()

    return json.loads(_fix_json(result))


def _fix_json(s: str) -> str:
    """Fix common LLM JSON issues: trailing commas."""
    import re
    return re.sub(r',\s*([\]}])', r'\1', s)