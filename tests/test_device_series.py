"""Compatible series are learned navigation metadata, never physical device aliases."""
from datetime import datetime, timedelta, timezone
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'biobot'))

spec = importlib.util.spec_from_file_location('tested_device_series', Path(__file__).resolve().parents[1] / 'biobot/device_series.py')
series = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'openai': types.SimpleNamespace(OpenAI=Mock()),
                              'model_settings': types.SimpleNamespace(model_for=lambda _: 'test-model')}):
    spec.loader.exec_module(series)

GROUP = {'kind': 'series', 'name': 'Maker A Series', 'same_programming_interface': True,
         'programming_interface': 'Maker API v2, backwards compatible with v1', 'protocol_format': 'Documented transfer schema',
         'sources': [{'url': 'https://manufacturer.example/compatibility', 'claim': 'Same command API and protocol schema'}],
         'members': [{'kind': 'model', 'name': 'Maker A10', 'source': 'https://manufacturer.example/a10'},
                     {'kind': 'model', 'name': 'Maker A10T', 'source': 'https://manufacturer.example/a10t'},
                     {'kind': 'model', 'name': 'Maker A10T Plus', 'source': 'https://manufacturer.example/a10t-plus'}]}


class DeviceSeriesTests(unittest.TestCase):
    def test_shared_programming_series_collapses_choices_but_keeps_exact_variants(self):
        choices = series.clean_choices([GROUP], ['Maker A10', 'Maker B20'])
        self.assertEqual([item['name'] for item in choices], ['Maker A Series', 'Maker B20'])
        self.assertEqual([item['name'] for item in choices[0]['members']], ['Maker A10', 'Maker A10T', 'Maker A10T Plus'])
        self.assertEqual(choices[1]['kind'], 'model')
        self.assertEqual(series.clean_choices([GROUP['members'][0], GROUP], ['Maker A10'])[0]['kind'], 'series')
        self.assertEqual(len(series.clean_choices([GROUP['members'][0], GROUP], ['Maker A10'])), 1)

    def test_file_extension_or_similar_names_cannot_establish_series_equivalence(self):
        for field, value in [('same_programming_interface', False), ('sources', []), ('protocol_format', ''),
                             ('members', [GROUP['members'][0]])]:
            group = copy.deepcopy(GROUP)
            group[field] = value
            choices = series.clean_choices([group], ['Maker A10'])
            self.assertEqual(choices, [{'kind': 'model', 'name': 'Maker A10', 'registered': True}])

    def test_discovery_persists_evidence_and_reuses_it_without_another_api_call(self):
        client = Mock()
        client.responses.create.return_value.output_text = json.dumps({'choices': [GROUP]})
        with tempfile.TemporaryDirectory() as directory, patch.object(series, 'CACHE_PATH', Path(directory) / 'series.json'), \
             patch.object(series, 'OpenAI', return_value=client), \
             patch.dict(sys.modules, {'deck_visualizer': types.SimpleNamespace(_clean_llm_json=lambda value: value)}):
            first = series.series_choices('Maker A', ['Maker A10'], 'test-key')
            second = series.series_choices('Maker A', ['Maker A10', 'New saved model'], 'test-key')
            self.assertEqual(first[0]['name'], 'Maker A Series')
            self.assertEqual(first[0]['sources'], GROUP['sources'])
            self.assertEqual(second[-1]['name'], 'New saved model')
            self.assertTrue(series.CACHE_PATH.exists())
        client.responses.create.assert_called_once()

    def test_known_family_shows_its_series_and_other_saved_models_not_unrelated_online_models(self):
        choices = series.clean_choices([GROUP, {'kind': 'model', 'name': 'Maker Old Model',
                                                'source': 'https://manufacturer.example/old'}], ['Maker A10', 'Maker B20'])
        visible = series._visible_choices(choices, ['Maker A10', 'Maker B20'])
        self.assertEqual([choice['name'] for choice in visible], ['Maker A Series', 'Maker B20'])
        self.assertEqual(len(visible[0]['members']), 3)
        self.assertEqual(series._visible_choices(choices, []), choices)

    def test_enter_expands_every_member_and_deduplicates_physical_models(self):
        self.assertEqual(series.model_names([GROUP, GROUP['members'][0], {'kind':'model','name':'Maker B20'}]),
                         ['Maker A10', 'Maker A10T', 'Maker A10T Plus', 'Maker B20'])

    def test_autocomplete_uses_only_fresh_cached_series_anchored_to_saved_devices(self):
        rows = [{'name':'Maker A10','key':'a','status':'ready','search_terms':['Microplate reader','absorbance']}, {'name':'Maker B20','key':'b','status':'local'}]
        entry = {'checked_at':datetime.now(timezone.utc).isoformat(), 'choices':[GROUP]}
        with patch.object(series, '_read', return_value={'query':entry}), patch.object(series, 'OpenAI') as client:
            suggestions = series.suggestion_choices(rows)
            self.assertEqual([item['name'] for item in suggestions], ['Maker A Series', 'Maker B20'])
            self.assertEqual(len(suggestions[0]['members']), 3)
            self.assertIn('Microplate reader',suggestions[0]['search_terms'])
            self.assertEqual(series.suggestion_choices([]), [])
            self.assertEqual(series.suggestion_choices(rows[1:]), rows[1:])
            entry['checked_at'] = (datetime.now(timezone.utc)-timedelta(days=8)).isoformat()
            self.assertEqual(series.suggestion_choices(rows), rows)
            client.assert_not_called()
