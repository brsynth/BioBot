"""Read-only access to public device documentation, excluding users' saved code."""
from functools import lru_cache
import fcntl
import json
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
EXTENSIONS = {'.pdf', '.txt', '.text', '.rst', '.md'}


def _profile(device):
    from handlers import load_handlers_config
    from device_catalog import find_device, lookup_key
    profiles = load_handlers_config()
    row = find_device(device)
    identifier = row['device_id'] if row else device
    profile = profiles.get(identifier)
    if profile is None:
        profile = next((value for value in profiles.values() if lookup_key(value.get('name', '')) == lookup_key(device)), None)
    if not profile:
        raise ValueError('Device documentation not found.')
    root = (SCRIPT_DIR / profile['docs_path']).resolve()
    if not any(root.is_relative_to((SCRIPT_DIR / folder).resolve()) and root != (SCRIPT_DIR / folder).resolve()
               for folder in ('data/docs', 'docs')):
        raise ValueError('Device documentation not found.')
    return profile, root


def _files(root):
    if not root.exists():
        return {}
    shared = (root.parent / '_shared' / 'files').resolve()
    return {path.relative_to(root).as_posix(): path for path in root.rglob('*')
            if path.is_file() and path.suffix.lower() in EXTENSIONS
            and not any(part.startswith('.') or part in {'codes', 'failed_codes', '_shared'} for part in path.relative_to(root).parts)
            and (path.resolve().is_relative_to(root) or path.resolve().is_relative_to(shared))}


@lru_cache(maxsize=64)
def _text(path, modified, size):
    if path.suffix.lower() != '.pdf':
        with path.open('r', encoding='utf-8', errors='replace') as file:
            return file.read(200_000)
    try:
        import fitz
        with fitz.open(path) as document:
            text = ''
            for page in document:
                text += page.get_text() + '\n'
                if len(text) >= 200_000:
                    break
            return text[:200_000]
    except (ImportError, RuntimeError, ValueError):
        return ''


def document_text(path):
    stat = path.stat()
    return _text(path, stat.st_mtime_ns, stat.st_size)


def documentation(device, query=''):
    profile, root = _profile(device)
    files = _files(root)
    query = query.strip().casefold()[:200]
    documents = []
    for name, path in sorted(files.items()):
        text = document_text(path) if query else ''
        index = text.casefold().find(query) if query else -1
        if query and query not in name.casefold() and index < 0:
            continue
        documents.append({'file':name, 'name':path.name, 'format':path.suffix[1:].upper(),
                          'snippet':text[max(0,index-80):index+180].strip() if index >= 0 else ''})
    try:
        with (root / 'sources.json').open() as file:
            sources = list(json.load(file))
    except (OSError, ValueError, TypeError):
        sources = []
    sources += [source.get('url', '') for source in profile.get('programming_sources', []) if isinstance(source, dict)]
    sources = list(dict.fromkeys(url for url in sources if isinstance(url, str) and urlparse(url).scheme in {'http','https'} and urlparse(url).netloc))
    preparing = False
    lock = root / (profile.get('store_path', 'index.pkl') + '.lock')
    if lock.exists():
        with lock.open() as file:
            try:
                fcntl.flock(file, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                preparing = True
    return {'device':profile['name'], 'documents':documents, 'total':len(files), 'sources':sources, 'preparing':preparing}


def document_file(device, name):
    _, root = _profile(device)
    path = _files(root).get(name)
    if path is None:
        raise ValueError('Document not found.')
    return path
