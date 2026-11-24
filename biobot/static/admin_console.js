/* Administrator maintenance. All displayed server values use textContent/value. */
(() => {
  const modal = document.getElementById('admin-modal');
  if (!modal) return;
  const feedback = document.getElementById('admin-feedback');
  const token = document.getElementById('admin-csrf-token').value;
  let deviceRows = [];
  const expandedCategories = new Set();
  const deviceForms = new Map(), deviceEditVisible = new Set(), deviceCards = new Map();
  const deckPanel = document.getElementById('admin-device-deck');
  function message(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('is-error', error);
  }
  async function api(url, method = 'GET', body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {method, signal:controller.signal,
        headers: {'Content-Type':'application/json', 'X-CSRF-Token':token},
        ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      let result;
      try {result = await response.json();} catch (_) {throw Error("The server could not complete this change. Please retry.");}
      if (!response.ok) throw Error(result.error || 'Could not save this change.');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('Administration request timed out. Please retry.');
      throw error;
    } finally {clearTimeout(timer);}
  }

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action, disableWhileRunning = true) {
    const el = node('button', text, 'btn');
    let pending = false;
    el.type = 'button';
    el.addEventListener('click', async () => {
      if (pending) return;
      pending = true;
      if (disableWhileRunning) el.disabled = true;
      try {await action();} catch (error) {message(error.message, true);}
      finally {pending = false; if (disableWhileRunning) el.disabled = false;}
    });
    return el;
  }
  function field(parent, label, value = '', type = 'text') {
    const wrapper = node('label', label, 'admin-field');
    const input = node(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.value = value ?? '';
    wrapper.appendChild(input); parent.appendChild(wrapper);
    return input;
  }
  function actions(form, save, cancel) {
    const bar = node('div', undefined, 'admin-actions');
    const submit = button('Save changes', save);
    bar.append(submit, button('Cancel', cancel)); form.appendChild(bar);
  }
  function card(title, subtitle) {
    const el = node('article', undefined, 'admin-card');
    el.append(node('h4', title), node('p', subtitle, 'admin-card-summary'));
    return el;
  }
  const tabs = ['users', 'devices'];
  function selectTab(name) {
    for (const tab of tabs) {
      const active = tab === name;
      const button = document.getElementById(`admin-tab-${tab}`);
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      document.getElementById(`admin-panel-${tab}`).hidden = !active;
    }
  }
  for (const [index, name] of tabs.entries()) {
    const tab = document.getElementById(`admin-tab-${name}`);
    tab.addEventListener('click', () => selectTab(name));
    tab.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (['ArrowLeft','ArrowUp'].includes(event.key) ? tabs.length - 1 : 1)) % tabs.length];
        selectTab(target); document.getElementById(`admin-tab-${target}`).focus();
      }
    });
  }
  async function refreshUsers() {
    const box = document.getElementById('admin-users');
    const users = await api('/admin/users');
    const count = document.getElementById('admin-count-users');
    if (count) count.textContent = String(users.length);
    box.replaceChildren();
    for (const user of users) {
      const row = card(`${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email, user.email || 'No email');
      const tags = node('p', user.server_owner ? 'Server owner' : user.admin_status === 'approved' ? 'Administrator' : 'User', 'admin-tags');
      row.appendChild(tags);
      row.appendChild(button('Edit user', () => {
            const form = node('div', undefined, 'admin-editor');
        const inputs = {};
        for (const [key, label] of [['first_name','First name'],['last_name','Last name'],['email','Email'],['role','Role / job title'],['country','Country']]) {
          inputs[key] = field(form, label, user[key], key === 'email' ? 'email' : 'text');
        }
        const wrapper = node('label', 'Administrator access', 'admin-field');
        const access = node('select');
        for (const [value, label] of [['','User'],['requested','Requested'],['approved','Administrator']]) {
          const option = node('option', label); option.value = value; access.appendChild(option);
        }
        access.value = user.admin_status || ''; access.disabled = user.server_owner || String(user.id) === document.body.dataset.userId;
        wrapper.appendChild(access); form.appendChild(wrapper);
        actions(form, async () => {
          if (!inputs.email.reportValidity()) return;
          const data = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
          if (!access.disabled) data.admin_status = access.value || null;
          await api(`/admin/users/${user.id}`, 'PATCH', data);
          message('User changes saved.'); await refreshUsers();
        }, () => form.remove());
        row.appendChild(form);
      }));
      row.appendChild(button('Reset password', () => {
            const form = node('div', undefined, 'admin-editor');
        form.appendChild(node('p', 'This signs the user out everywhere and clears their saved API key. Chats and protocols are retained.'));
        const password = field(form, 'New password (at least 12 characters)', '', 'password');
        password.minLength = 12; password.maxLength = 200; password.required = true; password.autocomplete = 'new-password';
        const repeat = field(form, 'Repeat new password', '', 'password'); repeat.autocomplete = 'new-password';
        actions(form, async () => {
          if (!password.reportValidity()) return;
          if (password.value !== repeat.value) throw Error('The passwords do not match.');
          if (!confirm(`Reset the password for ${user.email}, sign out their sessions and clear their saved API key?`)) return;
          const result = await api(`/admin/users/${user.id}/reset`, 'POST', {password:password.value});
          password.value = ''; repeat.value = ''; form.remove();
          if (result.sign_in_required) {window.location.assign('/login'); return;}
          message('Password reset. The user must sign in again and re-enter their API key.');
        }, () => form.remove());
        row.appendChild(form);
      }));
      box.appendChild(row);
    }
  }
  function constraintEditor(parent, constraints) {
    const list = node('div', undefined, 'admin-constraints');
    parent.appendChild(node('h4', 'Constraints'));
    parent.appendChild(node('p', 'Keep the units and scope explicit. Numeric limits inform protocol generation; validation formulas are checked by the simulator.', 'admin-help'));
    const entries = [];
    function add(rule = {}) {
      const row = node('div', undefined, 'admin-constraint');
      const description = field(row, 'Constraint / scope', rule.description || rule.name);
      const unit = field(row, 'Unit', rule.unit);
      const increment = field(row, 'Multiple of (optional)', rule.multiple_of, 'number'); increment.step = 'any'; increment.min = '0';
      const minimum = field(row, 'Minimum (optional)', rule.minimum, 'number'); minimum.step = 'any';
      const maximum = field(row, 'Maximum (optional)', rule.maximum, 'number'); maximum.step = 'any';
      const source = field(row, 'Source or correction note', rule.source);
      const advanced = node('details'); advanced.appendChild(node('summary', 'Validation formula (optional)'));
      const scope = field(advanced, 'Applies to', rule.applies_to);
      const expression = field(advanced, 'Formula', rule.rule);
      row.appendChild(advanced);
      const entry = {row, value:() => ({...rule, description:description.value, unit:unit.value,
        source:source.value || 'Administrator correction',
        ...(increment.value ? {multiple_of:Number(increment.value)} : {multiple_of:undefined}),
        ...(minimum.value ? {minimum:Number(minimum.value)} : {minimum:undefined}),
        ...(maximum.value ? {maximum:Number(maximum.value)} : {maximum:undefined}),
        ...(scope.value ? {applies_to:scope.value} : {applies_to:undefined}),
        ...(expression.value ? {rule:expression.value} : {rule:undefined})})};
      entries.push(entry);
      row.appendChild(button('Remove constraint', () => {row.remove(); entries.splice(entries.indexOf(entry),1);}));
      list.appendChild(row);
    }
    for (const rule of constraints || []) add(rule);
    parent.append(list, button('Add constraint', () => add()));
    return () => entries.map(entry => entry.value());
  }
  function syncEditorToggles() {
    for (const [key, card] of deviceCards) {
      card.edit.setAttribute('aria-pressed', String(deviceEditVisible.has(key)));
      const deckOpen = window.adminDeckEditor?.isOpen?.(key) || false;
      card.deck.setAttribute('aria-pressed', String(deckOpen));
      const form = deviceForms.get(key);
      if (form) {
        form.hidden = !deviceEditVisible.has(key);
        if (form.parentElement !== card.row) card.row.appendChild(form);
      }
      if (deckOpen && deckPanel && deckPanel.parentElement !== card.row) card.row.appendChild(deckPanel);
    }
  }
  function dismissDeviceForm(key) {
    deviceForms.get(key)?.remove(); deviceForms.delete(key); deviceEditVisible.delete(key); syncEditorToggles();
  }
  async function editDevice(device) {
    if (deviceForms.has(device.key)) {
      if (deviceEditVisible.has(device.key)) deviceEditVisible.delete(device.key); else deviceEditVisible.add(device.key);
      syncEditorToggles(); return;
    }
    const detail = await api(`/admin/devices/${encodeURIComponent(device.key)}`);
    const form = node('div', undefined, 'admin-editor');
    form.id = `admin-device-form-${encodeURIComponent(device.key)}`;
    const profile = detail.profile || {};
    const categories = field(form, 'Equipment categories (one per line)', (profile.categories || []).join('\n'), 'textarea');
    form.appendChild(node('p', 'Use an existing equipment family or add your own. Devices can belong to several categories.', 'admin-help'));
    const features = field(form, 'Features (one per line)', (profile.features || []).join('\n'), 'textarea');
    const format = field(form, 'Instruction format / language', profile.output_type);
    const identifier = field(form, 'Format identifier', profile.output_format || 'text');
    const extension = field(form, 'File extension', profile.file_extension || '.txt');
    const programming = field(form, 'Programming interface', profile.programming_interface || '', 'textarea');
    const constraints = constraintEditor(form, profile.constraints || []);
    const sources = node('details'); sources.appendChild(node('summary', 'Reference sources'));
    for (const source of profile.sources || profile.programming_sources || []) sources.appendChild(node('p', `${source.claim || ''} ${source.url || ''}`));
    form.appendChild(sources);
    actions(form, async () => {
      const body = {profile: {categories:categories.value.split('\n').map(value=>value.trim()).filter(Boolean),
        features:features.value.split('\n').map(value=>value.trim()).filter(Boolean),
        output_type:format.value, output_format:identifier.value, file_extension:extension.value,
        programming_interface:programming.value, constraints:constraints()}};
      await api(`/admin/devices/${encodeURIComponent(device.key)}`, 'PATCH', body);
      dismissDeviceForm(device.key);
      message('Device changes saved.'); await refreshDevices();
    }, () => dismissDeviceForm(device.key));
    deviceForms.set(device.key, form); deviceEditVisible.add(device.key); syncEditorToggles();
  }
  const deviceCategories = device => device.categories?.length ? device.categories : ['Uncategorized'];
  const searchQuery = () => document.getElementById('admin-device-search').value.trim().toLowerCase();
  function matchesDevice(device, query) {
    return [device.device_name, device.status, device.output_type, device.output_format,
      ...deviceCategories(device), ...(device.features || []),
      ...(device.constraints || []).map(rule => rule.description || rule.name || '')]
      .some(value => String(value || '').toLowerCase().includes(query));
  }
  function highlight(element, value, query) {
    const text = String(value || '');
    element.replaceChildren();
    if (!query) {element.textContent = text; return;}
    const lower = text.toLowerCase();
    let start = 0, index;
    while ((index = lower.indexOf(query, start)) !== -1) {
      element.append(node('span', text.slice(start, index)), node('mark', text.slice(index, index + query.length)));
      start = index + query.length;
    }
    element.appendChild(node('span', text.slice(start)));
  }
  function renderEquipmentCloud({cloud, rows, query, expandedCategories, onSelect, onToggle = () => {}}) {
    const categories = [...new Set(rows.flatMap(deviceCategories))].sort();
    cloud.replaceChildren();
    for (const [index, category] of categories.entries()) {
      const members = rows.filter(device => deviceCategories(device).includes(category));
      const matches = members.filter(device => matchesDevice(device, query));
      const expanded = query ? matches.length > 0 : expandedCategories.has(category);
      const group = node('section', undefined, 'admin-category-bubble');
      group.classList.toggle('is-muted', !!query && !matches.length);
      const toggle = node('button', undefined, 'admin-category-toggle'); toggle.type = 'button';
      const label = node('span'); highlight(label, category, query);
      toggle.append(label, node('span', query ? `${matches.length} / ${members.length}` : String(members.length), 'admin-category-count'),
        node('span', expanded ? '−' : '+', 'admin-category-chevron'));
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-pressed', String(expandedCategories.has(category)));
      const list = node('div', undefined, 'admin-category-members'); list.id = `${cloud.id}-members-${index}`;
      list.hidden = !expanded; toggle.setAttribute('aria-controls', list.id);
      for (const device of (query ? matches : members).slice().sort((a,b) => a.device_name.localeCompare(b.device_name))) {
        const chip = node('button', undefined, 'admin-device-chip'); chip.type = 'button';
        highlight(chip, device.device_name, query);
        chip.classList.toggle('is-search-match', !!query);
        chip.setAttribute('aria-label', `${query ? 'Search match: ' : ''}${device.device_name}`);
        chip.addEventListener('click', () => onSelect(device));
        list.appendChild(chip);
      }
      toggle.addEventListener('click', () => {
        const selected = !expandedCategories.has(category);
        if (selected) expandedCategories.add(category); else expandedCategories.delete(category);
        const open = query ? matches.length > 0 : selected; list.hidden = !open;
        toggle.setAttribute('aria-pressed', String(selected));
        toggle.setAttribute('aria-expanded', String(open)); toggle.children[2].textContent = open ? '−' : '+';
        onToggle();
      });
      group.append(toggle, list); cloud.appendChild(group);
    }
  }
  async function selectDevice(device) {
    if (device.device_id && !['queued','building'].includes(device.status)) {
      const accepted = await window.adminDeckEditor?.open(device.key);
      if (accepted === false) return;
    } else if (window.adminDeckEditor?.close() === false) {
      return;
    }
    syncEditorToggles();
    deviceCards.get(device.key)?.row.scrollIntoView?.({behavior:'smooth', block:'start'});
  }
  function renderCategoryCloud() {
    renderEquipmentCloud({cloud:document.getElementById('admin-category-cloud'), rows:deviceRows, query:searchQuery(), expandedCategories,
      onSelect:selectDevice, onToggle:renderDeviceCards});
  }
  function renderDeviceCards() {
    const box = document.getElementById('admin-devices');
    const query = searchQuery();
    const visible = deviceRows.filter(device => matchesDevice(device, query) &&
      (!expandedCategories.size || deviceCategories(device).some(category => expandedCategories.has(category))));
    document.getElementById('admin-device-results').textContent = `${visible.length} of ${deviceRows.length} devices${query ? ' match your search' : ''}`;
    // Keep the live editor and its draft attached while result cards are rebuilt.
    if (deckPanel && box.contains?.(deckPanel)) box.parentElement.appendChild(deckPanel);
    box.replaceChildren(); deviceCards.clear();
    for (const device of visible) {
      const row = card(device.device_name, `${device.status} · ${device.output_type || device.output_format || 'Instruction format pending'}`);
      row.classList.toggle('is-search-match', !!query);
      highlight(row.children[0], device.device_name, query);
      highlight(row.children[1], `${device.status} · ${device.output_type || device.output_format || 'Instruction format pending'}`, query);
      const categories = node('p', undefined, 'admin-category-tags'); highlight(categories, deviceCategories(device).join(' · '), query);
      const features = node('p', undefined, 'admin-tags'); highlight(features, (device.features || []).join(' · ') || 'Features not yet documented', query);
      row.append(categories, features);
      for (const constraint of device.constraints || []) {
        const description = node('p', undefined, 'admin-limit'); highlight(description, constraint.description || constraint.name || '', query); row.appendChild(description);
      }
      if (device.error) row.appendChild(node('p', device.error, 'is-error'));
      const busy = ['queued','building'].includes(device.status);
      const edit = button('Edit device', () => editDevice(device)); edit.disabled = busy || !device.device_id;
      edit.setAttribute('aria-controls', `admin-device-form-${encodeURIComponent(device.key)}`);
      const reset = button('Reset from sources', async () => {
        if (!confirm(`Rediscover ${device.device_name}? This replaces administrator edits and rebuilds its shared default workspace. Personal layout copies and saved protocols are retained.`)) return;
        const result = await api(`/admin/devices/${encodeURIComponent(device.key)}/reset`, 'POST', {});
        message(result.message); await refreshDevices();
      }); reset.disabled = busy;
      const deck = button('Edit deck', async () => {
        if (!window.adminDeckEditor?.toggle) throw Error('The deck editor could not load. Reload the administration page and try again.');
        const accepted = await window.adminDeckEditor.toggle(device.key);
        if (accepted === false) return;
        syncEditorToggles();
      }, false);
      deck.setAttribute('aria-controls', 'admin-device-deck');
      deck.disabled = busy || !device.device_id;
      row.append(edit, deck, reset); box.appendChild(row); deviceCards.set(device.key,{row,edit,deck});
    }
    syncEditorToggles();
    if (!box.children.length) box.appendChild(node('p', 'No matching devices. Discovered devices will appear here.'));
  }
  function renderDevices() {renderCategoryCloud(); renderDeviceCards();}
  async function refreshDevices() {
    deviceRows = await api('/admin/devices');
    const available = new Set(deviceRows.flatMap(deviceCategories));
    for (const category of expandedCategories) if (!available.has(category)) expandedCategories.delete(category);
    const count = document.getElementById('admin-count-devices');
    if (count) count.textContent = String(deviceRows.length);
    renderDevices();
  }
  document.getElementById('admin-refresh-users')?.addEventListener('click', () => loadPanel('users', refreshUsers));
  document.getElementById('admin-device-search').addEventListener('input', renderDevices);
  document.getElementById('admin-category-reset').addEventListener('click', () => {
    expandedCategories.clear();
    document.getElementById('admin-device-search').value = ''; renderDevices();
  });
  document.getElementById('admin-refresh-devices').addEventListener('click', () => refreshDevices().catch(error=>message(error.message,true)));
  const resetButtons = ['admin-reset-db'].map(id => document.getElementById(id)).filter(Boolean);
  const updateButtons = ['admin-update-db'].map(id => document.getElementById(id)).filter(Boolean);
  function disableCatalogActions(disabled) {for (const button of [...resetButtons, ...updateButtons]) button.disabled = disabled;}
  async function refreshCatalogViews() {await refreshDevices();}
  let rebuildTimer;
  async function followDatabaseRebuild() {
    try {
      const state = await api('/devices/catalog');
      const counts = state.counts || {};
      document.getElementById('admin-catalog-progress').textContent = `Device database ${state.status}: ${counts.ready || 0} ready · ${state.updating || 0} checking online · ${(counts.queued || 0) + (counts.building || 0)} being prepared · ${(counts.failed || 0) + (state.update_errors || 0)} need retry.`;
      if (['complete', 'failed'].includes(state.status)) {disableCatalogActions(false); return;}
      rebuildTimer = setTimeout(async () => {
        try {await refreshCatalogViews(); await followDatabaseRebuild();}
        catch (error) {disableCatalogActions(false); message(error.message, true);}
      }, 3000);
    } catch (error) {disableCatalogActions(false); message(error.message, true);}
  }
  for (const resetButton of resetButtons) resetButton.addEventListener('click', async () => {
    if (!confirm('RESET DB clears all learned device profiles, categories, features, constraints and instruction formats, then rebuilds them and the shared decks from online sources. Administrator device corrections will be replaced. Users, chats, saved protocols and personal deck copies are preserved. Existing shared decks remain available until rebuilt. Start the rebuild?')) return;
    disableCatalogActions(true);
    clearTimeout(rebuildTimer);
    try {
      const result = await api('/admin/devices/reset', 'POST', {confirm:'RESET DB'});
      deviceForms.clear(); deviceEditVisible.clear();
      expandedCategories.clear(); document.getElementById('admin-device-search').value = '';
      message(result.message); await refreshCatalogViews(); await followDatabaseRebuild();
    } catch (error) {disableCatalogActions(false); message(error.message, true);}
  });
  for (const updateButton of updateButtons) updateButton.addEventListener('click', async () => {
    disableCatalogActions(true); clearTimeout(rebuildTimer);
    try {
      const result = await api('/admin/devices/update', 'POST', {});
      message(result.message); await refreshCatalogViews(); await followDatabaseRebuild();
    } catch (error) {disableCatalogActions(false); message(error.message, true);}
  });
  async function loadPanel(kind, loader) {
    const box = document.getElementById(`admin-${kind}`);
    box.replaceChildren(node('p', `Loading ${kind}…`));
    box.setAttribute('aria-busy', 'true');
    try {
      await loader();
      return true;
    } catch (error) {
      box.replaceChildren(node('p', error.message, 'is-error'), button(`Retry ${kind}`, async () => {
        const ok = await loadPanel(kind, loader);
        if (ok) message('');
      }));
      return false;
    } finally {box.setAttribute('aria-busy', 'false');}
  }
  async function refreshRequests() {
    const box = document.getElementById('admin-requests');
    if (!box) return;
    try {
      const requests = await api('/admin/requests');
      box.replaceChildren();
      for (const user of requests) {
        const row = card(`${user.first_name || ''} ${user.last_name || ''}`, user.email);
        for (const [label,approve] of [['Approve',true],['Reject',false]]) row.appendChild(button(label, async () => {
          await api(`/admin/requests/${user.id}`,'POST',{approve});
          await Promise.all([refreshRequests(), refreshUsers()]);
        }));
        box.appendChild(row);
      }
      if (!requests.length) box.appendChild(node('p','No pending access requests.','admin-help'));
    } catch (error) {box.replaceChildren(node('p',error.message,'is-error'));}
  }
  const debug = document.getElementById('debug-logs');
  if (debug) {
    try {debug.checked = localStorage.getItem('biobot-debug-logs') === '1';} catch (_) {}
    debug.addEventListener('change', () => {try {localStorage.setItem('biobot-debug-logs',debug.checked ? '1' : '0');} catch (_) {}});
  }
  window.adminConsole = {api, selectTab, renderEquipmentCloud, syncEditorToggles, async open() {
    message('Loading administration…');
    const results = await Promise.all([loadPanel('users', refreshUsers), loadPanel('devices', refreshDevices)]);
    message(results.every(Boolean) ? '' : 'Some administration data could not be loaded. Retry the affected list.', !results.every(Boolean));
  }};
  if (document.body?.classList?.contains('admin-app')) {window.adminConsole.open(); refreshRequests();}
})();
