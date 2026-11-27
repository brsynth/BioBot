"""Public manuals are searchable without exposing cached indexes or private code."""
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'biobot'))
import device_documentation as docs


class DeviceDocumentationTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);self.folder=self.root/'data/docs/device';self.folder.mkdir(parents=True)
        self.profile={'name':'Maker Device','docs_path':'data/docs/device','store_path':'index.pkl',
                      'programming_sources':[{'url':'https://manufacturer.example/api'},{'url':'javascript:alert(1)'}]}
        handlers=types.SimpleNamespace(load_handlers_config=lambda:{'device':self.profile})
        catalog=types.SimpleNamespace(find_device=lambda _:None,lookup_key=lambda value:''.join(c for c in value.casefold() if c.isalnum()))
        p=patch.dict(sys.modules,{'handlers':handlers,'device_catalog':catalog});p.start();self.addCleanup(p.stop)
        p=patch.object(docs,'SCRIPT_DIR',self.root);p.start();self.addCleanup(p.stop)
        (self.folder/'manual.txt').write_text('Programming reference: transfer 20 microlitres.')
        (self.folder/'sources.json').write_text(json.dumps({'https://manufacturer.example/manual':{}}))

    def test_lists_documents_and_safe_sources(self):
        data=docs.documentation('Maker Device')
        self.assertEqual(data['total'],1)
        self.assertEqual(data['documents'][0]['name'],'manual.txt')
        self.assertEqual(len(data['sources']),2)
        self.assertFalse(data['preparing'])

    def test_searches_document_contents_and_returns_snippets(self):
        data=docs.documentation('device','MICROLITRES')
        self.assertEqual(len(data['documents']),1)
        self.assertIn('20 microlitres',data['documents'][0]['snippet'])
        self.assertEqual(docs.documentation('device','absent')['documents'],[])

    def test_private_code_indexes_traversal_and_external_symlinks_are_not_exposed(self):
        for folder in ('codes','failed_codes'):
            (self.folder/folder).mkdir();(self.folder/folder/'private.txt').write_text('Private protocol')
        (self.folder/'index.pkl').write_bytes(b'private cached index')
        secret=self.root/'secret.txt';secret.write_text('secret')
        (self.folder/'escape.txt').symlink_to(secret)
        self.assertEqual(docs.documentation('device')['total'],1)
        for name in ('../secret.txt','codes/private.txt','failed_codes/private.txt','index.pkl','escape.txt'):
            with self.assertRaises(ValueError):docs.document_file('device',name)

    def test_downloaded_shared_files_are_available(self):
        shared=self.root/'data/docs/_shared/files';shared.mkdir(parents=True)
        (shared/'page.txt').write_text('Shared public manual')
        (self.folder/'linked.txt').symlink_to(shared/'page.txt')
        self.assertEqual(docs.documentation('device')['total'],2)
        self.assertEqual(docs.document_text(docs.document_file('device','linked.txt')),'Shared public manual')

    def test_preparation_lock_reports_in_progress(self):
        import fcntl
        with (self.folder/'index.pkl.lock').open('w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            self.assertTrue(docs.documentation('device')['preparing'])
        self.assertFalse(docs.documentation('device')['preparing'])

    def test_unknown_device_does_not_discover_or_fetch_anything(self):
        with self.assertRaises(ValueError):docs.documentation('missing')
