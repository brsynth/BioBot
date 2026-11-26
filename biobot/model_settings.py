"""OpenAI models used by BioBot: chosen by administrators, listed with their prices, refreshed daily."""
import json
import re
import time
from datetime import datetime, timedelta, timezone

from psycopg2.extras import Json

from config import get_db_connection

# Each role keeps a built-in default, used until an administrator chooses another model.
ROLES = {
    "main": ("Main model", "gpt-5.6-sol",
             "Protocol generation, deck binding, device layouts and compatible-item lists"),
    "light": ("Light model", "gpt-4o-mini", "Classification, quick checks and general hardware lists"),
    "documentation": ("Documentation model", "gpt-6.2-sol", "Finding official device documentation"),
}
UPDATE_MODES = {"off", "cheaper", "always"}
MODEL_CLASSES = {"sol", "mini", "nano", "terra", "luna", "astra", "pro"}
PRICING_URL = "https://developers.openai.com/api/docs/pricing"
REFRESH_EVERY = timedelta(days=1)
_cache = {"at": 0.0, "models": {}, "key": None}


def init_settings_tables(cursor):
    cursor.execute("""CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL,
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""")


def _read(cursor, key):
    init_settings_tables(cursor)  # also for installations started before this table existed
    cursor.execute("SELECT value FROM app_settings WHERE key = %s", (key,))
    row = cursor.fetchone()
    return row[0] if row else None


def _write(cursor, key, value):
    cursor.execute("""INSERT INTO app_settings (key, value) VALUES (%s, %s)
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()""", (key, Json(value)))


def _refresh_cache():
    """Read the administrator settings at most once a minute, never failing a request."""
    if time.monotonic() - _cache["at"] <= 60:
        return
    try:
        conn = get_db_connection()
        try:
            with conn, conn.cursor() as cursor:
                _cache["models"] = _read(cursor, "models") or {}
                stored = _read(cursor, "system_api_key")
                _cache["key"] = _cipher().decrypt(stored["cipher"].encode()).decode() if stored else None
        finally:
            conn.close()
    except Exception:
        pass
    _cache["at"] = time.monotonic()


def model_for(role):
    """The model chosen for a role, or its built-in default."""
    _refresh_cache()
    return _cache["models"].get(role) or ROLES[role][1]


def _cipher():
    """System API key encryption, bound to this installation's secret."""
    import base64, hashlib
    from cryptography.fernet import Fernet
    from config import get_flask_secret_key
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(f"biobot-system-api-key:{get_flask_secret_key()}".encode()).digest()))


def system_api_key():
    """The installation-wide OpenAI key set by an administrator, used when a user has none."""
    _refresh_cache()
    return _cache["key"]


def set_system_api_key(value, actor):
    """Store (encrypted) or clear the installation-wide key; it is never returned, only its last characters."""
    from admin_console import audit
    if not isinstance(value, str) or (value and not re.fullmatch(r"sk-[A-Za-z0-9_\-]{20,300}", value.strip())):
        raise ValueError("Enter an OpenAI API key (sk-…), or leave it empty to remove the stored key.")
    value = value.strip()
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            if value:
                _write(cursor, "system_api_key", {"cipher": _cipher().encrypt(value.encode()).decode(), "last4": value[-4:]})
            else:
                cursor.execute("DELETE FROM app_settings WHERE key = 'system_api_key'")
            audit(cursor, actor, "set_system_api_key", "system_api_key", {"set": bool(value)})
    finally:
        conn.close()
    _cache["at"] = 0.0


def settings():
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            chosen, catalog = _read(cursor, "models") or {}, _read(cursor, "openai_catalog") or {}
            stored_key = _read(cursor, "system_api_key")
            updates = _read(cursor, "model_updates") or {}
    finally:
        conn.close()
    return {"roles": [{"role": role, "label": label, "detail": detail, "default": default,
                       "model": chosen.get(role) or default, "auto_update": updates.get(role, "off"),
                       "model_class": _model_class({"id": chosen.get(role) or default,
                           **next((m for m in catalog.get("models", []) if m["id"] == (chosen.get(role) or default)), {})})} for role, (label, default, detail) in ROLES.items()],
            "catalog": catalog, "system_key": {"last4": stored_key["last4"]} if stored_key else None}


