"""Offline checks for shared geometry and private protocol contents."""
import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("tested_deck_library", Path(__file__).resolve().parents[1] / "biobot/deck_library.py")
library = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "config": types.SimpleNamespace(get_db_connection=Mock()),
    "deck_visualizer": types.SimpleNamespace(identify_device=Mock(), generate_device_layout=Mock(), bind_protocol=Mock()),
    "psycopg2.extras": types.SimpleNamespace(Json=lambda value: value, RealDictCursor=object),
}):
    spec.loader.exec_module(library)


def layout():
    return {"platform": "Robot XYZ", "layout_type": "grid", "grid": {"rows": 1, "cols": 2},
            "positions": [{"id": "source", "row": 0, "col": 0, "labware": None},
                          {"id": "destination", "row": 0, "col": 1, "labware": None}]}


class DeckGeometryTests(unittest.TestCase):
    def test_configurability_survives_layout_storage_and_protocol_composition(self):
        state = layout()
        state['positions'][0].update(fixed=True, configurable=True)
        state['positions'][1].update(fixed=True, configurable=False)
        state['instruments'] = [{'name':'Internal mechanism','fixed':True,'configurable':False}]
        saved = library.clean_layout(state)
        composed = library.compose_state(saved, {})
        self.assertTrue(composed['positions'][0]['configurable'])
        self.assertFalse(composed['positions'][1]['configurable'])
        self.assertFalse(composed['instruments'][0]['configurable'])
        state['positions'][0]['configurable'] = 'yes'
        with self.assertRaises(ValueError):
            library.clean_layout(state)

    def test_catalog_refresh_keeps_existing_options_and_enriches_matching_items(self):
        previous = {"categories": [{"name": "Plates", "items": [
            {"id": "a", "name": "Plate A", "well_count": 96},
            {"id": "b", "name": "Plate B"},
        ]}]}
        updated = {"categories": [{"name": "plates", "items": [
            {"id": "a", "name": "Plate A", "well_rows": 8, "well_columns": 12},
            {"id": "c", "name": "Plate C"},
        ]}, {"name": "Modules", "items": [{"id": "d", "name": "Module D"}]}]}
        merged = library.merge_catalogs(previous, updated)
        items = merged["categories"][0]["items"]
        self.assertEqual([item["id"] for item in items], ["a", "b", "c"])
        self.assertEqual(items[0]["well_count"], 96)
        self.assertEqual(items[0]["well_rows"], 8)
        self.assertEqual(merged["categories"][1]["items"][0]["id"], "d")
        self.assertNotIn("well_rows", previous["categories"][0]["items"][0])

    def test_hardware_schematic_survives_saved_layout_and_protocol_overlay(self):
        state = layout()
        visual = {"parts": [{"shape": "rect", "x": 10, "y": 10, "width": 80, "height": 80, "tone": "body"}]}
        state["positions"][0].update(labware="hardware_api", type="module", visual=visual)
        saved = library.clean_layout(state)
        composed = library.compose_state(saved, {})
        self.assertEqual(composed["positions"][0]["visual"], visual)
        state["positions"][0]["visual"]["parts"].clear()
        self.assertEqual(len(saved["positions"][0]["visual"]["parts"]), 1)

    def test_well_contents_remain_private_and_geometry_comes_from_loaded_labware(self):
        binding = {"initial_wells": [{"slot": "source", "well": "A1", "volume_ul": 10}],
                   "positions": [{"id": "source", "labware": "custom_plate", "type": "plate",
                                  "well_count": 48, "well_rows": 6, "well_columns": 8}],
                   "steps": [{"well_updates": [{"slot": "source", "well": "A1", "volume_ul": 0}]}]}
        state = library.compose_state(library.clean_layout(layout()), binding)
        self.assertEqual(state["positions"][0]["well_count"], 48)
        self.assertEqual(state["initial_wells"], binding["initial_wells"])
        self.assertEqual(state["steps"], binding["steps"])
        shared = library.clean_layout(state)
        self.assertNotIn("initial_wells", shared)
        self.assertNotIn("steps", shared)
        self.assertEqual(shared["positions"][0]["well_count"], 48)
        state["initial_wells"][0]["volume_ul"] = 0
        self.assertEqual(binding["initial_wells"][0]["volume_ul"], 10)

    def test_device_mount_identifiers_are_learned_data_and_persist_in_library_copies(self):
        state = layout()
        state["mounts"] = ["station_1", "station_2", "station_3", "station_1"]
        shared = library.clean_layout(state)
        self.assertEqual(shared["mounts"], ["station_1", "station_2", "station_3"])
        self.assertEqual(library.compose_state(shared, {})["mounts"], shared["mounts"])
        for mounts in ("station_1", [None], [""]):
            state["mounts"] = mounts
            with self.assertRaises(ValueError):
                library.clean_layout(state)

    def test_library_layout_strips_code_steps_sample_data_and_variables(self):
        state = layout()
        state.update({"_protocol_code": "private code", "steps": [{"volume": "secret"}], "title": "private title",
                      "parameters": [{"id": "sample", "label": "Sample amount", "value": "private quantity"}],
                      "plates": {"source": {"name": "sample identity", "type": "plate", "wells_used": ["A1"], "format": 96}}})
        state["positions"][0]["variable"] = "private_variable"
        saved = library.clean_layout(state)
        self.assertNotIn("_protocol_code", saved)
        self.assertNotIn("steps", saved)
        self.assertNotIn("title", saved)
        self.assertNotIn("parameters", saved)
        self.assertNotIn("variable", saved["positions"][0])
        self.assertNotIn("wells_used", saved["plates"]["source"])
        self.assertEqual(saved["plates"]["source"]["name"], "Source plate")
        self.assertEqual(saved["grid"]["labels"], ["source", "destination"])

    def test_protocol_binding_cannot_change_device_geometry(self):
        base = library.clean_layout(layout())
        before = copy.deepcopy(base)
        state = library.compose_state(base, {"grid": {"rows": 100}, "positions": [
            {"id": "source", "row": 20, "labware": "plate", "variable": "source_plate"}],
            "steps": [{"volume": "10 uL"}]})
        self.assertEqual(state["grid"], base["grid"])
        self.assertEqual(state["positions"][0]["row"], 0)
        self.assertEqual(state["positions"][0]["labware"], "plate")
        self.assertEqual(base, before)
        self.assertEqual(state["steps"], [{"volume": "10 uL"}])

    def test_incompatible_template_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no position"):
            library.compose_state(layout(), {"positions": [{"id": "missing", "labware": "plate"}]})

    def test_grid_coordinates_must_be_unique_and_within_bounds(self):
        for row, col in [(0, 0), (3, 1)]:
            state = layout()
            state["positions"][1].update(row=row, col=col)
            with self.assertRaises(ValueError):
                library.clean_layout(state)

    def test_shared_layout_rejects_markup_and_malformed_hardware(self):
        for value in ('<img src=x onerror=alert(1)>', 'plate" onmouseover="alert(1)', {"unexpected": "object"}):
            state = layout()
            state["positions"][0]["labware"] = value
            with self.assertRaises(ValueError):
                library.clean_layout(state)

    def test_workspace_description_accepts_quotes_ampersands_and_paragraph_length(self):
        description = 'Operator’s "loading & processing" area.\n' + 'Documented loading interfaces. ' * 25
        state = {'platform':'Device','layout_type':'spatial',
                 'workspace':{'width':100,'height':80,'label':description},'positions':[]}
        saved = library.clean_layout(state)
        self.assertEqual(saved['workspace']['label'], ' '.join(description.split()))
        self.assertGreater(len(saved['workspace']['label']),500)
        self.assertEqual(state['workspace']['label'],description)

    def test_workspace_description_rejects_markup_controls_and_excessive_length(self):
        for description in ('<script>alert(1)</script>','Hidden\x00text','x'*2001):
            state = {'platform':'Device','layout_type':'spatial',
                     'workspace':{'width':100,'height':80,'label':description},'positions':[]}
            with self.subTest(description=description[:30]):
                with self.assertRaisesRegex(ValueError,'Workspace description'):
                    library.clean_layout(state)

    def test_layout_sources_keep_urls_and_quoted_excerpts(self):
        state = {**layout(), "sources": [{"claim": 'deck has "54 tracks"\nper manual', "source": "https://x.org/a?b=1&c=<2>"}]}
        source = library.clean_layout(state)["sources"][0]
        self.assertEqual(source, {"claim": 'deck has "54 tracks" per manual', "source": "https://x.org/a?b=1&c= 2 "})

    def test_plate_format_cannot_allocate_unbounded_cells(self):
        state = {"platform": "Device", "layout_type": "plates", "plates": {"source": {"format": 100000000}}}
        with self.assertRaises(ValueError):
            library.clean_layout(state)

    def test_cached_plate_descriptions_are_normalized_without_regeneration(self):
        for count, expected in (("384-well", 384), ("96", 96), (None, None), (100000000, None)):
            state = library.compose_state(layout(), {"plates": {"source": {"format": count}}})
            self.assertEqual(state["plates"]["source"]["format"], expected)


