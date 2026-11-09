"""Dynamic parameter extraction and safe updates; no model requests."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch


class ProtocolParameterTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        modules = patch.dict(sys.modules, {
            "openai": types.SimpleNamespace(OpenAI=Mock(return_value=self.client)),
            "config": types.SimpleNamespace(get_api_key=lambda: "test", biobot_model="protocol-model", light_functions_model="catalog-model"),
        })
        modules.start(); self.addCleanup(modules.stop)
        spec = importlib.util.spec_from_file_location("tested_parameters", Path(__file__).resolve().parents[1] / "biobot/deck_visualizer.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def reply(self, value):
        self.client.responses.create.return_value.output_text = json.dumps(value)

    def test_parameters_are_extracted_dynamically_with_units(self):
        parameters = [{"id": "quantity", "label": "Sample amount", "value": "10 µL"}]
        self.reply({"steps": [], "parameters": parameters})
        result = self.module.bind_protocol("protocol", {"positions": []})
        self.assertEqual(result["parameters"], parameters)

    def test_malformed_or_duplicate_parameters_are_not_accepted(self):
        for parameters in ([{"id": "quantity", "label": "Amount", "value": {"unexpected": 10}}],
                           [{"id": "a", "label": "A", "value": "1"}] * 2):
            self.reply({"steps": [], "parameters": parameters})
            with self.assertRaises(ValueError):
                self.module.bind_protocol("protocol", {"positions": []})

    def test_numeric_metadata_and_constraints_are_preserved_and_invalid_units_rejected(self):
        parameter = {"id": "amount", "label": "Amount", "value": "10 µL", "type": "number", "unit": "µL", "units": {"µL": 1, "mL": 1000}}
        constraints = [{"left": "amount", "operator": "gt", "right": 0, "message": "Use a positive amount."}]
        self.reply({"steps": [], "parameters": [parameter], "parameter_constraints": constraints})
        result = self.module.bind_protocol("protocol", {"positions": []})
        self.assertEqual(result["parameters"][0]["units"], parameter["units"])
        self.assertEqual(result["parameter_constraints"], constraints)
        parameter["units"]["mL"] = -1000
        self.reply({"steps": [], "parameters": [parameter]})
        with self.assertRaisesRegex(ValueError, "units"):
            self.module.bind_protocol("protocol", {"positions": []})

    def test_valid_parameter_update_returns_complete_code(self):
        self.reply({"code": "updated protocol", "error": None})
        result = self.module.update_code_from_changes("original", [{"type": "set_parameter", "parameter_id": "amount", "new_value": "20 µL"}])
        self.assertEqual(result, "updated protocol")
        prompt = self.client.responses.create.call_args.kwargs["input"][0]["content"]
        self.assertIn("BEFORE editing", prompt)

    def test_impossible_parameter_update_raises_without_returning_code(self):
        self.reply({"code": None, "error": "Requested quantity exceeds the available amount."})
        with self.assertRaisesRegex(ValueError, "exceeds the available"):
            self.module.update_code_from_changes("original", [{"type": "set_parameter", "new_value": "impossible"}])

    def test_hardware_only_updates_keep_the_existing_response_format(self):
        self.client.responses.create.return_value.output_text = "```python\nupdated protocol\n```"
        self.assertEqual(self.module.update_code_from_changes("original", [{"type": "move_labware"}]), "updated protocol")
