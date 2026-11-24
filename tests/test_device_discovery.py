"""Device-neutral workspace discovery, local evidence and generic operations."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "biobot"))

from test_deck_library import library
from test_question_validation import engine
import protocol_lang as lang

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('discovered_visualizer', ROOT / 'biobot/deck_visualizer.py')
visualizer = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    'config': types.SimpleNamespace(get_api_key=lambda: 'key', biobot_model='test', light_functions_model='light'),
    'openai': types.SimpleNamespace(OpenAI=Mock()),
}):
    spec.loader.exec_module(visualizer)


def workspace():
    return {'platform': 'Maker Model7', 'layout_type': 'spatial',
            'workspace': {'width': 100, 'height': 80, 'shape': 'ellipse', 'view': 'top', 'label': 'Documented physical context'},
            'positions': [{'id': 'sample', 'x': 12.5, 'y': 20, 'width': 10, 'height': 15, 'shape': 'ellipse'}],
            'sources': [{'claim': 'relative proportions', 'source': 'manual.txt (page 3)'}]}


class DiscoveryTests(unittest.TestCase):
    def test_non_liquid_programmable_device_is_accepted(self):
        client = Mock()
        client.with_options.return_value = client
        client.responses.create.return_value.output_text = json.dumps({
            'status': 'valid', 'is_programmable_biology_device': True, 'is_liquid_handler': False,
            'device_id': 'maker_model7', 'name': 'Maker Model7', 'manufacturer': 'Maker', 'model': 'Model7'})
        with patch.object(engine, 'get_openai_client', return_value=client):
            self.assertEqual(engine.dispatch_device('Maker Model7', [], 'key')['device_id'], 'maker_model7')

    def test_spatial_geometry_survives_cleaning_and_protocol_overlay(self):
        state = library.clean_layout(workspace())
        composed = library.compose_state(state, {'positions': [{'id': 'sample', 'labware': 'holder'}], 'steps': []})
        self.assertEqual(composed['workspace']['label'], 'Documented physical context')
        self.assertEqual(composed['positions'][0]['x'], 12.5)
        self.assertEqual(composed['positions'][0]['shape'], 'ellipse')
        self.assertEqual(composed['positions'][0]['labware'], 'holder')
        self.assertNotIn('labware', state['positions'][0])

    def test_geometry_rejects_invalid_or_outside_positions(self):
        for key, value in [('x', -1), ('x', float('nan')), ('width', float('inf')), ('height', 0), ('x', 95), ('shape', 'untrusted')]:
            state = workspace()
            state['positions'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                library.clean_layout(state)

    def test_local_evidence_prevents_web_search(self):
        client = Mock()
        client.responses.create.return_value.output_text = json.dumps(workspace())
        with patch.object(visualizer, 'OpenAI', return_value=client), \
             patch.object(visualizer, 'local_layout_documentation', return_value='manual.txt: physical geometry'):
            self.assertEqual(visualizer.generate_device_layout('Maker Model7', 'key')['layout_type'], 'spatial')
        self.assertEqual(client.responses.create.call_count, 1)
        self.assertNotIn('tools', client.responses.create.call_args.kwargs)

    def test_insufficient_local_evidence_falls_back_to_web(self):
        client = Mock()
        client.responses.create.side_effect = [types.SimpleNamespace(output_text='{"needs_online":true}'),
                                               types.SimpleNamespace(output_text=json.dumps(workspace()))]
        with patch.object(visualizer, 'OpenAI', return_value=client), \
             patch.object(visualizer, 'local_layout_documentation', return_value='No physical layout in this API manual.'):
            visualizer.generate_device_layout('Maker Model7', 'key')
        self.assertEqual(client.responses.create.call_count, 2)
        self.assertEqual(client.responses.create.call_args.kwargs['tools'], [{'type': 'web_search'}])

    def test_no_local_evidence_searches_online_directly(self):
        client = Mock()
        client.responses.create.return_value.output_text = json.dumps(workspace())
        with patch.object(visualizer, 'OpenAI', return_value=client), \
             patch.object(visualizer, 'local_layout_documentation', return_value=''):
            visualizer.generate_device_layout('Maker Model7', 'key')
        self.assertEqual(client.responses.create.call_count, 1)
        self.assertIn('tools', client.responses.create.call_args.kwargs)

    def test_local_document_reader_excludes_protocol_feedback(self):
        import doc_loader
        with tempfile.TemporaryDirectory() as directory:
            docs = Path(directory)
            (docs / 'manual.txt').write_text('Public physical dimensions')
            for name in ('codes', 'failed_codes'):
                (docs / name).mkdir()
                (docs / name / 'private.txt').write_text('Private experiment details')
            chunks, _ = doc_loader.load_and_chunk_docs(str(docs), exclude_dirs=('codes', 'failed_codes'))
        self.assertIn('Public physical dimensions', '\n'.join(chunks))
        self.assertNotIn('Private experiment', '\n'.join(chunks))

    def test_generic_operation_settings_and_constraints_without_liquid_handling(self):
        protocol = {'parameters': {'exposure_ms': 25}, 'program': [
            {'device_op': {'name': 'acquire', 'parameters': {'exposure_ms': '{exposure_ms}', 'mode': 'brightfield'}}}],
            'constraints': [{'applies_to': 'device_op', 'rule': 'exposure_ms <= 100', 'message': 'Exposure exceeds limit'}]}
        result = lang.expand(protocol)
        self.assertEqual(result['steps'][0]['parameters'], {'exposure_ms': 25, 'mode': 'brightfield'})
        self.assertEqual(result['initial_wells'], [])
        protocol['parameters']['exposure_ms'] = 101
        with self.assertRaisesRegex(lang.ProtocolError, 'Exposure exceeds limit'):
            lang.expand(protocol)

    def test_generic_operation_resolves_target_and_rejects_unknown_instrument(self):
        protocol = {'labware': [{'id': 'vessel', 'position': 'sample'}], 'program': [
            {'device_op': {'name': 'read', 'at': 'vessel'}}]}
        self.assertEqual(lang.expand(protocol)['steps'][0]['source'], {'slot': 'sample', 'wells': []})
        protocol['program'][0]['device_op']['with'] = 'missing'
        with self.assertRaisesRegex(lang.ProtocolError, 'Unknown instrument'):
            lang.expand(protocol)

    def test_export_comparison_detects_missing_or_changed_non_liquid_operations(self):
        desired = {'program': [{'device_op': {'name': 'acquire', 'parameters': {'exposure_ms': 25}}}]}
        self.assertEqual(lang.execution_difference(desired, desired), '')
        self.assertIn('instrument operations', lang.execution_difference({'program': []}, desired))
        changed = {'program': [{'device_op': {'name': 'acquire', 'parameters': {'exposure_ms': 50}}}]}
        self.assertIn('settings', lang.execution_difference(changed, desired))
        reordered = {'program': [{'wait': {'minutes': 1}}, *desired['program']]}
        self.assertIn('execution order', lang.execution_difference(reordered, desired))
