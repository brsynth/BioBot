"""Discover platform settings on demand; a fresh install has no robot registry."""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from openai import OpenAI
from config import biobot_model, light_functions_model


_DEBUG = os.environ.get("HANDLERS_DEBUG", "").lower() in ("1", "true", "yes")

def _log(msg):
    """Debug log — silent by default. Set HANDLERS_DEBUG=1 to enable."""
    if _DEBUG:
        print(msg, file=sys.stderr, flush=True)

DATA_DIR = Path(__file__).resolve().parent / "data"
HANDLERS_CONFIG_PATH = DATA_DIR / "handlers.json"


def load_handlers_config():
    """Load handlers.json, creating data/ dir if needed. Returns {} on first run."""
    if not HANDLERS_CONFIG_PATH.exists():
        _log(f"[handlers] No handlers.json at {HANDLERS_CONFIG_PATH} — starting fresh")
        return {}
    try:
        cfg = json.loads(HANDLERS_CONFIG_PATH.read_text())
        _log(f"[handlers] Loaded {len(cfg)} handler(s) from {HANDLERS_CONFIG_PATH}")
        return cfg
    except (json.JSONDecodeError, OSError) as e:
        _log(f"[handlers] WARNING: Could not read handlers.json: {e}")
        return {}


def _save_handlers(handlers):
    """Persist handlers dict to handlers.json, creating data/ dir if needed."""
    try:
        HANDLERS_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(HANDLERS_CONFIG_PATH, "w") as f:
            json.dump(handlers, f, indent=4)
        _log(f"[handlers] Saved {len(handlers)} handler(s) to {HANDLERS_CONFIG_PATH}")
        return True
    except Exception as e:
        # Save failures are important — always show them
        print(f"STEP:WARNING — Could not save handlers.json: {e}", flush=True)
        return False


def _find_tool(tool_name):
    """
    Find a CLI tool by name. Checks PATH first, then Python's own bin directory
    (where pip installs console_scripts like opentrons_simulate).
    Returns the full path if found, None otherwise.
    """
    import sys

    # 1. Standard PATH lookup
    found = shutil.which(tool_name)
    if found:
        return found

    # 2. Check Python's scripts/bin directory (pip console_scripts land here)
    python_bin = Path(sys.executable).parent / tool_name
    if python_bin.exists() and os.access(str(python_bin), os.X_OK):
        return str(python_bin)

    # 3. Common pip install locations in Docker/virtualenv
    for candidate_dir in ["/usr/local/bin", "/usr/bin", "/app/.venv/bin"]:
        candidate = Path(candidate_dir) / tool_name
        if candidate.exists() and os.access(str(candidate), os.X_OK):
            return str(candidate)

    return None


def _test_tool(tool_path):
    """
    Smoke-test a CLI tool by running it with --version.
    Returns True if it runs without crashing (exit code 0).
    This catches import-time errors like pydantic incompatibilities.
    """
    try:
        result = subprocess.run(
            [tool_path, "--version"],
            capture_output=True, text=True, timeout=30
        )
        return result.returncode == 0
    except Exception:
        return False


