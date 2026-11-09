"""Persistent device layouts, private protocol bindings, and published layout copies."""
import copy
import hashlib
import json
import re
import uuid

from psycopg2.extras import Json, RealDictCursor
from config import get_db_connection
from deck_visualizer import identify_device, generate_device_layout, bind_protocol

BINDING_VERSION = 8  # BioBot-language protocols include tip moves.
CATALOG_VERSION = 4  # Broad catalogs with geometry and hardware schematics.


def init_deck_tables(cursor):
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS deck_templates (
            id UUID PRIMARY KEY,
            device_id TEXT NOT NULL,
            device_name TEXT NOT NULL,
            name TEXT NOT NULL,
            owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            parent_id UUID REFERENCES deck_templates(id) ON DELETE SET NULL,
            published BOOLEAN NOT NULL DEFAULT FALSE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            layout JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS deck_default_device
            ON deck_templates(device_id) WHERE is_default;
        CREATE TABLE IF NOT EXISTS deck_protocols (
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            code_hash TEXT NOT NULL,
            device_id TEXT NOT NULL,
            template_id UUID REFERENCES deck_templates(id) ON DELETE SET NULL,
            binding JSONB NOT NULL,
            PRIMARY KEY (user_id, code_hash)
        );
        CREATE TABLE IF NOT EXISTS deck_catalogs (
            platform_key TEXT NOT NULL,
            position_type TEXT NOT NULL,
            catalog JSONB NOT NULL,
            PRIMARY KEY (platform_key, position_type)
        );
    """)


def get_hardware_catalog(platform, position_type="labware", api_key=None):
    """Reuse a public hardware catalog across page loads and concurrent requests."""
    from deck_visualizer import get_catalog
    key = re.sub(r"[\s_-]", "", platform.strip().casefold())
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"catalog:{key}:{position_type}",))
            cursor.execute("SELECT catalog FROM deck_catalogs WHERE platform_key = %s AND position_type = %s", (key, position_type))
            row = cursor.fetchone()
            if row and row[0].get("_version") == CATALOG_VERSION:
                return row[0]
            # Store only platform-wide suggestions, never a user's custom hardware.
            catalog = get_catalog(platform, position_type, api_key=api_key, existing_catalog=row[0] if row else None)
            if not isinstance(catalog, dict) or not isinstance(catalog.get("categories"), list) or not catalog["categories"]:
                raise ValueError("No hardware suggestions were returned. Please retry.")
            if row:
                catalog = merge_catalogs(row[0], catalog)
            catalog["_version"] = CATALOG_VERSION
            cursor.execute("INSERT INTO deck_catalogs (platform_key, position_type, catalog) VALUES (%s, %s, %s) ON CONFLICT (platform_key, position_type) DO UPDATE SET catalog = EXCLUDED.catalog",
                           (key, position_type, Json(catalog)))
            return catalog
    finally:
        conn.close()


def merge_catalogs(previous, updated):
    """Enrich a catalog without losing options omitted by a later model reply."""
    result = copy.deepcopy(updated)
    categories, items = {}, {}
    for catalog in (previous, updated):
        for category in catalog.get("categories", []):
            key = category["name"].casefold()
            group = categories.setdefault(key, {"name": category["name"], "items": []})
            for item in category.get("items", []):
                identity = item["id"]
                if identity in items:
                    items[identity].update(copy.deepcopy(item))
                else:
                    items[identity] = copy.deepcopy(item)
                    group["items"].append(items[identity])
    result["categories"] = [group for group in categories.values() if group["items"]]
    return result


# Only physical layout/default hardware is shared; protocol data never enters a template.
FIELDS = {
    "grid": {"rows", "cols", "labels"},
    "positions": {"fixed", "id", "labware", "labware_display", "type", "module", "row", "col", "aspect_ratio", "well_count", "well_rows", "well_columns", "visual"},
    "instruments": {"name", "model", "mount", "tipracks"},
    "plate": {"name", "type", "format", "well_rows", "well_columns", "aspect_ratio"},
    "carrier": {"name", "type", "track", "positions"},
    "carrier_position": {"fixed", "index", "labware", "labware_display", "type", "well_count", "well_rows", "well_columns", "aspect_ratio", "visual"},
}


def clean_layout(state):
    if not isinstance(state, dict) or state.get("layout_type") not in {"grid", "linear", "plates"}:
        raise ValueError("Choose a supported deck layout.")

    def take(value, fields):
        if not isinstance(value, dict):
            raise ValueError("Invalid layout fields.")
        return {key: copy.deepcopy(value[key]) for key in fields if key in value}

    layout = {"platform": state.get("platform", ""), "layout_type": state["layout_type"]}
    if state.get("arrangement") in {"side_by_side", "facing"}:
        layout["arrangement"] = state["arrangement"]
    mounts = state.get("mounts", [])
    if not isinstance(mounts, list) or any(not isinstance(mount, str) or not mount for mount in mounts):
        raise ValueError("Instrument mounts must be a list of non-empty physical identifiers.")
    layout["mounts"] = list(dict.fromkeys(mounts))
    layout["grid"] = take(state.get("grid") or {}, FIELDS["grid"])
    layout["positions"] = [take(item, FIELDS["positions"]) for item in (state.get("positions") or [])]
    layout["instruments"] = [take(item, FIELDS["instruments"]) for item in (state.get("instruments") or [])]
    layout["plates"] = {role: take(plate, FIELDS["plate"]) for role, plate in (state.get("plates") or {}).items()
                        if role in {"source", "destination"} and isinstance(plate, dict)}
    # A library plate has a role, not a protocol/sample name.
    for role, plate in layout["plates"].items():
        plate["name"] = role.capitalize() + " plate"
    layout["carriers"] = {"items": []}
    for item in (state.get("carriers") or {}).get("items", []):
        carrier = take(item, FIELDS["carrier"])
        carrier["positions"] = [take(pos, FIELDS["carrier_position"]) for pos in item.get("positions", [])]
        layout["carriers"]["items"].append(carrier)

    def plain_values(value):
        if isinstance(value, str) and (len(value) > 500 or re.search(r'[<>"&\x00-\x1f]', value)):
            raise ValueError("Layout labels must be plain text without markup or quotation marks.")
        if isinstance(value, dict):
            for child in value.values():
                plain_values(child)
        if isinstance(value, list):
            if len(value) > 4096:
                raise ValueError("Too many layout items.")
            for child in value:
                plain_values(child)

    plain_values(layout)
    def text_fields(item, keys):
        if any(item.get(key) is not None and not isinstance(item[key], str) for key in keys):
            raise ValueError("Hardware names and identifiers must be text.")

    text_fields(layout, ("platform",))
    for pos in layout["positions"]:
        if pos.get("aspect_ratio") is not None and (type(pos["aspect_ratio"]) not in (int, float) or not 0.1 <= pos["aspect_ratio"] <= 10):
            raise ValueError("Invalid hardware aspect ratio.")
        text_fields(pos, ("labware", "labware_display", "type", "module"))
        for key in ("well_count", "well_rows", "well_columns"):
            if pos.get(key) is not None and (type(pos[key]) is not int or not 1 <= pos[key] <= 4096):
                raise ValueError("Well dimensions must be positive whole numbers up to 4096.")
    for instrument in layout["instruments"]:
        text_fields(instrument, ("name", "model", "mount"))
        if not isinstance(instrument.get("tipracks", []), list) or any(not isinstance(item, str) for item in instrument.get("tipracks", [])):
            raise ValueError("Tip racks must be a list of position identifiers.")
    for plate in layout["plates"].values():
        text_fields(plate, ("name", "type"))
        if plate.get("format") is not None and (type(plate["format"]) is not int or not 1 <= plate["format"] <= 4096):
            raise ValueError("Plate well counts must be positive whole numbers up to 4096.")
    for carrier in layout["carriers"]["items"]:
        text_fields(carrier, ("name", "type"))
        for pos in carrier["positions"]:
            text_fields(pos, ("labware",))
            if type(pos.get("index")) is not int or not 0 <= pos["index"] < 4096:
                raise ValueError("Invalid carrier position index.")
    positions = layout["positions"]
    ids = [pos.get("id") for pos in positions]
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("Deck positions need unique, non-empty identifiers.")
    if layout["layout_type"] == "grid":
        grid = layout["grid"]
        if any(type(grid.get(key)) is not int or not 1 <= grid[key] <= 128 for key in ("rows", "cols")) or grid["rows"] * grid["cols"] > 4096:
            raise ValueError("Invalid grid dimensions.")
        coordinates = []
        for pos in positions:
            if any(type(pos.get(axis)) is not int or not 0 <= pos[axis] < grid[size]
                   for axis, size in (("row", "rows"), ("col", "cols"))):
                raise ValueError("Position coordinates must fit the grid.")
            coordinates.append((pos["row"], pos["col"]))
        if len(set(coordinates)) != len(coordinates):
            raise ValueError("Two positions cannot occupy the same grid cell.")
        # Labels follow coordinates, including deliberately empty cells.
        grid["labels"] = [None] * (grid["rows"] * grid["cols"])
        for pos in positions:
            grid["labels"][pos["row"] * grid["cols"] + pos["col"]] = pos["id"]
    return layout


def compose_state(layout, binding):
    """Overlay only protocol contents; never let extraction replace device geometry."""
    state = copy.deepcopy(layout)
    positions = {pos["id"]: pos for pos in state.get("positions", [])}
    for patch in binding.get("positions", []):
        pos = positions.get(str(patch.get("id")))
        if pos is None:
            if patch.get("labware"):
                raise ValueError(f"This deck has no position {patch.get('id')} required by the protocol.")
            continue
        pos.update({key: patch[key] for key in ("labware", "labware_display", "variable", "type", "module") if key in patch})
        for key in ("well_count", "well_rows", "well_columns"):
            value = patch.get(key)
            if type(value) is int and 0 < value <= 4096:
                pos[key] = value
        ratio = patch.get("aspect_ratio")
        if type(ratio) in (int, float) and 0.1 <= ratio <= 10:
            pos["aspect_ratio"] = ratio
    if "instruments" in binding:
        state["instruments"] = copy.deepcopy(binding["instruments"])
    for role in ("source", "destination"):
        plate = (binding.get("plates") or {}).get(role)
        if isinstance(plate, dict):
            state.setdefault("plates", {}).setdefault(role, {}).update(copy.deepcopy(plate))
        rendered_plate = state.get("plates", {}).get(role)
        if rendered_plate:
            count = rendered_plate.get("format")
            if isinstance(count, str):
                match = re.fullmatch(r"(\d+)(?:[- ]?well)?", count.strip(), re.IGNORECASE)
                count = int(match[1]) if match else None
            rendered_plate["format"] = count if type(count) is int and 0 < count <= 4096 else None
    for carrier in (state.get("carriers") or {}).get("items", []):
        for patch in (binding.get("carriers") or {}).get("items", []):
            if str(patch.get("track")) == str(carrier.get("track")):
                for pos in carrier.get("positions", []):
                    match = next((p for p in patch.get("positions", []) if p.get("index") == pos.get("index")), None)
                    if match:
                        pos.update({key: match[key] for key in FIELDS["carrier_position"] | {"variable"} if key in match and key != "index"})
    state["title"] = binding.get("title", "")
    state["steps"] = copy.deepcopy(binding.get("steps", []))
    state["initial_wells"] = copy.deepcopy(binding.get("initial_wells", []))
    state["parameters"] = copy.deepcopy(binding.get("parameters", []))
    state["parameter_constraints"] = copy.deepcopy(binding.get("parameter_constraints", []))
    return state


def _visible(cursor, user_id, template_id):
    try:
        template_id = str(uuid.UUID(str(template_id)))
    except ValueError:
        raise ValueError("Invalid library deck.")
    cursor.execute("SELECT * FROM deck_templates WHERE id = %s AND (is_default OR published OR owner_id = %s)", (template_id, user_id))
    row = cursor.fetchone()
    if not row:
        raise ValueError("Library deck not found or unavailable.")
    return row


def _choices(cursor, user_id, device_id):
    cursor.execute("""SELECT t.id::text, t.name, t.owner_id, t.parent_id::text, t.published, t.is_default,
                      CASE WHEN t.owner_id IS NULL THEN 'BioBot'
                           ELSE COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'Community member') END AS author
                      FROM deck_templates t LEFT JOIN users u ON u.id = t.owner_id
                      WHERE t.device_id = %s AND (t.is_default OR t.published OR t.owner_id = %s)
                      ORDER BY t.is_default DESC, t.created_at, t.id""", (device_id, user_id))
    return [dict(row) for row in cursor.fetchall()]


def _default_deck(cursor, name, device_id, api_key):
    cursor.execute("SELECT * FROM deck_templates WHERE device_id = %s AND is_default", (device_id,))
    cached = cursor.fetchone()
    if cached is not None and cached["layout"].get("layout_type") == "plates" and "arrangement" not in cached["layout"]:
        # Layouts stored before plate arrangements: add it without regenerating (positions stay the same).
        from deck_visualizer import plate_arrangement
        layout = {**cached["layout"], "arrangement": plate_arrangement(name, api_key)}
        cursor.execute("UPDATE deck_templates SET layout = %s WHERE id = %s RETURNING *", (Json(layout), cached["id"]))
        cached = cursor.fetchone()
    if cached is not None:
        return cached
    cursor.execute("SET LOCAL lock_timeout = '10s'")
    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"deck-device:{device_id}",))
    cursor.execute("SELECT * FROM deck_templates WHERE device_id = %s AND is_default", (device_id,))
    default = cursor.fetchone()
    if default is None:
        layout = clean_layout(generate_device_layout(name, api_key))
        layout["platform"] = name
        cursor.execute("""INSERT INTO deck_templates (id, device_id, device_name, name, is_default, layout)
                          VALUES (%s, %s, %s, %s, TRUE, %s) RETURNING *""",
                       (str(uuid.uuid4()), device_id, name, f"{name} default", Json(layout)))
        default = cursor.fetchone()
    return default


def get_device_deck(name, user_id, api_key=None, template_id=None, identified_device=None):
    """Open shared physical geometry before a protocol exists."""
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute("SELECT DISTINCT device_id, device_name FROM deck_templates")
            known = [dict(row) for row in cursor.fetchall()]
            match = next((item for item in known if item["device_name"].casefold() == name.casefold()), None)
            device = {"device_id": match["device_id"], "name": match["device_name"]} if match else identified_device or identify_device(name, [], known, api_key)
            default = _default_deck(cursor, device["name"], device["device_id"], api_key)
            selected = _visible(cursor, user_id, template_id) if template_id else default
            if selected["device_id"] != device["device_id"]:
                raise ValueError("Choose a deck for the selected device.")
            state = copy.deepcopy(selected["layout"])
            choices = _choices(cursor, user_id, device["device_id"])
            state["_library"] = {"selected": next(item for item in choices if item["id"] == str(selected["id"])),
                                 "alternatives": choices, "layout": copy.deepcopy(selected["layout"])}
            state["steps"] = []
            return state
    finally:
        conn.close()


def get_deck(code, user_id, api_key=None, history=None, template_id=None, refresh_parameters=False):
    digest = hashlib.sha256(code.replace("\r\n", "\n").rstrip("\n").encode()).hexdigest()
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            requested = _visible(cursor, user_id, template_id) if template_id else None
            # Requests for the same code/device share the first successful generation.
            cursor.execute("SELECT * FROM deck_protocols WHERE user_id = %s AND code_hash = %s", (user_id, digest))
            protocol = cursor.fetchone()
            if protocol is None or refresh_parameters:
                cursor.execute("SET LOCAL lock_timeout = '10s'")
                cursor.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (f"deck-code:{user_id}:{digest}",))
                cursor.execute("SELECT * FROM deck_protocols WHERE user_id = %s AND code_hash = %s", (user_id, digest))
                protocol = cursor.fetchone()
            if protocol is None:
                import protocol_lang
                cursor.execute("SELECT DISTINCT device_id, device_name FROM deck_templates")
                known, structured = [dict(row) for row in cursor.fetchall()], protocol_lang.parse(code)
                device = next((item for item in known if structured and str(item["device_name"]).casefold() == str(structured.get("device", "")).casefold()), None) \
                    or identify_device(code, history or [], known, api_key)
                device_id, name = device["device_id"], device["name"]
                if requested and requested["device_id"] != device_id:
                    raise ValueError("Choose a deck for the protocol's device.")
                default = _default_deck(cursor, name, device_id, api_key)
                # Keep a successful device layout even if extracting this protocol fails.
                # The code's session lock remains held until this connection closes.
                conn.commit()
                binding = protocol_lang.binding(structured) if structured else bind_protocol(code, default["layout"], api_key)
                binding["_version"] = BINDING_VERSION
                protocol = {"device_id": device_id, "template_id": default["id"], "binding": binding}
                cursor.execute("""INSERT INTO deck_protocols (user_id, code_hash, device_id, template_id, binding)
                                  VALUES (%s, %s, %s, %s, %s)""", (user_id, digest, device_id, default["id"], Json(binding)))
            elif refresh_parameters and protocol["binding"].get("_version") != BINDING_VERSION:
                # Upgrade extraction artifacts without regenerating the shared device layout.
                import protocol_lang
                cursor.execute("SELECT layout FROM deck_templates WHERE device_id = %s AND is_default", (protocol["device_id"],))
                structured = protocol_lang.parse(code)
                binding = protocol_lang.binding(structured) if structured else bind_protocol(code, cursor.fetchone()["layout"], api_key)
                binding["_version"] = BINDING_VERSION
                protocol["binding"] = binding
                cursor.execute("UPDATE deck_protocols SET binding = %s WHERE user_id = %s AND code_hash = %s", (Json(binding), user_id, digest))
            selected_id = template_id or protocol["template_id"]
            if selected_id is None:
                cursor.execute("SELECT id FROM deck_templates WHERE device_id = %s AND is_default", (protocol["device_id"],))
                selected_id = cursor.fetchone()["id"]
            selected = requested or _visible(cursor, user_id, selected_id)
            if selected["device_id"] != protocol["device_id"]:
                raise ValueError("Choose a deck for the protocol's device.")
            state = compose_state(selected["layout"], protocol["binding"])
            if template_id:
                cursor.execute("UPDATE deck_protocols SET template_id = %s WHERE user_id = %s AND code_hash = %s", (selected["id"], user_id, digest))
            choices = _choices(cursor, user_id, protocol["device_id"])
            state["_library"] = {"selected": next(item for item in choices if item["id"] == str(selected["id"])),
                                 "alternatives": choices, "layout": selected["layout"]}
            state["_protocol_code"] = code
            state["_parameters_pending"] = protocol["binding"].get("_version") != BINDING_VERSION
            state["_playback_pending"] = state["_parameters_pending"] and not state.get("steps")
            return state
    finally:
        conn.close()


def save_copy(user_id, parent_id, name, state):
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
        raise ValueError("Give the deck a name of up to 120 characters.")
    layout = clean_layout(state)
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            parent = _visible(cursor, user_id, parent_id)
            layout["platform"] = parent["device_name"]
            template_id = str(uuid.uuid4())
            cursor.execute("""INSERT INTO deck_templates (id, device_id, device_name, name, owner_id, parent_id, layout)
                              VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                           (template_id, parent["device_id"], parent["device_name"], name.strip(), user_id, parent["id"], Json(layout)))
            return {"id": template_id, "name": name.strip()}
    finally:
        conn.close()


def publish_deck(user_id, template_id):
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            template = _visible(cursor, user_id, template_id)
            if template["owner_id"] != user_id or template["is_default"]:
                raise ValueError("Only your own deck copies can be published.")
            cursor.execute("UPDATE deck_templates SET published = TRUE WHERE id = %s", (template["id"],))
            return {"id": str(template["id"]), "published": True}
    finally:
        conn.close()
