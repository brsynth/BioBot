"""Run in the app environment with BIOBOT_TEST_DB=1; each test uses an isolated schema."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid


@unittest.skipUnless(os.environ.get("BIOBOT_TEST_DB") == "1", "requires isolated PostgreSQL integration environment")
class DeckLibraryDatabaseTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "biobot"))
        import config
        import deck_library
        self.library = deck_library
        self.connect = config.get_db_connection
        self.schema = "test_decks_" + uuid.uuid4().hex
        conn = self.connect()
        with conn, conn.cursor() as cur:
            cur.execute(f'CREATE SCHEMA "{self.schema}"')
            cur.execute(f'SET search_path TO "{self.schema}"')
            cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, api_key TEXT)")
            cur.execute("INSERT INTO users VALUES (1, 'First', 'User', NULL), (2, 'Second', 'User', NULL), (3, 'Third', 'User', NULL)")
            deck_library.init_deck_tables(cur)
        conn.close()
        self.addCleanup(self.drop_schema)
        self.base = {"platform": "Robot XYZ", "layout_type": "grid", "grid": {"rows": 1, "cols": 2},
                     "positions": [{"id": "source", "row": 0, "col": 0, "labware": None},
                                   {"id": "destination", "row": 0, "col": 1, "labware": None}]}
        self.binding = {"title": "private protocol", "positions": [{"id": "source", "labware": "source_plate", "variable": "private_name"}],
                        "steps": [{"action": "transfer", "source": {"slot": "source", "wells": ["A1"]},
                                   "destination": {"slot": "destination", "wells": ["B1"]}, "volume": "10 uL", "code_lines": [1]}]}
        self.mocks = {}
        values = {"get_db_connection": self.connection,
                  "identify_device": lambda *args: {"device_id": "robot_xyz", "name": "Robot XYZ"},
                  "generate_device_layout": lambda *args: copy.deepcopy(self.base),
                  "bind_protocol": lambda *args: copy.deepcopy(self.binding)}
        for name, value in values.items():
            patcher = patch.object(deck_library, name, side_effect=value)
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)

    def connection(self):
        conn = self.connect()
        with conn.cursor() as cur:
            cur.execute(f'SET search_path TO "{self.schema}"')
        return conn

    def drop_schema(self):
        conn = self.connect()
        with conn, conn.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
        conn.close()

    def get(self, code="protocol A", user=1, template=None):
        return self.library.get_deck(code, user, "test-key", template_id=template)

    def copy(self, state=None):
        state = state or self.get()
        layout = copy.deepcopy(state["_library"]["layout"])
        layout["positions"][0]["col"], layout["positions"][1]["col"] = 1, 0
        return self.library.save_copy(1, state["_library"]["selected"]["id"], "Alternative", layout)

    def test_same_code_never_calls_models_again(self):
        first, second = self.get(), self.get()
        self.assertEqual(first, second)
        for name in ("identify_device", "generate_device_layout", "bind_protocol"):
            self.assertEqual(self.mocks[name].call_count, 1)

    def test_file_line_endings_and_trailing_newlines_do_not_regenerate_deck(self):
        self.get("line one\nline two")
        self.get("line one\r\nline two\r\n")
        self.assertEqual(self.mocks["bind_protocol"].call_count, 1)

    def test_device_geometry_is_shared_but_bindings_are_per_user_and_code(self):
        self.get()
        self.get("protocol B")
        self.get("protocol A", user=2)
        self.assertEqual(self.mocks["generate_device_layout"].call_count, 1)
        self.assertEqual(self.mocks["bind_protocol"].call_count, 3)

    def test_private_copy_does_not_change_default_or_expose_protocol(self):
        original = self.get()
        saved = self.copy(original)
        updated = self.get(template=saved["id"])
        self.assertEqual(updated["positions"][0]["col"], 1)
        default = self.get(template=original["_library"]["selected"]["id"])
        self.assertEqual(default["positions"][0]["col"], 0)
        text = json.dumps(updated["_library"]["layout"])
        for private in ("private protocol", "private_name", "code_lines", "10 uL", "_protocol_code"):
            self.assertNotIn(private, text)
        with self.assertRaises(ValueError):
            self.get("other code", user=2, template=saved["id"])
        self.assertEqual(self.mocks["bind_protocol"].call_count, 1)

    def test_published_alternative_is_visible_and_reuses_cached_protocol_binding(self):
        state = self.get()
        other = self.get(user=2)
        saved = self.copy(state)
        self.assertEqual(len(other["_library"]["alternatives"]), 1)
        self.library.publish_deck(1, saved["id"])
        selected = self.get(user=2, template=saved["id"])
        self.assertEqual(len(selected["_library"]["alternatives"]), 2)
        self.assertEqual(selected["_library"]["selected"]["author"], "First User")
        self.assertEqual(selected["positions"][0]["col"], 1)
        self.assertEqual(selected["positions"][0]["labware"], "source_plate")
        self.assertEqual(selected["steps"], self.binding["steps"])
        self.assertEqual(self.mocks["generate_device_layout"].call_count, 1)
        self.assertEqual(self.mocks["bind_protocol"].call_count, 2)
        self.assertEqual(self.get(user=2)["_library"]["selected"]["id"], saved["id"])

    def test_only_owner_can_publish_and_copies_of_published_decks_are_private(self):
        state = self.get()
        with self.assertRaises(ValueError):
            self.library.publish_deck(1, state["_library"]["selected"]["id"])
        saved = self.copy(state)
        with self.assertRaises(ValueError):
            self.library.publish_deck(2, saved["id"])
        self.library.publish_deck(1, saved["id"])
        fork = self.library.save_copy(2, saved["id"], "My copy", state["_library"]["layout"])
        with self.assertRaises(ValueError):
            self.get(user=3, template=fork["id"])

    def test_concurrent_requests_generate_one_device_layout(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            states = list(pool.map(lambda user: self.get(user=user), [1, 2, 3]))
        self.assertEqual(len({state["_library"]["selected"]["id"] for state in states}), 1)
        self.assertEqual(self.mocks["generate_device_layout"].call_count, 1)
        self.assertEqual(self.mocks["bind_protocol"].call_count, 3)

    def test_failed_generation_is_not_cached(self):
        self.mocks["bind_protocol"].side_effect = RuntimeError("model unavailable")
        with self.assertRaises(RuntimeError):
            self.get()
        self.mocks["bind_protocol"].side_effect = lambda *args: copy.deepcopy(self.binding)
        self.assertTrue(self.get()["positions"])
        self.assertEqual(self.mocks["generate_device_layout"].call_count, 1)

    def test_concurrent_opens_of_the_same_code_extract_it_once(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            states = list(pool.map(lambda _: self.get(), range(3)))
        self.assertEqual(states[0], states[1])
        self.assertEqual(self.mocks["bind_protocol"].call_count, 1)

    def test_http_routes_enforce_authentication_and_publish_ownership(self):
        import app as server
        with patch.object(server, "get_db_connection", side_effect=self.connection):
            with server.app.test_client() as client:
                self.assertEqual(client.post('/deck/visualize', json={'code': 'protocol A'}).status_code, 403)
                self.assertEqual(client.post('/deck/library', json={}).status_code, 403)
                with client.session_transaction() as session:
                    session['user'] = 1
                state = client.post('/deck/visualize', json={'code': 'protocol A'}).get_json()
                response = client.post('/deck/library', json={
                    'parent_id': state['_library']['selected']['id'], 'name': 'HTTP copy', 'layout': self.base})
                self.assertEqual(response.status_code, 201)
                template_id = response.get_json()['id']
                with client.session_transaction() as session:
                    session['user'] = 2
                self.assertEqual(client.post(f'/deck/library/{template_id}/publish').status_code, 400)
                self.assertEqual(client.post('/deck/visualize', json={'code': 'protocol A', 'template_id': template_id}).status_code, 400)
                with client.session_transaction() as session:
                    session['user'] = 1
                self.assertEqual(client.post(f'/deck/library/{template_id}/publish').status_code, 200)
                with client.session_transaction() as session:
                    session['user'] = 2
                public = client.post('/deck/visualize', json={'code': 'protocol A', 'template_id': template_id})
                self.assertEqual(public.status_code, 200)
                self.assertEqual(public.get_json()['_library']['selected']['author'], 'First User')


if __name__ == "__main__":
    unittest.main()
