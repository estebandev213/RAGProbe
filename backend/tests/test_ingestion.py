"""Unit tests for text extraction and normalization."""

import pytest
from app.core.ingestion import (
    UnsupportedDocumentError,
    extract_text,
    normalize,
)


def _make_pdf(text: str) -> bytes:
    """Build a minimal single-page PDF whose only content is ``text``.

    Offsets in the cross-reference table are computed exactly so pypdf parses
    the file normally (no xref reconstruction), keeping the test honest.
    """
    body_objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"",  # placeholder for the content stream, filled in below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    content = b"BT /F1 24 Tf 72 720 Td (" + text.encode("latin-1") + b") Tj ET"
    body_objects[3] = (
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"
    )

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, obj in enumerate(body_objects, start=1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + obj + b"\nendobj\n"

    xref_pos = len(out)
    count = len(body_objects) + 1
    out += b"xref\n0 " + str(count).encode() + b"\n0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size " + str(count).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    return bytes(out)


def test_normalize_unifies_line_endings() -> None:
    assert normalize("a\r\nb\rc") == "a\nb\nc"


def test_normalize_strips_trailing_whitespace_and_ends() -> None:
    assert normalize("  line one   \n   line two\t\n  ") == "line one\n   line two"


def test_normalize_collapses_excess_blank_lines() -> None:
    assert normalize("a\n\n\n\nb") == "a\n\nb"


def test_normalize_is_idempotent() -> None:
    messy = "  title \r\n\r\n\r\n\r\nbody  \r\n"
    once = normalize(messy)
    assert normalize(once) == once


def test_extract_text_markdown() -> None:
    text, mime = extract_text("notes.md", b"# Title\r\n\r\nBody text  \r\n")
    assert mime == "text/markdown"
    assert text == "# Title\n\nBody text"


def test_extract_text_plain() -> None:
    text, mime = extract_text("notes.txt", b"plain content")
    assert mime == "text/plain"
    assert text == "plain content"


def test_extract_text_rejects_unsupported_extension() -> None:
    with pytest.raises(UnsupportedDocumentError):
        extract_text("data.csv", b"a,b,c")


def test_extract_text_pdf() -> None:
    text, mime = extract_text("doc.pdf", _make_pdf("Meridian stores documents"))
    assert mime == "application/pdf"
    assert "Meridian" in text


def test_extract_text_rejects_corrupt_pdf() -> None:
    with pytest.raises(UnsupportedDocumentError):
        extract_text("broken.pdf", b"%PDF-1.4 this is not a real pdf")
