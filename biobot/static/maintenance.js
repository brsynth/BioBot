(() => {
  const progress = document.getElementById('maintenance-progress');
  const detail = document.getElementById('maintenance-detail');
  async function poll() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/devices/catalog', {cache:'no-store', signal:controller.signal});
      if (response.status === 401 || response.status === 403) {window.location.replace('/login'); return;}
      if (!response.ok) throw Error('Unavailable');
      const state = await response.json();
      if (state.available) {window.location.reload(); return;}
      const counts = state.counts || {};
      progress.textContent = `${counts.ready || 0} devices ready · ${(counts.queued || 0) + (counts.building || 0)} being prepared`;
      detail.textContent = state.status === 'failed'
        ? 'Discovery was interrupted. An administrator can retry it in Administration.'
        : state.status === 'resetting' ? 'Clearing the previous catalog before starting fresh.'
        : 'The page will open automatically when discovery is complete.';
    } catch (_) {
      detail.textContent = 'Waiting for the server… reconnecting automatically.';
    } finally {clearTimeout(timeout);}
    setTimeout(poll, 3000);
  }
  poll();
})();
