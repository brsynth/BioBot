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
from unittest.mock import patch, Mock
import types

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
        self.assertIn("Checking available resources", output.getvalue())
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

    def test_interrupted_embedding_build_resumes_from_successful_passages(self):
        embed = self.patches['get_text_embedding_with_retry']
        embed.side_effect = [[0.1,0.2], RuntimeError('temporary outage')]
        with self.assertRaisesRegex(RuntimeError,'temporary outage'):
            self.load()
        self.assertFalse((self.root / self.config['docs_path'] / 'store.pkl').exists())
        embed.reset_mock();embed.side_effect = None;embed.return_value = [0.3,0.4]
        self.assertEqual(self.load()[2].ntotal,2)
        embed.assert_called_once_with('second','test-key')

    def test_compatible_model_reuses_downloads_and_embeddings_without_searching(self):
        import doc_fetcher,json
        peer=self.root/'docs/peer';peer.mkdir()
        page={'url':'https://manufacturer.example/shared-api','content':'Common programming reference','type':'text'}
        doc_fetcher.save_fetched_docs(str(peer),[page])
        (peer/'sources.json').write_text(json.dumps({page['url']:{}}))
        peer_config={**self.config,'name':'Peer Model','docs_path':'docs/peer'}
        documentation.load_or_build_index('peer',peer_config,api_key='test-key')
        self.patches['get_text_embedding_with_retry'].reset_mock()
        (self.root/'docs/robot_xyz/manual.txt').unlink()
        with patch('device_series.documentation_peers',return_value={'Peer Model'}), \
             patch('handlers.load_handlers_config',return_value={'peer':peer_config}), \
             patch.object(doc_fetcher,'discover_doc_urls') as discover, \
             patch.object(doc_fetcher.requests,'get') as download,patch.object(doc_fetcher.requests,'head') as verify:
            result=self.load()
        self.assertEqual(result[2].ntotal,2)
        self.patches['fetch_documentation'].assert_not_called()
        self.patches['get_text_embedding_with_retry'].assert_not_called()
        discover.assert_not_called();download.assert_not_called();verify.assert_not_called()
        self.assertTrue((self.root/'docs/robot_xyz/shared-api.txt').samefile(peer/'shared-api.txt'))

    def test_failed_save_does_not_publish_a_partial_store(self):
        with patch.object(documentation.os, "replace", side_effect=OSError("save failed")):
            with self.assertRaises(OSError):
                self.load()
        directory = self.root / self.config["docs_path"]
        self.assertEqual(sorted(p.name for p in directory.iterdir()), ["manual.txt", "store.pkl.lock"])


class DocumentationPreparationTests(unittest.TestCase):
    def test_initial_preparation_waits_for_index_and_skips_online_refresh(self):
        started, release = threading.Event(), threading.Event()
        config = {"robot": {"name":"Robot XYZ", "docs_path":"docs/robot", "store_path":"index.pkl"}}
        def build(*args, **kwargs):
            started.set()
            if not release.wait(5): raise RuntimeError("Test preparation did not finish")
            return ["manual"], ["source"], object()
        handlers = types.SimpleNamespace(load_handlers_config=lambda:config, detect_handler=lambda *args:None)
        with patch.dict(sys.modules, {"handlers":handlers}), patch.object(documentation, "load_or_build_index", side_effect=build), patch.object(documentation, "refresh_index") as refresh:
            future = documentation.preload_documentation("Robot XYZ", "test-key", check_updates=False)
            try:
                self.assertTrue(started.wait(5))
                self.assertFalse(future.done())
                self.assertIs(documentation.preload_documentation("Robot XYZ", "test-key", check_updates=False),future)
            finally:
                release.set()
            self.assertTrue(future.result(timeout=5))
            refresh.assert_not_called()

    def test_missing_documentation_does_not_report_ready(self):
        handlers = types.SimpleNamespace(load_handlers_config=lambda:{"robot":{"name":"Missing manual robot", "docs_path":"docs/missing", "store_path":"index.pkl"}}, detect_handler=lambda *args:None)
        with patch.dict(sys.modules, {"handlers":handlers}), patch.object(documentation,"load_or_build_index",return_value=([],[],None)):
            with self.assertRaisesRegex(ValueError,"No usable device documentation"):
                documentation.preload_documentation("Missing manual robot", "test-key", check_updates=False).result(timeout=5)


class EmbeddingRetryTests(unittest.TestCase):
    def call(self, effects, retries=5):
        client=Mock()
        client.embeddings.create.side_effect=effects
        with patch.object(documentation,'OpenAI',return_value=client),patch.object(documentation.time,'sleep') as sleep:
            result=documentation.get_text_embedding_with_retry('passage','test-key',retries=retries)
        return result,client,sleep

    def test_server_error_respects_retry_delay(self):
        error=RuntimeError('server unavailable');error.status_code=520;error.body={'retry_after':60}
        result,client,sleep=self.call([error,types.SimpleNamespace(data=[types.SimpleNamespace(embedding=[1.,2.])])])
        self.assertEqual(result,[1.,2.]);self.assertEqual(client.embeddings.create.call_count,2)
        sleep.assert_called_once_with(60)

    def test_connection_error_is_retried(self):
        from openai import APIConnectionError
        import httpx
        error=APIConnectionError(request=httpx.Request('POST','https://api.example.test/embeddings'))
        _,_,sleep=self.call([error,types.SimpleNamespace(data=[types.SimpleNamespace(embedding=[1.,2.])])])
        sleep.assert_called_once_with(2)

    def test_http_retry_header_is_respected(self):
        error=RuntimeError('busy');error.status_code=429;error.response=types.SimpleNamespace(headers={'retry-after':'75'})
        _,_,sleep=self.call([error,types.SimpleNamespace(data=[types.SimpleNamespace(embedding=[1.,2.])])])
        sleep.assert_called_once_with(75)

    def test_authentication_and_budget_errors_are_not_retried(self):
        for status in (401,None):
            error=RuntimeError('budget or credentials');error.status_code=status
            with patch.object(documentation,'OpenAI') as client,patch.object(documentation.time,'sleep') as sleep:
                client.return_value.embeddings.create.side_effect=error
                with self.assertRaises(RuntimeError):
                    documentation.get_text_embedding_with_retry('passage','test-key')
                self.assertEqual(client.return_value.embeddings.create.call_count,1);sleep.assert_not_called()

    def test_transient_retries_are_bounded(self):
        error=RuntimeError('unavailable');error.status_code=503
        with patch.object(documentation,'OpenAI') as client,patch.object(documentation.time,'sleep') as sleep:
            client.return_value.embeddings.create.side_effect=error
            with self.assertRaises(RuntimeError):
                documentation.get_text_embedding_with_retry('passage','test-key',retries=3)
            self.assertEqual(client.return_value.embeddings.create.call_count,3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list],[2,4])
