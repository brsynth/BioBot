"""Bad downloaded or cached PDFs must not disable device documentation."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "biobot"))
try:
    import fitz
    import doc_fetcher
    import doc_loader
except ImportError as error:
    raise unittest.SkipTest(f"requires app dependencies: {error}")


def pdf_bytes():
    with fitz.open() as document:
        document.new_page().insert_text((72, 72), "Valid device manual")
        return document.tobytes()


class DocumentationPDFTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.docs = Path(temporary.name) / "docs" / "device"
        self.docs.mkdir(parents=True)
        self.url = "https://manufacturer.example/manual.pdf"

    def fetch(self, content, content_type="application/pdf", url=None):
        response = Mock(content=content, headers={"Content-Type": content_type})
        with patch.object(doc_fetcher.requests, "get", return_value=response):
            return doc_fetcher.fetch_page_content(url or self.url)

    def test_corrupt_pdf_does_not_block_valid_pdf_and_text(self):
        (self.docs / "a-broken.pdf").write_bytes(b"%PDF-1.7\nno objects found")
        (self.docs / "manual.pdf").write_bytes(pdf_bytes())
        (self.docs / "notes.txt").write_text("Additional device documentation")
        warnings = io.StringIO()
        with contextlib.redirect_stderr(warnings):
            chunks, sources = doc_loader.load_and_chunk_docs(str(self.docs))
        self.assertEqual(chunks, ["Valid device manual", "Additional device documentation"])
        self.assertEqual(sources, ["manual.pdf (page 1)", "notes.txt (part 0)"])
        self.assertIn("a-broken.pdf", warnings.getvalue())

    def test_only_corrupt_pdfs_returns_no_documentation(self):
        (self.docs / "broken.pdf").write_bytes(b"not a pdf")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(doc_loader.load_and_chunk_docs(str(self.docs)), ([], []))

    def test_document_closes_when_page_extraction_fails(self):
        document = Mock()
        document.__enter__ = Mock(return_value=document)
        document.__exit__ = Mock(return_value=False)
        page = Mock()
        page.get_text.side_effect = RuntimeError("broken page")
        document.__iter__ = Mock(return_value=iter([page]))
        with patch.object(fitz, "open", return_value=document):
            with self.assertRaisesRegex(RuntimeError, "broken page"):
                doc_loader._parse_pdf("manual.pdf", "manual.pdf")
        document.__exit__.assert_called_once()

    def test_html_error_page_at_pdf_url_is_rejected(self):
        content = b"<html>Access denied</html>" * 100
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.fetch(content, "text/html"), (None, [], "error"))

    def test_invalid_pdf_with_header_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.fetch(b"%PDF-1.7\n" + b"broken" * 200), (None, [], "error"))

    def test_valid_small_pdf_with_query_string_is_accepted(self):
        content = pdf_bytes()
        self.assertLess(len(content), 1000)
        self.assertEqual(self.fetch(content, "application/octet-stream", self.url + "?download=1"),
                         (content, [], "pdf"))

    def test_password_protected_pdf_is_rejected(self):
        with fitz.open(stream=pdf_bytes(), filetype="pdf") as document:
            content = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,
                                       owner_pw="owner", user_pw="reader")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.fetch(content), (None, [], "error"))

    def test_invalid_update_preserves_shared_pdf_and_source_metadata(self):
        valid = {"url": self.url, "content": pdf_bytes(), "type": "pdf"}
        self.assertEqual(doc_fetcher.save_fetched_docs(str(self.docs), [valid]), 1)
        local = self.docs / "manual.pdf"
        shared_index = self.docs.parent / "_shared" / "index.json"
        original_index = json.loads(shared_index.read_text())
        with contextlib.redirect_stderr(io.StringIO()):
            saved = doc_fetcher.save_fetched_docs(str(self.docs), [
                {**valid, "content": b"%PDF-1.7\ninvalid update"}])
        self.assertEqual(saved, 0)
        self.assertEqual(local.read_bytes(), valid["content"])
        self.assertEqual(json.loads(shared_index.read_text()), original_index)

    def test_index_build_and_reuse_with_corrupt_cached_pdf(self):
        import documentation_index
        (self.docs / "broken.pdf").write_bytes(b"%PDF-1.7\nno objects found")
        (self.docs / "manual.txt").write_text("Valid device documentation")
        config = {"name": "Device", "docs_path": str(self.docs), "store_path": "store.pkl"}
        with patch.object(documentation_index, "get_text_embedding_with_retry", return_value=[0.1, 0.2]) as embed, \
             patch.object(documentation_index, "fetch_documentation") as fetch, \
             contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            first = documentation_index.load_or_build_index("device", config, api_key="test")
            second = documentation_index.load_or_build_index("device", config, api_key="test")
        self.assertEqual(first[0], ["Valid device documentation"])
        self.assertEqual(second[:2], first[:2])
        self.assertEqual(second[2].ntotal, 1)
        embed.assert_called_once()
        fetch.assert_not_called()

    def corrupt_tracked_pdf(self):
        page = {"url": self.url, "content": pdf_bytes(), "type": "pdf"}
        doc_fetcher.save_fetched_docs(str(self.docs), [page])
        with patch.object(doc_fetcher, "_validators", return_value={"etag": "unchanged"}):
            doc_fetcher.record_sources(str(self.docs), [page])
        path = self.docs / "manual.pdf"
        path.write_bytes(b"%PDF-1.7\nno objects found")
        return page, path

    def test_loader_downloads_and_indexes_recovered_pdf_immediately(self):
        page, path = self.corrupt_tracked_pdf()
        with patch.object(doc_fetcher, "fetch_page_content", return_value=(page["content"], [], "pdf")) as fetch, \
             patch.object(doc_fetcher, "_validators", return_value={}), \
             contextlib.redirect_stderr(io.StringIO()):
            chunks, sources = doc_loader.load_and_chunk_docs(str(self.docs))
        fetch.assert_called_once_with(self.url)
        self.assertEqual(chunks, ["Valid device manual"])
        self.assertEqual(sources, ["manual.pdf (page 1)"])
        self.assertEqual(path.read_bytes(), page["content"])

    def test_failed_recovery_continues_and_observes_cooldown(self):
        _, path = self.corrupt_tracked_pdf()
        original = path.read_bytes()
        (self.docs / "notes.txt").write_text("Usable documentation")
        with patch.object(doc_fetcher, "fetch_page_content", return_value=(None, [], "error")) as fetch, \
             patch.object(doc_fetcher.time, "time", return_value=1000), \
             contextlib.redirect_stderr(io.StringIO()):
            for _ in range(2):
                self.assertEqual(doc_loader.load_and_chunk_docs(str(self.docs))[0], ["Usable documentation"])
        fetch.assert_called_once_with(self.url)
        self.assertEqual(path.read_bytes(), original)
        with patch.object(doc_fetcher.time, "time", return_value=1301), \
             patch.object(doc_fetcher, "fetch_page_content", return_value=(None, [], "error")) as retry, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(doc_fetcher.recover_pdf(str(self.docs), str(path)))
        retry.assert_called_once_with(self.url)

    def test_recovery_repairs_other_device_hard_link_and_shared_fallback(self):
        page, path = self.corrupt_tracked_pdf()
        other = self.docs.parent / "other_device"
        other.mkdir()
        import os
        os.link(path, other / "manual.pdf")
        (self.docs / "sources.json").unlink()
        with patch.object(doc_fetcher, "fetch_page_content", return_value=(page["content"], [], "pdf")), \
             patch.object(doc_fetcher, "_validators", return_value={}), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(doc_fetcher.recover_pdf(str(self.docs), str(path)))
        self.assertEqual((other / "manual.pdf").read_bytes(), page["content"])

    def test_background_update_repairs_even_with_unchanged_server_etag(self):
        page, path = self.corrupt_tracked_pdf()
        (self.docs / ".shared").touch()
        with patch.object(doc_fetcher, "fetch_page_content", return_value=(page["content"], [], "pdf")) as fetch, \
             patch.object(doc_fetcher, "_validators", return_value={"etag": "unchanged"}), \
             patch.object(doc_fetcher, "discover_doc_urls", return_value=[]), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(doc_fetcher.update_documentation("Device", [], str(self.docs), "test"), 1)
        fetch.assert_called_once_with(self.url)
        self.assertEqual(path.read_bytes(), page["content"])

    def test_recovered_pdf_is_added_to_an_existing_index(self):
        import documentation_index
        import os
        page, path = self.corrupt_tracked_pdf()
        (self.docs / "notes.txt").write_text("Existing documentation")
        config = {"name": "Device", "docs_path": str(self.docs), "store_path": "store.pkl"}
        with patch.object(documentation_index, "get_text_embedding_with_retry", return_value=[0.1, 0.2]), \
             patch.object(doc_fetcher, "fetch_page_content", return_value=(None, [], "error")), \
             contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            first = documentation_index.load_or_build_index("device", config, api_key="test")
        self.assertEqual(first[0], ["Existing documentation"])
        # Make ordering independent of the filesystem's timestamp resolution.
        os.utime(self.docs / "store.pkl", (1, 1))
        (self.docs / "manual.pdf.repair.lock").write_text("0")
        with patch.object(doc_fetcher, "fetch_page_content", return_value=(page["content"], [], "pdf")), \
             patch.object(doc_fetcher, "_validators", return_value={}), \
             patch.object(documentation_index, "get_text_embedding_with_retry", return_value=[0.1, 0.2]), \
             contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(doc_fetcher.recover_pdf(str(self.docs), str(path)))
            rebuilt = documentation_index.load_or_build_index("device", config, api_key="test")
        self.assertIn("Valid device manual", rebuilt[0])
        self.assertEqual(rebuilt[2].ntotal, 2)
