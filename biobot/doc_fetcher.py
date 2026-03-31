"""
Autonomous documentation fetcher for BioBot RAG pipeline.

When no local documentation is found for a liquid handler, this module:
1. Asks the LLM for official documentation URLs (GitHub, ReadTheDocs, manufacturer sites)
2. Fetches content from those URLs (HTML pages, raw text files, PDFs)
3. Saves them permanently to docs/{handler}/ for future use

This makes the RAG pipeline self-provisioning — it only fetches once,
then the docs are local for all subsequent runs.
"""

import os, sys
import re
import time
import json
import requests
from urllib.parse import urlparse, urljoin
from openai import OpenAI
from bs4 import BeautifulSoup


# Max pages to crawl per source to avoid runaway fetching
MAX_PAGES_PER_SOURCE = 30
MAX_TOTAL_PAGES = 80
REQUEST_TIMEOUT = 15
CRAWL_DELAY = 0.5  # seconds between requests


def get_openai_client(api_key):
    return OpenAI(api_key=api_key)

def _log(msg):
    """Log to stderr so it doesn't pollute stdout (which engine.py reads as code output)."""
    print(msg, file=sys.stderr, flush=True)


def discover_doc_urls(handler_name, handler_keywords, api_key):
    """
    Use the LLM with web search to find REAL official documentation URLs
    for a liquid handler. Strongly prefers scrapable sources.
    Returns a list of {"url": ..., "type": "page"|"repo"|"docs_site", "description": ...}
    """
    client = get_openai_client(api_key)

    response = client.responses.create(
        model="gpt-5.4",
        tools=[{"type": "web_search"}],
        input=[
            {
                "role": "system",
                "content": """You are an expert in lab automation documentation.
You have access to web search. Use it to find REAL, VERIFIED official documentation for the given liquid handling platform.

PRIORITY ORDER for sources:
1. **GitHub repositories** — Look for official SDKs, Python libraries, or API wrappers on GitHub. Link to the raw README.md, docs/ folder, or specific .py/.rst/.md files using raw.githubusercontent.com URLs when possible.
2. **ReadTheDocs / GitBook / hosted docs** — Official API documentation sites (e.g., https://pyhamilton.readthedocs.io)
3. include OFFICIAL sources from the manufacturer or their official GitHub organization
4. **PDF documentation** — Direct links to .pdf user guides, programming manuals, or API references from the manufacturer's site
5. **PyPI package pages** — Link to the PyPI page if there's an official Python package (e.g., https://pypi.org/project/pyhamilton/)
6. **Raw text files** — Any .rst, .md, or .txt documentation files accessible via direct URL

Return txt raw file if you find contents that are NOT scrapable

After searching, return ONLY a JSON array of objects with:
- "url": the exact URL (must be from your actual search results)
- "type": "docs_site", "repo", or "page"
- "description": everything that you found

Return 3-10 sources."""
            },
            {
                "role": "user",
                "content": f"Search the web for documentation,references, SDKs, Python libraries, and API references for: {handler_name} (liquid handling robot). Keywords: {', '.join(handler_keywords)}. Focus on finding GitHub repos, ReadTheDocs sites, and downloadable PDF manuals."
            }
        ]
    )

    raw = response.output_text.strip()
    # Clean potential markdown wrapping
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)

    try:
        sources = json.loads(raw)
        if isinstance(sources, list):
            print(f"STEP:DISCOVERED DOCUMENTATION SOURCES FOR: {handler_name}", flush=True)
            for i, src in enumerate(sources, 1):
                _log(f"  [{i}] {src.get('type', '?').upper()}: {src.get('url', 'N/A')}")
                _log(f"      {src.get('description', 'No description')}")
            return sources
    except json.JSONDecodeError:
        _log(f"WARNING: Could not parse LLM response as JSON: {raw[:200]}")

    return []


MIN_CONTENT_LENGTH = 200  # Skip pages with less than this many characters of text


