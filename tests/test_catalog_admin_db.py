"""Real PostgreSQL queue/concurrency and admin authorization tests in isolated schemas."""
from concurrent.futures import ThreadPoolExecutor
import copy
import os
from pathlib import Path
import sys
import threading
import tempfile
import json
import hashlib
import unittest
from unittest.mock import Mock, patch
import uuid

PROFILE = {'identity':{'manufacturer':'Maker','model':'Model7','variant':''}, 'aliases':[], 'programmable': True, 'name': 'Maker Model7', 'device_id': 'maker_model7',
           'output_type': 'Command file', 'output_format': 'commands', 'file_extension': '.cmd',
           'programming_interface': 'Documented method import', 'features': ['measurement'],
           'constraints': [{'description': 'Increment of 2.5 nL', 'unit': 'nL', 'multiple_of': 2.5}],
           'sources': [{'url': 'https://manufacturer.example/manual', 'claim': 'Documented programming interface'}]}
LAYOUT = {'platform': 'Maker Model7', 'layout_type': 'spatial', 'workspace': {'width': 100, 'height': 80},
          'positions': [{'id': 'stage', 'x': 10, 'y': 10, 'width': 20, 'height': 20}],
          'sources': [{'claim': 'geometry', 'source': 'manual'}]}


@unittest.skipUnless(os.environ.get('BIOBOT_TEST_DB') == '1', 'requires isolated PostgreSQL integration environment')
class CatalogAdminTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'biobot'))
        import config, device_catalog, admin_console, deck_library, app
        self.config, self.catalog, self.admin, self.library, self.server = config, device_catalog, admin_console, deck_library, app
        self.connect = config.get_db_connection
        import handlers, device_series
        runtime = tempfile.TemporaryDirectory()
        self.addCleanup(runtime.cleanup)
        self.runtime = Path(runtime.name)
        for module, field, filename in ((handlers,'HANDLERS_CONFIG_PATH','handlers.json'),
                                         (device_series,'CACHE_PATH','device_series.json')):
            p = patch.object(module,field,self.runtime/filename)
            p.start();self.addCleanup(p.stop)
        # Installation credentials must never influence or appear in test failures.
        for module in (config, device_catalog, app):
            p = patch.object(module, 'get_api_key', return_value='test-only')
            p.start(); self.addCleanup(p.stop)
        self.schema = 'test_catalog_' + uuid.uuid4().hex
        conn = self.connect()
        with conn, conn.cursor() as cursor:
            cursor.execute(f'CREATE SCHEMA "{self.schema}"')
            # Advisory locks are database-wide, so give each test schema its own key space.
            cursor.execute(f"""CREATE FUNCTION "{self.schema}".hashtextextended(text,bigint) RETURNS bigint
                LANGUAGE SQL IMMUTABLE AS $$ SELECT pg_catalog.hashtextextended('{self.schema}:' || $1,$2) $$""")
            cursor.execute(f"""CREATE FUNCTION "{self.schema}".hashtext(text) RETURNS integer
                LANGUAGE SQL IMMUTABLE AS $$ SELECT pg_catalog.hashtext('{self.schema}:' || $1) $$""")
        conn.close()
        self.addCleanup(self.drop_schema)
        for module in (config, device_catalog, admin_console, deck_library, app):
            p = patch.object(module, 'get_db_connection', side_effect=self.connection)
            p.start(); self.addCleanup(p.stop)
        config.init_db()
        self.catalog._running.clear()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("""INSERT INTO users (id,email,first_name,admin_status) VALUES
                (1,'admin@example.test','Admin','approved'), (2,'user@example.test','User',NULL),
                (3,'owner@example.test','Owner','approved')""")
        conn.close()
        self.discover_profile = device_catalog.discover_profile
        self.profile = patch.object(device_catalog, 'discover_profile', return_value=copy.deepcopy(PROFILE)).start()
        self.mirror = patch.object(device_catalog, '_save_profile').start()
        self.geometry = patch.object(deck_library, 'generate_device_layout', return_value=copy.deepcopy(LAYOUT)).start()
        self.addCleanup(patch.stopall)
        patch.object(device_catalog, 'start_catalog').start()
        patch.dict(os.environ, {'BIOBOT_ADMINS': 'owner@example.test'}).start()
        self.client = app.app.test_client()
        self.login(1)
        self.headers = {'X-CSRF-Token': 'test-csrf'}

    def connection(self):
        conn = self.connect()
        with conn.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{self.schema}", pg_catalog')
        return conn

    def drop_schema(self):
        conn = self.connect()
        with conn, conn.cursor() as cursor:
            cursor.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
        conn.close()

    def login(self, user, client=None):
        with (client or self.client).session_transaction() as session:
            session['user'] = user; session['session_version'] = 0; session['admin_csrf'] = 'test-csrf'

    def queue(self, name='Maker Model7'):
        with patch.object(self.catalog, 'resume_device'):
            return self.catalog.request_device(name, 'test-key')['catalog_job']

    def ready(self):
        key = self.queue()
        self.catalog._integrate(key, 'test-key')
        self.assertEqual(self.catalog.job_status(key)['status'], 'ready')
        return key

    def test_cli_grants_admin_by_email_without_changing_other_account_data(self):
        import admin
        with patch.object(admin,'get_db_connection',side_effect=self.connection):
            self.assertEqual(admin.grant_admin(' USER@example.test '),1)
            self.assertEqual(admin.grant_admin('missing@example.test'),0)
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute('SELECT admin_status,session_version FROM users WHERE id=2')
            self.assertEqual(cursor.fetchone(),('approved',0))
            cursor.execute("SELECT actor_id,target FROM admin_audit WHERE action='grant_admin_cli'")
            self.assertEqual(cursor.fetchall(),[(None,'2')])
        conn.close()

    def test_device_discovery_logs_progress_without_credentials(self):
        with self.assertLogs(self.catalog._log,level='INFO') as captured:
            key=self.ready()
        output='\n'.join(captured.output)
        for stage in ('Device discovery queued','Device discovery started','Device profile verified',
                      'Preparing device workspace','Device ready'):
            self.assertIn(stage,output)
        self.assertIn(PROFILE['name'],output)
        self.assertIn('job='+key,output)
        self.assertIn('elapsed=',output)
        self.assertNotIn('test-key',output)

    def test_fresh_device_accepts_explicit_mount_identifiers_in_objects(self):
        self.geometry.return_value['mounts']=[{'id':'attachment_1','description':'Documented interface'}]
        self.ready()
        saved=self.catalog._read('SELECT layout FROM deck_templates WHERE is_default',one=True)
        self.assertEqual(saved['layout']['mounts'],['attachment_1'])

    def test_fresh_device_accepts_no_applicable_mounts(self):
        self.geometry.return_value['mounts']=None
        self.ready()
        saved=self.catalog._read('SELECT layout FROM deck_templates WHERE is_default',one=True)
        self.assertEqual(saved['layout']['mounts'],[])

    def test_fresh_device_accepts_a_descriptive_workspace_label(self):
        description = 'Operator’s "loading & processing" area. ' + 'Documented loading interfaces. ' * 25
        self.geometry.return_value['workspace']['label'] = description
        self.ready()
        saved = self.catalog._read('SELECT layout FROM deck_templates WHERE is_default',one=True)
        self.assertEqual(saved['layout']['workspace']['label'],description.strip())
        self.geometry.assert_called_once()

    def test_concurrent_request_reuses_in_progress_entry(self):
        key = self.queue()
        entered, finish = threading.Event(), threading.Event()
        def discover(*args):
            entered.set()
            if not finish.wait(5):
                raise RuntimeError('test did not release the builder')
            return copy.deepcopy(PROFILE)
        self.profile.side_effect = discover
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.catalog._integrate, key, 'test-key')
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(self.queue(), key)
                self.assertEqual(self.catalog.job_status(key)['status'], 'building')
                pool.submit(self.catalog._integrate, key, 'test-key').result(timeout=3)
                self.assertEqual(self.profile.call_count, 1)
            finally:
                finish.set()
            first.result(timeout=5)
        self.assertEqual(self.catalog.job_status(key)['status'], 'ready')
        self.assertEqual(self.geometry.call_count, 1)
        self.assertEqual(self.catalog.job_status(self.queue())['status'], 'ready')
        self.assertEqual(self.profile.call_count, 1)

    def test_interrupted_entry_resumes_from_persisted_profile(self):
        from psycopg2.extras import Json
        key = self.queue()
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE device_catalog_jobs SET status='building',profile=%s WHERE lookup_key=%s", (Json(PROFILE),key))
        conn.close()
        self.catalog._integrate(key, 'test-key')
        self.profile.assert_not_called()
        self.assertEqual(self.catalog.job_status(key)['status'], 'ready')

    def test_layout_failure_is_retryable_without_rediscovering_language(self):
        key = self.queue()
        self.geometry.side_effect = RuntimeError('synthetic failure')
        self.catalog._integrate(key, 'test-key')
        self.assertEqual(self.catalog.job_status(key)['status'], 'failed')
        self.geometry.side_effect = None
        self.queue()
        self.catalog._integrate(key, 'test-key')
        self.assertEqual(self.catalog.job_status(key)['status'], 'ready')
        self.assertEqual(self.profile.call_count, 1)

    def test_automatic_non_liquid_candidate_is_excluded_before_workspace_preparation(self):
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name) VALUES('legacycandidate','Maker Model7')")
        conn.close()
        with self.assertLogs(self.catalog._log,level='INFO') as captured:
            self.catalog._integrate('legacycandidate','test-key',automatic=True)
        row=self.catalog.find_device('legacycandidate')
        self.assertEqual(row['status'],'excluded')
        self.assertTrue(any('outside liquid handling' in line for line in captured.output))
        self.geometry.assert_not_called();self.mirror.assert_not_called()
        self.assertEqual(self.admin.devices(),[])
        self.assertEqual(self.client.get('/devices/equipment').json,[])
        # Explicitly selecting the same instrument promotes it out of the excluded automatic queue.
        with patch.object(self.catalog,'resume_device'):
            selected=self.catalog.request_device('legacycandidate','test-key')
        self.assertEqual(selected['status'],'queued')
        self.assertTrue(self.catalog.find_device('legacycandidate')['on_demand'])
        self.catalog._integrate('legacycandidate','test-key',automatic=True)
        self.assertEqual(self.catalog.job_status('legacycandidate')['status'],'ready')
        self.geometry.assert_called_once()

    def test_old_automatic_inventory_is_retired_but_requested_devices_remain(self):
        self.ready()
        with self.connection() as conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name,status,profile) VALUES(%s,%s,'ready',%s)",
                           ('oldreader','Old reader',json.dumps(PROFILE)))
            liquid = {**PROFILE, 'categories':['Liquid handling']}
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name,status,profile) VALUES(%s,%s,'ready',%s)",
                           ('oldliquidhandler','Old liquid handler',json.dumps(liquid)))
        with self.connection() as conn, conn.cursor(cursor_factory=self.catalog.RealDictCursor) as cursor:
            self.assertEqual(self.catalog.exclude_automatic_non_liquid_devices(cursor),1)
            self.assertEqual(self.catalog.exclude_automatic_non_liquid_devices(cursor),0)
        with self.connection() as conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name) VALUES('unverified','Unverified candidate')")
        self.assertEqual(self.catalog.find_device('oldreader')['status'],'excluded')
        self.assertEqual(self.catalog.find_device('oldliquidhandler')['status'],'ready')
        names = {row['device_name'] for row in self.admin.devices()}
        self.assertNotIn('Old reader',names)
        self.assertNotIn('Unverified candidate',names)
        self.assertIn('Maker Model7',names)

    def test_new_automatic_liquid_handler_is_integrated(self):
        self.profile.return_value['features']=['Liquid handling']
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name) VALUES('newliquidhandler','Maker Model7')")
        conn.close()
        self.catalog._integrate('newliquidhandler','test-key',automatic=True)
        self.assertEqual(self.catalog.job_status('newliquidhandler')['status'],'ready')
        self.geometry.assert_called_once()

    def test_automatic_discovery_searches_only_liquid_handlers(self):
        with patch.object(self.catalog,'OpenAI'),patch.object(self.catalog,'_answer',return_value={'devices':[]}) as search:
            self.catalog._bootstrap('test-key')
        instructions=search.call_args.args[1]
        self.assertIn('only programmable liquid handlers',instructions)
        self.assertIn('native function',instructions)
        self.assertEqual(self.catalog.catalog_status()['status'],'complete')

    def test_on_demand_non_liquid_device_is_verified_registered_and_documented(self):
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',return_value={'name':PROFILE['name'],'device_id':PROFILE['device_id']}), \
             patch.object(self.catalog,'resume_device'),patch('documentation_index.preload_documentation') as docs:
            pending=self.client.post('/devices/validate',json={'device':PROFILE['name']})
            self.assertEqual(pending.status_code,202)
            self.catalog._integrate(pending.json['catalog_job'],'test-key')
            ready=self.client.post('/devices/validate',json={'device':PROFILE['name']})
        self.assertEqual(ready.status_code,200)
        self.assertEqual(ready.json['status'],'ready')
        self.profile.assert_called_once()
        saved=self.catalog.find_device(PROFILE['name'])['profile']
        self.assertTrue(saved['programmable'])
        self.assertNotIn('Liquid handling',saved['categories'])
        docs.assert_called_once_with(PROFILE['name'],'test-key',check_updates=False)

    def test_first_build_is_persistent_and_not_repeated(self):
        self.profile.return_value['features']=['Liquid handling']
        answers = [{'devices':[{'name':'Maker Model7','source':'https://manufacturer.example/manual'}], 'next_query':'other manufacturers'}, {'devices':[]}]
        with patch.object(self.catalog, 'OpenAI'), patch.object(self.catalog, '_answer', side_effect=answers) as discover:
            self.catalog._bootstrap('test-key')
            self.assertEqual(self.catalog.catalog_status()['status'], 'complete')
            self.assertEqual(self.catalog.catalog_status()['counts']['ready'], 1)
            self.catalog._bootstrap('test-key')
            self.assertEqual(discover.call_count, 2)

    def test_saved_device_validation_does_not_wait_for_documentation(self):
        from concurrent.futures import Future
        key = self.queue()
        self.catalog._integrate(key, 'test-key')
        future = Future()  # Documentation is still preparing when validation returns.
        with patch('documentation_index.preload_documentation', return_value=future) as preload:
            response = self.client.post('/devices/validate', json={'device':PROFILE['name']})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()['device_id'], PROFILE['device_id'])
        self.assertFalse(future.done())
        preload.assert_called_once()

    def test_device_api_returns_pending_then_same_completed_model(self):
        with patch.object(self.server, 'dispatch_device', return_value={'name':PROFILE['name'],'device_id':PROFILE['device_id']}), patch.object(self.catalog, 'resume_device'):
            response = self.client.post('/devices/validate', json={'device':'Maker Model7'})
        self.assertEqual(response.status_code, 202)
        key = response.get_json()['catalog_job']
        self.catalog._integrate(key,'test-key')
        response = self.client.get('/devices/discovery/' + key)
        self.assertEqual(response.get_json()['status'], 'ready')
        with self.client.session_transaction() as session:
            self.assertEqual(session['validated_device']['device_id'], PROFILE['device_id'])

    def test_admin_endpoints_reject_nonadmins_and_missing_csrf(self):
        self.login(2)
        for path in ('/admin/users','/admin/devices','/admin/devices/anything'):
            self.assertEqual(self.client.get(path).status_code,403)
        self.assertEqual(self.client.patch('/admin/users/1',json={'first_name':'hijack'},headers=self.headers).status_code,403)
        self.login(1)
        self.assertEqual(self.client.patch('/admin/users/2',json={'first_name':'Changed'}).status_code,403)
        users = self.client.get('/admin/users').get_json()
        for user in users:
            self.assertFalse({'password','api_key','encryption_salt'} & set(user))

    def test_admin_edits_are_validated_persisted_and_audited(self):
        response = self.client.patch('/admin/users/2',json={'first_name':'Changed','admin_status':'approved'},headers=self.headers)
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.client.get('/admin/users').get_json()[1]['first_name'],'Changed')
        self.assertEqual(self.client.patch('/admin/users/2',json={'password':'bad'},headers=self.headers).status_code,400)
        key = self.ready()
        changes = {'profile': {'features':['measurement','liquid-handling'], 'constraints':[{'description':'Multiple of 5 nL','unit':'nL','multiple_of':5}],
                              'output_type':'CSV method','output_format':'csv','file_extension':'.csv','programming_interface':'Method import'}}
        response = self.client.patch('/admin/devices/'+key,json=changes,headers=self.headers)
        self.assertEqual(response.status_code,200, response.get_json())
        detail = self.client.get('/admin/devices/'+key).get_json()
        self.assertEqual(detail['profile']['constraints'][0]['multiple_of'],5)
        self.assertEqual(detail['profile']['output_format'],'csv')
        self.assertEqual(self.catalog._read('SELECT COUNT(*) AS n FROM admin_audit',one=True)['n'],2)

    def test_reset_user_revokes_sessions_clears_key_and_preserves_chats(self):
        other = self.server.app.test_client(); self.login(2,other)
        response = self.client.post('/admin/users/2/reset',json={'password':'a-new-password-123'},headers=self.headers)
        self.assertEqual(response.status_code,200)
        self.assertEqual(other.get('/devices/catalog').status_code,401)
        row = self.catalog._read('SELECT session_version,api_key FROM users WHERE id=2',one=True)
        self.assertEqual(row['session_version'],1); self.assertIsNone(row['api_key'])
        self.assertEqual(self.client.post('/admin/users/3/reset',json={'password':'a-new-password-123'},headers=self.headers).status_code,400)
        self.assertEqual(self.client.patch('/admin/users/1',json={'admin_status':None},headers=self.headers).status_code,400)

    def test_reset_device_queues_fresh_profile_and_preserves_default_until_ready(self):
        key = self.ready()
        with patch.object(self.catalog,'resume_device'):
            response = self.client.post('/admin/devices/'+key+'/reset',json={},headers=self.headers)
        self.assertEqual(response.status_code,202)
        row = self.catalog.find_device(PROFILE['name'])
        self.assertEqual(row['status'],'queued'); self.assertIsNone(row['profile']); self.assertTrue(row['reset_layout'])
        self.assertEqual(len(self.catalog._read('SELECT id FROM deck_templates WHERE is_default')),1)
        self.catalog._integrate(key,'test-key')
        self.assertEqual(self.catalog.job_status(key)['status'],'ready')
        self.assertEqual(self.profile.call_count,2)
        self.assertEqual(len(self.catalog._read('SELECT id FROM deck_templates WHERE is_default')),1)

    def test_admin_cannot_edit_a_device_owned_by_an_active_builder(self):
        key = self.queue()
        conn = self.connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_lock(hashtextextended(%s,0))",('catalog-device:'+key,))
            conn.commit()
            response = self.client.patch('/admin/devices/'+key,json={'profile':{}},headers=self.headers)
            self.assertEqual(response.status_code,409)
            response = self.client.post('/admin/devices/'+key+'/reset',json={},headers=self.headers)
            self.assertEqual(response.status_code,409)
        finally:
            conn.close()

    def test_invalid_constraint_increment_and_bounds_are_rejected_before_save(self):
        key = self.ready()
        for constraint in ({'description':'bad increment','multiple_of':0},
                           {'description':'bad range','minimum':5,'maximum':1}):
            result = self.client.patch('/admin/devices/'+key,json={'profile':{'constraints':[constraint]}},headers=self.headers)
            self.assertEqual(result.status_code,400)
        self.assertEqual(self.catalog.find_device(PROFILE['name'])['profile']['constraints'][0]['multiple_of'],2.5)

    def test_admin_workspace_is_separate_and_requires_admin_access(self):
        response = self.client.get('/admin')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertRegex(response.data.decode(),r'/static/admin_console\.js\?v=\d+')
        for marker in (b'admin-panel-users',b'admin-panel-devices',b'admin-device-deck',b'admin-deck-stage'):
            self.assertIn(marker,response.data)
        self.assertNotIn(b'id="chat-history"',response.data)
        self.assertNotIn(b'class="admin-brand"',response.data)
        self.assertNotIn(b'class="admin-return"',response.data)
        self.assertNotIn(b'id="admin-category-cloud"',response.data)
        self.assertNotIn(b'id="admin-tab-decks"',response.data)
        self.assertNotIn(b'id="admin-deck-cloud"',response.data)
        self.assertNotIn(b'id="admin-deck-device"',response.data)
        user_page=self.client.get('/').data
        for page in (response.data,user_page):
            for marker in (b'id="app-banner"',b'id="admin-workspace-link"',b'id="account-menu"',b'id="settings-modal"',b'/static/account.js'):
                self.assertIn(marker,page)
        self.assertNotIn(b'id="admin-modal"',user_page)
        self.assertNotIn(b'/static/admin_console.js',user_page)
        self.login(2)
        self.assertEqual(self.client.get('/admin').status_code,403)

    def test_visual_deck_edit_changes_only_shared_default_geometry(self):
        key=self.ready()
        default=self.catalog._read('SELECT * FROM deck_templates WHERE is_default',one=True)
        private=self.library.save_copy(1,str(default['id']),'Private layout',copy.deepcopy(LAYOUT))
        updated=copy.deepcopy(LAYOUT);updated['positions'][0]['x']=15
        before_profile=self.catalog.find_device(PROFILE['name'])['profile']
        response=self.client.patch('/admin/devices/'+key+'/layout',json={'layout':updated},headers=self.headers)
        self.assertEqual(response.status_code,200,response.get_json())
        new_default=self.catalog._read('SELECT * FROM deck_templates WHERE is_default',one=True)
        self.assertEqual(new_default['id'],default['id'])
        self.assertEqual(new_default['layout']['positions'][0]['x'],15)
        private_layout=self.catalog._read('SELECT layout FROM deck_templates WHERE id=%s',(private['id'],),one=True)['layout']
        self.assertEqual(private_layout['positions'][0]['x'],10)
        self.assertEqual(self.catalog.find_device(PROFILE['name'])['profile'],before_profile)
        self.assertEqual(self.catalog._read('SELECT action FROM admin_audit ORDER BY id DESC LIMIT 1',one=True)['action'],'edit_device_layout')
        self.assertEqual(self.client.patch('/admin/devices/'+key+'/layout',json={'layout':updated}).status_code,403)
        updated['positions'][0]['x']=500
        self.assertEqual(self.client.patch('/admin/devices/'+key+'/layout',json={'layout':updated},headers=self.headers).status_code,400)
        self.login(2)
        self.assertEqual(self.client.patch('/admin/devices/'+key+'/layout',json={'layout':LAYOUT},headers=self.headers).status_code,403)

    def test_profile_reports_current_approval_and_prevents_stale_caching(self):
        self.login(2)
        response=self.client.get('/user/profile')
        self.assertEqual(response.status_code,200)
        self.assertFalse(response.get_json()['is_admin'])
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("UPDATE users SET admin_status='approved' WHERE id=2")
        conn.close()
        response=self.client.get('/user/profile')
        self.assertTrue(response.get_json()['is_admin'])
        self.assertEqual(response.get_json()['admin_status'],'approved')
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        page=self.client.get('/').data
        self.assertIn(b'id="admin-workspace-link"',page)
        self.assertIn(b'href="/admin"',page)
        self.assertNotIn(b'awaiting approval',page)

    def test_verified_alias_reuses_model_and_layout_without_another_build(self):
        key=self.ready()
        alias=copy.deepcopy(PROFILE);alias['name']='Maker Model7 Robot';alias['aliases']=['Maker Model7 Robot']
        alias['device_id']='unstable_generated_label'
        self.profile.return_value=alias
        other=self.queue('Maker Model7 Robot')
        self.catalog._integrate(other,'test-key')
        self.assertEqual(self.catalog.find_device('Maker Model7 Robot')['lookup_key'],key)
        self.assertEqual(self.catalog.job_status(other)['catalog_job'],key)
        self.assertEqual(self.geometry.call_count,1)
        self.assertEqual(self.catalog.catalog_status()['counts']['ready'],1)
        self.assertEqual(len(self.admin.devices()),1)
        self.assertEqual(self.queue('Maker Model7 Robot'),key)

    def test_two_simultaneous_aliases_have_one_canonical_builder(self):
        original=self.queue();alias_key=self.queue('Maker Model7 Robot')
        started,finish=threading.Event(),threading.Event()
        def geometry(*args):
            started.set()
            if not finish.wait(5):raise RuntimeError('builder was not released')
            return copy.deepcopy(LAYOUT)
        self.geometry.side_effect=geometry
        with ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(self.catalog._integrate,original,'test-key')
            try:
                self.assertTrue(started.wait(3))
                pool.submit(self.catalog._integrate,alias_key,'test-key').result(timeout=3)
                self.assertEqual(self.geometry.call_count,1)
            finally:finish.set()
            first.result(timeout=5)
        self.assertEqual(self.catalog.job_status(original)['status'],'ready')
        self.assertEqual(self.catalog.job_status(alias_key)['catalog_job'],original)
        self.assertEqual(len(self.catalog._read('SELECT id FROM deck_templates WHERE is_default')),1)

    def test_alias_verification_preserves_administrator_profile_corrections(self):
        key=self.ready()
        changes={'profile':{'features':['custom capability'],'constraints':[{'description':'Corrected increment','unit':'nL','multiple_of':5}],
                 'output_type':'Custom method','output_format':'csv','file_extension':'.csv','programming_interface':'Corrected import'}}
        self.admin.save_device(key,changes,1)
        other=self.queue('Maker Model7 Robot');self.catalog._integrate(other,'test-key')
        saved=self.catalog.find_device(PROFILE['name'])['profile']
        self.assertEqual(saved['features'],['custom capability'])
        self.assertEqual(saved['constraints'][0]['multiple_of'],5)
        self.assertEqual(saved['output_format'],'csv')

    def test_similar_models_and_physical_variants_are_not_merged(self):
        self.ready()
        for model,variant,name in [('Model70','','Maker Model70'),('Model7','XL','Maker Model7 XL')]:
            profile=copy.deepcopy(PROFILE);profile.update(name=name,device_id=name.lower().replace(' ','_'))
            profile['identity']={'manufacturer':'Maker','model':model,'variant':variant}
            self.profile.return_value=profile
            key=self.queue(name);self.catalog._integrate(key,'test-key')
            self.assertEqual(self.catalog.job_status(key)['status'],'ready')
        self.assertEqual(len(self.admin.devices()),3)
        self.assertEqual(self.geometry.call_count,3)

    def test_legacy_reconciliation_keeps_layout_uuids_private_copies_and_protocols(self):
        import hashlib
        from psycopg2.extras import Json,RealDictCursor
        from device_identity import reconcile_existing
        key=self.ready()
        legacy_id=str(uuid.uuid4());legacy_key='makermodel7robot'
        legacy_layout=copy.deepcopy(LAYOUT);legacy_layout['positions'][0]['x']=30
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("INSERT INTO deck_templates(id,device_id,device_name,name,is_default,layout) VALUES (%s,'legacy_model7','Maker Model7 Robot','Legacy default',TRUE,%s)",(legacy_id,Json(legacy_layout)))
            cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name,device_id,device_name,status) VALUES (%s,'Maker Model7 Robot','legacy_model7','Maker Model7','ready')",(legacy_key,))
            code='private cached protocol';digest=hashlib.sha256(code.encode()).hexdigest()
            cursor.execute("INSERT INTO deck_protocols(user_id,code_hash,device_id,template_id,binding) VALUES (1,%s,'legacy_model7',%s,%s)",(digest,legacy_id,Json({'steps':[],'positions':[],'_version':self.library.BINDING_VERSION})))
        conn.close()
        private=self.library.save_copy(1,legacy_id,'My private copy',legacy_layout)
        conn=self.connection()
        with conn,conn.cursor(cursor_factory=RealDictCursor) as cursor:reconcile_existing(cursor)
        conn.close()
        target=self.catalog.find_device('Maker Model7 Robot')
        self.assertEqual(self.catalog.find_device('Maker Model7')['lookup_key'],target['lookup_key'])
        self.assertEqual(len(self.admin.devices()),1)
        rows=self.catalog._read('SELECT id::text,device_id,is_default,owner_id,published FROM deck_templates')
        self.assertEqual(len(rows),3)
        self.assertEqual(sum(row['is_default'] for row in rows),1)
        self.assertEqual({row['device_id'] for row in rows},{target['device_id']})
        self.assertEqual(next(row for row in rows if row['id']==private['id'])['owner_id'],1)
        self.assertFalse(next(row for row in rows if row['id']==private['id'])['published'])
        state=self.library.get_deck(code,1,'test-key')
        self.assertEqual(state['_library']['selected']['id'],legacy_id)
        self.assertEqual(state['positions'][0]['x'],30)
        self.assertEqual(len(self.catalog._read('SELECT * FROM device_identity_merges')),1)
        conn=self.connection()
        with conn,conn.cursor(cursor_factory=RealDictCursor) as cursor:reconcile_existing(cursor)
        conn.close()
        self.assertEqual(len(self.catalog._read('SELECT * FROM device_identity_merges')),1)

    def test_legacy_layout_with_identical_name_and_different_id_is_reconciled(self):
        from psycopg2.extras import Json,RealDictCursor
        from device_identity import reconcile_existing
        self.ready();legacy_id=str(uuid.uuid4())
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("INSERT INTO deck_templates(id,device_id,device_name,name,is_default,layout) VALUES (%s,'older_model_id','Maker Model7','Older saved default',TRUE,%s)",(legacy_id,Json(LAYOUT)))
        conn.close()
        conn=self.connection()
        with conn,conn.cursor(cursor_factory=RealDictCursor) as cursor:reconcile_existing(cursor)
        conn.close()
        rows=self.catalog._read('SELECT id::text,device_id,is_default FROM deck_templates')
        self.assertEqual(len(rows),2)
        self.assertEqual(sum(row['is_default'] for row in rows),1)
        self.assertEqual(len({row['device_id'] for row in rows}),1)
        self.assertIn(legacy_id,{row['id'] for row in rows})
        self.assertEqual(len(self.admin.devices()),1)

    def test_three_way_name_bridge_reconciles_before_registering_shared_aliases(self):
        from psycopg2.extras import Json,RealDictCursor
        from device_identity import reconcile_existing
        self.ready()
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            for identifier,requested in [('legacy_model7','Maker Model7'),('robot_model7','Maker Model7 Robot')]:
                key='old'+identifier.replace('_','')
                cursor.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name,device_id,device_name,status) VALUES (%s,%s,%s,'Maker Model7 Robot','ready')",(key,requested,identifier))
                cursor.execute("INSERT INTO deck_templates(id,device_id,device_name,name,is_default,layout) VALUES (%s,%s,%s,'Old default',TRUE,%s)",(str(uuid.uuid4()),identifier,requested,Json(LAYOUT)))
        conn.close()
        conn=self.connection()
        with conn,conn.cursor(cursor_factory=RealDictCursor) as cursor:reconcile_existing(cursor)
        conn.close()
        self.assertEqual(len(self.admin.devices()),1)
        self.assertEqual(len(self.catalog._read('SELECT * FROM deck_templates')),3)
        self.assertEqual(len(self.catalog._read('SELECT * FROM deck_templates WHERE is_default')),1)
        self.assertEqual(self.catalog.find_device('Maker Model7')['lookup_key'],self.catalog.find_device('Maker Model7 Robot')['lookup_key'])

    def test_identity_backfill_reuses_existing_profile_and_saved_geometry(self):
        key=self.ready()
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute('UPDATE device_catalog_jobs SET model_key=NULL WHERE lookup_key=%s',(key,))
        conn.close()
        self.profile.reset_mock();self.geometry.reset_mock()
        self.catalog._upgrade_identities('test-key')
        self.profile.assert_not_called();self.geometry.assert_not_called()
        self.assertIsNotNone(self.catalog.find_device(PROFILE['name'])['model_key'])

    def test_imported_protocol_resolves_verified_alias_without_device_rediscovery(self):
        key=self.ready()
        other=self.queue('Maker Model7 Robot');self.catalog._integrate(other,'test-key')
        code='{"device":"Maker Model7 Robot","program":[{"device_op":{"name":"read"}}]}'
        with patch.object(self.library,'identify_device',side_effect=AssertionError('cached alias must resolve locally')):
            state=self.library.get_deck(code,1,'test-key')
        self.assertEqual(state['platform'],self.catalog.find_device(PROFILE['name'])['device_name'])
        self.assertEqual(self.geometry.call_count,1)

    def test_bootstrap_rejects_known_aliases_without_stopping_other_model_discovery(self):
        self.ready()
        alias=self.queue('Maker Model7 Robot');self.catalog._integrate(alias,'test-key')
        another=copy.deepcopy(PROFILE);another.update(name='Maker Model70',device_id='maker_model70')
        another['identity']={'manufacturer':'Maker','model':'Model70','variant':''}
        another['features']=['Liquid handling']
        self.profile.return_value=another
        batches=[{'devices':[{'name':'Maker Model7 Robot','source':'https://manufacturer.example/manual'}]},
                 {'devices':[{'name':'Maker Model70','source':'https://manufacturer.example/model70'}]},
                 {'devices':[]}]
        with patch.object(self.catalog,'OpenAI'),patch.object(self.catalog,'_answer',side_effect=batches) as search:
            self.catalog._bootstrap('test-key')
        self.assertEqual(search.call_count,3)
        self.assertEqual(len(self.admin.devices()),2)
        self.assertEqual(self.geometry.call_count,2)
        self.assertIn('Maker Model7 Robot',search.call_args_list[0].args[2]['known_devices'])

    def test_equipment_categories_infer_from_capabilities_and_save_custom_corrections(self):
        key=self.ready()
        self.assertEqual(self.admin.devices()[0]['categories'],['Analysis & detection'])
        result=self.client.patch('/admin/devices/'+key,json={'profile':{'categories':[' Custom family ', 'custom family', 'liquid HANDLING']}},headers=self.headers)
        self.assertEqual(result.status_code,200,result.get_json())
        expected=['Custom family','Liquid handling']
        self.assertEqual(self.catalog.find_device(PROFILE['name'])['profile']['categories'],expected)
        self.assertEqual(self.admin.devices()[0]['categories'],expected)
        self.assertEqual(self.admin.device_detail(key)['profile']['categories'],expected)
        self.assertEqual(len(self.admin.devices()),1)
        invalid=self.client.patch('/admin/devices/'+key,json={'profile':{'categories':'bad'}},headers=self.headers)
        self.assertEqual(invalid.status_code,400)
        self.assertEqual(self.admin.devices()[0]['categories'],expected)

    def test_legacy_identifier_and_partial_catalog_profiles_keep_local_capabilities(self):
        key=self.ready()
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("UPDATE device_catalog_jobs SET profile=%s WHERE lookup_key=%s", ('{"sources":[]}',key))
        conn.close()
        local={**copy.deepcopy(PROFILE),'features':['Acoustic droplet ejection']}
        with patch('handlers.load_handlers_config',return_value={'maker_model_7':local}):
            self.assertEqual(self.admin.devices()[0]['categories'],['Liquid handling'])
            self.assertEqual(self.admin.device_detail(key)['profile']['features'],local['features'])
            check=self.connection()
            with check,check.cursor() as cursor:
                cursor.execute("UPDATE device_catalog_jobs SET profile=%s WHERE lookup_key=%s", ('{"categories":[]}',key))
            check.close()
            self.assertEqual(self.admin.devices()[0]['categories'],[])

    def test_unclassified_build_fails_before_geometry_and_can_retry_to_ready(self):
        profile=copy.deepcopy(PROFILE)
        profile.update(features=[],categories=['Uncategorized'],programming_interface='Documented method import')
        self.profile.return_value=profile
        key=self.queue()
        self.catalog._integrate(key,'test-key')
        state=self.catalog.job_status(key)
        self.assertEqual(state['status'],'failed')
        self.assertIn('equipment category',state['error'])
        self.geometry.assert_not_called()
        self.profile.return_value=copy.deepcopy(PROFILE)
        self.assertEqual(self.queue(),key)
        self.catalog._integrate(key,'test-key')
        self.assertEqual(self.catalog.job_status(key)['status'],'ready')
        self.assertEqual(self.catalog.find_device(PROFILE['name'])['profile']['categories'],['Analysis & detection'])

    def test_interrupted_unclassified_profile_cannot_bypass_build_category_check(self):
        from psycopg2.extras import Json
        key=self.queue()
        incomplete=copy.deepcopy(PROFILE);incomplete.update(features=[],categories=[])
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("UPDATE device_catalog_jobs SET status='building',profile=%s WHERE lookup_key=%s",(Json(incomplete),key))
        conn.close()
        self.profile.return_value=incomplete
        self.profile.reset_mock()
        self.catalog._integrate(key,'test-key')
        self.assertEqual(self.catalog.job_status(key)['status'],'failed')
        self.geometry.assert_not_called()
        self.profile.assert_called_once()

    def test_reset_database_removes_devices_and_restarts_empty_preserving_private_work(self):
        from psycopg2.extras import Json
        import handlers, device_series
        key=self.ready()
        self.queue('Maker Model7 Robot');self.catalog._integrate('makermodel7robot','test-key')
        default=self.catalog._read('SELECT * FROM deck_templates WHERE is_default',one=True)
        private=self.library.save_copy(1,str(default['id']),'Keep my deck',copy.deepcopy(LAYOUT))
        code='saved protocol'
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("INSERT INTO deck_protocols(user_id,code_hash,device_id,template_id,binding) VALUES(1,%s,%s,%s,%s)",
                           (hashlib.sha256(code.encode()).hexdigest(),PROFILE['device_id'],default['id'],Json({'_version':self.library.BINDING_VERSION,'steps':[]})))
            cursor.execute("INSERT INTO deck_protocols(user_id,code_hash,device_id,template_id,binding) VALUES(2,%s,%s,%s,%s)",
                           (hashlib.sha256(code.encode()).hexdigest(),PROFILE['device_id'],default['id'],Json({'_version':self.library.BINDING_VERSION,'steps':[]})))
            cursor.execute("INSERT INTO deck_catalogs(platform_key,position_type,catalog) VALUES('maker','labware','{}')")
        conn.close()
        handlers._save_handlers({'old-device':{'name':'Old device'}})
        device_series.CACHE_PATH.write_text('{"old-series":{}}')
        def snapshot(table):
            return self.catalog._read(f"SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM {table} t",one=True)['data']
        before={table:snapshot(table) for table in ('users','chat_names','saved_protocols')}
        with patch.object(self.catalog,'start_catalog') as start:
            response=self.client.post('/admin/devices/reset',json={'confirm':'RESET DB'},headers=self.headers)
        self.assertEqual(response.status_code,202,response.get_json())
        self.assertEqual(response.json['removed'],1)
        self.assertEqual(response.json['queued'],0)
        start.assert_called_once_with('test-only',force=True)
        for table in ('device_catalog_jobs','device_catalog_aliases','device_identity_merges','deck_catalogs'):
            self.assertEqual(snapshot(table),[],table)
        self.assertEqual(self.admin.devices(),[])
        self.assertEqual(self.client.get('/devices/equipment').json,[])
        self.assertEqual(handlers.load_handlers_config(),{})
        self.assertFalse(device_series.CACHE_PATH.exists())
        for table in before:self.assertEqual(snapshot(table),before[table],table)
        templates=snapshot('deck_templates')
        self.assertTrue(all(not row['is_default'] for row in templates))
        self.assertTrue(any(row['id']==private['id'] and row['layout']==self.library.clean_layout(LAYOUT) for row in templates))
        state=self.library.get_deck(code,1,'test-key')
        self.assertEqual(state['platform'],PROFILE['name'])
        self.assertEqual(state['workspace'],LAYOUT['workspace'])
        other=self.library.get_deck(code,2,'test-key')
        self.assertEqual(state['_library']['selected']['owner_id'],1)
        self.assertEqual(other['_library']['selected']['owner_id'],2)
        self.assertNotEqual(state['_library']['selected']['id'],other['_library']['selected']['id'])
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("UPDATE deck_protocols SET binding=jsonb_set(binding,'{_version}','0') WHERE user_id=1")
        conn.close()
        with patch.object(self.library,'bind_protocol',return_value={'steps':[]}) as bind:
            upgraded=self.library.get_deck(code,1,'test-key',refresh_parameters=True)
        self.assertEqual(bind.call_args.args[1]['workspace'],LAYOUT['workspace'])
        self.assertEqual(upgraded['_library']['selected']['id'],state['_library']['selected']['id'])
        self.assertEqual(self.admin.devices(),[])
        self.profile.reset_mock()
        with patch.object(self.catalog,'OpenAI'),patch.object(self.catalog,'_answer',return_value={'devices':[]}):
            self.catalog._bootstrap('test-key')
        self.profile.assert_not_called()
        self.assertEqual(self.catalog.catalog_status()['status'],'complete')
        self.assertEqual(self.admin.devices(),[])
        self.config.init_db()
        self.assertEqual(self.admin.devices(),[])

    def test_reset_database_rolls_back_if_clearing_profile_registry_fails(self):
        key=self.ready()
        with patch('handlers._save_handlers',return_value=False),patch.object(self.catalog,'start_catalog') as start:
            result=self.client.post('/admin/devices/reset',json={'confirm':'RESET DB'},headers=self.headers)
        self.assertEqual(result.status_code,400)
        self.assertEqual(self.catalog.job_status(key)['status'],'ready')
        self.assertTrue(self.catalog._read('SELECT 1 FROM deck_templates WHERE is_default'))
        start.assert_not_called()

    def test_reset_database_cannot_clear_a_live_protocol_task(self):
        key=self.ready(); run_id=str(uuid.uuid4())
        owner=self.connection()
        try:
            with owner,owner.cursor() as cursor:
                cursor.execute("INSERT INTO chat_names(chat_id,user_id,name) VALUES('active-reset-test',1,'active')")
                cursor.execute("INSERT INTO chat_runs(chat_id,id,user_id) VALUES('active-reset-test',%s,1)",(run_id,))
                cursor.execute('SELECT pg_advisory_lock(hashtextextended(%s,0))',('chat-run:'+run_id,))
            result=self.client.post('/admin/devices/reset',json={'confirm':'RESET DB'},headers=self.headers)
            self.assertEqual(result.status_code,409)
            self.assertEqual(self.catalog.job_status(key)['status'],'ready')
        finally:owner.close()

    def test_reset_database_requires_admin_csrf_and_drains_active_builders(self):
        key=self.ready()
        url='/admin/devices/reset'
        self.assertEqual(self.client.post(url,json={'confirm':'RESET DB'}).status_code,403)
        self.assertEqual(self.client.post(url,json={},headers=self.headers).status_code,400)
        self.login(2)
        self.assertEqual(self.client.post(url,json={'confirm':'RESET DB'},headers=self.headers).status_code,403)
        self.login(1)
        conn=self.connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_lock_shared(hashtextextended('catalog-reset',0))")
            conn.commit()
            with patch.object(self.catalog,'_submit') as submit:
                result=self.client.post(url,json={'confirm':'RESET DB'},headers=self.headers)
            self.assertEqual(result.status_code,202,result.get_json())
            self.assertTrue(self.catalog.reset_pending())
            self.assertEqual(self.admin.devices(),[])
            self.assertEqual(self.catalog.catalog_status()['status'],'resetting')
            submit.assert_called_once()
            # New builders stop while the old builder drains.
            self.profile.reset_mock()
            self.catalog._integrate(key,'test-key')
            self.profile.assert_not_called()
        finally:conn.close()
        with patch.object(self.catalog,'start_catalog') as start:
            self.catalog._finish_reset('test-key')
        start.assert_called_once_with('test-key',force=True)
        self.assertFalse(self.catalog.reset_pending())
        self.assertIsNone(self.catalog.find_device(key))
        self.assertEqual(self.admin.devices(),[])

    def test_online_update_checks_ready_devices_and_refreshes_metadata_without_rebuilding_decks(self):
        key=self.ready()
        before=self.catalog._read('SELECT id,layout FROM deck_templates ORDER BY id')
        updated=copy.deepcopy(PROFILE);updated.update(output_type='CSV method',output_format='csv',file_extension='.csv')
        updated['sources'].append({'url':'https://manufacturer.example/new-manual','claim':'Updated method format'})
        self.profile.return_value=updated;self.profile.reset_mock();self.geometry.reset_mock()
        with patch.object(self.catalog,'start_catalog') as start:
            response=self.client.post('/admin/devices/update',json={},headers=self.headers)
        self.assertEqual(response.status_code,202,response.get_json())
        start.assert_called_once_with('test-only',force=True)
        self.assertEqual(self.catalog.job_status(key)['status'],'ready')
        self.assertEqual(self.catalog.catalog_status()['updating'],1)
        with patch.object(self.catalog,'OpenAI'),patch.object(self.catalog,'_answer',return_value={'devices':[]}):
            self.catalog._bootstrap('test-key')
        self.profile.assert_called_once()
        self.assertEqual(self.catalog.find_device(PROFILE['name'])['profile']['output_format'],'csv')
        self.assertEqual(self.catalog.catalog_status()['updating'],0)
        self.assertIsNotNone(self.catalog.find_device(PROFILE['name'])['checked_at'])
        self.assertEqual(self.catalog._read('SELECT id,layout FROM deck_templates ORDER BY id'),before)
        self.geometry.assert_not_called()

    def test_online_update_preserves_admin_corrections_and_keeps_ready_device_on_check_failure(self):
        key=self.ready()
        self.admin.save_device(key,{'profile':{'features':['Administrator correction']}},1)
        updated=copy.deepcopy(PROFILE);updated.update(features=['New online feature'],categories=['Analysis & detection'])
        updated['sources'].append({'url':'https://manufacturer.example/update','claim':'New reference'})
        self.profile.return_value=updated
        self.catalog._integrate(key,'test-key',check_updates=True)
        row=self.catalog.find_device(PROFILE['name'])
        self.assertEqual(row['profile']['features'],['Administrator correction'])
        self.assertIn(updated['sources'][-1],row['profile']['sources'])
        before=row['profile']
        self.profile.side_effect=ValueError('Official sources temporarily unavailable')
        self.catalog._integrate(key,'test-key',check_updates=True)
        row=self.catalog.find_device(PROFILE['name'])
        self.assertEqual(row['status'],'ready');self.assertEqual(row['profile'],before)
        self.assertIn('temporarily unavailable',row['error'])
        self.assertEqual(self.catalog.catalog_status()['update_errors'],1)

    def test_online_update_finds_new_models_after_initial_inventory_limit_is_reached(self):
        self.ready()
        another=copy.deepcopy(PROFILE);another.update(name='Maker Model70',device_id='maker_model70')
        another['identity']={'manufacturer':'Maker','model':'Model70','variant':''}
        another['features']=['Liquid handling']
        self.profile.side_effect=lambda name,key: copy.deepcopy(another if name=='Maker Model70' else PROFILE)
        with patch.dict(os.environ,{'BIOBOT_CATALOG_INITIAL_LIMIT':'1'}):
            response=self.client.post('/admin/devices/update',json={},headers=self.headers)
            self.assertEqual(response.status_code,202)
            with patch.object(self.catalog,'OpenAI'),patch.object(self.catalog,'_answer',return_value={'devices':[{'name':'Maker Model70','source':'https://manufacturer.example/model70'}]}) as search:
                self.catalog._bootstrap('test-key')
        search.assert_called_once()
        self.assertEqual(len(self.admin.devices()),2)
        self.assertEqual(self.catalog.catalog_status()['counts']['ready'],2)

    def test_online_update_requires_admin_csrf_and_refuses_active_catalog_work(self):
        key=self.ready();url='/admin/devices/update'
        self.assertEqual(self.client.post(url,json={}).status_code,403)
        self.login(2)
        self.assertEqual(self.client.post(url,json={},headers=self.headers).status_code,403)
        self.login(1)
        conn=self.connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_lock_shared(hashtextextended('catalog-reset',0))")
            conn.commit()
            self.assertEqual(self.client.post(url,json={},headers=self.headers).status_code,409)
            self.assertFalse(self.catalog.find_device(PROFILE['name'])['refresh_profile'])
        finally:conn.close()

    def test_landing_equipment_catalog_is_available_to_users_and_exposes_only_ready_public_fields(self):
        key=self.ready()
        alias=self.queue('Maker Model7 Robot');self.catalog._integrate(alias,'test-key')
        self.queue('Model still being prepared')
        self.login(2)
        response=self.client.get('/devices/equipment')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        rows=response.get_json();self.assertEqual(len(rows),1)
        self.assertEqual(set(rows[0]),{'key','name','categories','status','manufacturer','model','search_terms'})
        self.assertEqual(rows[0]['categories'],['Analysis & detection'])
        self.assertEqual(rows[0]['key'],key)
        self.assertEqual(rows[0]['status'],'ready')
        self.assertIn('measurement',rows[0]['search_terms'])
        with self.client.session_transaction() as session:session.clear()
        self.assertEqual(self.client.get('/devices/equipment').status_code,403)

    def test_reviewed_model_correction_moves_default_bindings_but_preserves_private_layouts(self):
        from psycopg2.extras import Json,RealDictCursor
        from device_identity import correct_model_assignment
        target=self.ready()
        legacy='makerfamily';old_id=str(uuid.uuid4())
        old_layout=copy.deepcopy(LAYOUT);old_layout['positions'][0]['id']='old stage'
        conn=self.connection()
        with conn,conn.cursor() as q:
            q.execute("INSERT INTO device_catalog_jobs(lookup_key,requested_name,device_id,device_name,status,model_key) VALUES (%s,'Maker family','family','Maker family','ready','family-identity')",(legacy,))
            q.execute("INSERT INTO deck_templates(id,device_id,device_name,name,is_default,layout) VALUES (%s,'family','Maker family','Old default',TRUE,%s)",(old_id,Json(old_layout)))
            q.execute("INSERT INTO deck_protocols(user_id,code_hash,device_id,template_id,binding) VALUES (1,'reviewed-correction','family',%s,%s)",(old_id,Json({'positions':[{'id':'old stage','labware':'sample'}],'steps':[{'source':{'slot':'old stage'}}]})))
        conn.close()
        private=self.library.save_copy(1,old_id,'Private unchanged',old_layout)
        conn=self.connection()
        with conn,conn.cursor(cursor_factory=RealDictCursor) as q:
            correct_model_assignment(q,legacy,target,{'old stage':'stage'},'Reviewed manufacturer manual + user-selected exact model')
        conn.close()
        binding=self.catalog._read("SELECT template_id,binding FROM deck_protocols WHERE code_hash='reviewed-correction'",one=True)
        canonical=self.catalog._read('SELECT id FROM deck_templates WHERE device_id=%s AND is_default',(self.catalog.find_device(PROFILE['name'])['device_id'],),one=True)
        self.assertEqual(binding['template_id'],canonical['id'])
        self.assertEqual(binding['binding']['positions'][0]['id'],'stage')
        self.assertEqual(binding['binding']['steps'][0]['source']['slot'],'stage')
        self.assertEqual(self.catalog._read('SELECT layout FROM deck_templates WHERE id=%s',(private['id'],),one=True)['layout'],self.library.clean_layout(old_layout))
        self.assertEqual(len(self.admin.devices()),1)
        self.assertTrue(self.catalog._read('SELECT previous_record FROM device_identity_merges',one=True)['previous_record']['correction_evidence'])

    def test_discovery_requires_an_exact_model_and_rejects_product_family_decks(self):
        for scope in [None,'family']:
            profile=copy.deepcopy(PROFILE)
            if scope:profile.update(model_scope=scope,family_models=['Maker Model7','Maker Model7T'])
            with patch.object(self.catalog,'OpenAI'),patch.object(self.catalog,'_answer',return_value=profile):
                with self.assertRaises(ValueError):self.discover_profile('Maker family','test-key')

    def test_catalog_transfer_physics_is_exposed_to_new_and_cached_protocol_decks(self):
        profile=copy.deepcopy(PROFILE)
        profile['features']=['Acoustic droplet ejection']
        profile['constraints'][0]['name']='Drop transfer resolution'
        profile['constraints'][0]['source']='manufacturer manual'
        self.profile.return_value=profile
        self.ready()
        state=self.library.get_device_deck(PROFILE['name'],1,'test-key')
        self.assertEqual(state['_transfer_physics']['droplet_volume_nl'],2.5)
        code='{"device":"Maker Model7","program":[{"device_op":{"name":"read"}}]}'
        for _ in range(2):
            state=self.library.get_deck(code,1,'test-key')
            self.assertEqual(state['_transfer_physics']['droplet_volume_nl'],2.5)

    def test_landing_keeps_saved_layout_and_categories_after_discovery_failure(self):
        key=self.ready()
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute("UPDATE device_catalog_jobs SET status='failed',reset_layout=TRUE,error='Interrupted' WHERE lookup_key=%s",(key,))
        conn.close()
        self.login(2)
        with patch('handlers.load_handlers_config',return_value={PROFILE['device_id']:copy.deepcopy(PROFILE)}):
            rows=self.client.get('/devices/equipment').get_json()
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['status'],'local')
        self.assertEqual(rows[0]['categories'],['Analysis & detection'])
        self.assertEqual(rows[0]['name'],PROFILE['name'])

    def test_series_clarification_prefers_saved_models_without_registering_the_family(self):
        from engine import DeviceIncomplete
        from psycopg2.extras import Json
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            for model in ('10','20'):
                name='Maker SeriesA '+model
                cursor.execute('INSERT INTO deck_templates (id,device_id,device_name,name,is_default,layout) VALUES (%s,%s,%s,%s,TRUE,%s)',
                               (str(uuid.uuid4()),'maker_seriesa_'+model,name,name,Json(LAYOUT)))
        conn.close()
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',side_effect=DeviceIncomplete('Specify the exact model.','SeriesA')), \
             patch('engine.list_device_models') as online, patch('device_series.series_choices',return_value=[]), \
             patch.object(self.catalog,'request_device') as register:
            response=self.client.post('/devices/validate',json={'device':'SeriesA'})
        self.assertEqual(response.status_code,200,response.get_json())
        data=response.get_json()
        self.assertEqual(data['scope'],'series')
        self.assertEqual(data['query'],'SeriesA')
        self.assertEqual(data['options'],['Maker SeriesA 10','Maker SeriesA 20'])
        self.assertEqual(data['options_source'],'saved')
        online.assert_not_called()
        register.assert_not_called()

    def test_unknown_series_preserves_query_and_labels_online_choices_without_registering_them(self):
        from engine import DeviceIncomplete
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',side_effect=DeviceIncomplete('Specify the exact model.','SeriesA')), \
             patch('engine.list_device_models',return_value=['Maker SeriesA 10']) as online, \
             patch('device_series.series_choices',return_value=[]), patch.object(self.catalog,'request_device') as register:
            data=self.client.post('/devices/validate',json={'device':'SeriesA'}).get_json()
        online.assert_called_once_with('SeriesA','test-key')
        self.assertEqual(data['scope'],'series')
        self.assertEqual(data['options_source'],'online')
        register.assert_not_called()


    def test_series_choices_are_navigation_metadata_and_do_not_create_physical_devices(self):
        from engine import DeviceIncomplete
        group={'kind':'series','name':'Maker A Series','programming_interface':'Shared API','protocol_format':'Transfer schema',
               'members':[{'kind':'model','name':'Maker A10'},{'kind':'model','name':'Maker A10T Plus'}]}
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',side_effect=DeviceIncomplete('Specify the exact model.','Maker A')), \
             patch('device_series.series_choices',return_value=[group]) as groups, \
             patch.object(self.catalog,'request_device') as register:
            response=self.client.post('/devices/validate',json={'device':'Maker A'})
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(response.get_json()['choices'],[group])
        self.assertEqual(response.get_json()['options'],['Maker A10','Maker A10T Plus'])
        self.assertEqual(groups.call_args.args[0],'Maker A')
        register.assert_not_called()
        conn=self.connection()
        with conn,conn.cursor() as cursor:
            cursor.execute('SELECT COUNT(*) FROM deck_templates')
            self.assertEqual(cursor.fetchone()[0],0)
        conn.close()

    def test_discovered_family_returns_model_choices_without_creating_a_deck_or_retrying(self):
        key = self.queue('Maker A Family')
        self.profile.side_effect = self.catalog.DeviceFamily('Maker A Family', ['A10', 'A20'])
        self.catalog._integrate(key, 'test-key')
        with patch.object(self.catalog, 'resume_device') as resume:
            response = self.client.post('/devices/validate', json={'device':'Maker A Family'})
        data = response.get_json()
        self.assertTrue(data['incomplete'], data)
        self.assertEqual(data['options'], ['Maker A Family A10', 'Maker A Family A20'])
        self.assertEqual(self.catalog.job_status(key)['options'], data['options'])
        resume.assert_not_called()
        self.geometry.assert_not_called()
        suggestions = self.client.get('/devices/equipment?series=1').get_json()
        self.assertEqual(suggestions[0]['kind'], 'family')
        self.assertEqual([member['name'] for member in suggestions[0]['members']], data['options'])

    def test_legacy_family_error_becomes_choices_without_online_rediscovery(self):
        key = self.queue('Maker Old Family')
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE device_catalog_jobs SET status='failed',error=%s WHERE lookup_key=%s",
                           (self.catalog.FAMILY_MESSAGE + ': X10, X20', key))
        conn.close()
        with patch.object(self.catalog, 'resume_device') as resume:
            data = self.client.post('/devices/validate', json={'device':'Maker Old Family'}).get_json()
        self.assertTrue(data['incomplete'], data)
        self.assertEqual(data['options'], ['Maker Old Family X10','Maker Old Family X20'])
        resume.assert_not_called()
        self.profile.assert_not_called()

    def test_description_discovery_offers_cross_manufacturer_models_without_registering(self):
        from engine import DeviceIncomplete
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',side_effect=DeviceIncomplete('Choose a model.','plate reader','description')), \
             patch('engine.list_device_models',return_value=['Maker A10','Other B20']) as discover, \
             patch('device_series.series_choices') as groups, patch.object(self.catalog,'request_device') as register:
            response=self.client.post('/devices/validate',json={'device':'plate reader'})
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(response.get_json()['options'],['Maker A10','Other B20'])
        discover.assert_called_once_with('plate reader','test-key',scope='description')
        groups.assert_not_called()
        register.assert_not_called()

    def test_combined_prompt_retains_protocol_intent_with_a_cached_device(self):
        self.ready()
        prompt = 'Dilute DNA using Maker Model7'
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',return_value={'name':PROFILE['name'],
                          'device_id':PROFILE['device_id'],'has_protocol_request':True}) as dispatch, \
             patch('documentation_index.preload_documentation'):
            result = self.client.post('/devices/validate',json={'device':PROFILE['name'],'prompt':prompt})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json['has_protocol_request'])
        self.assertEqual(result.json['name'], PROFILE['name'])
        self.assertEqual(dispatch.call_args.args[0], prompt)

    def test_device_preparation_is_private_history_and_reopens_the_same_chat(self):
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',return_value={'name':PROFILE['name'],'device_id':PROFILE['device_id']}), \
             patch.object(self.catalog,'resume_device'):
            first=self.client.post('/devices/validate',json={'device':PROFILE['name']}).get_json()
            second=self.client.post('/devices/validate',json={'device':PROFILE['name']}).get_json()
        self.assertEqual(first['chat_id'],second['chat_id'])
        history=self.client.get('/chats').get_json()
        self.assertEqual(len(history),1)
        self.assertEqual(history[0]['chat_id'],first['chat_id'])
        self.assertEqual(history[0]['preparation']['status'],'running')
        self.assertIsNone(history[0]['run'])  # This is device preparation, not a prompt to replay.
        self.client.post('/chat/'+first['chat_id']+'/read')
        self.assertFalse(self.client.get('/chats').get_json()[0]['preparation']['seen'])
        self.login(2)
        self.assertEqual(self.client.get('/chats').get_json(),[])
        self.assertEqual(self.client.get('/chat/'+first['chat_id']).status_code,404)
        self.login(1)
        self.catalog._integrate(first['catalog_job'],'test-key')
        history=self.client.get('/chats').get_json()
        self.assertEqual(history[0]['preparation']['status'],'done')
        self.assertFalse(history[0]['preparation']['seen'])
        self.client.post('/chat/'+first['chat_id']+'/read')
        self.assertTrue(self.client.get('/chats').get_json()[0]['preparation']['seen'])
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), patch('documentation_index.preload_documentation'):
            opened=self.client.post('/chat/'+first['chat_id']+'/device',json={'device':PROFILE['name']})
        self.assertEqual(opened.status_code,200,opened.get_json())
        self.assertEqual(opened.get_json()['platform'],PROFILE['name'])
        self.assertIsNone(self.client.get('/chats').get_json()[0]['preparation'])

    def test_failed_preparation_stays_in_history_with_an_error(self):
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',return_value={'name':PROFILE['name'],'device_id':PROFILE['device_id']}), \
             patch.object(self.catalog,'resume_device'):
            result=self.client.post('/devices/validate',json={'device':PROFILE['name']}).get_json()
        self.profile.side_effect=ValueError('Could not verify this device.')
        self.catalog._integrate(result['catalog_job'],'test-key')
        history=self.client.get('/chats').get_json()
        self.assertEqual(history[0]['chat_id'],result['chat_id'])
        self.assertEqual(history[0]['preparation']['status'],'error')

    def test_device_verification_retries_transient_provider_overload(self):
        import httpx, json
        from openai import OpenAI
        calls=[]
        profile={**copy.deepcopy(PROFILE),'model_scope':'exact_model'}
        def respond(request):
            calls.append(request)
            if len(calls)==1:
                return httpx.Response(503,headers={'retry-after':'0.01'},json={'error':{'message':'Overloaded','type':'service_unavailable_error','code':'server_is_overloaded'}})
            return httpx.Response(200,json={'id':'response-test','object':'response','created_at':0,'model':'test-model',
                'output':[{'type':'message','id':'message-test','role':'assistant','status':'completed',
                           'content':[{'type':'output_text','text':json.dumps(profile),'annotations':[]}]}]})
        with httpx.Client(transport=httpx.MockTransport(respond)) as http:
            with patch.object(self.catalog,'OpenAI',side_effect=lambda **kwargs:OpenAI(**kwargs,http_client=http)):
                result=self.discover_profile(PROFILE['name'],'test-key')
        self.assertEqual(len(calls),2)
        self.assertEqual(result['name'],PROFILE['name'])

    def test_provider_overload_is_reported_instead_of_generic_interruption(self):
        import httpx
        from openai import InternalServerError
        key=self.queue()
        self.profile.side_effect=InternalServerError('Overloaded',response=httpx.Response(503,request=httpx.Request('POST','https://api.openai.com/v1/responses')),body={'code':'server_is_overloaded'})
        self.catalog._integrate(key,'test-key')
        result=self.catalog.job_status(key)
        self.assertEqual(result['status'],'failed')
        self.assertIn('HTTP 503',result['error'])
        self.assertIn('Saved progress is kept',result['error'])

    def test_protocol_submission_reuses_the_device_preparation_chat(self):
        with patch.object(self.server,'_deck_request_context',return_value=('test-key',None)), \
             patch.object(self.server,'dispatch_device',return_value={'name':PROFILE['name'],'device_id':PROFILE['device_id']}), \
             patch.object(self.catalog,'resume_device'):
            preparing=self.client.post('/devices/validate',json={'device':PROFILE['name']}).get_json()
            opened=self.client.post('/chat',json={'device':PROFILE['name'],'prepare_device':True})
        self.assertEqual(opened.status_code,201,opened.get_json())
        self.assertEqual(opened.get_json()['chat_id'],preparing['chat_id'])
        self.assertEqual(len(self.client.get('/chats').get_json()),1)
