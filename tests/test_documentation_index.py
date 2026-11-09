"""Documentation preloading and generation must share one durable build."""
from concurrent.futures import ThreadPoolExecutor
import contextlib
import io
from pathlib import Path
import pickle
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "biobot"))
try:
    import documentation_index as documentation
except ImportError as error:
    raise unittest.SkipTest(f"requires app dependencies: {error}")


class DocumentationIndexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        docs = self.root / "docs/robot_xyz"
        docs.mkdir(parents=True)
        (docs / "manual.txt").write_text("Public robot documentation")
        self.config = {"name": "Robot XYZ", "docs_path": "docs/robot_xyz", "store_path": "store.pkl"}
        self.patches = {}
        for name, value in {"SCRIPT_DIR": self.root,
                            "load_and_chunk_docs": (["first", "second"], ["manual", "manual"]),
                            "get_text_embedding_with_retry": [0.1, 0.2],
                            "fetch_documentation": False}.items():
            p = patch.object(documentation, name, value) if name == "SCRIPT_DIR" else patch.object(documentation, name, return_value=value)
            self.patches[name] = p.start()
            self.addCleanup(p.stop)

    def load(self):
        return documentation.load_or_build_index("robot_xyz", self.config, api_key="test-key")

    def test_an_existing_store_loads_without_fetching_or_embedding_again(self):
        first = self.load()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            second = self.load()
        self.assertEqual(first[:2], second[:2])
        self.assertEqual(second[2].ntotal, 2)
        self.assertEqual(self.patches["get_text_embedding_with_retry"].call_count, 2)
        self.patches["fetch_documentation"].assert_not_called()
        self.assertIn("Loading Robot XYZ", output.getvalue())
        self.assertNotIn("Building", output.getvalue())

    def test_existing_legacy_pickle_stores_are_reused(self):
        path = self.root / self.config["docs_path"] / self.config["store_path"]
        with path.open("wb") as file:
            pickle.dump({"chunks": ["old"], "chunk_sources": ["manual"], "embeddings": [[1., 2.]]}, file)
        self.assertEqual(self.load()[0], ["old"])
        self.patches["get_text_embedding_with_retry"].assert_not_called()

    def test_generation_reuses_a_concurrent_preload_instead_of_building_twice(self):
        entered, release = threading.Event(), threading.Event()
        def embed(*args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test embedding timed out")
            return [0.1, 0.2]
        self.patches["get_text_embedding_with_retry"].side_effect = embed
        with patch("handlers.load_handlers_config", return_value={"robot_xyz": self.config}), \
             patch("handlers.detect_handler") as detect, ThreadPoolExecutor(max_workers=1) as pool:
            preload = documentation.preload_documentation("Robot XYZ", "test-key")
            try:
                self.assertTrue(entered.wait(2))
                self.assertIs(documentation.preload_documentation("Robot XYZ", "test-key"), preload)
                generation = pool.submit(self.load)
            finally:
                release.set()
            preload.result(timeout=3)
            self.assertEqual(generation.result(timeout=3)[2].ntotal, 2)
            detect.assert_not_called()
        self.assertEqual(self.patches["load_and_chunk_docs"].call_count, 1)
        self.assertEqual(self.patches["get_text_embedding_with_retry"].call_count, 2)

    def test_failed_save_does_not_publish_a_partial_store(self):
        with patch.object(documentation.os, "replace", side_effect=OSError("save failed")):
            with self.assertRaises(OSError):
                self.load()
        directory = self.root / self.config["docs_path"]
        self.assertEqual(sorted(p.name for p in directory.iterdir()), ["manual.txt", "store.pkl.lock"])