def fetch_page_content(url, timeout=REQUEST_TIMEOUT):
    """
    Fetch a URL and extract clean text content.
    Returns (text_content, linked_urls, content_type) or (None, [], "error") on failure.
    """
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "")

        # PDF — save as binary
        if "pdf" in content_type.lower() or url.lower().endswith(".pdf"):
            if len(resp.content) > 1000:  # Skip tiny/empty PDFs
                return resp.content, [], "pdf"
            return None, [], "error"

        # Plain text files (.rst, .txt, .md, .py)
        if any(url.lower().endswith(ext) for ext in [".rst", ".txt", ".md", ".py"]):
            if len(resp.text.strip()) >= MIN_CONTENT_LENGTH:
                return resp.text, [], "text"
            return None, [], "error"

        # GitHub raw content
        if "raw.githubusercontent.com" in url:
            if len(resp.text.strip()) >= MIN_CONTENT_LENGTH:
                return resp.text, [], "text"
            return None, [], "error"

        # HTML — parse and extract text + links
        if "html" in content_type.lower() or not content_type:
            soup = BeautifulSoup(resp.text, "html.parser")

            # Remove script, style, nav, footer elements
            for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                tag.decompose()

            # Try to find the main content area
            main = (
                soup.find("main") or
                soup.find("article") or
                soup.find("div", class_=re.compile(r"content|document|body", re.I)) or
                soup.find("div", role="main") or
                soup.body
            )

            if main:
                text = main.get_text(separator="\n", strip=True)
            else:
                text = soup.get_text(separator="\n", strip=True)

            # Clean up excessive whitespace
            text = re.sub(r'\n{3,}', '\n\n', text)

            # Skip pages with too little content (likely JS-rendered or nav-only)
            if len(text.strip()) < MIN_CONTENT_LENGTH:
                return None, [], "error"

            # Extract links for crawling
            links = []
            for a in soup.find_all("a", href=True):
                href = a["href"]
                full_url = urljoin(url, href)
                links.append(full_url)

            return text, links, "html"

        return None, [], "unknown"

    except Exception as e:
        _log(f"  Failed to fetch {url}: {e}")
        return None, [], "error"


def is_doc_url(url, base_domain):
    """Check if a URL is likely a documentation page worth crawling."""
    parsed = urlparse(url)

    # Stay on the same domain
    if parsed.netloc and base_domain not in parsed.netloc:
        return False

    # Skip non-doc paths
    skip_patterns = [
        r'/issues', r'/pull/', r'/commit/', r'/releases',
        r'/actions', r'/security', r'/graphs', r'/network',
        r'\.zip$', r'\.tar\.gz$', r'\.whl$',
        r'/login', r'/signup', r'/search',
        r'#', r'\?q=',
    ]
    for pattern in skip_patterns:
        if re.search(pattern, url):
            return False

    # Prefer doc-like paths
    doc_patterns = [
        r'/docs?/', r'/api/', r'/guide/', r'/tutorial/',
        r'/reference/', r'/manual/', r'/getting.?started',
        r'readthedocs', r'\.rst$', r'\.md$', r'\.txt$',
        r'/modules/', r'/commands/', r'/protocol/',
    ]
    for pattern in doc_patterns:
        if re.search(pattern, url, re.I):
            return True

    return True  # Default to allowing if same domain


