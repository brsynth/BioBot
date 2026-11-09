"""Workspace persistence and ownership checks in isolated PostgreSQL schemas."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid


@unittest.skipUnless(os.environ.get("BIOBOT_TEST_DB") == "1", "requires isolated PostgreSQL integration environment")
class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "biobot"))
        import config
        import app
        import deck_library
        self.server, self.library = app, deck_library
        preloader = patch("documentation_index.preload_documentation")
        self.preload = preloader.start()
        self.addCleanup(preloader.stop)
        self.connect = config.get_db_connection
        self.schema = "test_workspace_" + uuid.uuid4().hex
        conn = self.connect()
        with conn, conn.cursor() as cursor:
            cursor.execute(f'CREATE SCHEMA "{self.schema}"')
        conn.close()
        self.addCleanup(self.drop_schema)
        for module in (config, app, deck_library):
            p = patch.object(module, "get_db_connection", side_effect=self.connection)
            p.start(); self.addCleanup(p.stop)
        config.init_db()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO users (id, first_name) VALUES (1, 'First'), (2, 'Second')")
        conn.close()
        self.client = app.app.test_client()
        self.login(1)

    def connection(self):
        conn = self.connect()
        with conn.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{self.schema}"')
        return conn

    def drop_schema(self):
        conn = self.connect()
        with conn, conn.cursor() as cursor:
            cursor.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
        conn.close()

    def login(self, user):
        with self.client.session_transaction() as session:
            session["user"] = user
            session["encryption_key"] = "test-key"

    def save(self):
        response = self.client.post("/protocols", json={"name": "My experiment", "code": "print('original')", "device": "Robot XYZ"})
        self.assertEqual(response.status_code, 201)
        return response.get_json()["id"]

    def test_protocol_snapshot_is_encrypted_and_private(self):
        protocol_id = self.save()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("SELECT name, code FROM saved_protocols")
            name, code = cursor.fetchone()
            self.assertTrue(name.startswith("gAAAAA"))
            self.assertTrue(code.startswith("gAAAAA"))
        conn.close()
        saved = self.client.get(f"/protocols/{protocol_id}").get_json()
        self.assertEqual(saved["code"], "print('original')")
        self.login(2)
        self.assertEqual(self.client.get("/protocols").get_json(), [])
        self.assertEqual(self.client.get(f"/protocols/{protocol_id}").status_code, 404)
        self.assertEqual(self.client.post("/chat", json={"protocol_id": protocol_id}).status_code, 404)

    def test_opening_protocol_seeds_a_new_chat_without_changing_snapshot(self):
        protocol_id = self.save()
        chat_id = self.client.post("/chat", json={"protocol_id": protocol_id}).get_json()["chat_id"]
        messages = self.client.get(f"/chat/{chat_id}").get_json()
        self.assertIn("print('original')", messages[-1]["content"])
        self.assertEqual(self.client.get("/chats").get_json()[0]["device"], "Robot XYZ")
        self.client.delete(f"/chat/{chat_id}")
        self.assertEqual(self.client.get(f"/protocols/{protocol_id}").get_json()["code"], "print('original')")

    def test_protocol_rename_and_remove_are_private_and_preserve_chats(self):
        protocol_id = self.save()
        url = f"/protocols/{protocol_id}"
        chat_id = self.client.post("/chat", json={"protocol_id": protocol_id}).get_json()["chat_id"]
        self.login(2)
        self.assertEqual(self.client.patch(url, json={"name": "Stolen"}).status_code, 404)
        self.assertEqual(self.client.delete(url).status_code, 404)
        self.login(1)
        for name in ("", " " * 3, "A" * 121, 123):
            self.assertEqual(self.client.patch(url, json={"name": name}).status_code, 400)
        self.assertEqual(self.client.patch(url, json={"name": " Renamed "}).get_json()["name"], "Renamed")
        self.assertEqual(self.client.get(url).get_json()["code"], "print('original')")
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("SELECT name FROM saved_protocols")
            self.assertTrue(cursor.fetchone()[0].startswith("gAAAAA"))
        conn.close()
        self.assertEqual(self.client.delete(url).status_code, 200)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.get("/protocols").get_json(), [])
        self.assertIn("print('original')", self.client.get(f"/chat/{chat_id}").get_json()[-1]["content"])
        self.assertEqual(self.client.get("/protocols?trashed=1").get_json()[0]["id"], protocol_id)
        self.assertEqual(self.client.post("/chat", json={"protocol_id": protocol_id}).status_code, 404)
        self.login(2)
        self.assertEqual(self.client.get("/protocols?trashed=1").get_json(), [])
        self.assertEqual(self.client.post(url + "/restore").status_code, 404)
        self.login(1)
        self.assertEqual(self.client.post(url + "/restore").status_code, 200)
        self.assertEqual(self.client.get(url).get_json()["name"], "Renamed")
        self.assertEqual(self.client.get("/protocols?trashed=1").get_json(), [])

    def test_only_explicitly_saved_protocols_appear_and_inputs_are_validated(self):
        self.client.post("/chat")
        self.assertEqual(self.client.get("/protocols").get_json(), [])
        for data in ({"name": "", "code": "pass"}, {"name": "A", "code": ""}, {"name": "A", "code": []}, {"name": "A" * 121, "code": "pass"}):
            self.assertEqual(self.client.post("/protocols", json=data).status_code, 400)
        self.save()
        self.assertEqual(len(self.client.get("/protocols").get_json()), 1)

    def test_previously_used_devices_are_scoped_to_user(self):
        self.save()
        self.assertEqual(self.client.get("/devices").get_json(), ["Robot XYZ"])
        self.login(2)
        self.assertEqual(self.client.get("/devices").get_json(), [])

    def test_optional_device_is_context_when_chat_is_created(self):
        chat_id = self.client.post("/chat", json={"device": "Robot XYZ"}).get_json()["chat_id"]
        messages = self.client.get(f"/chat/{chat_id}").get_json()
        self.assertIn("Selected device: Robot XYZ", messages[0]["content"])
        self.assertEqual(self.client.get("/chats").get_json()[0]["device"], "Robot XYZ")
        self.preload.assert_not_called()
        self.assertEqual(self.client.post("/chat", json={"device": []}).status_code, 400)

    def test_new_chat_is_identified_as_waiting_for_device_choice(self):
        chat_id = self.client.post("/chat").get_json()["chat_id"]
        chat = self.client.get("/chats").get_json()[0]
        self.assertEqual(chat["chat_id"], chat_id)
        self.assertFalse(chat["has_messages"])
        self.assertIsNone(chat["device"])
        self.assertIsNone(chat["run"])

    def test_device_selection_reuses_layout_and_remembers_chat_context(self):
        chat = self.client.post("/chat").get_json()["chat_id"]
        base = {"platform": "Robot XYZ", "layout_type": "grid", "grid": {"rows": 1, "cols": 1},
                "positions": [{"id": "a", "row": 0, "col": 0, "type": "empty"}]}
        with patch.object(self.library, "identify_device", return_value={"device_id": "xyz", "name": "Robot XYZ"}) as identify, \
             patch.object(self.library, "generate_device_layout", return_value=base) as generate:
            for _ in range(2):
                response = self.client.post(f"/chat/{chat}/device", json={"device": "Robot XYZ"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()["steps"], [])
            self.assertEqual(identify.call_count, 1)
            self.assertEqual(generate.call_count, 1)
        self.assertEqual(self.preload.call_args.args[0], "Robot XYZ")
        self.assertEqual(self.client.get("/devices").get_json(), ["Robot XYZ"])
        messages = self.client.get(f"/chat/{chat}").get_json()
        self.assertIn("Robot XYZ", messages[-1]["content"])
        self.assertEqual(len(messages), 2)
        self.login(2)
        self.assertEqual(self.client.post(f"/chat/{chat}/device", json={"device": "Robot XYZ"}).status_code, 400)

    def test_landing_dispatch_validation_precedes_deck_creation_and_is_reused(self):
        with patch.object(self.server, "dispatch_device", side_effect=ValueError("Enter a liquid handler model.")), \
             patch.object(self.library, "generate_device_layout") as generate:
            rejected = self.client.post("/devices/validate", json={"device": "unrelated equipment"})
            self.assertEqual(rejected.status_code, 400)
            generate.assert_not_called()
            self.assertEqual(self.client.get("/chats").get_json(), [])
        device = {"device_id": "xyz", "name": "Robot XYZ"}
        base = {"platform": "Robot XYZ", "layout_type": "grid", "grid": {"rows": 1, "cols": 1},
                "positions": [{"id": "a", "row": 0, "col": 0, "type": "empty"}]}
        with patch.object(self.server, "dispatch_device", return_value=device) as dispatch, \
             patch.object(self.library, "identify_device") as identify, \
             patch.object(self.library, "generate_device_layout", return_value=base):
            self.assertEqual(self.client.post("/devices/validate", json={"device": "robot xyz"}).get_json(), device)
            chat = self.client.post("/chat").get_json()["chat_id"]
            response = self.client.post(f"/chat/{chat}/device", json={"device": "Robot XYZ"})
            self.assertEqual(response.status_code, 200)
            dispatch.assert_called_once()
            identify.assert_not_called()

    def test_page_has_new_chat_landing_and_no_code_view(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        for text in (b'liquid-handler-logo', b'id="landing-intro"', b'id="device-select"', b'class="library-section chat-library" open', b'class="library-section trash-library"', b'id="account-menu"', b'class="history-toolbar"'):
            self.assertIn(text, page.data)
        self.assertNotIn(b'id="deck-code-view"', page.data)
