"""Keep catalog lookup independent of the full protocol model; no API calls."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch


class CatalogModelTests(unittest.TestCase):
    def test_hardware_lookup_uses_the_lightweight_model(self):
        client = Mock()
        client.responses.create.return_value.output_text = '{"categories": []}'
        constructor = Mock(return_value=client)
        spec = importlib.util.spec_from_file_location('tested_deck_visualizer', Path(__file__).resolve().parents[1] / 'biobot/deck_visualizer.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {
            'openai': types.SimpleNamespace(OpenAI=constructor),
            'config': types.SimpleNamespace(get_api_key=lambda: 'test', biobot_model='protocol-model', light_functions_model='catalog-model'),
        }):
            spec.loader.exec_module(module)
        module.get_catalog('Robot XYZ')
        self.assertEqual(client.responses.create.call_args.kwargs['model'], 'catalog-model')
        self.assertEqual(constructor.call_args.kwargs['max_retries'], 0)


if __name__ == '__main__':
    unittest.main()
