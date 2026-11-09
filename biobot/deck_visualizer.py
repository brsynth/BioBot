"""
deck_visualizer.py — Universal LLM-Driven Deck Visualization

Generates device geometry and extracts protocol contents as separate JSON artifacts.
Handles code updates when the user modifies the deck through the visualization.
"""

from openai import OpenAI
from config import get_api_key, biobot_model, light_functions_model

LAYOUT_SCHEMA = """Return ONLY valid JSON matching this structure:
{
  "platform": "Device model name",
  "layout_type": "grid | linear | plates",
  "grid": {"rows": 1, "cols": 1, "labels": ["position_id"]},
  "mounts": [],
  "positions": [{"id": "physical position identifier", "labware": null,
                 "labware_display": null, "type": "empty", "module": null, "row": 0, "col": 0, "aspect_ratio": null}],
  "instruments": [{"name": "Fixed instrument name", "model": "Model identifier", "mount": null, "tipracks": []}],
  "plates": {"source": {"name": "Source plate", "type": null, "format": null},
             "destination": {"name": "Destination plate", "type": null, "format": null}},
  "carriers": {"items": [{"name": "Carrier name", "type": "Carrier identifier", "track": 1,
                          "positions": [{"index": 0, "labware": null}]}]}
}
These are structural examples, not physical defaults. Include only the relevant layout fields.
"""

STEPS_PROMPT = """You are an expert in laboratory automation. Given protocol input (program code, tabular transfers, command files, plain text instructions, or any other format) and a list of deck position IDs, extract ALL liquid-handling steps in execution order.

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

1. Tabular transfers / picklists:
   - Each data row is typically one transfer step.
   - Common columns: Source Well, Destination Well, Volume, Source Plate, Destination Plate.
   - Map each row to a "transfer" action. Use "source" for the source plate/well and "destination" for the destination plate/well.
   - code_lines = the 1-indexed line number of that CSV row (header is line 1, first data row is line 2, etc.).
   - Preserve separate sequential transfers as separate steps, even when they share a source well.

2. Program code:
   - Each executed instrument operation is a step. Resolve operations from the specified device's API and documentation rather than assuming particular method names.
   - For steps inside loops (for/while), include BOTH the loop header line(s) AND the action line(s) in code_lines.
   - Multiple nested loops: include all enclosing loop headers.
   - Resolve finite loops from the declared configuration and expand their iterations in execution order. A loop containing aspirate then dispense must produce aspirate, dispense, aspirate, dispense, etc. for the actual wells in each iteration, never all aspirations followed by all dispenses.
   - Reuse the same code_lines for repeated executions of the same statement. Separate source-code lines are not needed for each iteration.

3. Command files:
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
- One step represents one executed liquid-handling operation. List multiple wells together ONLY when the protocol's instrument operates on them simultaneously, as with parallel channels. Derive this from the actual instrument configuration, never assume a channel count.
- Never collapse successive columns, rows, destinations, or loop iterations into one well list to shorten playback. Preserve their execution order, including intervening mixing and tip operations. Do not impose a 50-step limit.
- Do not invent iteration counts, wells or simultaneous operations when they cannot be resolved from the protocol.
- Include volume_changes: [{slot, well, delta_ul}] for each operation whose liquid movement is known. delta_ul is the signed net change in that individual well, in microlitres: negative for liquid removed, positive for liquid added. Resolve units, channel counts and repetitions from the actual executed operation; never multiply a per-well volume by the number of parallel wells. Provide one net entry per affected well. Mixing alone does not change well volume. Omit changes that cannot be determined rather than guessing. These changes let playback maintain running volumes even when a step omits the resulting total.
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
1. Current protocol for a liquid handler (structured protocol or code)
2. A list of changes the user made on the deck

Apply ALL changes to the protocol and return the updated version in the same format.

Rules:
- Apply every change in the list.
- Handle coherence: if a pipette changes, update the tiprack. If a tiprack changes, check the pipette is compatible. If volumes exceed the new pipette range, adjust them.
- For labware changes: replace the old API name with the new one everywhere it appears.
- For additions: add the appropriate load statement in the right place.
- For move_labware: move the existing hardware from from_slot to to_slot. Preserve its variable and update affected deck references; do not create a second copy or change the experimental operations.
- For removals: remove or comment out the load statement and warn if it's referenced elsewhere.
- Keep all other code intact — variables, logic, comments, structure.

Return ONLY the updated code. No explanation, no markdown fences.
"""


