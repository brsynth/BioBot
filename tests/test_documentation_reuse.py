"""Documentation crawls stay in their repository and reuse stored public pages first."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'biobot'))
try:
    import doc_fetcher as docs
except ImportError as error:
    raise unittest.SkipTest(f'requires app dependencies: {error}')


class DocumentationReuseTests(unittest.TestCase):
    def test_github_crawl_cannot_visit_profiles_conversations_or_other_repositories(self):
        root='https://github.com/maker/sdk'
        guide=root+'/blob/main/docs/api.md'
        links=['https://github.com/author',root+'/pull/1001',root+'/issues/2',
               'https://github.com/other/sdk',guide]
        with patch.object(docs,'fetch_page_content',side_effect=[('Documentation '*30,links,'html'),('API '*100,[],'text')]) as fetch,patch.object(docs.time,'sleep'):
            pages=docs.crawl_docs_site(root)
        self.assertEqual([page['url'] for page in pages],[root,guide])
        self.assertEqual([call.args[0] for call in fetch.call_args_list],[root,guide])
        for url in (root+'/pull/1001','https://github.com/author'):
            with patch.object(docs,'fetch_page_content') as fetch:
                self.assertEqual(docs.crawl_docs_site(url),[])
                fetch.assert_not_called()
        self.assertFalse(docs.is_doc_url('https://github.com.unrelated.test/maker/sdk','github.com'))

    def test_cached_sources_are_reused_before_accessibility_checks_or_downloads(self):
        with tempfile.TemporaryDirectory() as folder:
            old=Path(folder)/'docs/old';new=Path(folder)/'docs/new'
            root='https://github.com/maker/sdk'
            page={'url':root,'content':'Existing programming manual','type':'html'}
            docs.save_fetched_docs(str(old),[page]);docs.mark_crawled(str(old),root)
            with patch.object(docs,'discover_doc_urls',return_value=[{'url':root,'type':'repo'}]), \
                 patch.object(docs,'verify_url') as verify,patch.object(docs,'fetch_page_content') as fetch, \
                 patch.object(docs.time,'sleep'):
                pages,failed=docs.gather_documentation('New model',[],'test-key',str(new))
            self.assertEqual([page['url'] for page in pages],[root])
            self.assertEqual(failed,[]);verify.assert_not_called();fetch.assert_not_called()
