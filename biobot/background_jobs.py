"""Bounded daemon workers for persistent, restartable background jobs.

Unlike ThreadPoolExecutor, these workers do not register an interpreter-exit
join. Web-worker reloads can finish while interrupted catalog/documentation jobs
are recovered from their existing durable state by the next worker.
"""
from concurrent.futures import Future
from queue import Queue
from threading import Lock, Thread


class BackgroundExecutor:
    def __init__(self, max_workers, thread_name_prefix):
        if type(max_workers) is not int or max_workers < 1:
            raise ValueError('max_workers must be a positive integer')
        self._max_workers = max_workers
        self._prefix = thread_name_prefix
        self._queue = Queue()
        self._lock = Lock()
        self._threads = []
        self._closed = False

    def submit(self, function, *args, **kwargs):
        future = Future()
        with self._lock:
            if self._closed:
                raise RuntimeError('Background executor is shut down')
            if not self._threads:
                for index in range(self._max_workers):
                    worker = Thread(target=self._work, name=f'{self._prefix}-{index}', daemon=True)
                    self._threads.append(worker)
                    worker.start()
            self._queue.put((future, function, args, kwargs))
        return future

    def _work(self):
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                future, function, args, kwargs = item
                if not future.set_running_or_notify_cancel():
                    continue
                try:
                    result = function(*args, **kwargs)
                except BaseException as error:
                    future.set_exception(error)
                else:
                    future.set_result(result)
            finally:
                self._queue.task_done()

    def shutdown(self, wait=True):
        with self._lock:
            if not self._closed:
                self._closed = True
                for _ in self._threads:
                    self._queue.put(None)
        if wait:
            for worker in self._threads:
                worker.join()
