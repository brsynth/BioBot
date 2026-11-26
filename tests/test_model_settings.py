import sys
import types
import unittest
from unittest.mock import patch, MagicMock, Mock
import copy
import json

sys.path.insert(0, "biobot")
failing_db = types.SimpleNamespace(get_db_connection=lambda: (_ for _ in ()).throw(OSError("no database")))
with patch.dict(sys.modules, {"config": failing_db, "psycopg2": types.ModuleType("psycopg2"),
                              "psycopg2.extras": types.SimpleNamespace(Json=lambda value: value)}):
    import model_settings


class ModelSettingsTest(unittest.TestCase):
    def test_defaults_apply_when_settings_cannot_be_read(self):
        model_settings._cache["at"] = 0.0
        self.assertEqual(model_settings.model_for("main"), model_settings.ROLES["main"][1])
        self.assertIsNone(model_settings.system_api_key())

    def test_only_text_generation_aliases_are_listed(self):
        keep = ["gpt-6-sol", "gpt-6-luna", "o4-mini", "gpt-4o-mini"]
        drop = ["gpt-6-sol-2026-09-22", "gpt-4o-realtime-preview", "text-embedding-3-small", "gpt-image-1", "whisper-1", "tts-1"]
        self.assertTrue(all(model_settings._chat_model(name) for name in keep))
        self.assertFalse(any(model_settings._chat_model(name) for name in drop))

    def test_dated_snapshot_uses_family_prices(self):
        prices = {"gpt-5.4": {"input": 2.5, "cached_input": 0.25, "output": 15}}
        self.assertEqual(model_settings._model_prices("gpt-5.4-2026-03-05", prices), prices["gpt-5.4"])

    def test_snapshot_prices_take_precedence_and_fill_missing_fields(self):
        prices = {"gpt-5.4": {"input": 2.5, "cached_input": 0.25, "output": 15},
                  "gpt-5.4-2026-03-05": {"input": 3, "cached_input": None, "output": 0}}
        self.assertEqual(model_settings._model_prices("gpt-5.4-2026-03-05", prices),
                         {"input": 3, "cached_input": 0.25, "output": 0})

    def test_missing_family_price_is_not_guessed_from_another_model(self):
        prices = {"gpt-5.4": {"input": 2.5, "output": 15}}
        self.assertEqual(model_settings._model_prices("gpt-5.4-pro-2026-03-05", prices),
                         {"input": None, "cached_input": None, "output": None})


