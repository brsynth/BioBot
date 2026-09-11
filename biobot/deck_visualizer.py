"""
deck_visualizer.py — Universal LLM-Driven Deck Visualization

Sends protocol code to the LLM → gets interactive HTML for any liquid handler.
Handles code updates when the user modifies the deck through the visualization.
"""

from openai import OpenAI
from config import get_api_key

VISUALIZE_PROMPT = """You are an expert in laboratory automation and liquid handling robots. You will be given protocol code or a CSV picklist.

Your task: extract the deck layout as a JSON object. Identify the platform, the deck structure, and every piece of hardware.

Return ONLY valid JSON (no markdown, no explanation) matching this exact schema:

{
  "platform": "Human-readable platform name (e.g. Opentrons OT-2, Hamilton STAR, Echo 650, Tecan Fluent, Beckman Biomek)",
  "layout_type": "grid | linear | plates",
  "title": "Short protocol name if available",
  "grid": {
    "rows": 4, "cols": 3,
    "labels": ["1","2","3","4","5","6","7","8","9","10","11","12"],
    "note": "Only for layout_type=grid. For OT-2: 4 rows x 3 cols, slots numbered bottom-left to top-right"
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
      "name": "Instrument display name (e.g. P300 Single GEN2)",
      "model": "API model name (e.g. p300_single_gen2)",
      "mount": "left | right | channel_count | null",
      "tipracks": ["slot ids where tipracks are"]
    }
  ],
  "plates": {
    "note": "Only for layout_type=plates (e.g. Echo). null otherwise.",
    "source": {"name": "Source Plate", "type": "384PP", "format": 384, "wells_used": ["A1","A2"]},
    "destination": {"name": "Dest Plate", "type": "96-well", "format": 96, "wells_used": ["A1","B1"]},
    "transfer_count": 50,
    "volume_range": "2.5 - 500 nL"
  },
  "carriers": {
    "note": "Only for layout_type=linear (e.g. Hamilton). null otherwise.",
    "items": [
      {"name": "Tip Carrier", "type": "TIP_CAR_480", "track": 3, "positions": [
        {"index": 0, "labware": "50uL tips", "variable": "tips_01"},
        {"index": 1, "labware": null}
      ]}
    ]
  }
}

RULES:
- For Opentrons OT-2: layout_type="grid", grid 4x3, slots 1-11 + trash at 12. Row 0 = slots 10,11,12 (top). Row 3 = slots 1,2,3 (bottom).
- For Hamilton STAR: layout_type="linear", use carriers array.
- For Echo 650 / acoustic: layout_type="plates", use plates object. Detect from CSV columns (Source Well, Dest Well, Transfer Volume).
- For any other platform: choose the best layout_type and fill accordingly.
- Include ALL positions, even empty ones.
- If the input is a CSV (not Python), it's likely an Echo/acoustic picklist.
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
        model="gpt-4o-mini",
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
        model="gpt-4o-mini",
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
        model="gpt-4o-mini",
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