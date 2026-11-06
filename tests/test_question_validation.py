"""Offline checks for shared clarification and dispatch; no API or database required."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
config = types.SimpleNamespace(biobot_model="test-model", light_functions_model="test-light", get_api_key=lambda: "key")


def load_module(name, filename, dependencies):
    spec = importlib.util.spec_from_file_location(name, ROOT / "biobot" / filename)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, dependencies):
        spec.loader.exec_module(module)
    return module


questionnaire = load_module("tested_questionnaire", "questionnaire.py", {
    "config": config, "openai": types.SimpleNamespace(OpenAI=Mock()),
})
engine = load_module("tested_engine", "engine.py", {
    "config": config, "openai": types.SimpleNamespace(OpenAI=Mock()), "questionnaire": questionnaire,
})


class SufficiencyTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        patcher = patch.object(questionnaire, "get_openai_client", return_value=self.client)
        patcher.start()
        self.addCleanup(patcher.stop)

    def outputs(self, *values):
        self.client.responses.create.side_effect = [types.SimpleNamespace(output_text=value) for value in values]

    def test_reference_unit_identity_is_normalized_without_retry(self):
        self.outputs(json.dumps({"questions": [{"id": "count", "question": "How many?", "type": "number", "unit": "", "units": {}}]}))
        result = questionnaire.check_sufficient_info("Prepare a protocol", [], "key")
        self.assertEqual(result["questions"][0]["units"], {"": 1})
        self.assertEqual(self.client.responses.create.call_count, 1)

    def test_repairs_missing_unit_metadata_before_display(self):
        original = {"questions": [{"id": "quantity", "type": "number", "question": "Quantity (mM)?"}]}
        repaired = {"questions": [{**original["questions"][0], "unit": "mM", "units": {"mM": 1, "uM": 0.001}}]}
        self.outputs(json.dumps(original), json.dumps(repaired))
        self.assertEqual(questionnaire.check_sufficient_info("Prepare a protocol", [], "key"), repaired)

    def test_failed_repairs_never_return_broken_fields_or_prose(self):
        for repair in ('not json', '{"questions": [{"type": "number"}]}'):
            self.outputs('{"questions": [{"type": "number"}]}', repair)
            with self.assertRaisesRegex(ValueError, "retry"):
                questionnaire.check_sufficient_info("Prepare a protocol", [], "key")

    def test_submitted_params_and_history_are_rechecked_without_truncation(self):
        self.outputs("SUFFICIENT")
        history = [{"role": "user", "content": "[PROTOCOL_PARAMS]" + "x" * 500 + " critical value"}]
        self.assertIsNone(questionnaire.check_sufficient_info("[PROTOCOL_PARAMS] corrected answer", history, "key"))
        content = self.client.responses.create.call_args.kwargs["input"][1]["content"]
        self.assertIn("critical value", content)
        self.assertIn("corrected answer", content)

    def test_conflicting_submission_returns_correction_questions(self):
        data = {"questions": [{"id": "correction", "question": "Correct this value?"}]}
        self.outputs(json.dumps(data))
        self.assertEqual(questionnaire.check_sufficient_info("[PROTOCOL_PARAMS] conflicting answer", [], "key"), data)

    def test_free_text_followup_is_repaired_into_questionnaire(self):
        data = {"questions": [{"id": "model", "question": "Which instrument model?"}]}
        self.outputs("Please provide the model and quantities.", "```json\n" + json.dumps(data) + "\n```")
        self.assertEqual(questionnaire.check_sufficient_info("operation instrument", [], "key"), data)

    def test_information_request_can_bypass_protocol_questions(self):
        self.outputs("NOT_PROTOCOL")
        self.assertEqual(questionnaire.check_sufficient_info("Explain this operation", [], "key", allow_general=True), "NOT_PROTOCOL")


class DispatchTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(engine.os.environ, {}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_missing_details_start_questionnaire_before_chat_or_generation(self):
        data = {"questions": [{"id": "quantity", "question": "What quantity?"}]}
        with patch.object(engine, "check_sufficient_info", return_value=data) as assess, \
             patch.object(engine, "classify_prompt") as classify, \
             patch.object(engine, "run_gpt_stream") as chat, \
             patch.object(engine.subprocess, "Popen") as generate:
            result = list(engine.process_user_query("operation instrument", [], "model", api_key="key"))
        self.assertEqual(json.loads(result[0].removeprefix(engine.QUESTIONS_MARKER)), data)
        assess.assert_called_once_with("operation instrument", [], "key", allow_general=True)
        classify.assert_not_called()
        chat.assert_not_called()
        generate.assert_not_called()

    def test_informational_request_stays_conversational(self):
        with patch.object(engine, "check_sufficient_info", return_value="NOT_PROTOCOL"), \
             patch.object(engine, "run_gpt_stream", return_value=iter(["Explanation"])):
            self.assertEqual(list(engine.process_user_query("Explain this operation", [], "model", api_key="key")), ["Explanation"])

    def test_complete_protocol_does_not_repeat_completeness_check_in_subprocess(self):
        process = Mock(stdout=iter(["FORMAT:csv\n", "complete protocol\n"]), returncode=0)
        with patch.object(engine, "check_sufficient_info", return_value=None) as assess, \
             patch.object(engine.subprocess, "Popen", return_value=process) as generate:
            result = list(engine.process_user_query("Complete request", [], "model", api_key="key"))
        assess.assert_called_once()
        self.assertEqual(generate.call_args.kwargs["env"]["BIOBOT_SKIP_SUFFICIENT_CHECK"], "1")
        self.assertIn("complete protocol", result[0])

    def test_explicit_one_shot_mode_still_skips_questionnaire(self):
        with patch.dict(engine.os.environ, {"BIOBOT_SKIP_SUFFICIENT_CHECK": "1"}), \
             patch.object(engine, "classify_prompt", return_value="general"), \
             patch.object(engine, "check_sufficient_info") as assess, \
             patch.object(engine, "run_gpt_stream", return_value=iter(["Answer"])):
            self.assertEqual(list(engine.process_user_query("Question", [], "model", api_key="key")), ["Answer"])
        assess.assert_not_called()


if __name__ == "__main__":
    unittest.main()
