"""Document ingestion: extract text from pdf/md/txt and normalize it.

The normalized text produced here is the *canonical* document text stored in
the database. Every downstream char offset — chunk ``start_char``/``end_char``
(§6.1) and exam ``gold_spans`` (§6.3) — indexes into this exact string, so
normalization happens once, here, and never again. That invariant is what the
chunker test (``text[start:end] == chunk.text``) relies on.
"""

from __future__ import annotations

import io
import re
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PdfReadError

# Accepted upload types, keyed by lowercase file extension, mapped to the
# canonical MIME we record. Extension is the source of truth: browser-supplied
# content types are inconsistent (e.g. text/markdown is often missing).
_PDF_EXTENSIONS: frozenset[str] = frozenset({".pdf"})
_TEXT_MIMES: dict[str, str] = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
}
SUPPORTED_EXTENSIONS: frozenset[str] = _PDF_EXTENSIONS | frozenset(_TEXT_MIMES)

# Collapse 3+ consecutive newlines down to a paragraph break.
_EXCESS_BLANK_LINES = re.compile(r"\n{3,}")
# Trailing horizontal whitespace at the end of each line.
_TRAILING_WS = re.compile(r"[ \t]+(?=\n)")


class UnsupportedDocumentError(ValueError):
    """Raised when a file's type is not accepted or its content cannot be read."""


def normalize(text: str) -> str:
    """Produce canonical document text.

    Unifies line endings, strips trailing whitespace per line, collapses long
    runs of blank lines to a single paragraph break, and trims the document
    ends. Deterministic and idempotent so stored offsets stay stable.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _TRAILING_WS.sub("", text)
    text = _EXCESS_BLANK_LINES.sub("\n\n", text)
    return text.strip()


def _extract_pdf(data: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except (PdfReadError, OSError, ValueError) as exc:
        raise UnsupportedDocumentError(f"Could not read PDF: {exc}") from exc
    return "\n\n".join(pages)


def extract_text(filename: str, data: bytes) -> tuple[str, str]:
    """Extract and normalize text from an uploaded file.

    Returns ``(normalized_text, canonical_mime)``. Raises
    :class:`UnsupportedDocumentError` for unsupported extensions or unreadable
    content — the documents route maps that to HTTP 422.
    """
    ext = Path(filename).suffix.lower()
    if ext in _PDF_EXTENSIONS:
        raw = _extract_pdf(data)
        mime = "application/pdf"
    elif ext in _TEXT_MIMES:
        raw = data.decode("utf-8", errors="replace")
        mime = _TEXT_MIMES[ext]
    else:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise UnsupportedDocumentError(
            f"Unsupported file type '{ext or filename}'. Supported types: {supported}."
        )
    return normalize(raw), mime