def set_models(data, actor):
    from admin_console import audit
    if not isinstance(data, dict) or not data or set(data) - set(ROLES) - {"updates"}:
        raise ValueError("Unsupported model settings.")
    selections = {key: value for key, value in data.items() if key in ROLES}
    updates = data.get("updates", {})
    if not isinstance(updates, dict) or set(updates) - set(ROLES) or any(
            not isinstance(mode, str) or mode not in UPDATE_MODES for mode in updates.values()):
        raise ValueError("Choose off, cheaper, or always for each model update policy.")
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            _lock_model_settings(cursor)
            known = {item["id"] for item in (_read(cursor, "openai_catalog") or {}).get("models", [])}
            for role, model in selections.items():
                if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", model):
                    raise ValueError("Invalid model name.")
                if known and model not in known and model != ROLES[role][1]:
                    raise ValueError(f"{model} is not among the available OpenAI models.")
            if selections:
                _write(cursor, "models", {**(_read(cursor, "models") or {}), **selections})
            if updates:
                _write(cursor, "model_updates", {**(_read(cursor, "model_updates") or {}), **updates})
            audit(cursor, actor, "set_models", "models", data)
    finally:
        conn.close()
    _cache["at"] = 0.0


def _lock_model_settings(cursor):
    cursor.execute("SELECT pg_advisory_xact_lock(hashtext('biobot-model-settings'))")


def _model_class(info):
    """Named classes are fixed; newly named equivalents require an official source."""
    name = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", info["id"])
    match = re.fullmatch(r"gpt-\d+(?:\.\d+|o)?(?:-(sol|mini|nano|terra|luna|astra|pro))?", name)
    if match and (match[1] or int(re.match(r"gpt-(\d+)", name)[1]) < 6):
        return match[1] or "sol"
    if (isinstance(info.get("model_class"), str) and info["model_class"] in MODEL_CLASSES and isinstance(info.get("class_source"), str)
            and info["class_source"].startswith(("https://developers.openai.com/", "https://platform.openai.com/"))):
        return info["model_class"]
    return None


def _newer(candidate, current):
    """Use documented release dates, otherwise compare standard GPT versions."""
    dates = []
    for index, item in enumerate((candidate, current)):
        try:
            released = datetime.strptime(item.get("released_at", ""), "%Y-%m-%d").date()
            if index == 0 and released > datetime.now(timezone.utc).date():
                return False
            dates.append(released if released <= datetime.now(timezone.utc).date() else None)
        except (TypeError, ValueError):
            dates.append(None)
    if all(dates):
        return dates[0] > dates[1]
    def version(item):
        match = re.fullmatch(r"gpt-(\d+)(?:\.(\d+)|o)?(?:-(?:sol|mini|nano|terra|luna|astra|pro))?(?:-\d{4}-\d{2}-\d{2})?", item["id"])
        return (int(match[1]), int(match[2] or 0)) if match else None
    versions = [version(item) for item in (candidate, current)]
    return bool(all(versions) and versions[0] > versions[1])


def _no_more_expensive(candidate, current):
    pairs = [(candidate.get(key), current.get(key)) for key in ("input", "output", "cached_input")]
    if pairs[-1] == (None, None):
        pairs.pop()  # neither model advertises a cached-input rate
    return all(type(new) in (int, float) and type(old) in (int, float) and 0 <= new <= old
               for new, old in pairs)


def _auto_updates(chosen, policies, models):
    """Return only newer same-class, available, stable models suitable for each task."""
    catalog = {item["id"]: item for item in models}
    changes = {}
    for role, (_, default, _) in ROLES.items():
        mode = policies.get(role, "off")
        if mode not in ("cheaper", "always"):
            continue
        current = catalog.get(chosen.get(role) or default, {"id": chosen.get(role) or default})
        model_class = _model_class(current)
        if not model_class:
            continue
        best = current
        for item in models:
            if (item.get("status") != "stable" or not _chat_model(item["id"])
                    or _model_class(item) != model_class or not _newer(item, current)):
                continue
            if role != "light" and item.get("web_search") is not True:
                continue
            if mode == "cheaper" and not _no_more_expensive(item, current):
                continue
            if _newer(item, best):
                best = item
        if best["id"] != current["id"]:
            changes[role] = best["id"]
    return changes


def _apply_auto_updates(cursor, catalog):
    from admin_console import audit
    _lock_model_settings(cursor)
    chosen = _read(cursor, "models") or {}
    policies = _read(cursor, "model_updates") or {}
    changes = _auto_updates(chosen, policies, catalog["models"])
    if changes:
        _write(cursor, "models", {**chosen, **changes})
        for role, model in changes.items():
            audit(cursor, None, "auto_update_model", role, {
                "from": chosen.get(role) or ROLES[role][1], "to": model, "policy": policies[role]})
        _cache["at"] = 0.0