class TransferPhysicsTests(unittest.TestCase):
    def test_physics_comes_from_documented_capability_and_quantum_not_model_name(self):
        profile={'features':['Acoustic Droplet Ejection'],'constraints':[{'name':'Drop transfer resolution','unit':'nL','multiple_of':2.5,'source':'manufacturer manual'}]}
        self.assertEqual(library.transfer_physics(profile),{'mechanism':'acoustic_droplets','droplet_volume_nl':2.5})
        profile['constraints'][0]['multiple_of']=25
        self.assertEqual(library.transfer_physics(profile)['droplet_volume_nl'],25)
        profile['features']=['Pipetting']
        self.assertIsNone(library.transfer_physics(profile))

    def test_unknown_or_conflicting_droplet_sizes_are_not_invented(self):
        profile={'features':['acoustic droplet ejection'],'constraints':[]}
        self.assertNotIn('droplet_volume_nl',library.transfer_physics(profile))
        profile['constraints']=[{'name':'Drop resolution','multiple_of':2.5,'unit':'nL'}]
        self.assertNotIn('droplet_volume_nl',library.transfer_physics(profile))
        profile['constraints'][0]['source']='manual'
        profile['constraints'].append({**profile['constraints'][0],'multiple_of':25})
        self.assertNotIn('droplet_volume_nl',library.transfer_physics(profile))


if __name__ == "__main__":
    unittest.main()
