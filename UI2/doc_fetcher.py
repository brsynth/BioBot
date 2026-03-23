"""
Autonomous documentation fetcher for BioBot RAG pipeline.

When no local documentation is found for a liquid handler, this module:
1. Asks the LLM for official documentation URLs (GitHub, ReadTheDocs, manufacturer sites)
2. Fetches content from those URLs (HTML pages, raw text files, PDFs)
3. Saves them permanently to docs/{handler}/ for future use

This makes the RAG pipeline self-provisioning — it only fetches once,
then the docs are local for all subsequent runs.
"""

import os
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


def discover_doc_urls(handler_name, handler_keywords, api_key):
    """
    Ask the LLM to provide official documentation URLs for a liquid handler.
    Returns a list of {"url": ..., "type": "page"|"repo"|"docs_site", "description": ...}
    """
    client = get_openai_client(api_key)

    response = client.responses.create(
        model="gpt-5.4-mini",
        input=[
            {
                "role": "system",
                "content": """You are an expert in lab automation documentation. 
Given a liquid handling platform name, provide the OFFICIAL documentation sources.

Return ONLY a JSON array of objects with these fields:
- "url": the exact URL (must be real and accessible)
- "type": one of "docs_site" (ReadTheDocs, official docs), "repo" (GitHub/GitLab repo with docs), "page" (single useful page)
- "description": brief description of what this source contains

CRITICAL RULES:
- Only include OFFICIAL sources from the manufacturer or their official GitHub organization
- Prefer ReadTheDocs, GitHub repos with /docs or /api directories, and official developer portals
- Do NOT include forums, blog posts, tutorials from third parties, or Stack Overflow
- Do NOT include URLs you're not confident actually exist
- For GitHub repos, point to the specific docs/api directory if possible, not just the repo root
- Return between 3-8 sources maximum

Return ONLY the JSON array, no markdown, no explanation."""
            },
            {
                "role": "user",
                "content": f"Find official documentation sources for: {handler_name} (liquid handling robot platform). Keywords: {', '.join(handler_keywords)}"
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
            return sources
    except json.JSONDecodeError:
        print(f"WARNING: Could not parse LLM response as JSON: {raw[:200]}", flush=True)

    return []


def fetch_page_content(url, timeout=REQUEST_TIMEOUT):
    """
    Fetch a URL and extract clean text content.
    Returns (text_content, linked_urls) or (None, []) on failure.
    """
    try:
        headers = {
            "User-Agent": "BioBot-DocFetcher/1.0 (lab automation documentation indexer)"
        }
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "")

        # PDF — save as binary, return None for text (will be handled separately)
        if "pdf" in content_type.lower() or url.lower().endswith(".pdf"):
            return resp.content, [], "pdf"

        # Plain text files (.rst, .txt, .md, .py)
        if any(url.lower().endswith(ext) for ext in [".rst", ".txt", ".md", ".py"]):
            return resp.text, [], "text"

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

            # Extract links for crawling
            links = []
            for a in soup.find_all("a", href=True):
                href = a["href"]
                full_url = urljoin(url, href)
                links.append(full_url)

            return text, links, "html"

        return None, [], "unknown"

    except Exception as e:
        print(f"  Failed to fetch {url}: {e}", flush=True)
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
                print(f"  Fetched: {url} ({len(content)} chars)", flush=True)
        elif content and content_type == "pdf":
            results.append({
                "url": url,
                "content": content,
                "type": "pdf"
            })
            print(f"  Fetched PDF: {url}", flush=True)

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
            except Exception as e:
                print(f"  Could not save {filename}: {e}", flush=True)

        elif content_type in ("html", "text"):
            # Determine extension
            if path_part.endswith((".rst", ".md", ".txt")):
                filename = path_part
            else:
                filename = f"{path_part}.txt"

            filepath = os.path.join(docs_path, filename)
            try:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(content)
                saved += 1
            except Exception as e:
                print(f"  Could not save {filename}: {e}", flush=True)

    return saved


def fetch_documentation(handler_name, handler_keywords, docs_path, api_key):
    """
    Main entry point: discover, fetch, and save documentation for a handler.
    Returns True if docs were successfully fetched and saved.
    """
    print(f"STEP:No local docs found — searching for {handler_name} official documentation...", flush=True)

    # 1. Ask the LLM for documentation URLs
    sources = discover_doc_urls(handler_name, handler_keywords, api_key)

    if not sources:
        print(f"STEP:Could not find documentation sources for {handler_name}", flush=True)
        return False

    print(f"STEP:Found {len(sources)} documentation sources — fetching content...", flush=True)

    # 2. Fetch content from each source
    all_fetched = []
    for source in sources:
        url = source.get("url", "")
        source_type = source.get("type", "page")
        desc = source.get("description", "")

        if not url:
            continue

        print(f"STEP:Fetching from {urlparse(url).netloc}: {desc}...", flush=True)
        time.sleep(2)

        if source_type == "docs_site":
            # Crawl the docs site
            pages = crawl_docs_site(url, max_pages=MAX_PAGES_PER_SOURCE)
            all_fetched.extend(pages)
        elif source_type == "repo":
            # For repos, try to fetch the docs directory listing
            pages = crawl_docs_site(url, max_pages=MAX_PAGES_PER_SOURCE)
            all_fetched.extend(pages)
        else:
            # Single page fetch
            content, _, content_type = fetch_page_content(url)
            if content:
                all_fetched.append({
                    "url": url,
                    "content": content,
                    "type": content_type
                })

        # Cap total pages
        if len(all_fetched) >= MAX_TOTAL_PAGES:
            print(f"STEP:Reached page limit ({MAX_TOTAL_PAGES}), stopping fetch...", flush=True)
            break

    if not all_fetched:
        print(f"STEP:Could not fetch any documentation content for {handler_name}", flush=True)
        return False

    # 3. Save to docs folder
    print(f"STEP:Saving {len(all_fetched)} documents to {docs_path}...", flush=True)
    time.sleep(5)
    saved_count = save_fetched_docs(docs_path, all_fetched)

    if saved_count == 0:
        print(f"STEP:Failed to save any documents", flush=True)
        return False

    print(f"STEP:Successfully saved {saved_count} documentation files for {handler_name}", flush=True)
    time.sleep(5)
    return True