def _pip_install(pip_spec, timeout=300):
    """Run pip install for a given spec (e.g. 'opentrons==9.0.0'). Returns (success, stderr)."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", pip_spec, "--break-system-packages", "-q"],
            capture_output=True, text=True, timeout=timeout
        )
        return result.returncode == 0, result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "Installation timed out"
    except Exception as e:
        return False, str(e)


def _ask_llm_pip_info(client, tool_name):
    """Ask LLM for pip package name AND a known-good version for a CLI tool."""
    try:
        response = client.responses.create(
            model=light_functions_model,
            input=[
                {
                    "role": "system",
                    "content": "You are an expert in Python packaging and lab automation. "
                               "Given a CLI tool name, return ONLY valid JSON with two fields:\n"
                               '{"pip_package": "exact pip package name", "pip_version": "latest known stable version that works"}\n'
                               "For example, for 'opentrons_simulate': "
                               '{"pip_package": "opentrons", "pip_version": "9.0.0"}\n'
                               "Return ONLY the JSON. If you don't know the package, return: "
                               '{"pip_package": "unknown", "pip_version": null}'
                },
                {
                    "role": "user",
                    "content": f"CLI tool: {tool_name}"
                }
            ]
        )
        raw = response.output_text.strip()
        # Try JSON parse
        try:
            info = json.loads(raw)
            return info.get("pip_package"), info.get("pip_version")
        except json.JSONDecodeError:
            # Fallback: treat as plain package name (old behavior)
            pkg = raw.lower().strip("'\"")
            if pkg and pkg != "unknown" and re.fullmatch(r"[a-z0-9_.-]+", pkg):
                return pkg, None
            return None, None
    except Exception as e:
        _log(f"[handlers] WARNING: Could not query LLM for pip info: {e}")
        return None, None


def _try_install_tool(cfg, client):
    """
    Attempt to pip-install the package that provides a simulation tool.
    Uses 'pip_package' and 'pip_version' from handler config if available,
    otherwise asks the LLM. Tests the tool after install to catch runtime
    errors (e.g. pydantic incompatibilities).
    Returns the full path to the tool if install succeeded, None otherwise.
    """
    tool_name = cfg.get("simulate_tool")
    if not tool_name:
        return None

    # Already installed? Test it actually works
    found = _find_tool(tool_name)
    if found:
        if _test_tool(found):
            return found
        else:
            print(f"STEP:Found {tool_name} at {found} but it crashes — will reinstall...", flush=True)

    # Determine pip package name + version
    pip_pkg = cfg.get("pip_package")
    pip_ver = cfg.get("pip_version")

    if not pip_pkg:
        pip_pkg, pip_ver_from_llm = _ask_llm_pip_info(client, tool_name)
        if not pip_pkg or pip_pkg == "unknown":
            _log(f"[handlers] Could not determine pip package for '{tool_name}'")
            return None
        cfg["pip_package"] = pip_pkg
        if pip_ver_from_llm and not pip_ver:
            pip_ver = pip_ver_from_llm
            cfg["pip_version"] = pip_ver
        _log(f"[handlers] LLM says '{tool_name}' → pip '{pip_pkg}' version '{pip_ver}'")

    # Build install spec (with version pin if available)
    pip_spec = f"{pip_pkg}=={pip_ver}" if pip_ver else pip_pkg
    print(f"STEP:Installing '{pip_spec}' to enable simulation...", flush=True)

    success, stderr = _pip_install(pip_spec)
    if not success:
        _log(f"[handlers] ✗ Failed to install '{pip_spec}': {stderr[:200]}")
        # If we had a version pin and it failed, try without version
        if pip_ver:
            print(f"STEP:Version {pip_ver} failed — trying latest '{pip_pkg}'...", flush=True)
            success, stderr = _pip_install(pip_pkg)
            if not success:
                _log(f"[handlers] ✗ Also failed without version pin: {stderr[:200]}")
                return None

    # Check tool exists after install
    found = _find_tool(tool_name)
    if not found:
        _log(f"[handlers] WARNING: Installed '{pip_spec}' but '{tool_name}' still not found")
        return None

    # Smoke test — does it actually run without crashing?
    if _test_tool(found):
        print(f"STEP:✓ {tool_name} installed and verified at {found}", flush=True)
        return found

    # Tool crashes (e.g. pydantic issue) — try pinned version if we haven't yet
    if not pip_ver:
        print(f"STEP:{tool_name} crashes after install — asking for a known-good version...", flush=True)
        _, fallback_ver = _ask_llm_pip_info(client, tool_name)
        if fallback_ver:
            fallback_spec = f"{pip_pkg}=={fallback_ver}"
            print(f"STEP:Trying '{fallback_spec}'...", flush=True)
            success, _ = _pip_install(fallback_spec)
            if success:
                found = _find_tool(tool_name)
                if found and _test_tool(found):
                    cfg["pip_version"] = fallback_ver
                    print(f"STEP:✓ {tool_name} v{fallback_ver} works — saved version pin", flush=True)
                    return found

    print(f"STEP:✗ {tool_name} installed but crashes — using LLM review instead", flush=True)
    return None


def _refresh_simulation_status(cfg):
    """
    Check if a handler's simulation tool is available on this system.
    Uses the saved 'simulate_tool' field (the CLI command name from discovery).
    No LLM call — just a local _find_tool() check.

    Returns True if the config was changed (caller should persist).
    """
    tool_name = cfg.get("simulate_tool")

    # Migration: old entries may have simulate_cmd but no simulate_tool
    if not tool_name and cfg.get("simulate_cmd"):
        tool_name = cfg["simulate_cmd"][0] if isinstance(cfg["simulate_cmd"], list) else cfg["simulate_cmd"]
        cfg["simulate_tool"] = tool_name
        _log(f"[handlers] Migrated simulate_cmd → simulate_tool='{tool_name}'")

    if not tool_name:
        return False  # No known simulation tool for this platform

    found = _find_tool(tool_name)

    # If found, verify it actually works (catches pydantic/import crashes)
    tool_works = found and _test_tool(found)

    if tool_works and cfg.get("validation_strategy") != "simulation":
        # Tool is installed and works — upgrade to simulation
        cfg["simulate_cmd"] = [found]
        cfg["validation_strategy"] = "simulation"
        _log(f"[handlers] ✓ Simulation tool '{tool_name}' verified at {found} — upgrading to simulation")
        return True
    elif found and not tool_works and cfg.get("validation_strategy") == "simulation":
        # Tool exists but crashes — downgrade
        cfg["simulate_cmd"] = None
        cfg["validation_strategy"] = "llm_review"
        _log(f"[handlers] ✗ Simulation tool '{tool_name}' found but crashes — falling back to LLM review")
        return True
    elif not found and cfg.get("validation_strategy") == "simulation":
        # Tool was removed — downgrade to llm_review
        cfg["simulate_cmd"] = None
        cfg["validation_strategy"] = "llm_review"
        _log(f"[handlers] ✗ Simulation tool '{tool_name}' no longer found — falling back to LLM review")
        return True
    elif tool_works:
        _log(f"[handlers] ✓ Simulation tool '{tool_name}' available — validation_strategy=simulation")
    elif found:
        _log(f"[handlers] ✗ Simulation tool '{tool_name}' found but crashes — validation_strategy=llm_review")
    else:
        _log(f"[handlers] ✗ Simulation tool '{tool_name}' not installed — validation_strategy=llm_review")

    return False


def _discover_simulate_tool(cfg, client):
    """
    One-time LLM call to learn the CLI simulation tool for a known handler
    that was saved before simulate_tool tracking existed.
    Returns True if cfg was modified.
    """
    handler_name = cfg.get("name", "unknown")
    _log(f"[handlers] No simulate_tool for '{handler_name}' — one-time LLM lookup...")
    try:
        response = client.responses.create(
            model=light_functions_model,
            input=[
                {
                    "role": "system",
                    "content": "You are an expert in lab automation. Given a liquid handling platform name, "
                               "return ONLY the exact CLI command name (single word, no arguments) that can "
                               "simulate/validate protocols for this platform. For example, Opentrons uses "
                               "'opentrons_simulate'. If no well-known official simulation tool exists, "
                               "return exactly: none"
                },
                {
                    "role": "user",
                    "content": f"Platform: {handler_name}"
                }
            ]
        )
        cmd = response.output_text.strip().lower().strip("'\"")
        if cmd and cmd != "none" and re.fullmatch(r"[a-z0-9_.-]+", cmd):
            cfg["simulate_tool"] = cmd
            _log(f"[handlers] Discovered simulate_tool='{cmd}' for {handler_name}")
            return True
        else:
            _log(f"[handlers] No simulation tool known for {handler_name}")
            return False
    except Exception as e:
        _log(f"[handlers] WARNING: Could not discover simulate_tool: {e}")
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
    _log(f"[handlers] LLM detected platform: '{detected}'")

    # ── Known handler ──────────────────────────────────────────────
    if detected in available_ids:
        cfg = handlers[detected]
        _log(f"[handlers] Known handler '{detected}' — strategy={cfg.get('validation_strategy')}, "
             f"simulate_tool={cfg.get('simulate_tool')}, simulate_cmd={cfg.get('simulate_cmd')}")

        # One-time migration: if we have no simulate_tool info at all, ask LLM once
        needs_save = False
        if not cfg.get("simulate_tool") and not cfg.get("simulate_cmd"):
            needs_save = _discover_simulate_tool(cfg, client)

        # Quick local check: did the simulation tool get installed/removed since last run?
        needs_save = _refresh_simulation_status(cfg) or needs_save

        # If tool is known but not installed, try auto-installing
        if (cfg.get("simulate_tool") and
                cfg.get("validation_strategy") == "llm_review" and
                not cfg.get("simulate_cmd")):
            found_path = _try_install_tool(cfg, client)
            if found_path:
                cfg["simulate_cmd"] = [found_path]
                cfg["validation_strategy"] = "simulation"
                needs_save = True

        if needs_save:
            _save_handlers(handlers)

        # Show the user what validation setup is active
        strategy = cfg.get("validation_strategy", "llm_review")
        sim_cmd = cfg.get("simulate_cmd")
        if strategy == "simulation" and sim_cmd:
            print(f"STEP:Validation: simulation via {' '.join(sim_cmd)}", flush=True)
        else:
            print(f"STEP:Validation: LLM review (no simulation tool available)", flush=True)

        return detected, handlers

    # ── Unknown platform ───────────────────────────────────────────
    if detected == "unknown":
        return None, handlers
    if not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,63}", detected):
        raise ValueError("Invalid platform ID returned by discovery")

    # ── New handler — LLM discovery ────────────────────────────────
    _log(f"[handlers] New platform '{detected}' — running LLM discovery...")

    discovery_response = client.responses.create(
        model=light_functions_model,
        input=[
            {
                "role": "system",
                "content": """You are an expert in lab automation. Given a platform ID, return ONLY valid JSON with these fields:

