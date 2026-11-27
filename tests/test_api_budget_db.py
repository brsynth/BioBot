"""Real PostgreSQL allowance tests; all provider calls are fakes, never billable."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import os
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_catalog_admin_db as fixtures


@unittest.skipUnless(os.environ.get('BIOBOT_TEST_DB') == '1', 'requires isolated PostgreSQL')
class ApiBudgetTests(unittest.TestCase):
    connection = fixtures.CatalogAdminTests.connection
    drop_schema = fixtures.CatalogAdminTests.drop_schema
    login = fixtures.CatalogAdminTests.login

    def setUp(self):
        fixtures.CatalogAdminTests.setUp(self)
        import api_budget, model_settings
        self.budget, self.models = api_budget, model_settings
        p = patch.object(model_settings, 'get_db_connection', side_effect=self.connection)
        p.start(); self.addCleanup(p.stop)
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            model_settings._write(cursor, 'openai_catalog', {'models': [
                {'id': 'test-model', 'input': 2, 'cached_input': 0.1, 'output': 10}]})
        conn.close()

    def total(self, user=1):
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute('SELECT COALESCE(SUM(amount),0) FROM api_usage WHERE user_id=%s', (user,))
            result = cursor.fetchone()[0]
        conn.close()
        return result

    def reserve(self, user=1, **extra):
        return self.budget._reserve(user, 'test-model', {'input': 'hello', 'max_output_tokens': 40000, **extra}, False)

    def set_limit(self, value, user=1):
        self.admin.edit_user(user, {'daily_api_limit': value}, 1, lambda email: False)

    def test_admin_limit_default_zero_unlimited_and_authorization(self):
        self.assertEqual(self.client.get('/admin/users').json[0]['daily_api_limit'], 0.5)
        self.assertEqual(self.client.patch('/admin/users/2', json={'daily_api_limit': 1}).status_code, 403)
        for amount in [0, 0.75, None]:
            result = self.client.patch('/admin/users/2', headers=self.headers, json={'daily_api_limit': amount})
            self.assertEqual(result.status_code, 200)
            users = self.client.get('/admin/users').json
            self.assertEqual(users[1]['daily_api_limit'], amount)
            self.assertEqual(users[0]['daily_api_limit'], 0.5)
        for amount in [-1, 'NaN', 'Infinity', True, '', 0.0000001, 1000001]:
            self.assertEqual(self.client.patch('/admin/users/2', headers=self.headers,
                                             json={'daily_api_limit': amount}).status_code, 400)
        self.login(2)
        self.assertEqual(self.client.patch('/admin/users/1', headers=self.headers,
                                         json={'daily_api_limit': None}).status_code, 403)

    def test_new_device_and_documentation_setup_bypass_zero_daily_allowance(self):
        import documentation_index as docs
        self.set_limit(0)
        provider=Mock(return_value=NS(usage=NS(input_tokens=100,output_tokens=50),output=[]))
        resource=self.budget._Resource(NS(create=provider),1)
        def setup_call(value):
            resource.create(model='test-model',input='shared device knowledge')
            return value
        self.profile.side_effect=lambda *args:setup_call(fixtures.PROFILE.copy())
        self.geometry.side_effect=lambda *args,**kwargs:setup_call(fixtures.LAYOUT.copy())
        token=self.budget.set_user(1)
        try:
            with patch.object(self.catalog,'resume_device'):
                job=self.catalog.request_device('Maker Model7','test-only')
            self.catalog._integrate(job['catalog_job'],'test-only')
            self.assertEqual(self.catalog.job_status(job['catalog_job'])['status'],'ready')
            handler={'name':'Maker Model7','docs_path':'docs/new-device','store_path':'index.pkl'}
            def fetch(name,keywords,path,key):
                setup_call(True)
                Path(path).mkdir(parents=True,exist_ok=True)
                (Path(path)/'manual.txt').write_text('Public documentation')
                return True
            with patch.object(docs,'SCRIPT_DIR',self.runtime), \
                 patch('handlers.load_handlers_config',return_value={'maker_model7':handler}), \
                 patch.object(docs,'fetch_documentation',side_effect=fetch), \
                 patch.object(docs,'load_and_chunk_docs',return_value=(['New manual passage'],['manual.txt'])), \
                 patch.object(docs,'get_text_embedding_with_retry',side_effect=lambda *args:setup_call([0.1,0.2])):
                self.assertTrue(docs.preload_documentation('Maker Model7','test-only',check_updates=False).result(timeout=5))
            self.assertEqual(provider.call_count,4)
            self.assertEqual(self.total(),0)
            with self.assertRaises(self.budget.BudgetError):
                resource.create(model='test-model',input='Design a protocol')
            self.assertEqual(provider.call_count,4)
        finally:
            self.budget.reset_user(token)

    def test_shared_setup_overrides_subprocess_identity_and_restores_metering(self):
        with patch.dict(os.environ,{'BIOBOT_USAGE_USER':'1','BIOBOT_USAGE_KEY_HASH':self.budget._hash('shared-key')}):
            self.assertEqual(self.budget.funded_user('shared-key'),1)
            with self.assertRaisesRegex(RuntimeError,'setup interrupted'):
                with self.budget.shared_setup():
                    self.assertIsNone(self.budget.funded_user('shared-key'))
                    env=dict(os.environ);self.budget.subprocess_context(env,'shared-key')
                    self.assertNotIn('BIOBOT_USAGE_USER',env)
                    raise RuntimeError('setup interrupted')
            self.assertEqual(self.budget.funded_user('shared-key'),1)

    def test_recharge_adds_credit_only_for_selected_user_without_changing_daily_limit(self):
        url='/admin/users/2/recharge'
        self.assertEqual(self.client.post(url,json={'amount':0.75}).status_code,403)
        self.login(2)
        self.assertEqual(self.client.post(url,json={'amount':0.75},headers=self.headers).status_code,403)
        self.login(1)
        response=self.client.post(url,json={'amount':0.75},headers=self.headers)
        self.assertEqual(response.status_code,200,response.json)
        users=self.client.get('/admin/users').json
        self.assertEqual(users[0]['daily_api_credit'],0)
        self.assertEqual(users[1]['daily_api_credit'],0.75)
        self.assertEqual(users[1]['daily_api_limit'],0.5)
        self.assertEqual(self.total(2),0)
        self.assertEqual(self.client.post(url,json={'amount':0.25},headers=self.headers).status_code,200)
        self.assertEqual(self.client.get('/admin/users').json[1]['daily_api_credit'],1)
        with self.connection() as conn,conn.cursor() as cursor:
            cursor.execute("SELECT actor_id FROM admin_audit WHERE action='recharge_quota'")
            self.assertEqual(cursor.fetchall(),[(1,),(1,)])

    def test_recharge_restores_exhausted_allowance_and_expires_the_next_day(self):
        import uuid
        with self.connection() as conn,conn.cursor() as cursor:
            cursor.execute("INSERT INTO api_usage(id,user_id,day,model,amount,reserved) VALUES(%s,1,(NOW() AT TIME ZONE 'UTC')::date,'test-model',0.5,FALSE)",(str(uuid.uuid4()),))
        with self.assertRaises(self.budget.BudgetError):self.reserve()
        self.admin.recharge_quota(1,0.5,1)
        self.assertIsNotNone(self.reserve())
        self.assertGreater(self.total(),Decimal('0.5'))
        self.set_limit(0)
        with self.connection() as conn,conn.cursor() as cursor:
            cursor.execute('UPDATE api_quota_recharges SET day=day-1')
        self.assertEqual(self.client.get('/admin/users').json[0]['daily_api_credit'],0)
        with self.assertRaises(self.budget.BudgetError):self.reserve()

    def test_recharge_rejects_invalid_amounts_and_unknown_users(self):
        for value in (0,-1,None,True,'NaN','Infinity','',1000001,0.0000001):
            response=self.client.post('/admin/users/1/recharge',json={'amount':value},headers=self.headers)
            self.assertEqual(response.status_code,400,(value,response.json))
        self.assertEqual(self.client.post('/admin/users/999/recharge',json={'amount':1},headers=self.headers).status_code,400)
        self.assertEqual(self.client.get('/admin/users').json[0]['daily_api_credit'],0)

    def test_zero_stops_calls_and_unlimited_allows_them(self):
        self.set_limit(0)
        resource = Mock()
        wrapped = self.budget._Resource(resource, 1)
        with self.assertRaisesRegex(self.budget.BudgetError, 'disabled'):
            wrapped.create(model='test-model', input='hello')
        resource.create.assert_not_called()
        self.set_limit(None)
        self.assertIsNotNone(self.reserve(max_output_tokens=1000000))
        self.assertGreater(self.total(), Decimal('0.5'))

    def test_concurrent_reservations_share_one_daily_balance(self):
        self.set_limit(0.1)
        def request(_):
            try:
                return self.reserve(max_output_tokens=8000) is not None
            except self.budget.BudgetError:
                return False
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(request, range(6)))
        self.assertTrue(any(results))
        self.assertFalse(all(results))
        self.assertLessEqual(self.total(), Decimal('0.1'))
        self.assertIsNotNone(self.reserve(user=2, max_output_tokens=8000))

    def test_actual_cached_tokens_searches_and_embeddings_are_accounted_once(self):
        reservation = self.reserve(tools=[{'type': 'web_search'}])
        response = NS(usage=NS(input_tokens=1000, output_tokens=500,
                              input_tokens_details=NS(cached_tokens=400)), output=[NS(type='web_search_call')])
        self.budget._settle(reservation, response)
        self.budget._settle(reservation, response)
        self.assertEqual(self.total(), Decimal('0.01624'))
        r = self.budget._reserve(1, 'text-embedding-3-small', {'input': 'hello'}, True)
        self.budget._settle(r, NS(usage=NS(total_tokens=1000)))
        self.assertEqual(self.total(), Decimal('0.01626'))

    def test_unreported_usage_stays_reserved_and_explicit_rejection_refunds(self):
        r = self.reserve()
        before = self.total()
        self.budget._settle(r, NS())
        self.assertEqual(self.total(), before)
        self.budget._settle(r, failed=True)
        self.assertEqual(self.total(), 0)

    def test_new_day_resets_without_erasing_history_or_admin_changes(self):
        self.reserve()
        before = self.total()
        self.set_limit(0.1)
        with self.assertRaises(self.budget.BudgetError):
            self.reserve()
        self.assertEqual(self.total(), before)
        conn = self.connection()
        with conn, conn.cursor() as cursor:
            cursor.execute("UPDATE api_usage SET day=day-1")
        conn.close()
        self.assertIsNotNone(self.reserve())

    def test_unknown_prices_fail_closed_only_for_finite_allowance(self):
        with self.assertRaisesRegex(self.budget.BudgetError, 'published price'):
            self.budget._reserve(1, 'unknown-model', {'input': 'hello'}, False)
        self.set_limit(None)
        self.assertIsNone(self.budget._reserve(1, 'unknown-model', {'input': 'hello'}, False))

    def test_identity_follows_background_and_subprocess_only_for_shared_key(self):
        from background_jobs import BackgroundExecutor
        with patch.object(self.config, 'get_api_key', return_value='shared-key'):
            token = self.budget.set_user(1)
            try:
                self.assertEqual(self.budget.funded_user('shared-key'), 1)
                self.assertIsNone(self.budget.funded_user('personal-key'))
                env = {'BIOBOT_USAGE_USER': 'wrong', 'BIOBOT_USAGE_KEY_HASH': 'wrong'}
                self.budget.subprocess_context(env, 'shared-key')
                pool = BackgroundExecutor(1, 'budget-test')
                try:
                    self.assertEqual(pool.submit(self.budget.funded_user, 'shared-key').result(3), 1)
                finally:
                    pool.shutdown()
                self.budget.subprocess_context(env, 'personal-key')
                self.assertNotIn('BIOBOT_USAGE_USER', env)
                self.budget.subprocess_context(env, 'shared-key')
            finally:
                self.budget.reset_user(token)
            with patch.dict(os.environ, env):
                self.assertEqual(self.budget.funded_user('shared-key'), 1)
                self.assertIsNone(self.budget.funded_user('personal-key'))

    def test_account_settings_hide_legacy_shared_key_but_keep_personal_key(self):
        for key, expected in [('test-only', ''), ('personal-test-key', 'personal-test-key')]:
            conn = self.connection()
            with conn, conn.cursor() as cursor:
                cursor.execute('UPDATE users SET api_key=%s WHERE id=1', (key,))
            conn.close()
            response = self.client.get('/user/profile')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['api_key'], expected)

    def test_sdk_options_keep_metering_and_personal_keys_are_exempt(self):
        client = Mock()
        client.with_options.return_value = client
        with patch.object(self.config, 'get_api_key', return_value='shared-key'):
            constructor = self.budget.metered_openai(Mock(return_value=client))
            token = self.budget.set_user(1)
            try:
                wrapped = constructor(api_key='shared-key')
                self.assertIsInstance(wrapped.with_options(timeout=10).responses, self.budget._Resource)
                self.assertIs(constructor(api_key='personal-key'), client)
                self.set_limit(0)
                with self.assertRaises(self.budget.BudgetError):
                    wrapped.with_options(timeout=10).responses.create(model='test-model', input='hello')
                client.responses.create.assert_not_called()
            finally:
                self.budget.reset_user(token)

    def test_stream_settles_completion_and_retains_interrupted_reservation(self):
        response = NS(usage=NS(input_tokens=1000, output_tokens=500), output=[])
        class Stream:
            def __init__(self, events): self.events = events; self.closed = False
            def __iter__(self): return iter(self.events)
            def close(self): self.closed = True
        for complete in (True, False):
            stream = Stream([NS(type='response.completed', response=response)] if complete else [NS(type='response.output_text.delta')])
            resource = self.budget._Resource(NS(create=Mock(return_value=stream)), 1)
            list(resource.create(model='test-model', input='hello', stream=True))
            self.assertTrue(stream.closed)
        self.assertGreater(self.total(), Decimal('0.007'))


if __name__ == '__main__':
    unittest.main()
