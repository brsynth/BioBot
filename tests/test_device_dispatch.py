"""Family clarification preserves the query and never registers a series as one model."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'biobot'))

spec = importlib.util.spec_from_file_location('tested_device_dispatch', Path(__file__).resolve().parents[1] / 'biobot/engine.py')
engine = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    'openai': types.SimpleNamespace(OpenAI=Mock()),
    'config': types.SimpleNamespace(get_api_key=lambda: 'test-key'),
    'model_settings': types.SimpleNamespace(model_for=lambda _: 'test-model'),
    'questionnaire': types.SimpleNamespace(check_sufficient_info=Mock()),
}):
    spec.loader.exec_module(engine)


class DeviceDispatchTests(unittest.TestCase):
    def client(self, output):
        client = Mock()
        client.with_options.return_value = client
        client.responses.create.return_value.output_text = json.dumps(output)
        patcher = patch.object(engine, 'get_openai_client', return_value=client)
        patcher.start()
        self.addCleanup(patcher.stop)
        return client

    def test_family_query_does_not_expand_to_the_whole_manufacturer(self):
        self.client({'status': 'incomplete', 'scope': 'series', 'manufacturer': 'Maker'})
        with self.assertRaises(engine.DeviceIncomplete) as result:
            engine.dispatch_device('SeriesA', [], 'test-key')
        self.assertEqual(result.exception.query, 'SeriesA')
        self.assertEqual(result.exception.scope, 'series')

    def test_combined_protocol_and_device_preserve_the_models_intent_assessment(self):
        self.client({'status':'valid','scope':'model','manufacturer':'Maker','model':'Model 10',
                     'device_id':'maker_model10','name':'Maker Model 10',
                     'is_programmable_biology_device':True,'has_protocol_request':True})
        result = engine.dispatch_device('Dilute DNA on Maker Model 10', [], 'test-key')
        self.assertEqual(result['name'], 'Maker Model 10')
        self.assertTrue(result['has_protocol_request'])

    def test_manufacturer_alone_is_not_a_physical_model(self):
        self.client({'status': 'incomplete', 'manufacturer': 'Maker'})
        with self.assertRaises(engine.DeviceIncomplete) as result:
            engine.dispatch_device('Maker', [], 'test-key')
        self.assertEqual(result.exception.scope, 'manufacturer')

    def test_series_cannot_be_accepted_even_if_the_classifier_says_valid(self):
        self.client({'status': 'valid', 'scope': 'series', 'manufacturer': 'Maker',
                     'model': 'SeriesA', 'name': 'Maker SeriesA', 'device_id': 'maker_seriesa',
                     'is_programmable_biology_device': True})
        with self.assertRaises(engine.DeviceIncomplete):
            engine.dispatch_device('SeriesA', [], 'test-key')

    def test_local_clarification_offers_only_matching_physical_models_and_deduplicates_aliases(self):
        known = [{'device_id': 'a10', 'name': 'Maker SeriesA 10'},
                 {'device_id': 'a20', 'name': 'Earlier Maker SeriesA 20'},
                 {'device_id': 'a20', 'name': 'Maker SeriesA 20'},
                 {'device_id': 'b10', 'name': 'Maker SeriesB 10'}]
        options = engine.matching_device_models('SeriesA', known)
        self.assertEqual(len(options), 2)
        self.assertTrue(all('SeriesA' in name for name in options))

    def test_online_choices_require_exact_model_scope_and_a_source(self):
        model = {'name': 'Maker SeriesA 10', 'scope': 'model', 'source': 'https://manufacturer.example/seriesa/10'}
        client = self.client({'models': [model, model, {'name': 'Maker SeriesA', 'scope': 'series', 'source': model['source']},
                                        {'name': 'Unsourced model', 'scope': 'model'}, 'Legacy unsourced name']})
        self.assertEqual(engine.list_device_models('SeriesA', 'test-key'), ['Maker SeriesA 10'])
        self.assertEqual(client.responses.create.call_args.kwargs['input'][-1]['content'], 'SeriesA')

    def test_description_requests_matching_models_instead_of_selecting_or_rejecting_a_device(self):
        self.client({'status':'incomplete','scope':'description','is_programmable_biology_device':True})
        with self.assertRaises(engine.DeviceIncomplete) as result:
            engine.dispatch_device('plate reader', [], 'test-key')
        self.assertEqual(result.exception.scope, 'description')
        self.assertEqual(result.exception.query, 'plate reader')

    def test_descriptive_discovery_searches_functions_across_manufacturers(self):
        client=self.client({'models':[{'name':'Maker A10','scope':'model','source':'https://maker.example/manual'},
                                     {'name':'Other B20','scope':'model','source':'https://other.example/manual'}]})
        self.assertEqual(engine.list_device_models('plate reader','test-key',scope='description'),['Maker A10','Other B20'])
        prompt=client.responses.create.call_args.kwargs['input'][0]['content']
        self.assertIn('across manufacturers',prompt)
        self.assertIn('own functions',prompt)