{
  "name": "Official full name of the platform",
  "simulate_tool": "CLI command that can simulate/validate a protocol for this platform, or null if none exists",
  "pip_package": "The pip package name that provides the simulation tool, or null if none",
  "pip_version": "A known stable version of the pip package where the CLI tool works reliably, or null if unsure",
  "output_type": "The typical file format the platform uses: 'script' for Python, 'csv' for CSV picklists, 'hsl' for Hamilton HSL, 'file' for other",
  "keywords": ["keyword1", "keyword2"]
}

RULES:
- simulate_tool: the EXACT CLI command name (just the binary, no arguments). For example, Opentrons OT-2 and Flex use "opentrons_simulate". Only include well-known, official simulation tools. If unsure or none exists, use null.
- pip_package: the pip package that installs the simulation tool. For example, "opentrons_simulate" comes from pip package "opentrons". If unsure or none, use null.
- pip_version: a known stable version where the simulate_tool works. For example, opentrons 9.0.0 is stable. Newer versions may have dependency issues. Use null if unsure.
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
    pip_package = disco.get("pip_package")       # e.g. "opentrons" or None
    pip_version = disco.get("pip_version")       # e.g. "9.0.0" or None

    print(f"STEP:Detected new platform: {handler_name} (not in config — will search for docs)...", flush=True)
    if simulate_tool:
        ver_info = f" v{pip_version}" if pip_version else ""
        _log(f"[handlers] LLM says simulation tool is '{simulate_tool}' (pip: {pip_package}{ver_info})")

    # Build the handler entry early so _try_install_tool can use it
    new_cfg = {
        "name": handler_name,
        "docs_path": f"data/docs/{detected}",
        "store_path": f"rag_store_{detected}.pkl",
        "simulate_tool": simulate_tool,     # Always saved — the CLI name from discovery
        "pip_package": pip_package,          # Always saved — the pip package from discovery
        "pip_version": pip_version,          # Always saved — known-good version from discovery
        "simulate_cmd": None,
        "validation_strategy": "llm_review",
        "output_type": disco.get("output_type", "file"),
        "keywords": disco.get("keywords", [detected])
    }

    # Check if the simulation tool is installed, try to install if not
    if simulate_tool:
        found_path = _find_tool(simulate_tool)
        if not found_path:
            # Try auto-installing
            found_path = _try_install_tool(new_cfg, client)

        if found_path:
            new_cfg["simulate_cmd"] = [found_path]
            new_cfg["validation_strategy"] = "simulation"
            print(f"STEP:Simulation tool '{simulate_tool}' ready at {found_path} — will use simulation validation", flush=True)
        else:
            print(f"STEP:Could not install simulation tool '{simulate_tool}' — using LLM review", flush=True)
    else:
        _log(f"[handlers] No known simulation tool for this platform — using LLM review")

    handlers[detected] = new_cfg

    _save_handlers(handlers)
    print(f"STEP:Added {handler_name} to handlers config (strategy={new_cfg['validation_strategy']})", flush=True)

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