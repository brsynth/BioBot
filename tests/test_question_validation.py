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
        self.assertEqual(self.client.responses.create.call_args.kwargs["model"], config.biobot_model)

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
        self.assertEqual([call.kwargs["model"] for call in self.client.responses.create.call_args_list],
                         [config.biobot_model])

    def test_completed_questionnaire_preserves_original_context_and_validates_answers(self):
        data = {"questions": [{"id": "derived", "question": "What is the calculated quantity?"}]}
        self.outputs("SUFFICIENT")
        history = [{"role": "user", "content": "original experimental request"}]
        history += [{"role": "assistant", "content": "__QUESTIONS__:" + json.dumps(data)},
                    {"role": "user", "content": "[PROTOCOL_PARAMS] earlier answer"}] * 4
        self.assertIsNone(questionnaire.check_sufficient_info("[PROTOCOL_PARAMS] latest answer", history, "key"))
        content = self.client.responses.create.call_args.kwargs["input"]
        self.assertIn("original experimental request", content[1]["content"])
        self.assertIn("do not design another questionnaire", content[0]["content"])

    def test_invalid_followup_review_is_bounded(self):
        self.outputs("more questions", "invalid")
        with self.assertRaisesRegex(ValueError, "retry"):
            questionnaire.check_sufficient_info("[PROTOCOL_PARAMS] answers", [], "key")
        self.assertEqual(self.client.responses.create.call_count, 2)

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

    def test_device_dispatch_rejects_unrelated_names_and_requires_explicit_acceptance(self):
        client = Mock()
        client.with_options.return_value = client
        with patch.object(engine, "get_openai_client", return_value=client):
            for accepted in (False, "true", None):
                client.responses.create.return_value.output_text = json.dumps({"is_liquid_handler": accepted, "name": "Invented device", "device_id": "invented", "message": "Enter a liquid handler model."})
                with self.assertRaisesRegex(ValueError, "liquid handler"):
                    engine.dispatch_device("unrelated equipment", [], "key")

    def test_device_dispatch_normalizes_a_valid_model_using_the_dispatch_model(self):
        client = Mock()
        client.with_options.return_value = client
        client.responses.create.return_value.output_text = json.dumps({"is_liquid_handler": True, "device_id": "robot_xyz", "name": "Robot XYZ", "manufacturer": "Robot", "model": "XYZ"})
        known = [{"device_id": "robot_xyz", "name": "Robot XYZ"}]
        with patch.object(engine, "get_openai_client", return_value=client):
            self.assertEqual(engine.dispatch_device("robot xyz", known, "key"), known[0])
        self.assertEqual(client.responses.create.call_args.kwargs["model"], config.light_functions_model)

    def test_incomplete_device_asks_for_model_instead_of_reporting_invalid(self):
        client = Mock()
        client.with_options.return_value = client
        client.responses.create.return_value.output_text = json.dumps({
            "status": "incomplete", "is_liquid_handler": False,
            "manufacturer": "Maker", "model": None, "message": "Invalid device.",
        })
        with patch.object(engine, "get_openai_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "incomplete.*specify.*model"):
                engine.dispatch_device("Maker", [], "key")

    def test_invalid_device_retains_its_correction(self):
        client = Mock()
        client.with_options.return_value = client
        client.responses.create.return_value.output_text = json.dumps({
            "status": "invalid", "is_liquid_handler": False,
            "message": "This is not a liquid handler. Please enter a liquid handler model.",
        })
        with patch.object(engine, "get_openai_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "not a liquid handler"):
                engine.dispatch_device("unrelated equipment", [], "key")

    def test_device_dispatch_rejects_a_known_model_inferred_from_manufacturer_only(self):
        client = Mock()
        client.with_options.return_value = client
        known = [{"device_id": "maker_model7", "name": "Maker Model-7"}]
        with patch.object(engine, "get_openai_client", return_value=client):
            for model in ("Model-7", "Maker"):
                client.responses.create.return_value.output_text = json.dumps({"is_liquid_handler": True, **known[0], "manufacturer": "Maker", "model": model})
                # Even an erroneous positive agent answer cannot select an unstated model.
                with self.assertRaisesRegex(ValueError, "specify.*model"):
                    engine.dispatch_device("Maker", known, "key")

    def test_device_dispatch_accepts_explicit_models_with_case_and_punctuation_variants(self):
        client = Mock()
        client.with_options.return_value = client
        client.responses.create.return_value.output_text = json.dumps({"is_liquid_handler": True, "device_id": "maker_model7", "name": "Maker Model-7", "manufacturer": "Maker", "model": "Model-7"})
        with patch.object(engine, "get_openai_client", return_value=client):
            for name in ("Maker Model-7", "maker model7", "MODEL 7"):
                self.assertEqual(engine.dispatch_device(name, [], "key")["name"], "Maker Model-7")
            for name in ("Maker Model70", "Maker Model7X"):
                with self.assertRaisesRegex(ValueError, "specify.*model"):
                    engine.dispatch_device(name, [], "key")

    def test_empty_or_non_json_device_replies_never_expose_parser_errors(self):
        client = Mock()
        client.with_options.return_value = client
        with patch.object(engine, "get_openai_client", return_value=client):
            for name in ("toto", "opentrons"):
                for output in ("", "Please specify the model", "null", "[]", '{"is_liquid_handler": true, "device_id": 42}'):
                    client.responses.create.return_value.output_text = output
                    with self.assertRaisesRegex(ValueError, "manufacturer and model"):
                        engine.dispatch_device(name, [], "key")
        self.assertEqual(client.responses.create.call_args.kwargs["text"], {"format": {"type": "json_object"}})

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

    def test_subprocess_timeout_is_reported_instead_of_an_empty_reply(self):
        def start(*args, **kwargs):
            kwargs["stderr"].write("openai.APITimeoutError: Request timed out.\n")
            return Mock(stdout=iter(["STEP:Indexing documentation...\n"]), returncode=1)
        with patch.object(engine, "check_sufficient_info", return_value=None), \
             patch.object(engine.subprocess, "Popen", side_effect=start), patch("builtins.print"):
            reply = engine.process_user_query("Complete request", [], "model", api_key="key")
            self.assertTrue(next(reply).startswith(engine.RAG_STATUS_PREFIX))
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                list(reply)

    def test_status_only_success_is_not_a_valid_answer(self):
        process = Mock(stdout=iter(["STEP:Preparing...\n"]), returncode=0)
        with patch.object(engine, "check_sufficient_info", return_value=None), \
             patch.object(engine.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "without an answer"):
                list(engine.process_user_query("Complete request", [], "model", api_key="key"))

    def test_subprocess_questionnaire_does_not_require_protocol_output(self):
        questions = {"questions": [{"id": "device", "question": "Which device?"}]}
        process = Mock(stdout=iter(["QUESTIONS:" + json.dumps(questions)]), returncode=0)
        with patch.object(engine, "check_sufficient_info", return_value=None), \
             patch.object(engine.subprocess, "Popen", return_value=process):
            reply = list(engine.process_user_query("Complete request", [], "model", api_key="key"))
        self.assertEqual(len(reply), 1)
        self.assertTrue(reply[0].startswith(engine.QUESTIONS_MARKER))


if __name__ == "__main__":
    unittest.main()
