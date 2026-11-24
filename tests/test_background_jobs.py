"""Background discovery must not keep a reloading web worker alive."""
from pathlib import Path
import subprocess
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'biobot'))
from background_jobs import BackgroundExecutor


class BackgroundJobsTests(unittest.TestCase):
    def test_process_exits_with_an_unfinished_discovery_job(self):
        code = '''from background_jobs import BackgroundExecutor
from threading import Event
started = Event()
def blocked_job():
    started.set()
    Event().wait()
pool = BackgroundExecutor(1, 'reload-test')
pool.submit(blocked_job)
assert started.wait(1)
print('worker may exit', flush=True)
'''
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).resolve().parents[1] / 'biobot',
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('worker may exit', result.stdout)

    def test_concurrency_is_bounded_and_callbacks_receive_results(self):
        pool = BackgroundExecutor(2, 'bounded-test')
        release, two_started = threading.Event(), threading.Event()
        lock = threading.Lock()
        active = 0
        peak = 0
        def job(value):
            nonlocal active, peak
            with lock:
                active += 1; peak = max(peak, active)
                if active == 2:
                    two_started.set()
            if not release.wait(3):
                raise TimeoutError('test did not release jobs')
            with lock:
                active -= 1
            return value * 2
        try:
            jobs = [pool.submit(job, index) for index in range(5)]
            callback = threading.Event()
            jobs[-1].add_done_callback(lambda future: callback.set())
            self.assertTrue(two_started.wait(1))
            self.assertFalse(jobs[-1].running())
            release.set()
            self.assertEqual([job.result(timeout=3) for job in jobs], [0, 2, 4, 6, 8])
            self.assertTrue(callback.wait(1))
            self.assertEqual(peak, 2)
        finally:
            release.set(); pool.shutdown()

    def test_a_failed_job_does_not_stop_the_worker(self):
        pool = BackgroundExecutor(1, 'failure-test')
        try:
            def fail():
                raise ValueError('synthetic failure')
            with self.assertRaisesRegex(ValueError, 'synthetic failure'):
                pool.submit(fail).result(timeout=1)
            self.assertEqual(pool.submit(lambda: 7).result(timeout=1), 7)
        finally:
            pool.shutdown()
