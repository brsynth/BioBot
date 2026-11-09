"""BioBot protocol language: deterministic expansion and checks; no model requests."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "biobot"))
import protocol_lang as lang  # noqa: E402

DILUTION = {
    "device": "Opentrons OT-2", "description": "1:2 serial dilution",
    "labware": [
        {"id": "plate", "position": "1", "identifier": "corning_96_wellplate_360ul_flat", "type": "plate", "rows": 8, "columns": 12, "max_volume_ul": 360},
        {"id": "res", "position": "2", "identifier": "nest_12_reservoir_15ml", "type": "reservoir", "rows": 1, "columns": 12},
        {"id": "tips", "position": "3", "identifier": "opentrons_96_tiprack_300ul", "type": "tiprack", "rows": 8, "columns": 12},
        {"id": "trash", "position": "12", "identifier": "opentrons_1_trash_1100ml_fixed", "type": "trash"},
    ],
    "instruments": [{"id": "p300", "model": "p300_single_gen2", "tips": ["tips"], "min_volume_ul": 20, "max_volume_ul": 300}],
    "liquids": [{"name": "diluent", "at": "res:A1", "volume_ul": 10000}, {"name": "sample", "at": "res:A2", "volume_ul": 2000}],
    "parameters": {"n_points": 6, "volume_ul": 100},
    "program": [
        {"transfer": {"from": "res:A1", "to": "plate:B2..B{n_points}", "volume": "{volume_ul}"}},
        {"transfer": {"from": "res:A2", "to": "plate:B1", "volume": "2*{volume_ul}"}},
        {"for": "i", "in": "1..{n_points}-1", "do": [
            {"transfer": {"from": "plate:B{i}", "to": "plate:B{i+1}", "volume": "{volume_ul}", "mix_after": 3}}]},
    ],
}


def variant(**changes):
    protocol = copy.deepcopy(DILUTION)
    protocol.update(changes)
    return protocol


class ExpansionTests(unittest.TestCase):
    def test_serial_dilution_volumes_and_mixtures(self):
        result = lang.expand(DILUTION)
        self.assertEqual(len([s for s in result["steps"] if s["action"] == "transfer"]), 11)
        final = result["final_wells"]
        self.assertEqual([final[f"plate:B{i}"]["volume_ul"] for i in range(1, 7)], [100, 100, 100, 100, 100, 200])
        self.assertEqual(final["plate:B3"]["liquids"], {"diluent": 75, "sample": 25})
        step = result["steps"][-2]
        self.assertEqual((step["source"], step["destination"]), ({"slot": "1", "wells": ["B5"]}, {"slot": "1", "wells": ["B6"]}))
        self.assertEqual(step["volume_changes"][0]["delta_ul"], -100)

    def test_parameter_change_re_expands_without_rewriting_the_program(self):
        updated = lang.set_parameters(json.dumps(DILUTION), [{"type": "set_parameter", "parameter_id": "n_points", "new_value": "4"}])
        self.assertEqual(json.loads(updated)["program"], DILUTION["program"])
        self.assertEqual(len(lang.movements(updated)), 7)

    def test_tips_are_picked_column_by_column_and_dropped_in_the_trash(self):
        steps = lang.expand(DILUTION)["steps"]
        self.assertEqual([s["action"] for s in steps[:6]], ["pickup_tip", "transfer", "drop_tip"] * 2)
        self.assertEqual([s["source"]["wells"] for s in steps if s["action"] == "pickup_tip"][:3], [["A1"], ["B1"], ["C1"]])
        self.assertEqual(steps[2]["source"], {"slot": "12", "wells": []})
        once = variant(program=[{"transfer": {"from": "res:A1", "to": "plate:A1..A3", "volume": 50, "new_tip": "once"}}])
        self.assertEqual([s["action"] for s in lang.expand(once)["steps"]], ["pickup_tip"] + ["transfer"] * 3 + ["drop_tip"])
        no_tips = variant(instruments=[{"id": "echo", "model": "Echo 650"}])
        self.assertEqual({s["action"] for s in lang.expand(no_tips)["steps"]}, {"transfer"})

    def test_column_ranges_and_pairing(self):
        protocol = variant(program=[{"transfer": {"from": "res:A1", "to": "plate:A1..H1", "volume": 50}},
                                    {"transfer": {"from": "plate:A1..H1", "to": "plate:A2..H2", "volume": 25}}])
        moves = lang.movements(protocol)
        self.assertEqual(len(moves), 16)
        self.assertEqual(moves[8], ("1:A1", "1:A2", 25))

    def test_binding_feeds_the_simulator(self):
        binding = lang.binding(DILUTION)
        self.assertEqual(binding["positions"][0]["well_count"], 96)
        self.assertEqual(binding["instruments"][0]["tipracks"], ["3"])
        self.assertEqual(binding["parameters"][0], {"id": "n_points", "label": "n points", "value": "6", "type": "number", "unit": "", "units": {"": 1}, "integer": True})
        self.assertEqual(binding["initial_wells"][0]["liquids"], [{"name": "diluent", "volume_ul": 10000}])

    def test_non_protocols_are_left_to_the_llm_path(self):
        self.assertIsNone(lang.parse("from opentrons import protocol_api"))
        self.assertIsNone(lang.parse('{"steps": []}'))


class CheckTests(unittest.TestCase):
    def assertFails(self, protocol, message, **kwargs):
        with self.assertRaises(lang.ProtocolError) as caught:
            lang.expand(protocol, **kwargs)
        self.assertIn(message, str(caught.exception))

    def test_physical_errors(self):
        self.assertFails(variant(parameters={"n_points": 6, "volume_ul": 400}), "outside p300's range")
        self.assertFails(variant(program=[{"transfer": {"from": "plate:A1", "to": "plate:A2", "volume": 50}}]), "holds 0 µL")
        self.assertFails(variant(program=[{"transfer": {"from": "res:A1", "to": "plate:A1", "volume": 300}},
                                          {"transfer": {"from": "res:A1", "to": "plate:A1", "volume": 100}}]), "overflows")
        self.assertFails(variant(program=[{"transfer": {"from": "res:A1", "to": "plate:A1..A12", "volume": 20}}] * 9), "needs 108 tips")

    def test_documented_volume_step_and_dead_volume(self):
        acoustic = variant(instruments=[{"id": "echo", "model": "Echo 650", "volume_step_ul": 0.0025}],
                           program=[{"transfer": {"from": "res:A1", "to": "plate:A1", "volume": 0.0035}}])
        self.assertFails(acoustic, "not a multiple of echo's 0.0025 µL volume step")
        acoustic["program"][0]["transfer"]["volume"] = 0.005
        self.assertEqual(len(lang.expand(acoustic)["steps"]), 1)
        source = copy.deepcopy(DILUTION)
        source["labware"][1]["dead_volume_ul"] = 1950
        source["program"] = [{"transfer": {"from": "res:A2", "to": "plate:A1", "volume": 100}}]
        self.assertFails(source, "below its 1950 µL dead volume")

    def test_reference_errors_name_the_instruction(self):
        self.assertFails(variant(program=[{"mix": {"at": "plate:I1", "volume": 50}}]), "program[0]: Well I1 does not exist")
        self.assertFails(variant(program=[{"transfer": {"from": "nope:A1", "to": "plate:A1", "volume": 50}}]), "Unknown labware")
        self.assertFails(variant(program=[{"pipette": {}}]), "expected one of")
        self.assertFails(DILUTION, "unknown deck position 3", positions=["1", "2"])

    def test_formulas_are_arithmetic_only(self):
        for expression in ("__import__('os')", "volume_ul.real", "[1][0]", "1/0"):
            with self.assertRaises(lang.ProtocolError):
                lang.evaluate(expression, {"volume_ul": 100})
        self.assertEqual(lang.evaluate("2*volume_ul // 3", {"volume_ul": 100}), 66)

    def test_movement_difference(self):
        a, b = ("1:A1", "1:A2", 10), ("1:A2", "1:A3", 10)
        self.assertEqual(lang.movement_difference([a, b], [a, ("1:A2", "1:A3", 10.0001)]), "")
        self.assertIn("different order", lang.movement_difference([b, a], [a, b]))
        self.assertEqual(lang.movement_difference([a, ("1:A2", "1:A3", 9)], [a, b]),
                         "1 transfer(s) differ, first at #2: script 1:A2 → 1:A3, 9 µL, protocol 1:A2 → 1:A3, 10 µL")
        self.assertIn("makes 1 transfers, the protocol 2", lang.movement_difference([a], [a, b]))

    def test_end_state_comparison(self):
        self.assertEqual(lang.end_state_mismatches(DILUTION, [{"at": "plate:B1..B5", "volume_ul": 100}]), [])
        self.assertEqual(lang.end_state_mismatches(DILUTION, [{"at": "plate:B6", "volume_ul": 100}]),
                         ["plate:B6 ends with 200 µL, expected 100 µL."])


if __name__ == "__main__":
    unittest.main()
