"""Discover platform settings on demand; a fresh install has no robot registry."""
import json
import re
from pathlib import Path
from openai import OpenAI
from config import biobot_model

DATA_DIR = Path(__file__).resolve().parent / "data"
HANDLERS_CONFIG_PATH = DATA_DIR / "handlers.json"


def load_handlers_config():
    if not HANDLERS_CONFIG_PATH.exists():
        return {}
    return json.loads(HANDLERS_CONFIG_PATH.read_text())


def get_openai_client(api_key):
    return OpenAI(api_key=api_key)


def detect_handler(query, history, api_key):
    """
    Detect which liquid handler the user is referring to using LLM classification.
    If the handler isn't in handlers.json, creates a dynamic entry so
    the doc fetcher can find and download its documentation.
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

    # Known handler — return directly
    if detected in available_ids:
        return detected, handlers

    if detected == "unknown":
        return None, handlers
    if not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,63}", detected):
        raise ValueError("Invalid platform ID returned by discovery")

    # New handler — ask the LLM for the proper display name
    name_response = client.responses.create(
        model=biobot_model,
        input=[
            {
                "role": "system",
                "content": "Return ONLY the official full name of this liquid handling robot platform/brand. No explanation, no punctuation, just the name."
            },
            {
                "role": "user",
                "content": f"Platform ID: {detected}"
            }
        ]
    )
    handler_name = name_response.output_text.strip().strip("'\"")

    print(f"STEP:Detected new platform: {handler_name} (not in config — will search for docs)...", flush=True)

    handlers[detected] = {
        "name": handler_name,
        "docs_path": f"data/docs/{detected}",
        "store_path": f"rag_store_{detected}.pkl",
        "simulate_cmd": None,
        "validation_strategy": "llm_review",
        "output_type": "file",
        "keywords": [detected]
    }

    # Save discovered platforms in runtime data.
    try:
        HANDLERS_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(HANDLERS_CONFIG_PATH, "w") as f:
            json.dump(handlers, f, indent=4)
        print(f"STEP:Added {handler_name} to handlers config", flush=True)
    except Exception as e:
        print(f"WARNING: Could not save to handlers.json: {e}", flush=True)

    return detected, handlers
