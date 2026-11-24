"""Model identity is structured and independent of generated labels or IDs."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('tested_device_identity',Path(__file__).resolve().parents[1]/'biobot/device_identity.py')
identity=importlib.util.module_from_spec(spec)
with patch.dict(sys.modules,{'psycopg2.extras':types.SimpleNamespace(Json=lambda x:x,RealDictCursor=object)}):
    spec.loader.exec_module(identity)


class ModelIdentityTests(unittest.TestCase):
    def test_display_names_and_generated_ids_do_not_change_the_model_identity(self):
        a={'name':'Maker Model 7','device_id':'arbitrary_id','identity':{'manufacturer':'Maker','model':'Model-7','variant':''}}
        b={'name':'Maker Model-7 Robot','device_id':'another_id','identity':{'manufacturer':'MAKER','model':'Model 7','variant':''}}
        self.assertEqual(identity.model_key(a),identity.model_key(b))
        self.assertEqual(identity.stable_device_id(a),identity.stable_device_id(b))

    def test_physical_variants_and_model_prefixes_remain_distinct(self):
        profiles=[{'identity':{'manufacturer':'Maker','model':model,'variant':variant}} for model,variant in [('Model7',''),('Model70',''),('Model7','XL')]]
        self.assertEqual(len({identity.model_key(profile) for profile in profiles}),3)
        self.assertEqual(len({identity.stable_device_id(profile) for profile in profiles}),3)

    def test_invalid_or_missing_physical_identity_cannot_generate_an_identifier(self):
        for data in ({'manufacturer':'Maker','model':''},{'manufacturer':'','model':'Model7'},{'manufacturer':'Maker','model':'Model7','variant':4}):
            with self.assertRaises(ValueError):identity.model_key({'identity':data})

    def test_product_family_cannot_claim_an_individual_physical_identity(self):
        profile={'identity':{'manufacturer':'Maker','model':'Series7'},'model_scope':'family','family_models':['Model7','Model7T']}
        with self.assertRaises(ValueError):identity.model_key(profile)