def crawl_docs_site(start_url, max_pages=MAX_PAGES_PER_SOURCE):
    """
    Crawl a documentation site starting from a URL.
    Returns a list of {"url": ..., "content": ..., "type": ...} dicts.
    """
    parsed = urlparse(start_url)
    base_domain = parsed.netloc
    visited = set()
    to_visit = [start_url]
    results = []

    while to_visit and len(results) < max_pages:
        url = to_visit.pop(0)

        # Normalize URL
        url = url.split("#")[0]  # Remove fragments
        if url in visited:
            continue
        visited.add(url)

        content, links, content_type = fetch_page_content(url)

        if content and content_type in ("html", "text"):
            # Skip very short pages (navs, redirects)
            if isinstance(content, str) and len(content.strip()) > 100:
                results.append({
                    "url": url,
                    "content": content,
                    "type": content_type
                })
                _log(f"  Fetched: {url} ({len(content)} chars)")
        elif content and content_type == "pdf":
            results.append({
                "url": url,
                "content": content,
                "type": "pdf"
            })
            _log(f"  Fetched PDF: {url}")

        # Add discovered links to crawl queue
        for link in links:
            if link not in visited and is_doc_url(link, base_domain):
                to_visit.append(link)

        time.sleep(CRAWL_DELAY)

    return results


def save_fetched_docs(docs_path, fetched_pages):
    """
    Save fetched content to the docs folder as text/PDF files.
    Returns the number of files saved.
    """
    os.makedirs(docs_path, exist_ok=True)
    saved = 0
    saved_files = []

    for i, page in enumerate(fetched_pages):
        url = page["url"]
        content = page["content"]
        content_type = page["type"]

        # Generate a clean filename from the URL
        parsed = urlparse(url)
        path_part = parsed.path.strip("/").replace("/", "_")
        if not path_part:
            path_part = f"page_{i}"

        if content_type == "pdf":
            filename = f"{path_part}.pdf" if not path_part.endswith(".pdf") else path_part
            filepath = os.path.join(docs_path, filename)
            try:
                with open(filepath, "wb") as f:
                    f.write(content)
                saved += 1
                saved_files.append({"file": filename, "source": url, "type": "PDF"})
            except Exception as e:
                _log(f"  Could not save {filename}: {e}")

        elif content_type in ("html", "text"):
            # Determine extension
            if path_part.endswith((".rst", ".md", ".txt")):
                filename = path_part
            else:
                filename = f"{path_part}.txt"

            filepath = os.path.join(docs_path, filename)
            size = len(content) if isinstance(content, str) else 0
            try:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(content)
                saved += 1
                saved_files.append({"file": filename, "source": url, "type": content_type.upper(), "size": size})
            except Exception as e:
                _log(f"  Could not save {filename}: {e}")

    # Print summary
    if saved_files:
        _log(f"SAVED FILES TO: {docs_path}")
        for sf in saved_files:
            size_str = f" ({sf['size']} chars)" if sf.get('size') else ""
            _log(f"  [{sf['type']}] {sf['file']}{size_str}")
            _log(f"        from: {sf['source']}")

    return saved


def verify_url(url, timeout=10):
    """Quick HEAD request to check if a URL is accessible before crawling."""
    try:
        headers = {"User-Agent": "BioBot-DocFetcher/1.0"}
        resp = requests.head(url, headers=headers, timeout=timeout, allow_redirects=True)
        return resp.status_code < 400
    except Exception:
        return False


def search_github_repos(handler_name, handler_keywords):
    """
    Search GitHub for official repos/docs related to the handler.
    Uses the GitHub search API (no auth needed for public repos).
    Returns a list of source dicts.
    """
    sources = []
    search_terms = [handler_name] + handler_keywords[:2]

    for term in search_terms:
        try:
            query = f"{term} liquid handler"
            resp = requests.get(
                "https://api.github.com/search/repositories",
                params={"q": query, "sort": "stars", "per_page": 3},
                headers={"Accept": "application/vnd.github.v3+json"},
                timeout=10
            )
            if resp.status_code == 200:
                for repo in resp.json().get("items", []):
                    full_name = repo["full_name"]
                    # Try common doc paths
                    for doc_path in ["docs", "api", "documentation", "wiki"]:
                        doc_url = f"https://github.com/{full_name}/tree/main/{doc_path}"
                        raw_url = f"https://github.com/{full_name}/tree/main/{doc_path}"
                        sources.append({
                            "url": raw_url,
                            "type": "repo",
                            "description": f"GitHub: {full_name}/{doc_path}"
                        })
                    # Also add the README
                    sources.append({
                        "url": f"https://raw.githubusercontent.com/{full_name}/main/README.md",
                        "type": "page",
                        "description": f"GitHub README: {full_name}"
                    })
        except Exception as e:
            _log(f"  GitHub search failed for '{term}': {e}")

    return sources


