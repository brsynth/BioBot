"""Offline discovery checks; no API key, database, or robot SDK required."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("tested_handlers", ROOT / "biobot/handlers.py")
handlers = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "config": types.SimpleNamespace(biobot_model="test-model"),
    "openai": types.SimpleNamespace(OpenAI=Mock()),
}):
    spec.loader.exec_module(handlers)


class HandlerDiscoveryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.registry = Path(directory.name) / "data/handlers.json"
        patcher = patch.object(handlers, "HANDLERS_CONFIG_PATH", self.registry)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = Mock()
        patcher = patch.object(handlers, "get_openai_client", return_value=self.client)
        patcher.start()
        self.addCleanup(patcher.stop)

    def outputs(self, *values):
        self.client.responses.create.side_effect = [types.SimpleNamespace(output_text=v) for v in values]

    def test_fresh_install_has_no_platforms(self):
        self.assertEqual(handlers.load_handlers_config(), {})
        self.assertFalse(self.registry.exists())

    def test_discovered_platform_is_persisted_and_reused(self):
        self.outputs("robot_xyz", "Robot XYZ")
        platform, registry = handlers.detect_handler("Use Robot XYZ", [], "test-key")
        self.assertEqual(platform, "robot_xyz")
        config = registry[platform]
        self.assertEqual(config["docs_path"], "data/docs/robot_xyz")
        self.assertIsNone(config["simulate_cmd"])
        self.assertEqual(config["validation_strategy"], "llm_review")
        self.assertEqual(json.loads(self.registry.read_text()), registry)
        self.outputs("robot_xyz")
        self.assertEqual(handlers.detect_handler("Continue", [], "test-key"), (platform, registry))
        self.assertEqual(self.client.responses.create.call_count, 3)

    def test_unspecified_platform_never_chooses_a_cached_robot(self):
        self.outputs("unknown")
        self.assertEqual(handlers.detect_handler("Make a dilution", [], "test-key"), (None, {}))
        self.assertFalse(self.registry.exists())
        self.registry.parent.mkdir()
        registry = {"robot_xyz": {"name": "Robot XYZ"}}
        self.registry.write_text(json.dumps(registry))
        self.outputs("unknown")
        self.assertEqual(handlers.detect_handler("Make a dilution", [], "test-key"), (None, registry))
        self.assertEqual(handlers.load_handlers_config(), registry)

    def test_unsafe_platform_id_cannot_create_runtime_paths(self):
        self.outputs("../../outside")
        with self.assertRaises(ValueError):
            handlers.detect_handler("Use my robot", [], "test-key")
        self.assertFalse(self.registry.exists())


if __name__ == "__main__":
    unittest.main()
