"""BioBot protocol language — a vendor-agnostic JSON protocol, expanded deterministically.

The LLM writes and edits protocols in this language; the simulator plays their
expansion; device code is generated from them only at export. Nothing here calls
an LLM or executes generated code: formulas go through a small arithmetic evaluator.
"""
import ast
import json
import operator
import re

LANGUAGE_SPEC = """BioBot protocol language (JSON). Return ONE JSON object:
{"device": "device model", "description": "aim of the experiment",
 "labware": [{"id": "short name", "position": "documented deck position id", "identifier": "documented hardware identifier",
              "type": "plate | tiprack | reservoir | tuberack | module | trash", "rows": 8, "columns": 12, "max_volume_ul": 360, "dead_volume_ul": 0}],
 "instruments": [{"id": "short name", "model": "documented model", "mount": null, "tips": ["tiprack id"], "min_volume_ul": 20, "max_volume_ul": 300, "volume_step_ul": null}],
 "liquids": [{"name": "diluent", "at": "res:A1", "volume_ul": 10000}],
 "parameters": {"n_points": 6, "volume_ul": 100},
 "program": [instructions, in execution order]}
Instructions (exactly one key each):
 {"transfer": {"from": WELLS, "to": WELLS, "volume": V, "with": "instrument id", "mix_after": 3, "new_tip": "always | once"}}
 {"mix": {"at": WELLS, "volume": V, "repeats": 3, "with": "instrument id"}}
 {"incubate": {"at": "labware id", "temperature_c": 37, "minutes": 30}}
 {"wait": {"minutes": 5}}
 {"move": {"labware": "labware id", "to": "position id"}}
 {"device_op": {"name": "documented operation", "description": "what it does"}}
 {"for": "i", "in": "1..{n_points}-1", "do": [instructions]}
WELLS is "labware_id:A1", a list "plate:A1,A2", or a range along a row or a column "plate:B2..B6" / "plate:A1..H1".
{expr} inserts arithmetic (+ - * / // %) on parameters and loop variables, e.g. "plate:B{i+1}"; V may be a number or "2*{volume_ul}".
Volumes are in µL. A transfer from one well to several dispenses into each; equal-length lists pair up.
Tips are implicit: an instrument with "tips" takes the next unused tip (racks in order, column by column) for each transfer or mix
("new_tip": "once" keeps one tip for the whole instruction) and drops it in the labware of type "trash", which you must declare.
Labware are only the items placed on deck positions; built-in parts of the device (heads, transducers, pipettes, grippers) are instruments.
Use the device's documented positions, identifiers and capabilities only. Put adopted defaults in parameters and reference them rather than repeating values.
"constraints": every specificity or limit of this device stated in its documentation (volumes, resolution, capacities,
dead volumes, compatible labware, positions, speeds, …), each as a rule the simulator checks:
 {"applies_to": "transfer | mix | step | well", "rule": "expression that must be true", "message": "what the limit is", "source": "documentation excerpt"}
 A transfer or mix rule sees volume_ul, instrument, source_/destination_ labware, type, identifier, before_ul and after_ul
 (e.g. "volume_ul / 0.0025 == round(volume_ul / 0.0025)", "destination_after_ul <= 65 or destination_type != 'plate'");
 "step" rules apply to every transfer and mix; a "well" rule sees labware, type, identifier, well and well_volume_ul after each change.
 Rules use numbers, strings, + - * / // %, comparisons, and/or/not, abs, round, min, max. Declare only documented limits.
The following fields are shortcuts for common limits; give them too when documented:
labware rows, columns, max_volume_ul (well capacity or working volume) and dead_volume_ul (volume a source well cannot be drawn below);
instrument min_volume_ul, max_volume_ul and volume_step_ul (volume resolution, e.g. a droplet size: every volume must be a multiple of it)."""

ACTIONS = ("transfer", "mix", "incubate", "wait", "move", "device_op")
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.USub: operator.neg, ast.UAdd: operator.pos}


class ProtocolError(ValueError):
    pass


def parse(text):
    """Return the protocol dict if text is a BioBot protocol, else None."""
    try:
        protocol = json.loads(text) if isinstance(text, str) else text
    except ValueError:
        return None
    return protocol if isinstance(protocol, dict) and isinstance(protocol.get("program"), list) else None


_COMPARE = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le,
            ast.Gt: operator.gt, ast.GtE: operator.ge}
