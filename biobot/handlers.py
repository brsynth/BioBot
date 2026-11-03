"""Discover platform settings on demand; a fresh install has no robot registry."""
import json
import re
import shutil
from pathlib import Path
from openai import OpenAI
from config import biobot_model, light_functions_model

DATA_DIR = Path(__file__).resolve().parent / "data"
HANDLERS_CONFIG_PATH = DATA_DIR / "handlers.json"


def load_handlers_config():
    """Load handlers.json, creating data/ dir if needed. Returns {} on first run."""
    if not HANDLERS_CONFIG_PATH.exists():
        print(f"[handlers] No handlers.json at {HANDLERS_CONFIG_PATH} — starting fresh", flush=True)
        return {}
    try:
        cfg = json.loads(HANDLERS_CONFIG_PATH.read_text())
        print(f"[handlers] Loaded {len(cfg)} handler(s) from {HANDLERS_CONFIG_PATH}", flush=True)
        return cfg
    except (json.JSONDecodeError, OSError) as e:
        print(f"[handlers] WARNING: Could not read handlers.json: {e}", flush=True)
        return {}


def _save_handlers(handlers):
    """Persist handlers dict to handlers.json, creating data/ dir if needed."""
    try:
        HANDLERS_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(HANDLERS_CONFIG_PATH, "w") as f:
            json.dump(handlers, f, indent=4)
        print(f"[handlers] Saved {len(handlers)} handler(s) to {HANDLERS_CONFIG_PATH}", flush=True)
        return True
    except Exception as e:
        print(f"[handlers] WARNING: Could not save handlers.json: {e}", flush=True)
        return False


def _refresh_simulation_status(cfg):
    """
    Check if a handler's simulation tool is available on this system.
    Uses the saved 'simulate_tool' field (the CLI command name from discovery).
    No LLM call — just a local shutil.which() check.

    Returns True if the config was changed (caller should persist).
    """
    tool_name = cfg.get("simulate_tool")  # e.g. "opentrons_simulate"
    if not tool_name:
        return False  # No known simulation tool for this platform

    found = shutil.which(tool_name)

    if found and cfg.get("validation_strategy") != "simulation":
        # Tool is now installed — upgrade to simulation
        cfg["simulate_cmd"] = [tool_name]
        cfg["validation_strategy"] = "simulation"
        print(f"[handlers] ✓ Simulation tool '{tool_name}' found at {found} — upgrading to simulation validation", flush=True)
        return True
    elif not found and cfg.get("validation_strategy") == "simulation":
        # Tool was removed — downgrade to llm_review
        cfg["simulate_cmd"] = None
        cfg["validation_strategy"] = "llm_review"
        print(f"[handlers] ✗ Simulation tool '{tool_name}' no longer found — falling back to LLM review", flush=True)
        return True
    elif found:
        print(f"[handlers] ✓ Simulation tool '{tool_name}' available — validation_strategy=simulation", flush=True)
    else:
        print(f"[handlers] ✗ Simulation tool '{tool_name}' not installed — validation_strategy=llm_review", flush=True)

    return False


def get_openai_client(api_key):
    return OpenAI(api_key=api_key)


