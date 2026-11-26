import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'biobot'))
from equipment_categories import categories_for, clean_categories


class EquipmentCategoryTests(unittest.TestCase):
    def test_legacy_capabilities_allow_several_families_without_matching_brand_names(self):
        self.assertEqual(categories_for({'features':['Liquid-handling', 'fluorescence detection']}),
                         ['Liquid handling', 'Analysis & detection'])
        self.assertEqual(categories_for({'name':'Pipette Robot','features':[]}), [])

    def test_custom_categories_and_explicit_admin_corrections_are_preserved(self):
        self.assertEqual(categories_for({'categories':[' Custom   family ', 'custom family', 'liquid HANDLING'],
                                         'features':['imaging']}), ['Custom family', 'Liquid handling'])
        self.assertEqual(categories_for({'categories':[], 'features':['imaging']}), [])

    def test_invalid_categories_are_rejected(self):
        for invalid in ('Liquid handling', [None], [''], ['a'*81], ['x']*21):
            with self.assertRaises(ValueError):
                clean_categories(invalid)

    def test_acoustic_droplet_ejection_and_fluid_transfers_are_liquid_handling(self):
        for capability in ('Acoustic droplet ejection', 'Acoustic transfer',
                           'Transfer variable fluid heights in one fluid-transfer run',
                           'Liquid transfer protocols'):
            self.assertIn('Liquid handling', categories_for({'features':[capability]}))
        self.assertNotIn('Liquid handling', categories_for({'features':['Sample transport and plate transfer']}))

    def test_documented_interface_can_classify_legacy_profiles_without_features(self):
        self.assertIn('Liquid handling', categories_for({'programming_interface':'Execute liquid-transfer protocols from CSV pick lists.'}))
        self.assertEqual(categories_for({'categories':[], 'programming_interface':'Execute liquid-transfer protocols.'}), [])

    def test_discovery_requires_real_categories_and_fills_documented_capability_omissions(self):
        from equipment_categories import require_discovered_categories
        for value in ({'features':[]}, {'categories':['Uncategorized']}, {'categories':['Other']}):
            with self.assertRaisesRegex(ValueError,'equipment category'):
                require_discovered_categories(value)
        profile=require_discovered_categories({'categories':[], 'features':['Acoustic droplet ejection']})
        self.assertEqual(profile['categories'],['Liquid handling'])
        profile=require_discovered_categories({'categories':['Custom instrument family'], 'features':['Pipetting']})
        self.assertEqual(profile['categories'],['Custom instrument family','Liquid handling'])

    def test_operating_sensor_detection_is_not_an_analytical_capability(self):
        profile = {'features': ['Pipetting', 'Liquid level detection', 'Tip presence detection', 'Collision detection']}
        self.assertEqual(categories_for(profile), ['Liquid handling'])
        self.assertIn('Analysis & detection', categories_for({'features': ['Analyte detection']}))
        self.assertIn('Analysis & detection', categories_for({'features': ['Fluorescence detection']}))
