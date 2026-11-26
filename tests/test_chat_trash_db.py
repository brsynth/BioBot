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
        import deck_library as library
        self.library = library
        self.config, self.server = config, server
        self.connect = config.get_db_connection
        self.schema = 'test_trash_' + uuid.uuid4().hex
        conn = self.connect()
        with conn, conn.cursor() as cursor:
            cursor.execute(f'CREATE SCHEMA "{self.schema}"')
        conn.close()
        self.addCleanup(self.drop_schema)
        for module in (config, server, library):
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

    def test_restart_recovery_preserves_live_tasks_and_reports_only_interrupted_ones(self):
        run_id = str(uuid.uuid4())
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO chat_history(user_id,chat_id,role,content) VALUES(1,'one','user',%s) RETURNING id",
                           (self.server.encrypt_message('Generate a demo'),))
            message_id = cursor.fetchone()[0]
            cursor.execute("INSERT INTO chat_runs(chat_id,id,user_id,message_id) VALUES('one',%s,1,%s)", (run_id,message_id))
        conn.close()
        self.server.recover_interrupted_chat_runs(1)
        def status():
            conn=self.connection()
            with conn,conn.cursor() as cursor:
                cursor.execute("SELECT status FROM chat_runs WHERE chat_id='one'")
                value=cursor.fetchone()[0]
            conn.close();return value
        self.assertEqual(status(),'running')
        owner = self.connection()
        try:
            with owner,owner.cursor() as cursor:
                cursor.execute('SELECT pg_advisory_lock(hashtextextended(%s,0))',('chat-run:'+run_id,))
                cursor.execute("UPDATE chat_runs SET updated_at=NOW()-INTERVAL '1 hour' WHERE chat_id='one'")
            self.server.recover_interrupted_chat_runs(1)
            self.assertEqual(status(),'running')
        finally:
            owner.close()
        self.server.recover_interrupted_chat_runs(2)
        self.assertEqual(status(),'running')
        self.server.recover_interrupted_chat_runs(1)
        self.assertEqual(status(),'error')
        messages=self.client.get('/chat/one').json
        self.assertIn('server restart',messages[-1]['content'])
        wire=self.client.get('/chat/one/stream',buffered=True).data
        self.assertIn(b'__FAILED_CODE__:',wire)
        self.assertIn(b'server restart',wire)

    def test_move_to_trash_preserves_messages_and_restore_returns_original_chat(self):
        page = self.client.get('/')
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'id="trash-list"', page.data)
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

    def test_feasibility_explanation_preserves_text_format_in_stream_and_history(self):
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key = 'test-placeholder' WHERE id = 1")
        conn.close()
        for output_format in ('text', 'python'):
            content = 'Specify compatible plates.' if output_format == 'text' else 'print("demo")'
            def response(*args, **kwargs):
                yield '__RAG_STATUS__:Checking feasibility...'
                yield '__FORMAT__:' + output_format + '\n' + content
            with patch.object(self.server, 'decrypt_text', return_value='sk-test'), patch.object(self.server, 'process_user_query', side_effect=response), patch.object(self.library, 'get_deck', return_value={}):
                result = self.client.post('/chat/one/stream', json={'message': 'Make a demo'}, buffered=True)
            self.assertIn(('__STATUS__:__FORMAT__:' + output_format + '\n').encode(), result.data)
            self.assertIn(content.encode(), result.data)
            messages = self.client.get('/chat/one').get_json()
            expected = content if output_format == 'text' else 'Your protocol, deck and playback are ready.\n\n```python\n' + content + '\n```'
            self.assertEqual(messages[-1]['content'], expected)

    def test_feasibility_rejection_is_not_marked_as_a_completed_protocol(self):
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key='test-placeholder' WHERE id=1")
        conn.close()
        with patch.object(self.server,'decrypt_text',return_value='sk-test'), \
             patch.object(self.server,'process_user_query',return_value=iter([
                 '__FORMAT__:text\n__FAILED_CODE__:A documented constraint prevents this operation.'])), \
             patch.object(self.library,'get_deck') as deck:
            result = self.client.post('/chat/one/stream',json={'message':'Generate a protocol'},buffered=True)
        self.assertIn(b'__FAILED_CODE__:',result.data)
        deck.assert_not_called()
        chat = next(chat for chat in self.client.get('/chats').json if chat['chat_id']=='one')
        self.assertEqual(chat['run']['status'],'error')
        self.assertEqual(self.client.get('/chat/one').json[-1]['content'],'A documented constraint prevents this operation.')

    def test_generation_timeout_is_visible_and_saved_in_history(self):
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key = 'test-placeholder' WHERE id = 1")
        conn.close()

        def timeout(*args, **kwargs):
            yield '__RAG_STATUS__:Indexing documentation...'
            raise RuntimeError('Protocol preparation timed out. Please retry your request.')

        with patch.object(self.server, 'decrypt_text', return_value='sk-test'), patch.object(self.server, 'process_user_query', side_effect=timeout):
            result = self.client.post('/chat/one/stream', json={'message': 'Generate a protocol'}, buffered=True)
        self.assertIn(b'__FAILED_CODE__:', result.data)
        self.assertIn(b'timed out', result.data)
        messages = self.client.get('/chat/one').get_json()
        self.assertEqual(messages[-1]['role'], 'assistant')
        self.assertIn('timed out', messages[-1]['content'])
        self.assertNotIn('```', messages[-1]['content'])

    def test_refresh_reconnects_without_restarting_generation_or_losing_the_answer(self):
        from threading import Event
        release = Event()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key = 'test-placeholder' WHERE id = 1")
        conn.close()

        def response(*args, **kwargs):
            yield '__RAG_STATUS__:Preparing protocol...'
            if not release.wait(5):
                raise RuntimeError('Test release timed out')
            yield 'complete protocol'

        with patch.object(self.server, 'decrypt_text', return_value='sk-test'), patch.object(self.server, 'process_user_query', side_effect=response) as generate:
            initial = self.client.post('/chat/one/stream', json={'message': 'Generate a protocol'}, buffered=False)
            self.assertIn(b'Preparing protocol', next(iter(initial.response)))
            initial.close()  # The browser disappears while generation is still working.
            running = next(chat for chat in self.client.get('/chats').get_json() if chat['chat_id'] == 'one')
            self.assertEqual(running['run']['status'], 'running')
            self.assertEqual(self.client.post('/chat/one/stream', json={'message':'Duplicate'}).status_code, 409)
            with self.client.session_transaction() as session:
                session["user"] = 2
            self.assertEqual(self.client.get('/chat/one/stream').status_code, 404)
            with self.client.session_transaction() as session:
                session["user"] = 1
            release.set()
            replay = self.client.get('/chat/one/stream', buffered=True)
            self.assertIn(b'Preparing protocol', replay.data)
            self.assertIn(b'complete protocol', replay.data)
            self.assertEqual(generate.call_count, 1)
        messages = self.client.get('/chat/one').get_json()
        self.assertEqual(sum('complete protocol' in message['content'] for message in messages), 1)
        completed = next(chat for chat in self.client.get('/chats').get_json() if chat['chat_id'] == 'one')
        self.assertEqual(completed['run']['status'], 'done')
        self.assertFalse(completed['run']['seen'])
        self.client.post('/chat/one/read')
        completed = next(chat for chat in self.client.get('/chats').get_json() if chat['chat_id'] == 'one')
        self.assertTrue(completed['run']['seen'])

    def test_applied_deck_code_survives_reload_and_reopening(self):
        original = 'load original plate'
        updated = 'load original plate\nload added plate'
        content = 'Protocol:\n```text\n' + original + '\n```\nNotes:\n```text\nkeep this block\n```'
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE chat_history SET content = %s WHERE chat_id = 'one' AND role = 'assistant'", (self.server.encrypt_message(content),))
        conn.close()
        state = {'positions': [{'id': 'new', 'labware': 'added plate'}]}
        with patch('deck_visualizer.update_code_from_changes', return_value=updated), \
             patch.object(self.library, 'get_deck', return_value=state) as deck:
            result = self.client.post('/deck/update', json={'chat_id': 'one', 'code': original,
                'changes': [{'type': 'add_labware', 'slot': 'new', 'new': 'added plate'}]})
            self.assertEqual(result.status_code, 200)
            saved = self.client.get('/chat/one').get_json()[-1]['content']
            self.assertEqual(saved, content.replace(original, updated))
            reopened = self.client.post('/deck/visualize', json={'chat_id': 'one', 'code': updated})
            self.assertEqual(reopened.get_json(), state)
            self.assertEqual(deck.call_args.args[0], updated)

    def test_legacy_unsaved_deck_edits_are_saved_as_a_new_version(self):
        self.server._save_deck_protocol('one', 1, 'unsaved previous version', 'updated file')
        messages = self.client.get('/chat/one').get_json()
        self.assertEqual(messages[-2]['content'], 'Original response')
        self.assertEqual(messages[-1]['content'], '```\nupdated file\n```')

    def test_deck_changes_are_not_saved_if_rendering_the_updated_file_fails(self):
        with patch('deck_visualizer.update_code_from_changes', return_value='updated file'), \
             patch.object(self.library, 'get_deck', side_effect=ValueError('invalid layout')):
            result = self.client.post('/deck/update', json={'chat_id': 'one', 'code': 'original', 'changes': [{}]})
        self.assertEqual(result.status_code, 400)
        self.assertEqual(self.client.get('/chat/one').get_json()[-1]['content'], 'Original response')

    def test_deck_edits_cannot_be_saved_to_another_users_chat_or_trash(self):
        for chat_id in ('foreign', 'missing'):
            with self.assertRaisesRegex(ValueError, 'Chat not found'):
                self.server._save_deck_protocol(chat_id, 1, 'old', 'new')
        self.client.delete('/chat/one')
        with self.assertRaisesRegex(ValueError, 'Chat not found'):
            self.server._save_deck_protocol('one', 1, 'old', 'new')

    def test_hardware_catalog_is_persisted_and_reused_per_robot_and_hardware_type(self):
        catalog = {'categories': [{'name': 'Plates', 'items': [{'id': 'plate_api', 'name': 'Plate'}]}]}
        with patch('deck_visualizer.get_catalog', return_value=catalog) as generate:
            self.assertEqual(self.library.get_hardware_catalog('Robot XYZ', api_key='test'), catalog)
            self.assertEqual(self.library.get_hardware_catalog('robot-xyz', api_key='another'), catalog)
            self.assertEqual(generate.call_count, 1)
            self.library.get_hardware_catalog('Robot XYZ', 'instrument', api_key='test')
            self.assertEqual(generate.call_count, 2)

    def test_failed_catalog_lookup_does_not_poison_the_persistent_cache(self):
        catalog = {'categories': [{'name': 'Plates', 'items': []}]}
        with patch('deck_visualizer.get_catalog', side_effect=[RuntimeError('timeout'), catalog]) as generate:
            with self.assertRaisesRegex(RuntimeError, 'timeout'):
                self.library.get_hardware_catalog('Robot XYZ', api_key='test')
            self.assertEqual(self.library.get_hardware_catalog('Robot XYZ', api_key='test'), catalog)
            self.assertEqual(generate.call_count, 2)

    def test_legacy_catalog_gets_well_geometry_once_then_reuses_it(self):
        import json
        legacy = {'categories': [{'name': 'Plates', 'items': [{'id': 'plate_api', 'name': 'Plate'}]}]}
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO deck_catalogs (platform_key,position_type,catalog) VALUES (%s,%s,%s::jsonb)",
                           ('robotxyz', 'labware', json.dumps(legacy)))
        conn.close()
        updated = {'categories': [{'name': 'Plates', 'items': [{'id': 'plate_api', 'name': 'Plate', 'type': 'plate', 'well_count': 96, 'well_rows': 8, 'well_columns': 12}]}]}
        with patch('deck_visualizer.get_catalog', return_value=updated) as generate:
            catalog = self.library.get_hardware_catalog('Robot XYZ', api_key='test')
            self.assertEqual(catalog['categories'][0]['items'][0]['well_rows'], 8)
            self.assertEqual(self.library.get_hardware_catalog('Robot XYZ', api_key='test'), catalog)
            generate.assert_called_once()


    def test_deck_preparation_failure_is_not_a_completed_task(self):
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key = 'test-placeholder' WHERE id = 1")
        conn.close()
        with patch.object(self.server, 'decrypt_text', return_value='sk-test'), \
             patch.object(self.server, 'process_user_query', return_value=iter(['__FORMAT__:json\n{}'])), \
             patch.object(self.library, 'get_deck', side_effect=RuntimeError('Deck preparation failed.')):
            response=self.client.post('/chat/one/stream',json={'message':'Demo'},buffered=True)
        self.assertIn(b'__FAILED_CODE__:',response.data)
        chat=next(chat for chat in self.client.get('/chats').get_json() if chat['chat_id']=='one')
        self.assertEqual(chat['run']['status'],'error')
        saved=self.client.get('/chat/one').get_json()[-1]['content']
        self.assertIn('Deck preparation failed',saved)
        self.assertNotIn('playback are ready',saved)

    def test_protocol_prompt_is_saved_while_its_device_prepares(self):
        from threading import Event
        release=Event()
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key='test-placeholder' WHERE id=1")
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name,status) VALUES ('new-device','Maker Model7','building')")
            cursor.execute("UPDATE chat_names SET device_name='Maker Model7',device_job='new-device' WHERE chat_id='one'")
        conn.close()
        def ready(key):
            if not release.wait(5):raise RuntimeError('Test release timed out')
            return {'catalog_job':key,'status':'ready','name':'Maker Model7','device_id':'model7'}
        with patch.object(self.server,'decrypt_text',return_value='sk-test'), \
             patch('device_catalog.request_device',return_value={'catalog_job':'new-device','status':'building','message':'Preparing the selected device…'}), \
             patch('device_catalog.job_status',side_effect=ready), \
             patch.object(self.server,'process_user_query',return_value=iter(['Protocol answer'])) as generate:
            try:
                response=self.client.post('/chat/one/stream',json={'message':'Prepare a dilution'},buffered=False)
                self.assertIn('Prepare a dilution',[item['content'] for item in self.client.get('/chat/one').get_json()])
                generate.assert_not_called()
            finally:
                release.set()
            self.assertIn('Protocol answer',response.get_data(as_text=True))
            generate.assert_called_once()

    def test_task_stays_running_until_deck_and_playback_are_ready(self):
        from threading import Event
        preparing, release = Event(), Event()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE users SET api_key = 'test-placeholder' WHERE id = 1")
        conn.close()
        def prepare(*args, **kwargs):
            preparing.set()
            if not release.wait(5):
                raise RuntimeError('Test release timed out')
            return {'steps':[], '_parameters_pending':False, '_playback_pending':False}
        with patch.object(self.server, 'decrypt_text', return_value='sk-test'), \
             patch.object(self.server, 'process_user_query', return_value=iter(['__FORMAT__:python\nprint("demo")'])), \
             patch.object(self.library, 'get_deck', side_effect=prepare) as deck:
            try:
                response=self.client.post('/chat/one/stream', json={'message':'Make a demo'}, buffered=False)
                self.assertTrue(preparing.wait(3))
                chat=next(chat for chat in self.client.get('/chats').get_json() if chat['chat_id']=='one')
                self.assertEqual(chat['run']['status'],'running')
                self.assertFalse(chat['run']['seen'])
            finally:
                release.set()
            wire=response.get_data(as_text=True)
            self.assertIn('Preparing deck and playback',wire)
            self.assertIn('print("demo")',wire)
            self.assertTrue(deck.call_args.kwargs['refresh_parameters'])
        chat=next(chat for chat in self.client.get('/chats').get_json() if chat['chat_id']=='one')
        self.assertEqual(chat['run']['status'],'done')

if __name__ == '__main__':
    unittest.main()