class AutomaticModelUpdatesTest(unittest.TestCase):
    @staticmethod
    def model(name, **extra):
        return {"id": name, "input": 2, "cached_input": 0.2, "output": 10,
                "status": "stable", "web_search": True, **extra}

    def changes(self, candidates, mode="always", role="main", current="gpt-5.6-sol"):
        return model_settings._auto_updates({role: current}, {role: mode}, candidates)

    def test_default_is_new_documentation_sol_with_updates_opt_in(self):
        self.assertEqual(model_settings.ROLES["documentation"][1], "gpt-6.2-sol")
        self.assertEqual(model_settings._auto_updates({}, {}, [self.model("gpt-9-sol")]), {})

    def test_newest_same_class_selected_even_if_more_expensive_in_always_mode(self):
        models = [self.model("gpt-5.6-sol"), self.model("gpt-6-sol", input=3),
                  self.model("gpt-6.2-sol", input=4), self.model("gpt-9-astra")]
        self.assertEqual(self.changes(models), {"main": "gpt-6.2-sol"})
        self.assertEqual(self.changes(models, "off"), {})

    def test_old_full_size_and_mini_classifications_are_preserved(self):
        self.assertEqual(self.changes([self.model("gpt-6.2-sol")], current="gpt-5.4-2026-03-05"),
                         {"main": "gpt-6.2-sol"})
        models = [self.model("gpt-5.4-mini"), self.model("gpt-6-sol"), self.model("gpt-7-luna")]
        self.assertEqual(self.changes(models, role="light", current="gpt-4o-mini"), {"light": "gpt-5.4-mini"})

    def test_cheaper_mode_does_not_trade_an_input_decrease_for_output_increase(self):
        current = self.model("gpt-5.6-sol", input=4, cached_input=0.4, output=20)
        cases = [
            ({"input": 2, "output": 21}, False),
            ({"input": 4, "cached_input": 0.4, "output": 20}, True),
            ({"input": 2, "output": None}, False),
            ({"input": 2, "cached_input": None}, False),
            ({"input": 2, "cached_input": 0.5}, False),
            ({"input": 2, "cached_input": 0, "output": 20}, True),
        ]
        for prices, expected in cases:
            with self.subTest(prices=prices):
                result = self.changes([current, self.model("gpt-6.2-sol", **prices)], "cheaper")
                self.assertEqual(bool(result), expected)
        self.assertEqual(self.changes([self.model("gpt-6.2-sol")], "cheaper"), {})

    def test_newest_eligible_cheaper_model_can_skip_a_more_expensive_successor(self):
        models = [self.model("gpt-5.6-sol", input=4, output=20),
                  self.model("gpt-6-sol", input=3), self.model("gpt-6.2-sol", input=5)]
        self.assertEqual(self.changes(models, "cheaper"), {"main": "gpt-6-sol"})

    def test_older_models_previews_and_missing_capabilities_are_skipped(self):
        models = [self.model("gpt-5.4"), self.model("gpt-7-sol", status="preview"),
                  self.model("gpt-8-sol", status=None), self.model("gpt-9-sol", web_search=False),
                  self.model("gpt-10-sol", released_at="2999-01-01")]
        self.assertEqual(self.changes(models), {})
        self.assertEqual(self.changes([self.model("gpt-9-mini", web_search=False)], role="light", current="gpt-4o-mini"),
                         {"light": "gpt-9-mini"})
        self.assertEqual(self.changes([self.model("gpt-9-sol", web_search=False)], role="documentation"), {})

    def test_officially_documented_new_class_name_requires_a_source_and_newer_release(self):
        current = self.model("gpt-5.6-sol", released_at="2026-04-01")
        successor = self.model("gpt-7-newname", model_class="sol", released_at="2026-05-01")
        self.assertEqual(self.changes([current, successor]), {})
        successor["class_source"] = "https://unverified.example/model"
        self.assertEqual(self.changes([current, successor]), {})
        successor["class_source"] = "https://developers.openai.com/api/docs/models/example"
        self.assertEqual(self.changes([current, successor]), {"main": "gpt-7-newname"})
        successor["released_at"] = "2026-03-01"
        self.assertEqual(self.changes([current, successor]), {})
        self.assertIsNone(model_settings._model_class({"id": "gpt-9"}))

    def database(self, initial):
        state = copy.deepcopy(initial)
        conn, cursor = MagicMock(), MagicMock()
        conn.cursor.return_value.__enter__.return_value = cursor
        cursor.fetchone.return_value = [True]
        patches = [
            patch.object(model_settings, "get_db_connection", return_value=conn),
            patch.object(model_settings, "_read", side_effect=lambda _, key: copy.deepcopy(state.get(key))),
            patch.object(model_settings, "_write", side_effect=lambda _, key, value: state.__setitem__(key, copy.deepcopy(value))),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        return state, cursor

    def test_settings_save_policy_and_explicit_model_atomically_and_return_them(self):
        state, cursor = self.database({"models": {"main": "gpt-5.6-sol"},
            "openai_catalog": {"models": [self.model("gpt-6.2-sol")]}})
        audit = Mock()
        with patch.dict(sys.modules, {"admin_console": types.SimpleNamespace(audit=audit)}):
            model_settings.set_models({"documentation": "gpt-6.2-sol", "updates": {"main": "cheaper"}}, 12)
        self.assertEqual(state["models"], {"main": "gpt-5.6-sol", "documentation": "gpt-6.2-sol"})
        self.assertEqual(state["model_updates"], {"main": "cheaper"})
        audit.assert_called_once()
        settings = {role["role"]: role for role in model_settings.settings()["roles"]}
        self.assertEqual(settings["main"]["auto_update"], "cheaper")
        self.assertEqual(settings["light"]["auto_update"], "off")
        self.assertEqual(settings["documentation"]["model_class"], "sol")
        before = copy.deepcopy(state)
        with patch.dict(sys.modules, {"admin_console": types.SimpleNamespace(audit=audit)}):
            for data in ({"updates": {"main": "sometimes"}}, {"updates": []}, {"updates": {"other": "always"}}):
                with self.assertRaises(ValueError):
                    model_settings.set_models(data, 12)
        self.assertEqual(state, before)

    def test_refresh_persists_upgrade_and_audits_it_but_does_not_advance_on_lookup_failure(self):
        models = [self.model("gpt-5.6-sol", input=4, cached_input=0.4, output=20), self.model("gpt-6.2-sol")]
        state, cursor = self.database({"models": {"main": "gpt-5.6-sol"}, "model_updates": {"main": "cheaper"}})
        client, audit = MagicMock(), Mock()
        client.models.list.return_value.data = [types.SimpleNamespace(id=item["id"]) for item in models]
        client.responses.create.return_value.output_text = json.dumps({"models": {item["id"]: item for item in models}})
        with patch.dict(sys.modules, {"openai": types.SimpleNamespace(OpenAI=Mock(return_value=client)),
                                      "admin_console": types.SimpleNamespace(audit=audit)}), \
                patch.object(model_settings, "model_for", return_value="gpt-5.6-sol"):
            model_settings.refresh_catalog("test-key", force=True)
            self.assertEqual(state["models"]["main"], "gpt-6.2-sol")
            self.assertEqual(audit.call_args.args[1:4], (None, "auto_update_model", "main"))
            state["models"] = {"main": "gpt-5.6-sol"}
            client.responses.create.side_effect = RuntimeError("lookup unavailable")
            catalog = model_settings.refresh_catalog("test-key", force=True)
            self.assertTrue(catalog["price_error"])
            self.assertEqual(state["models"]["main"], "gpt-5.6-sol")
            self.assertEqual(audit.call_count, 1)


if __name__ == "__main__":
    unittest.main()
