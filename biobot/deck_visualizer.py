"""
deck_visualizer.py — Universal LLM-Driven Deck Visualization

Generates device geometry and extracts protocol contents as separate JSON artifacts.
Handles code updates when the user modifies the deck through the visualization.
"""

from openai import OpenAI
from config import get_api_key, light_functions_model

LAYOUT_SCHEMA = """Return ONLY valid JSON matching this structure:
{
  "platform": "Device model name",
  "layout_type": "grid | linear | plates",
  "grid": {"rows": 1, "cols": 1, "labels": ["position_id"]},
  "positions": [{"id": "physical position identifier", "labware": null,
                 "labware_display": null, "type": "empty", "module": null, "row": 0, "col": 0}],
  "instruments": [{"name": "Fixed instrument name", "model": "Model identifier", "mount": null, "tipracks": []}],
  "plates": {"source": {"name": "Source plate", "type": null, "format": null},
             "destination": {"name": "Destination plate", "type": null, "format": null}},
  "carriers": {"items": [{"name": "Carrier name", "type": "Carrier identifier", "track": 1,
                          "positions": [{"index": 0, "labware": null}]}]}
}
These are structural examples, not physical defaults. Include only the relevant layout fields.
"""

STEPS_PROMPT = """You are an expert in laboratory automation. Given protocol code and a list of deck position IDs, extract ALL liquid-handling steps in execution order.

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

RULES:
- source.slot and destination.slot MUST match a position id from the provided list.
- For pickup_tip/drop_tip: use source only. Omit destination.
- For aspirate/mix: use source only. For dispense: use destination only. For transfer: use both.
- If individual wells cannot be determined, use an empty array [].
- If no liquid handling steps exist, return {"steps": []}.
- code_lines: an array of 1-indexed line numbers from the source code that produce this step.
  For a simple call like `pipette.aspirate(100, plate['A1'])`, this is one line number.
  For steps inside a loop (for/while), include BOTH the loop header line(s) AND the action line(s).
  Example: if line 15 is `for well in wells:` and line 16 is `pipette.transfer(100, src, well)`,
  then each unrolled transfer step gets code_lines: [15, 16].
  Multiple nested loops: include all enclosing loop headers.
  This field is REQUIRED for every step. Examine the code carefully to map each step to its exact line(s).
- Return ONLY valid JSON. No trailing commas.
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

def identify_device(code, history, known_devices, api_key=None):
    """Identify a device without generating its layout or registering software tools."""
    import json, re
    client = OpenAI(api_key=api_key or get_api_key())
    context = [message['content'] for message in history if message.get('role') == 'user'][-8:]
    response = client.responses.create(model=light_functions_model, input=[
        {"role": "system", "content": "Identify the liquid-handling device model from the protocol and conversation. Return ONLY JSON: {\"device_id\": \"stable_lowercase_id\", \"name\": \"Device model name\"}. Reuse the exact ID of a matching known device. Different physical models must have different IDs. Do not infer the device from CSV/file format alone. If ambiguous or unspecified return {\"device_id\": null, \"name\": null}."},
        {"role": "user", "content": json.dumps({"known_devices": known_devices, "conversation": context, "protocol": code})},
    ])
    result = json.loads(_clean_llm_json(response.output_text))
    if not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,63}", result.get("device_id") or "") or not result.get("name"):
        raise ValueError("Please specify the instrument model in your chat before opening its deck.")
    return result


DEVICE_LAYOUT_PROMPT = """You design reusable physical deck layouts for laboratory instruments.
You receive ONLY a device model name, not a protocol. Generate its complete physical layout once.
""" + LAYOUT_SCHEMA + """
Rules:
- Describe the device's actual physical geometry, all positions (including unused ones), fixed hardware, and available source/destination locations.
- Use empty labware and instrument lists for configurable hardware; retain permanently fixed hardware.
- Do not include a protocol title, steps, sample names, well usage, transfer counts, volumes, code, or variable names.
- For grid layouts, provide integer rows/cols and explicit integer row/col coordinates for every position.
- Position IDs must be stable physical identifiers that protocol code can reference.
- For plate-based layouts, define source/destination plate roles without assuming the protocol's plate format.
- Return ONLY the JSON object.
"""


def generate_device_layout(device_name, api_key=None):
    import json
    from config import biobot_model
    client = OpenAI(api_key=api_key or get_api_key())
    response = client.responses.create(model=biobot_model, input=[
        {"role": "system", "content": DEVICE_LAYOUT_PROMPT},
        {"role": "user", "content": f"Device model: {device_name}"},
    ])
    return json.loads(_clean_llm_json(response.output_text))


def bind_protocol(code, layout, api_key=None):
    """Extract protocol contents/animation once; device geometry comes from the library."""
    import json
    from config import biobot_model
    client = OpenAI(api_key=api_key or get_api_key())
    prompt = STEPS_PROMPT + """
In addition to steps, include these protocol-specific fields in the same JSON object:
- title: a short protocol title.
- positions: [{id, labware, labware_display, variable, type, module}] for loaded hardware. IDs MUST come from the supplied device template. Do not invent physical positions.
- instruments: [{name, model, mount, tipracks}] describing instruments used by this protocol.
- plates: {source: {name, type, format, wells_used}, destination: {name, type, format, wells_used}} for plate-based protocols, otherwise null. Each format MUST be an integer well count or null, never a string with units.
- carriers: {items: [{track, positions: [{index, labware, variable}]}]} when the protocol loads carriers, otherwise null.
Do NOT generate or change layout_type, grid dimensions, physical coordinates, or other device geometry.
Use ONLY hardware and operations actually specified in the code; do not invent missing instruments or steps.
The input may be a script that GENERATES a protocol/picklist rather than directly driving an instrument. Resolve its declared configuration, constants, and documented run setup to extract the intended labware and transfers. Lack of hardware-loading commands does not imply an empty deck. Map source/destination roles onto the supplied template's physical identifiers. Set plate formats from the declared labware, not from the template's generic placeholders; retain null only when truly unspecified.
"""
    numbered = "\n".join(f"{i + 1}: {line}" for i, line in enumerate(code.splitlines()))
    response = client.responses.create(model=biobot_model, input=[
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"Device template:\n{json.dumps(layout)}\n\nProtocol:\n{numbered}"},
    ])
    result = json.loads(_clean_llm_json(response.output_text))
    if not isinstance(result, dict) or not isinstance(result.get("steps", []), list):
        raise ValueError("Could not extract this protocol's deck contents.")
    return result
