"""One persistent documentation index shared by preloading and generation."""
from concurrent.futures import ThreadPoolExecutor
import fcntl
import os
from pathlib import Path
import pickle
import re
import tempfile
import threading
import time

import faiss
import numpy as np
from openai import OpenAI
from config import get_api_key
from doc_loader import load_and_chunk_docs, get_supported_extensions
from doc_fetcher import fetch_documentation, update_documentation

SCRIPT_DIR = Path(__file__).resolve().parent
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="documentation")
_pending = {}
_pending_lock = threading.Lock()


def get_text_embedding_with_retry(text, api_key=None, retries=5, delay=2):
    client = OpenAI(api_key=api_key or get_api_key(), timeout=60, max_retries=0)
    for attempt in range(retries):
        try:
            return client.embeddings.create(model="text-embedding-3-small", input=text).data[0].embedding
        except Exception as error:
            if "rate limit" not in str(error).lower() or attempt == retries - 1:
                raise
            time.sleep(delay)
            delay *= 2


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
        if store_path.exists():
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
                     "embeddings": np.asarray([get_text_embedding_with_retry(chunk, api_key) for chunk in chunks], dtype="float32")}
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


def refresh_index(handler_config, chunk_size=3000, api_key=None):
    """Fetch only new or changed documentation and re-embed only the passages whose text changed."""
    docs_path = SCRIPT_DIR / handler_config["docs_path"]
    store_path = docs_path / handler_config["store_path"]
    if not store_path.exists():
        return 0
    changed = update_documentation(handler_config["name"], handler_config.get("keywords", []), str(docs_path), api_key or get_api_key())
    if not changed:
        return 0
    with open(str(store_path) + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with store_path.open("rb") as file:
            old = pickle.load(file)
        known = dict(zip(old["chunks"], old["embeddings"]))
        chunks, sources = load_and_chunk_docs(str(docs_path), chunk_size)
        store = {"chunks": chunks, "chunk_sources": sources, "embeddings": np.asarray(
            [known[chunk] if chunk in known else get_text_embedding_with_retry(chunk, api_key) for chunk in chunks], dtype="float32")}
        with tempfile.NamedTemporaryFile(dir=store_path.parent, delete=False) as file:
            pickle.dump(store, file)
        os.replace(file.name, store_path)
    return changed


def preload_documentation(device, api_key=None):
    """Prepare only the selected public device, without delaying the deck response."""
    key = re.sub(r"[^a-z0-9]", "", device.casefold())
    def prepare():
        from handlers import load_handlers_config, detect_handler
        handlers = load_handlers_config()
        handler_id = next((identifier for identifier, config in handlers.items()
                           if re.sub(r"[^a-z0-9]", "", config["name"].casefold()) == key), None)
        if handler_id is None:
            handler_id, handlers = detect_handler(device, [], api_key)
        if handler_id:
            existed = (SCRIPT_DIR / handlers[handler_id]["docs_path"] / handlers[handler_id]["store_path"]).exists()
            load_or_build_index(handler_id, handlers[handler_id], api_key=api_key)
            if existed:  # each request also checks online for new or changed documentation, in the background
                refresh_index(handlers[handler_id], api_key=api_key)
    with _pending_lock:
        if key in _pending and not _pending[key].done():
            return _pending[key]
        future = _executor.submit(prepare)
        _pending[key] = future
    def finished(result):
        with _pending_lock:
            if _pending.get(key) is result:
                del _pending[key]
        try:
            result.result()
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Device documentation preload failed")
    future.add_done_callback(finished)
    return future
