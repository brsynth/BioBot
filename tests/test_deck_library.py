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
    def test_library_layout_strips_code_steps_sample_data_and_variables(self):
        state = layout()
        state.update({"_protocol_code": "private code", "steps": [{"volume": "secret"}], "title": "private title",
                      "plates": {"source": {"name": "sample identity", "type": "plate", "wells_used": ["A1"], "format": 96}}})
        state["positions"][0]["variable"] = "private_variable"
        saved = library.clean_layout(state)
        self.assertNotIn("_protocol_code", saved)
        self.assertNotIn("steps", saved)
        self.assertNotIn("title", saved)
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

    def test_plate_format_cannot_allocate_unbounded_cells(self):
        state = {"platform": "Device", "layout_type": "plates", "plates": {"source": {"format": 100000000}}}
        with self.assertRaises(ValueError):
            library.clean_layout(state)

    def test_cached_plate_descriptions_are_normalized_without_regeneration(self):
        for count, expected in (("384-well", 384), ("96", 96), (None, None), (100000000, None)):
            state = library.compose_state(layout(), {"plates": {"source": {"format": count}}})
            self.assertEqual(state["plates"]["source"]["format"], expected)


if __name__ == "__main__":
    unittest.main()