def update_code_from_changes(code: str, changes: list, api_key: str = None) -> str:
    """Apply batched deck changes to protocol code using one LLM call."""
    import json
    client = OpenAI(api_key=api_key or get_api_key())

    changes_desc = json.dumps(changes, indent=2)
    parameter_edit = any(change.get("type") == "set_parameter" for change in changes)
    prompt = BATCH_UPDATE_PROMPT
    if parameter_edit:
        prompt += """
For set_parameter changes, update the named experimental input and every dependent calculation, volume, count, transfer and operation consistently. Values may include units or lists.
Validate the proposed values, units and relationships against the original protocol's intent and physical constraints BEFORE editing. Do not silently replace the requested value or change the experiment to make an impossible request work.
For this request return ONLY JSON: {"code": "complete updated code", "error": null} when valid, or {"code": null, "error": "clear explanation of the conflicting values and what to correct"} when invalid. Do not put an infeasibility warning in generated code and call it a successful update.
"""

    response = client.responses.create(
        model=biobot_model,
        input=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"Current code:\n\n{code}\n\nChanges to apply:\n{changes_desc}"}
        ],
    )

    result = response.output_text.strip()
    if parameter_edit:
        data = json.loads(_clean_llm_json(result))
        if data.get("error"):
            raise ValueError(str(data["error"]))
        if not isinstance(data.get("code"), str) or not data["code"].strip():
            raise ValueError("Could not update these parameters. Please try again.")
        return data["code"].strip()
    import re
    fenced = re.fullmatch(r"```[^\n]*\n([\s\S]*?)\n?```", result)
    return fenced.group(1).strip() if fenced else result


CATALOG_PROMPT = """You are an expert in laboratory automation. Given a liquid handler platform and a position on the deck, return a list of compatible hardware that can be placed there.

Return ONLY valid JSON matching this schema:

{
  "mounts": ["physical instrument mounting identifier, only when documented"],
  "categories": [
    {
      "name": "Category Name",
      "items": [
        {"id": "api_load_name", "name": "Human-readable name", "detail": "Short description", "type": "plate", "well_count": null, "well_rows": null, "well_columns": null, "aspect_ratio": null, "visual": {"parts": [{"shape": "rect", "x": 10, "y": 10, "width": 80, "height": 80, "radius": 8, "tone": "body"}]}}
      ]
    }
  ]
}

RULES:
- Return real, accurate hardware that is compatible with the specified platform.
- Group by category (e.g., "Tip Racks", "Well Plates", "Reservoirs", "Tube Racks", "Modules").
- Set each item's type to one of: plate, tiprack, tuberack, reservoir, module, trash, instrument. Never use the schema placeholder as a value.
- Include the correct API load names that the platform actually uses in code.
- For pipettes/instruments: include model names, volume ranges, and mount options.
- For instrument lookups, return mounts as an array of actual documented mounting identifiers. Use [] if unknown or not applicable; never assume two mounts or particular names.
- Return a broad catalog of documented compatible hardware across all applicable categories, including third-party compatible labware, sizes and volume variants. Do not limit categories to a few representative examples or impose a five-item cap. Keep descriptions concise; never invent hardware to increase the count.
- For the "detail" field: include key specs (volume, well count, dimensions).
- Where documented, provide type, well_count, well_rows, well_columns and aspect_ratio as structured fields so the interface does not guess geometry from a model name. Omit unknown values.
- For documented multiwell plates and tip racks, always include integer well_count, well_rows and well_columns; their product must match well_count. Retrieve the actual manufacturer's geometry, including ordinary empty plates. A known well count is not a reason to omit its documented row/column layout. These fields describe the hardware, not which wells are filled.
- For hardware without a well grid, provide a compact top-down graphical design in visual.parts based on the actual named hardware: its outline, chambers, lid, blocks or openings. Use at most 24 rect or ellipse shapes with numeric x, y, width, height and optional radius, all within a 0–100 coordinate system; tone is body, inset or accent. No SVG markup, text, scripts or external images. Adapt the design to the item; do not repeat the schema example for every item. This is a schematic, not a photograph. Do not invent wells on modules: well geometry belongs to separately loaded plates, unless the hardware has documented integral wells. Multiwell hardware uses its well geometry for rendering; omit its redundant visual to leave room for a complete catalog.
- If changing an instrument (pipette/channel), return instrument options instead of labware.
- Return ONLY the JSON. No markdown, no explanation.
"""


