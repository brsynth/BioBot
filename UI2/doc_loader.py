"""
Document loader for BioBot RAG pipeline.

Supports multiple file formats (RST, PDF, TXT) and provides
unified chunking for any documentation folder.

Usage:
    chunks, sources = load_and_chunk_docs("docs/opentrons", chunk_size=3000)
"""

import os
import re


# ============================================================
# Format-specific parsers
# ============================================================

def _parse_rst(content: str, filename: str) -> list[dict]:
    """
    Parse RST content into logical sections.
    Returns a list of {"text": ..., "source": ...} dicts.
    """
    # Clean RST directives and references
    content = re.sub(r"\.\. .*?::", "", content)
    content = re.sub(r":ref:`.*?`", "", content)

    # Split on RST section underlines (=, -, ~, ^, +)
    sections = re.split(r"\n\s*(=+|-+|~+|\^+|\++)\n", content)
    logical_sections = [
        "".join(pair).strip()
        for pair in zip(sections[::2], sections[1::2])
    ]

    # If no sections detected, treat entire content as one section
    if not logical_sections:
        logical_sections = [content.strip()]

    return [
        {"text": section, "source": f"{filename} (section {idx})"}
        for idx, section in enumerate(logical_sections)
        if section.strip()
    ]


def _parse_txt(content: str, filename: str) -> list[dict]:
    """
    Parse plain text into sections split by double newlines (paragraphs).
    Falls back to the full content as a single section.
    """
    # Split on double newlines to get paragraph groups
    paragraphs = re.split(r"\n\s*\n", content)

    # Group small paragraphs together to avoid tiny chunks
    sections = []
    current = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) < 1500:
            current += ("\n\n" + para) if current else para
        else:
            if current:
                sections.append(current)
            current = para
    if current:
        sections.append(current)

    if not sections:
        sections = [content.strip()]

    return [
        {"text": section, "source": f"{filename} (part {idx})"}
        for idx, section in enumerate(sections)
        if section.strip()
    ]


def _parse_pdf(filepath: str, filename: str) -> list[dict]:
    """
    Extract text from a PDF file and split into page-based sections.
    Uses PyMuPDF (fitz) if available, falls back to pdfplumber.
    """
    text_pages = []

    try:
        import fitz  # PyMuPDF
        doc = fitz.open(filepath)
        for page_num, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                text_pages.append({
                    "text": text.strip(),
                    "source": f"{filename} (page {page_num + 1})"
                })
        doc.close()
    except ImportError:
        try:
            import pdfplumber
            with pdfplumber.open(filepath) as pdf:
                for page_num, page in enumerate(pdf.pages):
                    text = page.extract_text()
                    if text and text.strip():
                        text_pages.append({
                            "text": text.strip(),
                            "source": f"{filename} (page {page_num + 1})"
                        })
        except ImportError:
            print(f"WARNING: No PDF library available. Install PyMuPDF (pip install pymupdf) "
                  f"or pdfplumber. Skipping {filename}")
            return []

    return text_pages


# ============================================================
# Unified loader
# ============================================================

# Map extensions to their parser
PARSERS = {
    ".rst": "rst",
    ".txt": "txt",
    ".text": "txt",
    ".pdf": "pdf",
}


def load_and_chunk_docs(base_path: str, chunk_size: int = 3000) -> tuple[list[str], list[str]]:
    """
    Walk a documentation folder, parse all supported files,
    and return (chunks, chunk_sources) ready for embedding.

    Supported formats: .rst, .pdf, .txt
    """
    all_sections = []

    for root, dirs, files in os.walk(base_path):
        for file in sorted(files):
            ext = os.path.splitext(file)[1].lower()
            parser_type = PARSERS.get(ext)

            if parser_type is None:
                continue  # Skip unsupported files

            full_path = os.path.join(root, file)

            if parser_type == "pdf":
                sections = _parse_pdf(full_path, file)
            else:
                try:
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                except Exception as e:
                    print(f"WARNING: Could not read {file}: {e}")
                    continue

                if parser_type == "rst":
                    sections = _parse_rst(content, file)
                elif parser_type == "txt":
                    sections = _parse_txt(content, file)
                else:
                    continue

            all_sections.extend(sections)

    # Now chunk each section to the target size
    chunks = []
    chunk_sources = []

    for section in all_sections:
        text = section["text"]
        source = section["source"]

        if len(text) <= chunk_size:
            chunks.append(text)
            chunk_sources.append(source)
        else:
            # Split large sections into sub-chunks
            for i in range(0, len(text), chunk_size):
                sub = text[i:i + chunk_size]
                if sub.strip():
                    chunks.append(sub)
                    chunk_sources.append(f"{source}, chunk {i // chunk_size}")

    return chunks, chunk_sources


def get_supported_extensions() -> list[str]:
    """Return list of supported file extensions."""
    return list(PARSERS.keys())