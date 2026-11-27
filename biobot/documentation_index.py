"""One persistent documentation index shared by preloading and generation."""
from api_budget import shared_setup
from background_jobs import BackgroundExecutor
import fcntl
import logging
import math
import os
from pathlib import Path
import pickle
import re
import tempfile
import threading
import time

import faiss
import numpy as np
from openai import OpenAI, APIConnectionError
from api_budget import metered_openai
OpenAI = metered_openai(OpenAI)
from config import get_api_key
from doc_loader import load_and_chunk_docs, get_supported_extensions
from doc_fetcher import fetch_documentation, update_documentation

SCRIPT_DIR = Path(__file__).resolve().parent
_executor = BackgroundExecutor(max_workers=2, thread_name_prefix="documentation")
_pending = {}
_pending_lock = threading.Lock()


def _pdf_recovered_since_index(docs_path, store_path):
    try:
        return (docs_path / ".pdf-recovered").stat().st_mtime_ns > store_path.stat().st_mtime_ns
    except FileNotFoundError:
        return False


def get_text_embedding_with_retry(text, api_key=None, retries=5, delay=2):
    client = OpenAI(api_key=api_key or get_api_key(), timeout=60, max_retries=0)
    for attempt in range(retries):
        try:
            return client.embeddings.create(model="text-embedding-3-small", input=text).data[0].embedding
        except Exception as error:
            status = getattr(error, "status_code", None)
            retryable = isinstance(error, APIConnectionError) or status in (408, 409, 429) or (isinstance(status, int) and 500 <= status < 600)
            if not retryable or attempt == retries - 1:
                raise
            headers = getattr(getattr(error, 'response', None), 'headers', {})
            body = getattr(error, 'body', None)
            waits = [delay]
            for value in (headers.get('retry-after'), body.get('retry_after') if isinstance(body, dict) else None):
                try:
                    value = float(value)
                    if math.isfinite(value) and value >= 0:
                        waits.append(value)
                except (TypeError, ValueError):
                    pass
            wait = max(waits)
            logging.getLogger(__name__).warning("Embedding request interrupted (HTTP %s); retrying in %.1fs (%s/%s)",
                                               status or 'connection', wait, attempt + 1, retries)
            time.sleep(wait)
            delay = min(delay * 2, 60)


