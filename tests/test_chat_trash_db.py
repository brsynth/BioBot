"""Trash/restore integration checks; BIOBOT_TEST_DB=1 uses isolated temporary schemas."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid


@unittest.skipUnless(os.environ.get('BIOBOT_TEST_DB') == '1', 'requires isolated PostgreSQL integration environment')
class ChatTrashTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'biobot'))
        import config
        import app as server
        self.config, self.server = config, server
        self.connect = config.get_db_connection
        self.schema = 'test_trash_' + uuid.uuid4().hex
        conn = self.connect()
        with conn, conn.cursor() as cursor:
            cursor.execute(f'CREATE SCHEMA "{self.schema}"')
        conn.close()
        self.addCleanup(self.drop_schema)
        for module in (config, server):
            patcher = patch.object(module, 'get_db_connection', side_effect=self.connection)
            patcher.start()
            self.addCleanup(patcher.stop)
        config.init_db()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO users (id, first_name) VALUES (1, 'First'), (2, 'Second')")
            cursor.executemany('INSERT INTO chat_names (chat_id, user_id, name) VALUES (%s, %s, %s)', [
                ('one', 1, server.encrypt_message('First chat')),
                ('two', 1, server.encrypt_message('Second chat')),
                ('foreign', 2, server.encrypt_message('Other user')),
            ])
            cursor.executemany('INSERT INTO chat_history (chat_id, user_id, role, content) VALUES (%s, 1, %s, %s)', [
                ('one', 'user', server.encrypt_message('Original request')),
                ('one', 'assistant', server.encrypt_message('Original response')),
            ])
        conn.close()
        self.client = server.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 1
            session['encryption_key'] = 'test-key'

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

    def ids(self, path):
        return {item['chat_id'] for item in self.client.get(path).get_json()}

    def test_move_to_trash_preserves_messages_and_restore_returns_original_chat(self):
        page = self.client.get('/')
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'id="trash-btn"', page.data)
        self.assertNotIn(b'id="delete-modal"', page.data)
        before = self.client.get('/chat/one').get_json()
        self.assertEqual(self.client.delete('/chat/one').status_code, 200)
        self.assertEqual(self.ids('/chats'), {'two'})
        self.assertEqual(self.ids('/chats?trashed=1'), {'one'})
        self.assertEqual(self.client.get('/chat/one').status_code, 404)
        self.assertEqual(self.client.post('/chat/one/stream', json={'message': 'New request'}).status_code, 404)
        self.assertEqual(self.client.post('/chat/one', json={'message': 'New request'}).status_code, 404)
        self.assertEqual(self.client.post('/chat/one/restore').status_code, 200)
        self.assertEqual(self.ids('/chats'), {'one', 'two'})
        self.assertEqual(self.ids('/chats?trashed=1'), set())
        self.assertEqual(self.client.get('/chat/one').get_json(), before)

    def test_user_cannot_trash_restore_or_read_another_users_chat(self):
        self.assertEqual(self.client.delete('/chat/foreign').status_code, 404)
        self.assertEqual(self.client.post('/chat/foreign/restore').status_code, 404)
        self.assertEqual(self.client.get('/chat/foreign').status_code, 404)
        self.assertEqual(self.ids('/chats?trashed=1'), set())
        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.delete('/chat/one').status_code, 403)
        self.assertEqual(self.client.post('/chat/one/restore').status_code, 403)
        self.assertEqual(self.client.get('/chats?trashed=1').status_code, 403)

    def test_repeated_trash_and_schema_migration_keep_messages_restorable(self):
        self.assertEqual(self.client.delete('/chat/one').status_code, 200)
        self.assertEqual(self.client.delete('/chat/one').status_code, 200)
        self.config.init_db()
        self.assertEqual(self.ids('/chats?trashed=1'), {'one'})
        self.assertEqual(self.client.post('/chat/one/restore').status_code, 200)
        self.assertEqual(len(self.client.get('/chat/one').get_json()), 2)

    def test_response_finishing_after_trashing_is_not_appended(self):
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key = 'test-placeholder' WHERE id = 1")
        conn.close()

        def response(*args, **kwargs):
            conn = self.connection()
            with conn, conn.cursor() as cursor:
                cursor.execute("UPDATE chat_names SET deleted_at = NOW() WHERE chat_id = 'one'")
            conn.close()
            yield 'Late assistant response'

        with patch.object(self.server, 'decrypt_text', return_value='sk-test'), patch.object(self.server, 'process_user_query', side_effect=response):
            result = self.client.post('/chat/one/stream', json={'message': 'Generate a protocol'}, buffered=True)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.ids('/chats?trashed=1'), {'one'})
        self.client.post('/chat/one/restore')
        messages = self.client.get('/chat/one').get_json()
        self.assertNotIn('Late assistant response', [message['content'] for message in messages])
        self.assertEqual(len(messages), 3)


if __name__ == '__main__':
    unittest.main()