def get_catalog(platform: str, position_type: str = "labware",
                current: str = None, api_key: str = None, existing_catalog=None) -> dict:
    """Ask the LLM for compatible hardware options for a given platform and position."""
    import json
    client = OpenAI(api_key=api_key or get_api_key(), timeout=40, max_retries=0)

    prompt = f"Platform: {platform}\n"
    prompt += f"I need to {'change' if current else 'add'} {position_type} options.\n"
    if current:
        prompt += f"Currently loaded: {current}\n"
    prompt += "Return compatible options for this platform."
    if existing_catalog:
        known = [{"category": category.get("name"), "items": [
            {key: item.get(key) for key in ("id", "name")} for item in category.get("items", [])
        ]} for category in existing_catalog.get("categories", [])]
        prompt += "\nExpand and enrich these existing options; preserve their identifiers and include additional compatible hardware: " + json.dumps(known)

    response = client.responses.create(
        model=light_functions_model,
        text={"format": {"type": "json_object"}},
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
    client = OpenAI(api_key=api_key or get_api_key(), timeout=20, max_retries=0)
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
- Use empty labware and instrument lists for configurable hardware; retain only mandatory, permanently fixed hardware. Mark fixed positions with fixed: true. Do not add example plates, optional modules, tips, or protocol-specific hardware.
- Do not include a protocol title, steps, sample names, well usage, transfer counts, volumes, code, or variable names.
- For grid layouts, provide integer rows/cols and explicit integer row/col coordinates for every position.
- Position IDs must be stable physical identifiers that protocol code can reference.
- mounts: actual documented instrument mounting identifiers, or [] when unknown or not applicable. Do not assume a particular number, naming scheme or orientation.
- When known, provide each position's physical width/height as a numeric aspect_ratio, respecting the device's orientation. Omit it when unknown.
- For plate-based layouts, define source/destination plate roles without assuming the protocol's plate format.
- Return ONLY the JSON object.
"""


def generate_device_layout(device_name, api_key=None):
    import json
    from config import biobot_model
    client = OpenAI(api_key=api_key or get_api_key(), timeout=40, max_retries=0)
    response = client.responses.create(model=biobot_model, input=[
        {"role": "system", "content": DEVICE_LAYOUT_PROMPT},
        {"role": "user", "content": f"Device model: {device_name}"},
    ])
    return json.loads(_clean_llm_json(response.output_text))


def bind_protocol(code, layout, api_key=None):
    """Extract protocol contents/animation once; device geometry comes from the library."""
    import json
    from config import biobot_model
    client = OpenAI(api_key=api_key or get_api_key(), timeout=60, max_retries=0)
    prompt = STEPS_PROMPT + """
In addition to steps, include these protocol-specific fields in the same JSON object:
- title: a short protocol title.
- parameters: [{id, label, value}] for the independent experimental inputs a user may reasonably edit. Use stable unique IDs, concise human-readable labels and text values with their units included where applicable. Resolve current values from the code. Include only parameters actually defined or unambiguously specified in the protocol; do not invent unknown values. Do not list derived results, implementation constants, device details or hardware already editable on the deck. Return [] when no experimental inputs can be identified.
- For each scalar numeric parameter, also include type: "number", unit: the reference unit ("" for counts), units: a map of compatible unit spellings to positive conversion factors into that reference unit, and integer: true only for whole-number counts. Include the reference unit with factor 1 and common compatible alternatives. Preserve case-sensitive unit symbols. Use type: "text" for nonnumeric parameters, including free-form series or lists.
- parameter_constraints: [{left: parameter ID, operator: "lt|lte|gt|gte|eq", right: another parameter ID or numeric constant, message: correction guidance}]. Derive only constraints justified by this protocol. All quantities compared in a constraint must use the same reference unit. Do not invent limits or execute expressions. Include [] if no known relationships or bounds apply.
- positions: [{id, labware, labware_display, variable, type, module}] for loaded hardware. IDs MUST come from the supplied device template. Do not invent physical positions.
- For each loaded position, include a numeric aspect_ratio (physical width divided by height in deck orientation) when the hardware footprint is known. Do not stretch the hardware to match the screen.
- For loaded multiwell hardware, include well_count, well_rows and well_columns from its declared definition when known. Preserve its actual well count and orientation; do not assume a standard plate format.
- initial_wells: [{slot, well, occupied, volume_ul}] describing wells with liquid before the first operation. Include only contents established by the protocol. Omit volume_ul when unknown. Empty destination wells must not be marked occupied merely because they receive liquid later.
- Each step may include well_updates: [{slot, well, occupied, volume_ul}] for the state of affected wells AFTER that step. Include exact remaining volumes and emptying only when they can be resolved from the protocol, accounting for all transfers, diluent, mixing and repetitions. Do not infer that a source empties simply because it is aspirated. Omit unknown values; do not invent starting volumes. Specify the actual tip wells in pickup_tip steps when known.
- For initial_wells and well_updates, also include liquids: [{name, volume_ul}] when liquid identities or mixture components are established by the protocol. Describe the contents at that specific step, including known component volumes in microlitres. Omit unknown component volumes and unknown identities; never invent contents or imply an unknown volume is zero. Use [] for explicitly empty wells.
- type must be exactly one of: plate, tiprack, reservoir, tuberack, module, trash, carrier, empty. Classify the actual hardware; do not use generic "labware" or source/destination roles as types.
- instruments: [{name, model, mount, tipracks}] describing instruments used by this protocol.
- plates: {source: {name, type, format, well_rows, well_columns, wells_used}, destination: {name, type, format, well_rows, well_columns, wells_used}} for plate-based protocols, otherwise null. Each format MUST be an integer well count or null, never a string with units. Use actual documented row/column counts and orientation when known; do not infer them from one standard plate format.
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
    parameters = result.get("parameters", [])
    if not isinstance(parameters, list) or len(parameters) > 60:
        raise ValueError("Could not extract this protocol's parameters.")
    result["parameters"] = []
    seen = set()
    for parameter in parameters:
        if not isinstance(parameter, dict) or any(not isinstance(parameter.get(key), str) for key in ("id", "label", "value")):
            raise ValueError("Could not extract this protocol's parameters.")
        if not parameter["id"] or parameter["id"] in seen or any(len(parameter[key]) > 1000 for key in ("id", "label", "value")):
            raise ValueError("Could not extract this protocol's parameters.")
        seen.add(parameter["id"])
        result["parameters"].append({key: parameter[key] for key in ("id", "label", "value")})
        saved = result["parameters"][-1]
        if parameter.get("type") == "number":
            unit, units = parameter.get("unit"), parameter.get("units")
            if not isinstance(unit, str) or not isinstance(units, dict) or any(not isinstance(name, str) or type(factor) not in (int, float) or not 0 < factor < float("inf") for name, factor in units.items()):
                raise ValueError("Could not extract parameter units. Please retry.")
            saved.update(type="number", unit=unit, units={**units, unit: 1}, integer=parameter.get("integer") is True)
        elif parameter.get("type") == "text":
            saved["type"] = "text"
    constraints = result.get("parameter_constraints", [])
    if not isinstance(constraints, list) or len(constraints) > 120:
        raise ValueError("Could not extract parameter constraints.")
    for constraint in constraints:
        if (not isinstance(constraint, dict) or not isinstance(constraint.get("left"), str) or constraint["left"] not in seen
                or constraint.get("operator") not in {"lt", "lte", "gt", "gte", "eq"}
                or not (type(constraint.get("right")) in (int, float) and abs(constraint["right"]) < float("inf") or isinstance(constraint.get("right"), str) and constraint["right"] in seen)
                or not isinstance(constraint.get("message", ""), str)):
            raise ValueError("Could not extract parameter constraints.")
    result["parameter_constraints"] = constraints
    return result