def _save_embedding_cache(cache, cache_path):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=cache_path.parent, delete=False) as file:
            temporary = file.name
            pickle.dump(cache, file)
        os.replace(temporary, cache_path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def embed_chunks(chunks, api_key, docs_path):
    """Embeddings for passages, cached by their text across all devices (docs/_shared/embeddings.pkl)."""
    import hashlib
    shared = Path(docs_path).parent / "_shared"
    shared.mkdir(parents=True, exist_ok=True)
    cache_path = shared / "embeddings.pkl"
    key = lambda chunk: hashlib.sha256(chunk.encode()).hexdigest()
    with open(str(cache_path) + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with cache_path.open("rb") as file:
                cache = pickle.load(file)
        except (OSError, EOFError, pickle.UnpicklingError):
            cache = {}
        dirty = 0
        try:
            for chunk in dict.fromkeys(chunks):
                if key(chunk) not in cache:
                    cache[key(chunk)] = get_text_embedding_with_retry(chunk, api_key)
                    dirty += 1
                    if dirty >= 20:
                        _save_embedding_cache(cache, cache_path)
                        dirty = 0
        finally:
            # Preserve successful passages even if a later request fails.
            if dirty:
                _save_embedding_cache(cache, cache_path)
    return np.asarray([cache[key(chunk)] for chunk in chunks], dtype="float32")


@shared_setup()
def load_or_build_index(handler_id, handler_config, chunk_size=3000, api_key=None):
    docs_path = SCRIPT_DIR / handler_config["docs_path"]
    store_path = docs_path / handler_config["store_path"]
    store_path.parent.mkdir(parents=True, exist_ok=True)
    name = handler_config["name"]
    # Processes share this lock: a protocol waits for its preload, then loads it.
    with open(str(store_path) + ".lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("STEP:Checking available resources...", flush=True)
            fcntl.flock(lock, fcntl.LOCK_EX)
        if store_path.exists() and not _pdf_recovered_since_index(docs_path, store_path):
            print("STEP:Checking available resources...", flush=True)
            with store_path.open("rb") as file:
                store = pickle.load(file)
        else:
            extensions = set(get_supported_extensions())
            has_docs = any(path.is_file() and path.suffix.lower() in extensions for path in docs_path.rglob("*"))
            if not has_docs and not fetch_documentation(name, handler_config.get("keywords", []), str(docs_path), api_key or get_api_key()):
                return [], [], None
            print("STEP:Checking available resources...", flush=True)
            chunks, sources = load_and_chunk_docs(str(docs_path), chunk_size)
            if not chunks:
                return [], [], None
            store = {"chunks": chunks, "chunk_sources": sources,
                     "embeddings": embed_chunks(chunks, api_key, docs_path)}
            # A terminated build must never leave a partial cache for the next request.
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=store_path.parent, delete=False) as file:
                    temporary = file.name
                    pickle.dump(store, file)
                os.replace(temporary, store_path)
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
        embeddings = np.asarray(store["embeddings"], dtype="float32")
        index = faiss.IndexFlatL2(embeddings.shape[1])
        index.add(embeddings)
        return store["chunks"], store["chunk_sources"], index


@shared_setup()
def refresh_index(handler_config, chunk_size=3000, api_key=None):
    """Fetch only new or changed documentation and re-embed only the passages whose text changed."""
    docs_path = SCRIPT_DIR / handler_config["docs_path"]
    store_path = docs_path / handler_config["store_path"]
    if not store_path.exists():
        return 0
    changed = update_documentation(handler_config["name"], handler_config.get("keywords", []), str(docs_path), api_key or get_api_key())
    if not changed and not _pdf_recovered_since_index(docs_path, store_path):
        return 0
    with open(str(store_path) + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with store_path.open("rb") as file:
            old = pickle.load(file)
        chunks, sources = load_and_chunk_docs(str(docs_path), chunk_size)
        store = {"chunks": chunks, "chunk_sources": sources, "embeddings": embed_chunks(chunks, api_key, docs_path)}
        with tempfile.NamedTemporaryFile(dir=store_path.parent, delete=False) as file:
            pickle.dump(store, file)
        os.replace(file.name, store_path)
    return changed


@shared_setup()
def preload_documentation(device, api_key=None, check_updates=True):
    """Return a shared future for preparing the selected device documentation."""
    key = re.sub(r"[^a-z0-9]", "", device.casefold())
    job_key = key if check_updates else key + ":initial"
    def prepare():
        from handlers import load_handlers_config, detect_handler
        handlers = load_handlers_config()
        handler_id = next((identifier for identifier, config in handlers.items()
                           if re.sub(r"[^a-z0-9]", "", config["name"].casefold()) == key), None)
        if handler_id is None:
            handler_id, handlers = detect_handler(device, [], api_key)
        if handler_id:
            existed = (SCRIPT_DIR / handlers[handler_id]["docs_path"] / handlers[handler_id]["store_path"]).exists()
            _, _, index = load_or_build_index(handler_id, handlers[handler_id], api_key=api_key)
            if index is None:
                raise ValueError("No usable device documentation was downloaded. Please retry.")
            if existed and check_updates:  # each request also checks online for new or changed documentation, in the background
                refresh_index(handlers[handler_id], api_key=api_key)
            return True
        raise ValueError("Could not prepare documentation for this device.")
    with _pending_lock:
        if job_key in _pending and not _pending[job_key].done():
            return _pending[job_key]
        future = _executor.submit(prepare)
        _pending[job_key] = future
    def finished(result):
        with _pending_lock:
            if _pending.get(job_key) is result:
                del _pending[job_key]
        try:
            result.result()
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Device documentation preload failed")
    future.add_done_callback(finished)
    return future