def detect_handler(query, history, api_key):
    """
    Detect which liquid handler the user is referring to using LLM classification.
    If the handler isn't in handlers.json, creates a dynamic entry via LLM discovery.
    On every call, re-checks whether the simulation tool is installed (no LLM needed).
    """
    handlers = load_handlers_config()
    available_ids = list(handlers.keys())
    client = get_openai_client(api_key)

    # Build context from recent conversation
    recent = [m for m in history if m["role"] != "system"][-8:]
    conversation_context = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content'][:500]}"
        for m in recent
    )

    # Build the known platforms description
    if available_ids:
        known_list = "\n".join(
            f'  - "{hid}" → {cfg["name"]}'
            for hid, cfg in handlers.items()
        )
    else:
        known_list = "  (none configured)"

    response = client.responses.create(
        model=biobot_model,
        input=[
            {
                "role": "system",
                "content": f"""You are an expert in lab automation and liquid handling robots.

Your task: identify which liquid handling PLATFORM (robot/instrument) the user is requesting a protocol for.

Here are the platforms already configured in our system:
{known_list}

INSTRUCTIONS:
1. Read the user's latest message AND the conversation history carefully.
2. Identify the liquid handling platform they are referring to.
3. If the platform matches one already configured, return its exact ID (the text in quotes above).
4. If the platform is NOT in the list above, return a new short lowercase ID for it. Use only lowercase letters, digits and underscores, identifying the specific instrument model when available.
5. If the user does NOT mention or imply any specific platform anywhere in the conversation, return "unknown".

IMPORTANT:
- Focus on the INSTRUMENT/ROBOT brand, not reagents, software, or lab techniques.
- Look at the ENTIRE conversation, not just the latest message — the platform may have been mentioned earlier.

Return ONLY the platform ID. One word, lowercase, no quotes, no explanation."""
            },
            {
                "role": "user",
                "content": f"Conversation history:\n{conversation_context}\n\nLatest message: {query}"
            }
        ]
    )

    detected = response.output_text.strip().lower().strip('"').replace(" ", "_")
    print(f"[handlers] LLM detected platform: '{detected}'", flush=True)

    # ── Known handler ──────────────────────────────────────────────
    if detected in available_ids:
        cfg = handlers[detected]
        print(f"[handlers] Known handler '{detected}' — strategy={cfg.get('validation_strategy')}, "
              f"simulate_tool={cfg.get('simulate_tool')}, simulate_cmd={cfg.get('simulate_cmd')}", flush=True)

        # Quick local check: did the simulation tool get installed/removed since last run?
        changed = _refresh_simulation_status(cfg)
        if changed:
            _save_handlers(handlers)

        return detected, handlers

    # ── Unknown platform ───────────────────────────────────────────
    if detected == "unknown":
        return None, handlers
    if not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,63}", detected):
        raise ValueError("Invalid platform ID returned by discovery")

    # ── New handler — LLM discovery ────────────────────────────────
    print(f"[handlers] New platform '{detected}' — running LLM discovery...", flush=True)

    discovery_response = client.responses.create(
        model=light_functions_model,
        input=[
            {
                "role": "system",
                "content": """You are an expert in lab automation. Given a platform ID, return ONLY valid JSON with these fields:

{
  "name": "Official full name of the platform",
  "simulate_tool": "CLI command that can simulate/validate a protocol for this platform, or null if none exists",
  "output_type": "The typical file format the platform uses: 'script' for Python, 'csv' for CSV picklists, 'hsl' for Hamilton HSL, 'file' for other",
  "keywords": ["keyword1", "keyword2"]
}

RULES:
- simulate_tool: the EXACT CLI command name (just the binary, no arguments). For example, Opentrons OT-2 and Flex use "opentrons_simulate". Only include well-known, official simulation tools. If unsure or none exists, use null.
- keywords: 2-4 search terms useful for finding documentation for this platform.
- Return ONLY the JSON. No markdown, no explanation."""
            },
            {
                "role": "user",
                "content": f"Platform ID: {detected}"
            }
        ]
    )

    try:
        disco = json.loads(_clean_discovery_json(discovery_response.output_text))
    except (json.JSONDecodeError, ValueError):
        disco = {}

    handler_name = disco.get("name") or detected.replace("_", " ").title()
    simulate_tool = disco.get("simulate_tool")  # e.g. "opentrons_simulate" or None

    print(f"STEP:Detected new platform: {handler_name} (not in config — will search for docs)...", flush=True)
    if simulate_tool:
        print(f"[handlers] LLM says simulation tool is '{simulate_tool}'", flush=True)

    # Check if the discovered simulation tool is actually installed right now
    sim_cmd = None
    validation_strategy = "llm_review"

    if simulate_tool and shutil.which(simulate_tool):
        sim_cmd = [simulate_tool]
        validation_strategy = "simulation"
        print(f"STEP:Found simulation tool '{simulate_tool}' — will use simulation validation", flush=True)
    elif simulate_tool:
        print(f"STEP:Simulation tool '{simulate_tool}' not installed yet — using LLM review (will auto-upgrade when installed)", flush=True)
    else:
        print(f"[handlers] No known simulation tool for this platform — using LLM review", flush=True)

    handlers[detected] = {
        "name": handler_name,
        "docs_path": f"data/docs/{detected}",
        "store_path": f"rag_store_{detected}.pkl",
        "simulate_tool": simulate_tool,     # Always saved — the CLI name from discovery
        "simulate_cmd": sim_cmd,            # Runtime: [tool_name] if installed, else None
        "validation_strategy": validation_strategy,
        "output_type": disco.get("output_type", "file"),
        "keywords": disco.get("keywords", [detected])
    }

    _save_handlers(handlers)
    print(f"STEP:Added {handler_name} to handlers config (strategy={validation_strategy})", flush=True)

    return detected, handlers


def _clean_discovery_json(raw: str) -> str:
    """Strip markdown fences and fix trailing commas from LLM JSON output."""
    result = raw.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[1] if "\n" in result else result[3:]
    if result.endswith("```"):
        result = result[:-3].strip()
    if result.startswith("json"):
        result = result[4:].strip()
    # Fix trailing commas before } or ]
    result = re.sub(r',\s*([\]}])', r'\1', result)
    return result