def _chat_model(model_id):
    """Text-generation models only, without dated snapshots (their alias is listed)."""
    return (re.match(r"(gpt-|o\d|chatgpt-)", model_id) and not re.search(r"\d{4}-\d{2}-\d{2}$", model_id)
            and not re.search(r"audio|realtime|tts|transcribe|image|search|embedding|moderation", model_id))


def _model_prices(model_id, prices):
    """Match dated snapshots to the published prices for their model family."""
    family = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model_id)
    exact, base = prices.get(model_id) or {}, prices.get(family) or {}
    result = {}
    for key in ("input", "cached_input", "output"):
        value = exact.get(key)
        if value is None:
            value = base.get(key)
        result[key] = float(value) if type(value) in (int, float) and 0 <= value < 10000 else None
    return result


def refresh_catalog(api_key, force=False):
    """List the OpenAI models this key can use and their official prices; at most once a day unless forced."""
    from openai import OpenAI
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(hashtext('openai-catalog'))")
            if not cursor.fetchone()[0]:
                return None  # another worker is refreshing
            previous = _read(cursor, "openai_catalog") or {}
            checked = previous.get("checked_at")
            if not force and checked and datetime.now(timezone.utc) - datetime.fromisoformat(checked) < REFRESH_EVERY:
                return previous
            client = OpenAI(api_key=api_key, timeout=180, max_retries=0)
            chosen = set((_read(cursor, "models") or {}).values()) | {default for _, default, _ in ROLES.values()}
            available = {model.id for model in client.models.list().data}
            ids = sorted({model_id for model_id in available if _chat_model(model_id)} | (chosen & available))
            # Prices need a model call; if it fails (e.g. no credits), keep the last known prices.
            known, price_error = {item["id"]: item for item in previous.get("models", [])}, None
            try:
                response = client.responses.create(model=model_for("main"), tools=[{"type": "web_search"}], input=[
                    {"role": "system", "content": (
                        f"Read OpenAI's official API pricing page ({PRICING_URL}). Return ONLY JSON: "
                        '{"models": {"<model id>": {"input": number, "cached_input": number or null, "output": number, '
                        '"model_class": "sol|mini|nano|terra|luna|astra|pro or null", "class_source": "official URL or null", '
                        '"released_at": "YYYY-MM-DD or null", "status": "stable|preview|deprecated or null", "web_search": true or false or null}}} '
                        "with Standard-tier USD prices per 1M tokens. Include only ids whose price the official page lists; "
                        "For dated snapshots, also consult the official model page to find their model family and its published prices. "
                        "Include model-family prices under their undated ids. Never estimate a price. "
                        "Use official model pages and the OpenAI changelog for classes, release dates, stability and web-search support. "
                        "Include metadata even when prices are unavailable. Keep named tiers separate. Only classify a differently named "
                        "model as equivalent when an official source establishes the equivalence; otherwise use null. Never infer release dates from knowledge cutoffs.")},
                    {"role": "user", "content": "Model ids: " + json.dumps(ids)},
                ])
                match = re.search(r"\{[\s\S]*\}", response.output_text or "")
                if not match:
                    raise ValueError("No model catalog returned by the pricing lookup.")
                prices = json.loads(match[0]).get("models")
                if not isinstance(prices, dict) or not prices or any(not isinstance(item, dict) for item in prices.values()):
                    raise ValueError("The model catalog lookup returned invalid data.")
            except Exception as error:
                prices, price_error = known, f"{type(error).__name__}: {str(error)[:160]}"
            models = [{"id": model_id, **_model_prices(model_id, prices),
                       **{key: (prices.get(model_id) or {}).get(key)
                          for key in ("model_class", "class_source", "released_at", "status", "web_search")}} for model_id in ids]
            # A failed price lookup is retried at the next hourly pass rather than in a day.
            catalog = {"checked_at": previous.get("checked_at") if price_error else datetime.now(timezone.utc).isoformat(),
                       "source": PRICING_URL, "models": models, "price_error": price_error}
            _write(cursor, "openai_catalog", catalog)
            if not price_error:
                _apply_auto_updates(cursor, catalog)
            return catalog
    finally:
        conn.close()


def start_daily_refresh(get_key):
    """Refresh the model list and prices once a day in the background when a server key is configured."""
    from threading import Thread

    def loop():
        while True:
            try:
                key = get_key()
                if key:
                    refresh_catalog(key)
            except Exception as error:
                print(f"OpenAI model catalog refresh failed: {error}")
            time.sleep(3600)
    Thread(target=loop, name="openai-catalog", daemon=True).start()