_FUNCTIONS = {"abs": abs, "round": round, "min": min, "max": max}


def evaluate(expr, scope):
    """Arithmetic, comparisons and and/or/not on numbers, strings and names in scope; anything else is rejected."""
    def walk(node):
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if isinstance(node, ast.Constant) and type(node.value) in (int, float, str, bool):
            return node.value
        if isinstance(node, ast.Name) and type(scope.get(node.id)) in (int, float, str, bool):
            return scope[node.id]
        if isinstance(node, ast.Compare) and all(type(op) in _COMPARE for op in node.ops):
            left = walk(node.left)
            for op, right in zip(node.ops, map(walk, node.comparators)):
                if not _COMPARE[type(op)](left, right):
                    return False
                left = right
            return True
        if isinstance(node, ast.BoolOp):
            values = (walk(value) for value in node.values)
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not walk(node.operand)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCTIONS and not node.keywords:
            return _FUNCTIONS[node.func.id](*map(walk, node.args))
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](walk(node.left), walk(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](walk(node.operand))
        raise ProtocolError(f"Unsupported expression: {expr}")
    try:
        return walk(ast.parse(str(expr).strip(), mode="eval"))
    except (SyntaxError, ZeroDivisionError, TypeError) as error:
        raise ProtocolError(f"Invalid expression {expr}: {error}") from None


def _number(value):
    return int(value) if float(value).is_integer() else round(value, 6)


def render(text, scope):
    return re.sub(r"\{([^{}]+)\}", lambda m: str(_number(evaluate(m[1], scope))), str(text))


def _volume(value, scope):
    volume = value if type(value) in (int, float) else evaluate(render(value, scope), scope)
    if not volume > 0:
        raise ProtocolError(f"Volume must be positive, got {value}.")
    return volume


def _split_well(well):
    match = re.fullmatch(r"([A-Z]+)(\d+)", well.strip().upper())
    if not match:
        raise ProtocolError(f"Invalid well {well}.")
    return match[1], int(match[2])


def _row_index(row):
    index = 0
    for char in row:
        index = index * 26 + ord(char) - 64
    return index


def _row_name(index):
    name = ""
    while index:
        index, rest = divmod(index - 1, 26)
        name = chr(65 + rest) + name
    return name


class _Run:
    def __init__(self, protocol):
        self.protocol = protocol
        self.labware = {item.get("id"): item for item in protocol.get("labware", []) if isinstance(item, dict)}
        self.instruments = [item for item in protocol.get("instruments", []) if isinstance(item, dict)]
        params = protocol.get("parameters") or {}
        if not isinstance(params, dict):
            raise ProtocolError("parameters must be an object of name: value.")
        self.params = params
        self.rules = [rule for rule in protocol.get("constraints", []) if isinstance(rule, dict) and rule.get("rule")]
        self.wells, self.steps, self.tips = {}, [], 0

    def locate(self, spec, scope):
        lab_id, _, wells = render(spec, scope).partition(":")
        lab = self.labware.get(lab_id.strip())
        if lab is None:
            raise ProtocolError(f"Unknown labware in {spec}.")
        result = []
        for part in filter(None, (p.strip() for p in wells.split(","))):
            first, _, last = part.partition("..")
            (row_a, col_a), (row_b, col_b) = _split_well(first), _split_well(last or first)
            if row_a == row_b:
                step = 1 if col_b >= col_a else -1
                result += [f"{row_a}{col}" for col in range(col_a, col_b + step, step)]
            elif col_a == col_b:
                a, b = _row_index(row_a), _row_index(row_b)
                step = 1 if b >= a else -1
                result += [f"{_row_name(r)}{col_a}" for r in range(a, b + step, step)]
            else:
                raise ProtocolError(f"A range must stay in one row or one column: {part}.")
        if not result:
            raise ProtocolError(f"No wells in {spec}.")
        for well in result:
            row, col = _split_well(well)
            if (type(lab.get("rows")) is int and _row_index(row) > lab["rows"]) or (type(lab.get("columns")) is int and col > lab["columns"]):
                raise ProtocolError(f"Well {well} does not exist in {lab_id}.")
        return lab_id.strip(), result

    def slot(self, lab_id):
        return str(self.labware[lab_id].get("position"))

    def update(self, lab_id, well):
        content = self.wells.get((lab_id, well), {"volume": 0, "liquids": {}})
        return {"slot": self.slot(lab_id), "well": well, "occupied": content["volume"] > 1e-9,
                "volume_ul": _number(content["volume"]),
                "liquids": [{"name": n, "volume_ul": _number(v)} for n, v in content["liquids"].items() if v > 1e-9]}

    def fill(self):
        for liquid in self.protocol.get("liquids", []):
            lab_id, wells = self.locate(liquid.get("at", ""), self.params)
            for well in wells:
                content = self.wells.setdefault((lab_id, well), {"volume": 0, "liquids": {}})
                volume = _volume(liquid.get("volume_ul"), self.params)
                content["volume"] += volume
                content["liquids"][liquid.get("name", "liquid")] = content["liquids"].get(liquid.get("name", "liquid"), 0) + volume
                self.check_capacity(lab_id, well)
        return [self.update(lab_id, well) for lab_id, well in self.wells]

    def check_capacity(self, lab_id, well):
        limit = self.labware[lab_id].get("max_volume_ul")
        volume = self.wells[(lab_id, well)]["volume"]
        if type(limit) in (int, float) and volume > limit + 1e-6:
            raise ProtocolError(f"{lab_id}:{well} overflows: {_number(volume)} µL > {limit} µL.")

    def instrument(self, name):
        if name is None:
            return self.instruments[0] if self.instruments else {}
        match = next((item for item in self.instruments if item.get("id") == name), None)
        if match is None:
            raise ProtocolError(f"Unknown instrument {name}.")
        return match

    def move_liquid(self, src, dst, volume):
        source = self.wells.get(src)
        dead = self.labware[src[0]].get("dead_volume_ul")
        if source is not None and type(dead) in (int, float) and source["volume"] - volume < dead - 1e-6:
            raise ProtocolError(f"{src[0]}:{src[1]} would go below its {dead} µL dead volume ({_number(source['volume'])} µL, aspirating {_number(volume)} µL).")
        if source is None or source["volume"] < volume - 1e-6:
            have = _number(source["volume"]) if source else 0
            raise ProtocolError(f"{src[0]}:{src[1]} holds {have} µL, cannot aspirate {_number(volume)} µL.")
        share = volume / source["volume"]
        target = self.wells.setdefault(dst, {"volume": 0, "liquids": {}})
        for name, amount in list(source["liquids"].items()):
            source["liquids"][name] -= amount * share
            target["liquids"][name] = target["liquids"].get(name, 0) + amount * share
        source["volume"] -= volume
        target["volume"] += volume
        self.check_capacity(*dst)

    def volume_of(self, place):
        return _number(self.wells.get(place, {"volume": 0})["volume"])

    def where(self, role, lab_id):
        lab = self.labware.get(lab_id, {})
        return {f"{role}_labware": lab_id or "", f"{role}_type": lab.get("type", ""), f"{role}_identifier": lab.get("identifier", "")}

    def check_rules(self, values, wells=()):
        """Every documented constraint that applies to this step (or to an affected well) must hold."""
        for rule in self.rules:
            target = rule.get("applies_to", "transfer")
            scopes = ([{**self.params, "labware": lab, "well": well, "well_volume_ul": self.volume_of((lab, well)),
                        "type": self.labware[lab].get("type", ""), "identifier": self.labware[lab].get("identifier", "")}
                       for lab, well in wells] if target == "well"
                      else [{**self.params, **values}] if target in ("step", values["action"]) else [])
            for scope in scopes:
                try:
                    holds = evaluate(rule["rule"], scope)
                except ProtocolError as error:
                    raise ProtocolError(f"Constraint “{rule.get('message') or rule['rule']}” cannot be evaluated: {error}") from None
                if not holds:
                    raise ProtocolError(f"{rule.get('message') or 'Device constraint violated'} (rule: {rule['rule']}).")

    def pick(self, pipette):
        """Pick up the next unused tip: racks in order, wells column by column. No-op without tips."""
        racks = pipette.get("tips") or []
        if not racks:
            return False
        index, self.tips = self.tips, self.tips + 1
        for rack in racks:
            lab = self.labware.get(rack)
            if lab is None:
                raise ProtocolError(f"Unknown tip rack {rack}.")
            rows, cols = lab.get("rows"), lab.get("columns")
            if type(rows) is not int or type(cols) is not int:
                well = None
                break
            if index < rows * cols:
                well = f"{_row_name(index % rows + 1)}{index // rows + 1}"
                break
            index -= rows * cols
        else:
            rack, well = racks[-1], None  # out of tips: reported once the program is expanded
        self.steps.append({"action": "pickup_tip", "source": {"slot": self.slot(rack), "wells": [well] if well else []},
                           "description": f"Pick up tip {rack}:{well}" if well else "Pick up tip", "code_lines": []})
        return True

    def drop(self):
        trash = next((lab_id for lab_id, lab in self.labware.items() if lab.get("type") == "trash"), None)
        step = {"action": "drop_tip", "description": "Drop tip in the trash", "code_lines": []}
        if trash:
            step["source"] = {"slot": self.slot(trash), "wells": []}
        self.steps.append(step)

    def transfer(self, op, scope):
        (src_lab, sources), (dst_lab, targets) = self.locate(op.get("from", ""), scope), self.locate(op.get("to", ""), scope)
        if len(sources) == 1:
            sources = sources * len(targets)
        if len(sources) != len(targets):
            raise ProtocolError(f"Cannot pair {len(sources)} sources with {len(targets)} destinations.")
        volume, pipette = _volume(op.get("volume"), scope), self.instrument(op.get("with"))
        low, high = pipette.get("min_volume_ul"), pipette.get("max_volume_ul")
        if (type(low) in (int, float) and volume < low) or (type(high) in (int, float) and volume > high):
            raise ProtocolError(f"{_number(volume)} µL is outside {pipette.get('id')}'s range {low}–{high} µL.")
        step = pipette.get("volume_step_ul")
        if type(step) in (int, float) and step > 0 and abs(volume / step - round(volume / step)) > 1e-6:
            raise ProtocolError(f"{_number(volume)} µL is not a multiple of {pipette.get('id')}'s {step} µL volume step.")
        once = op.get("new_tip") == "once"
        picked = once and self.pick(pipette)
        for source, target in zip(sources, targets):
            fresh = not once and self.pick(pipette)
            before = (self.volume_of((src_lab, source)), self.volume_of((dst_lab, target)))
            self.move_liquid((src_lab, source), (dst_lab, target), volume)
            self.check_rules({"action": "transfer", "volume_ul": volume, "instrument": pipette.get("id", ""),
                              **self.where("source", src_lab), **self.where("destination", dst_lab),
                              "source_before_ul": before[0], "source_after_ul": self.volume_of((src_lab, source)),
                              "destination_before_ul": before[1], "destination_after_ul": self.volume_of((dst_lab, target))},
                             [(src_lab, source), (dst_lab, target)])
            mix = f", mix {op['mix_after']}×" if op.get("mix_after") else ""
            self.steps.append({"action": "transfer", "source": {"slot": self.slot(src_lab), "wells": [source]},
                               "destination": {"slot": self.slot(dst_lab), "wells": [target]},
                               "volume": f"{_number(volume)} µL", "volume_ul": _number(volume),
                               "description": f"Transfer {_number(volume)} µL {src_lab}:{source} → {dst_lab}:{target}{mix}",
                               "code_lines": [],
                               "volume_changes": [{"slot": self.slot(src_lab), "well": source, "delta_ul": -_number(volume)},
                                                  {"slot": self.slot(dst_lab), "well": target, "delta_ul": _number(volume)}],
                               "well_updates": [self.update(src_lab, source), self.update(dst_lab, target)]})
            if fresh:
                self.drop()
        if picked:
            self.drop()

    def run(self, program, scope, path="program"):
        if not isinstance(program, list):
            raise ProtocolError(f"{path} must be a list of instructions.")
        for index, item in enumerate(program):
            where = f"{path}[{index}]"
            try:
                if isinstance(item, dict) and "for" in item:
                    first, _, last = render(item.get("in", ""), scope).partition("..")
                    for value in range(int(evaluate(first, scope)), int(evaluate(last or first, scope)) + 1):
                        self.run(item.get("do"), {**scope, item["for"]: value}, where + ".do")
                    continue
                if not isinstance(item, dict) or len(item) != 1 or next(iter(item)) not in ACTIONS:
                    raise ProtocolError(f"expected one of {', '.join(ACTIONS)} or for.")
                action, op = next(iter(item.items()))
                if not isinstance(op, dict):
                    raise ProtocolError(f"{action} needs an object of fields, got {op!r}.")
                if action == "transfer":
                    self.transfer(op, scope)
                    continue
                step = {"action": action, "code_lines": [], "description": op.get("description") or f"{action} " + ", ".join(f"{k} {render(v, scope) if isinstance(v, str) else v}" for k, v in op.items())}
                picked = False
                if action == "mix":
                    lab_id, wells = self.locate(op.get("at", ""), scope)
                    volume = _volume(op.get("volume"), scope)
                    picked = self.pick(self.instrument(op.get("with")))
                    step["source"] = {"slot": self.slot(lab_id), "wells": wells}
                    for well in wells:
                        self.check_rules({"action": "mix", "volume_ul": volume, "instrument": self.instrument(op.get("with")).get("id", ""),
                                          **self.where("source", lab_id), "source_before_ul": self.volume_of((lab_id, well)),
                                          "source_after_ul": self.volume_of((lab_id, well))}, [(lab_id, well)])
                elif action == "incubate" and op.get("at") not in self.labware:
                    raise ProtocolError(f"Unknown labware {op.get('at')}.")
                elif action == "move":
                    if op.get("labware") not in self.labware:
                        raise ProtocolError(f"Unknown labware {op.get('labware')}.")
                    self.labware[op["labware"]] = {**self.labware[op["labware"]], "position": op.get("to")}
                self.steps.append(step)
                if picked:
                    self.drop()
            except ProtocolError as error:
                raise ProtocolError(f"{where}: {error}") if not str(error).startswith("program") else error


def expand(protocol, positions=None):
    """Expand a protocol into simulator steps, checking it physically.
    positions: optional deck position ids the labware must use. Raises ProtocolError."""
    try:
        return _expand(protocol, positions)
    except (AttributeError, TypeError, KeyError, IndexError) as error:
        raise ProtocolError(f"Malformed protocol ({type(error).__name__}: {error}).") from None


def _expand(protocol, positions):
    protocol = parse(protocol)
    if protocol is None:
        raise ProtocolError("Not a BioBot protocol: a JSON object with a program list is required.")
    run = _Run(protocol)
    for lab_id, lab in run.labware.items():
        if positions is not None and str(lab.get("position")) not in {str(p) for p in positions}:
            raise ProtocolError(f"Labware {lab_id} uses unknown deck position {lab.get('position')}.")
    initial = run.fill()
    run.run(protocol["program"], dict(run.params))
    capacity = 0
    for name in {tip for item in run.instruments for tip in item.get("tips", [])}:
        lab = run.labware.get(name)
        if lab is None:
            raise ProtocolError(f"Unknown tip rack {name}.")
        capacity = None if capacity is None or type(lab.get("rows")) is not int or type(lab.get("columns")) is not int else capacity + lab["rows"] * lab["columns"]
    if capacity and run.tips > capacity:
        raise ProtocolError(f"The program needs {run.tips} tips but only {capacity} are loaded.")
    final = {f"{lab}:{well}": {"volume_ul": _number(c["volume"]), "liquids": {n: _number(v) for n, v in c["liquids"].items() if v > 1e-9}}
             for (lab, well), c in run.wells.items()}
    return {"steps": run.steps, "initial_wells": initial, "final_wells": final}


def match_positions(protocol, position_ids):
    """Map labware positions to the deck's real position ids when the match is unambiguous
    (same name ignoring case and punctuation, or contained in exactly one id). Returns a new protocol."""
    protocol = json.loads(json.dumps(parse(protocol)))
    norm = lambda value: re.sub(r"[^a-z0-9]", "", str(value).lower())
    ids = [str(i) for i in position_ids]
    for lab in protocol.get("labware", []):
        if not isinstance(lab, dict) or str(lab.get("position")) in ids:
            continue
        wanted = norm(lab.get("position"))
        same = [i for i in ids if norm(i) == wanted]
        near = [i for i in ids if wanted and (wanted in norm(i) or norm(i) in wanted)]
        match = same if len(same) == 1 else near if len(near) == 1 else []
        if match:
            lab["position"] = match[0]
    return protocol


def binding(protocol):
    """Simulator contents for get_deck, computed without any LLM call."""
    protocol = parse(protocol)
    result = expand(protocol)
    try:
        return _binding(protocol, result)
    except (AttributeError, TypeError, KeyError, IndexError) as error:
        raise ProtocolError(f"Malformed protocol ({type(error).__name__}: {error}).") from None


def _binding(protocol, result):
    parameters = []
    for name, value in (protocol.get("parameters") or {}).items():
        item = {"id": name, "label": name.replace("_", " "), "value": str(value)}
        if type(value) in (int, float):
            item.update(type="number", unit="", units={"": 1}, integer=type(value) is int)
        parameters.append(item)
    return {"title": protocol.get("description", ""), "steps": result["steps"], "initial_wells": result["initial_wells"],
            "parameters": parameters, "parameter_constraints": [],
            "positions": [{"id": str(lab.get("position")), "labware": lab.get("identifier"), "labware_display": lab.get("name") or lab.get("identifier"),
                           "variable": lab.get("id"), "type": lab.get("type", "plate"), "module": None,
                           **({"well_rows": lab["rows"], "well_columns": lab["columns"], "well_count": lab["rows"] * lab["columns"]}
                              if type(lab.get("rows")) is int and type(lab.get("columns")) is int else {})}
                          for lab in protocol.get("labware", [])],
            "instruments": [{"name": item.get("id"), "model": item.get("model"), "mount": item.get("mount"),
                             "tipracks": [str(next((l.get("position") for l in protocol.get("labware", []) if l.get("id") == t), t)) for t in item.get("tips", [])]}
                            for item in protocol.get("instruments", [])]}


def set_parameters(text, changes):
    """Apply set_parameter edits and return the updated protocol text; the result is re-checked."""
    protocol = parse(text)
    params = protocol.setdefault("parameters", {})
    for change in changes:
        name, value = change.get("parameter_id"), str(change.get("new_value", "")).strip()
        if name not in params:
            raise ProtocolError(f"Unknown parameter {name}.")
        try:
            params[name] = int(value) if re.fullmatch(r"[+-]?\d+", value) else float(value)
        except ValueError:
            params[name] = value
    expand(protocol)
    return json.dumps(protocol, indent=2, ensure_ascii=False)


def end_state_mismatches(protocol, expected):
    """Compare the expanded final volumes with expectations [{"at": WELLS, "volume_ul": n}]."""
    protocol, final = parse(protocol), expand(protocol)["final_wells"]
    run, problems = _Run(protocol), []
    for item in expected:
        try:
            lab_id, wells = run.locate(item.get("at", ""), run.params)
        except ProtocolError as error:
            problems.append(str(error))
            continue
        for well in wells:
            got, want = final.get(f"{lab_id}:{well}", {}).get("volume_ul", 0), item.get("volume_ul")
            if type(want) in (int, float) and abs(got - want) > max(0.5, 0.01 * want):
                problems.append(f"{lab_id}:{well} ends with {got} µL, expected {want} µL.")
    return problems


def movements(protocol):
    """Liquid movements (source position:well, destination position:well, µL) in execution order."""
    return [(f"{s['source']['slot']}:{s['source']['wells'][0]}", f"{s['destination']['slot']}:{s['destination']['wells'][0]}", s["volume_ul"])
            for s in expand(protocol)["steps"] if s["action"] == "transfer"]


def movement_difference(got, want):
    """Describe how two movement lists differ ("" when they match, volumes within rounding)."""
    same = lambda a, b: a[:2] == b[:2] and abs(a[2] - b[2]) <= max(0.01, 0.001 * abs(b[2]))
    show = lambda m: f"{m[0]} → {m[1]}, {m[2]} µL"
    if len(got) == len(want) and all(map(same, got, want)):
        return ""
    key = lambda m: (m[0], m[1], round(m[2], 2))
    pairs = [(i, a, b) for i, (a, b) in enumerate(zip(got, want)) if not same(a, b)]
    if sorted(map(key, got)) == sorted(map(key, want)):
        i, a, b = pairs[0]
        return f"the script makes the same {len(got)} transfers in a different order (first at #{i + 1}: script {show(a)}, protocol {show(b)})"
    parts = [f"the script makes {len(got)} transfers, the protocol {len(want)}"] if len(got) != len(want) else []
    if pairs:
        i, a, b = pairs[0]
        parts.append(f"{len(pairs)} transfer(s) differ, first at #{i + 1}: script {show(a)}, protocol {show(b)}")
    return "; ".join(parts)