def fetch_documentation(handler_name, handler_keywords, docs_path, api_key):
    """
    Main entry point: discover, fetch, and save documentation for a handler.
    Uses a multi-strategy approach:
    1. Try LLM-suggested URLs (verify accessibility first)
    2. Fall back to GitHub API search
    3. If still nothing, report what was attempted
    Returns True if docs were successfully fetched and saved.
    """
    print(f"STEP:No local docs found — searching for {handler_name} official documentation...", flush=True)
    time.sleep(2)

    all_fetched = []
    failed_urls = []

    # --- Strategy 1: LLM-suggested URLs ---
    print(f"STEP:Searching official documentation sources in the web...", flush=True)
    sources = discover_doc_urls(handler_name, handler_keywords, api_key)

    if sources:
        print(f"STEP:Found {len(sources)} sources — verifying accessibility...", flush=True)

        # Filter to only accessible URLs
        verified_sources = []
        for source in sources:
            url = source.get("url", "")
            if not url:
                continue
            if verify_url(url):
                verified_sources.append(source)
                _log(f"  ✓ Accessible: {url}")
            else:
                failed_urls.append(url)
                _log(f"  ✗ Not accessible: {url}")

        if verified_sources:
            print(f"STEP:Fetching from {len(verified_sources)} accessible sources...", flush=True)
            time.sleep(2)
            for source in verified_sources:
                url = source.get("url", "")
                source_type = source.get("type", "page")
                desc = source.get("description", "")

                print(f"STEP:Fetching from {urlparse(url).netloc}: {desc}...", flush=True)
                time.sleep(2)

                if source_type in ("docs_site", "repo"):
                    pages = crawl_docs_site(url, max_pages=MAX_PAGES_PER_SOURCE)
                    all_fetched.extend(pages)
                else:
                    content, _, content_type = fetch_page_content(url)
                    if content:
                        all_fetched.append({
                            "url": url,
                            "content": content,
                            "type": content_type
                        })

                if len(all_fetched) >= MAX_TOTAL_PAGES:
                    break

    # --- Strategy 2: GitHub search fallback ---
    if not all_fetched:
        print(f"STEP:LLM sources unavailable — searching GitHub...", flush=True)
        time.sleep(2)
        github_sources = search_github_repos(handler_name, handler_keywords)

        for source in github_sources:
            url = source.get("url", "")
            if not url or url in failed_urls:
                continue

            content, _, content_type = fetch_page_content(url)
            if content:
                all_fetched.append({
                    "url": url,
                    "content": content,
                    "type": content_type
                })
                _log(f"  Fetched from GitHub: {url}")

            if len(all_fetched) >= MAX_TOTAL_PAGES:
                break

    # --- No docs found at all ---
    if not all_fetched:
        print(f"STEP:Could not fetch documentation for {handler_name}", flush=True)
        if failed_urls:
            _log(f"  Attempted URLs that were not accessible:")
            for url in failed_urls:
                _log(f"    - {url}")
        print(f"STEP:You can manually add documentation files to {docs_path}/", flush=True)
        return False

    # --- Save fetched docs ---
    print(f"STEP:Saving {len(all_fetched)} documents to {docs_path}...", flush=True)
    saved_count = save_fetched_docs(docs_path, all_fetched)

    if saved_count == 0:
        print(f"STEP:Failed to save any documents", flush=True)
        return False

    print(f"STEP:Successfully saved {saved_count} documentation files for {handler_name}", flush=True)
    return True