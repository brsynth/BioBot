/* Read existing documentation without changing the deck or its inspector. */
(() => {
  const dialog = document.getElementById('device-documentation');
  if (!dialog) return;
  const get = id => document.getElementById(id);
  const list = get('documentation-list'), status = get('documentation-status');
  const search = get('documentation-search'), preview = get('documentation-preview');
  let device = '', controller, timer, version = 0;
  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function url(file, options = {}) {
    return '/devices/documentation/file?' + new URLSearchParams({device, file, ...options});
  }
  async function json(url, signal) {
    const response = await fetch(url, {signal, cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Documentation could not load. Please retry.');
    return data;
  }
  async function read(file) {
    const request = ++version;
    controller?.abort();clearTimeout(timer);controller = new AbortController();
    status.textContent = 'Opening document…';
    try {
      const data = await json(url(file.file, {view:'1'}), controller.signal);
      if (!dialog.open || request !== version) return;
      get('documentation-file-name').textContent = file.name;
      get('documentation-text').textContent = data.text || 'No text preview is available. Use Download to read the original document.';
      list.hidden = true;get('documentation-sources').hidden = true;preview.hidden = false;
      status.textContent = data.text.length >= 200000 ? 'Preview limited to the first 200,000 characters. Download the complete document below.' : '';
      const link = element('a','Download original');link.href = url(file.file);
      status.appendChild(link);
    } catch (error) {if (error.name !== 'AbortError' && request === version) status.textContent = error.message;}
  }
  async function refresh() {
    const request = ++version;
    controller?.abort();clearTimeout(timer);controller = new AbortController();
    try {
      const data = await json('/devices/documentation?' + new URLSearchParams({device, q:search.value}), controller.signal);
      if (!dialog.open || request !== version) return;
      get('device-documentation-title').textContent = data.device + ' — Documentation';
      preview.hidden = true;list.hidden = false;
      status.textContent = data.preparing ? 'Preparing documentation… downloaded documents are available below.'
        : data.total ? `${data.documents.length} of ${data.total} documents` : 'No documents are available yet.';
      list.replaceChildren();
      for (const file of data.documents) {
        const row = element('article'), title = element('button',file.name);
        title.type = 'button';title.className = 'documentation-file';title.addEventListener('click',()=>read(file));
        const download = element('a','Download');download.href = url(file.file);download.setAttribute('aria-label','Download '+file.name);
        row.append(title, element('small',file.format), download);
        if (file.snippet) row.appendChild(element('p',file.snippet));
        list.appendChild(row);
      }
      if (data.total && !data.documents.length) list.appendChild(element('p','No matching documents.'));
      const sources = get('documentation-source-links');sources.replaceChildren();
      for (const source of data.sources) {
        if (!/^https?:\/\//i.test(source)) continue;
        const link = element('a',source);link.href = source;link.target = '_blank';link.rel = 'noopener noreferrer';sources.appendChild(link);
      }
      get('documentation-sources').hidden = !sources.children.length;
      if (data.preparing) timer = setTimeout(refresh,3000);
    } catch (error) {
      if (error.name === 'AbortError' || request !== version) return;
      status.textContent = error.message;
      const retry = element('button','Retry');retry.type = 'button';retry.addEventListener('click',refresh);status.appendChild(retry);
    }
  }
  get('device-documentation-toggle').addEventListener('click',()=>{
    device = window.workspace?.deviceContext || '';
    search.value = '';list.replaceChildren();preview.hidden = true;list.hidden = false;
    get('documentation-source-links').replaceChildren();get('documentation-sources').hidden = true;
    get('device-documentation-title').textContent = 'Documentation';
    dialog.showModal();search.focus();
    if (!device) {status.textContent = 'Choose a device to read its documentation.';return;}
    status.textContent = 'Loading documentation…';refresh();
  });
  get('documentation-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{++version;controller?.abort();clearTimeout(timer);});
  search.addEventListener('input',()=>{++version;controller?.abort();clearTimeout(timer);timer = setTimeout(refresh,300);});
  get('documentation-back').addEventListener('click',refresh);
})();
