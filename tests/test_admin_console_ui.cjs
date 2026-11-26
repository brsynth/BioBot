const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/admin_console.js`, 'utf8');
const tick = () => new Promise(setImmediate);

function setup({users = [{id:1,first_name:'First',email:'admin@example.test',admin_status:'approved'}], devices = [], models = null} = {}) {
  class Element {
    constructor(tag='div') {this.tagName=tag;this.children=[];this.events={};this.attributes={};this.value='';this.dataset={};this.textContent='';
      this.classList={toggle(){}};}
    append(...nodes) {for(const node of nodes)this.appendChild(node);}
    appendChild(node) {node.remove();this.children.push(node);node.parentElement=this;if(this.tagName==='select'&&node.selected)this.value=node.value;}
    replaceChildren(...nodes) {for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);}
    remove() {if(this.parentElement){const parent=this.parentElement;parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;}}
    reportValidity() {return true;}
    contains(node) {return this===node || this.children.some(child=>child.contains(node));}
    addEventListener(name,fn) {this.events[name]=fn;}
    setAttribute(key,value) {this.attributes[key]=value;}
  }
  const elements=new Map();
  const get=id=>{if(!elements.has(id)) elements.set(id,new Element());return elements.get(id);};
  get('admin-csrf-token').value='csrf';
  get('admin-panel-devices').append(get('admin-devices'),get('admin-device-deck'));
  const timers=new Map(), calls=[];
  let serial=0;
  const state={devices,models,modelError:false};
  const context=vm.createContext({document:{getElementById:get,createElement:tag=>new Element(tag),body:{dataset:{userId:'1'}}},window:{},AbortController,
    Option:class extends Element {constructor(text,value,defaultSelected,selected){super('option');this.textContent=text;this.value=value;this.selected=selected;}},
    setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{
      calls.push({url,options});
      let data=url==='/admin/users' ? users : state.devices;
      if (/^\/admin\/users\/\d+$/.test(url) && options.method === 'PATCH') {
        Object.assign(users.find(user => String(user.id) === url.split('/').at(-1)), JSON.parse(options.body));
        data = {ok:true};
      }
      if(url==='/admin/models') {
        if(options.method==='PATCH'&&!state.modelError) {
          const body=JSON.parse(options.body);
          for(const role of state.models.roles) {
            if(body[role.role]) role.model=body[role.role];
            if(body.updates?.[role.role]) role.auto_update=body.updates[role.role];
          }
        }
        data=state.modelError ? {error:'Unable to save model settings'} : state.models;
      }
      if(data==='pending') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
      return {ok:!data.error,json:async()=>data};
    }});
  vm.runInContext(source,context);
  const text=node=>node.textContent+' '+node.children.map(text).join(' ');
  return {context,get,timers,calls,state,text};
}

test('users display even when the device request hangs; timeout offers retry',async()=>{
  const w=setup({devices:'pending'});
  const opening=w.context.window.adminConsole.open();
  await tick();
  assert.match(w.text(w.get('admin-users')),/First/);
  assert.match(w.text(w.get('admin-devices')),/Loading devices/);
  assert.equal(w.timers.size,1);
  [...w.timers.values()][0]();
  await opening;
  assert.match(w.text(w.get('admin-devices')),/timed out/);
  assert.match(w.text(w.get('admin-devices')),/Retry devices/);
  assert.doesNotMatch(w.get('admin-feedback').textContent,/Loading administration/);
  assert.equal(w.get('admin-devices').attributes['aria-busy'],'false');
  w.state.devices=[];
  await w.get('admin-devices').children[1].events.click();
  assert.match(w.text(w.get('admin-devices')),/No matching devices/);
  assert.equal(w.get('admin-feedback').textContent,'');
});

test('a failed user request does not hide the available device records',async()=>{
  const w=setup({users:{error:'Users are temporarily unavailable'},devices:[{key:'device',device_id:'device',device_name:'Saved instrument',status:'ready',features:['measurement'],constraints:[]}]});
  await w.context.window.adminConsole.open();
  assert.match(w.text(w.get('admin-users')),/Users are temporarily unavailable/);
  assert.match(w.text(w.get('admin-devices')),/Saved instrument/);
  assert.match(w.text(w.get('admin-devices')),/measurement/);
  assert.equal(w.get('admin-users').attributes['aria-busy'],'false');
});

test('successful administration clears loading and sends requests with abort signals',async()=>{
  const w=setup();
  await w.context.window.adminConsole.open();
  assert.equal(w.get('admin-feedback').textContent,'');
  assert.equal(w.timers.size,0);
  assert.match(w.text(w.get('admin-users')),/admin@example.test/);
  for(const {options} of w.calls) {
    assert.ok(options.signal);
    assert.equal(options.headers['X-CSRF-Token'],'csrf');
  }
});

test('search filters the flat device list and highlights literal device text',async()=>{
  const w=setup({devices:[
    {key:'a',device_id:'a',device_name:'Scope [X]',status:'ready',categories:['Imaging'],features:['fluorescence']},
    {key:'b',device_id:'b',device_name:'Pipette',status:'ready',categories:['Liquid handling']}
  ]});
  await w.context.window.adminConsole.open();
  w.get('admin-device-search').value='[X]';w.get('admin-device-search').events.input();
  assert.equal(w.get('admin-devices').children.length,1);
  const title=w.get('admin-devices').children[0].children[0];
  assert.equal(title.children.find(child=>child.tagName==='mark').textContent,'[X]');
  w.get('admin-device-search').value='FLUORESCENCE';w.get('admin-device-search').events.input();
  assert.equal(w.get('admin-devices').children.length,1);
  assert.match(w.get('admin-device-results').textContent,/1 of 2/);
  w.get('admin-device-search').value='missing';w.get('admin-device-search').events.input();
  assert.match(w.text(w.get('admin-devices')),/No matching devices/);
  w.get('admin-device-search-reset').events.click();
  assert.equal(w.get('admin-devices').children.length,2);
});

for (const resetId of ['admin-reset-db']) test(`${resetId} requires confirmation and starts the same protected rebuild`,async()=>{
  const w=setup();await w.context.window.adminConsole.open();
  const before=w.calls.length;
  w.context.confirm=()=>false;
  await w.get(resetId).events.click();
  assert.equal(w.calls.length,before);
  const requests=[];
  w.context.confirm=()=>true;
  w.context.fetch=async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>url==='/admin/devices/reset' ? {message:'Rebuild started'} :
      url==='/devices/catalog' ? {status:'complete',counts:{ready:3}} : []};
  };
  await w.get(resetId).events.click();
  const reset=requests.find(call=>call.url==='/admin/devices/reset');
  assert.equal(reset.options.method,'POST');
  assert.deepEqual(JSON.parse(reset.options.body),{confirm:'RESET DB'});
  assert.equal(reset.options.headers['X-CSRF-Token'],'csrf');
  assert.match(w.get('admin-catalog-progress').textContent,/3 ready/);
  assert.equal(w.get('admin-reset-db').disabled,false);
});

for (const updateId of ['admin-update-db']) test(`${updateId} checks online without resetting the database`,async()=>{
  const w=setup();await w.context.window.adminConsole.open();
  const requests=[];
  w.context.fetch=async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>url==='/admin/devices/update' ? {message:'Checking online'} :
      url==='/devices/catalog' ? {status:'complete',counts:{ready:3},updating:0,update_errors:1} : []};
  };
  await w.get(updateId).events.click();
  const update=requests.find(call=>call.url==='/admin/devices/update');
  assert.equal(update.options.method,'POST');
  assert.equal(update.options.headers['X-CSRF-Token'],'csrf');
  assert.equal(requests.some(call=>call.url==='/admin/devices/reset'),false);
  assert.match(w.get('admin-catalog-progress').textContent,/1 need retry/);
  assert.equal(w.get('admin-update-db').disabled,false);
});

test('editor buttons expose pressed states and preserve device drafts when hidden and shown',async()=>{
  const w=setup({devices:[{key:'a',device_id:'a',device_name:'Instrument A',status:'ready',categories:['Liquid handling']}]});
  await w.context.window.adminConsole.open();
  let detailReads=0;
  w.context.fetch=async()=>{detailReads++;return {ok:true,json:async()=>({profile:{features:['Pipetting'],categories:['Liquid handling'],constraints:[]}})};};
  let deckOpen=false;
  w.context.window.adminDeckEditor={toggle:async()=>{deckOpen=!deckOpen;},isOpen:()=>deckOpen};
  const row=w.get('admin-devices').children[0];
  const edit=row.children.find(child=>child.textContent==='Edit device');
  const deck=row.children.find(child=>child.textContent==='Edit deck');
  assert.equal(edit.attributes['aria-pressed'],'false');assert.equal(deck.attributes['aria-pressed'],'false');
  await edit.events.click();
  const form=row.children.find(child=>child.className==='admin-editor');
  assert.equal(edit.attributes['aria-pressed'],'true');assert.equal(form.hidden,false);
  const input=form.children[0].children[0];input.value='Draft feature';
  await edit.events.click();
  assert.equal(edit.attributes['aria-pressed'],'false');assert.equal(form.hidden,true);
  await edit.events.click();
  assert.equal(edit.attributes['aria-pressed'],'true');assert.equal(input.value,'Draft feature');assert.equal(detailReads,1);
  const currentButton=name=>w.get('admin-devices').children[0].children.find(child=>child.textContent===name);
  await deck.events.click();assert.equal(currentButton('Edit deck').attributes['aria-pressed'],'true');
  assert.equal(w.get('admin-device-deck').parentElement,w.get('admin-devices').children[0]);
  await currentButton('Edit deck').events.click();assert.equal(currentButton('Edit deck').attributes['aria-pressed'],'false');
  assert.equal(currentButton('Edit device').attributes['aria-pressed'],'true');
  assert.equal(input.value,'Draft feature');
});

test('opening a deck from the full list mounts it inside the selected card and survives refresh',async()=>{
  const w=setup({devices:[
    {key:'a',device_id:'a',device_name:'Instrument A',status:'ready',categories:['Liquid handling']},
    {key:'b',device_id:'b',device_name:'Instrument B',status:'ready',categories:['Liquid handling']}
  ]});
  await w.context.window.adminConsole.open();
  const panel=w.get('admin-device-deck');let openKey=null;
  w.context.window.adminDeckEditor={toggle:async key=>{openKey=openKey===key ? null : key;panel.hidden=!openKey;return true;},isOpen:key=>key===openKey};
  const first=w.get('admin-devices').children[0];
  const toggle=first.children.find(child=>child.textContent==='Edit deck');
  await toggle.events.click();
  assert.equal(w.get('admin-devices').children.length,2);
  await toggle.events.click();
  assert.equal(w.get('admin-devices').children.length,2);
  assert.equal(panel.hidden,true);
  await toggle.events.click();
  assert.equal(panel.parentElement,w.get('admin-devices').children[0]);
  assert.equal(panel.hidden,false);
  await w.context.window.adminConsole.open();
  assert.equal(panel.parentElement,w.get('admin-devices').children[0]);
  assert.equal(panel.hidden,false);
});

test('deck toggles preserve the search on the flat device list',async()=>{
  const w=setup({devices:[
    {key:'a',device_id:'a',device_name:'Instrument A',status:'ready',categories:['Liquid handling']},
    {key:'b',device_id:'b',device_name:'Instrument B',status:'ready',categories:['Imaging']}
  ]});
  await w.context.window.adminConsole.open();
  const search=w.get('admin-device-search');search.value='Instrument A';search.events.input();
  let open=false;
  w.context.window.adminDeckEditor={toggle:async()=>{open=!open;return true;},isOpen:()=>open};
  const toggle=w.get('admin-devices').children[0].children.find(child=>child.textContent==='Edit deck');
  await toggle.events.click();await toggle.events.click();
  assert.equal(w.get('admin-devices').children.length,1);
  assert.equal(search.value,'Instrument A');
  search.value='';search.events.input();
  assert.equal(w.get('admin-devices').children.length,2);
});

test('model update policies show per task and persist independently of manual selection',async()=>{
  const w=setup({models:{roles:[
    {role:'documentation',label:'Documentation model',detail:'Finding documentation',model:'gpt-6.2-sol',default:'gpt-6.2-sol',model_class:'sol',auto_update:'off'},
    {role:'light',label:'Light model',detail:'Classification',model:'gpt-4o-mini',default:'gpt-4o-mini',model_class:'mini',auto_update:'off'}
  ],catalog:{models:[]}}});
  w.context.window.adminConsole.selectTab('models');
  await tick();
  const find=(node,label)=>node.attributes['aria-label']===label ? node : node.children.map(child=>find(child,label)).find(Boolean);
  let policy=find(w.get('admin-models'),'Documentation model automatic updates');
  assert.equal(policy.value,'off');
  assert.deepEqual(policy.children.map(option=>option.value),['off','cheaper','always']);
  assert.match(w.text(w.get('admin-models')),/Model class: sol/);
  policy.value='cheaper';
  await policy.events.change();
  const request=w.calls.find(call=>call.options.method==='PATCH');
  assert.deepEqual(JSON.parse(request.options.body),{updates:{documentation:'cheaper'}});
  assert.equal(find(w.get('admin-models'),'Documentation model automatic updates').value,'cheaper');
  assert.equal(find(w.get('admin-models'),'Light model automatic updates').value,'off');
  assert.equal(w.state.models.roles[0].model,'gpt-6.2-sol');
  policy=find(w.get('admin-models'),'Documentation model automatic updates');
  w.state.modelError=true;
  policy.value='always';
  await policy.events.change();
  assert.equal(policy.value,'cheaper');
  assert.match(w.get('admin-feedback').textContent,/Unable to save/);
});

test('model dropdowns put newer releases first without pinning the selected model or default',async()=>{
  const w=setup({models:{roles:[{role:'main',label:'Main model',model:'gpt-5.4',default:'gpt-4o-mini'}],catalog:{models:[
    {id:'gpt-5.4',released_at:'2026-03-05'},
    {id:'gpt-5.4-mini',released_at:'2026-03-17'},
    {id:'gpt-6.2-sol',released_at:'2026-10-01'},
    {id:'gpt-4o-mini',released_at:'2024-07-18'},
    {id:'gpt-9-sol'},{id:'gpt-10-sol'}
  ]}}});
  w.context.window.adminConsole.selectTab('models');await tick();
  const row=w.get('admin-models').children.find(child=>child.children[0]?.textContent==='Main model');
  const select=row.children.find(child=>child.attributes['aria-label']==='Main model model');
  assert.deepEqual(select.children.map(option=>option.value),[
    'gpt-6.2-sol','gpt-5.4-mini','gpt-5.4','gpt-4o-mini','gpt-10-sol','gpt-9-sol'
  ]);
  assert.equal(select.value,'gpt-5.4');
});

test('Users tab saves separate zero and unlimited daily allowances', async () => {
  const users = [{id:1, first_name:'First', email:'first@example.test', daily_api_limit:0.5},
    {id:2, first_name:'Second', email:'second@example.test', daily_api_limit:null}];
  const w = setup({users});
  await w.context.window.adminConsole.open();
  const flatten = root => [root, ...root.children.flatMap(flatten)];
  for (const [index, unlimited, expected] of [[0,false,0], [1,true,null]]) {
    const row = w.get('admin-users').children[index];
    await flatten(row).find(item => item.textContent === 'Edit user').events.click();
    const controls = flatten(row);
    const amount = controls.find(item => item.type === 'number');
    const checkbox = controls.find(item => item.attributes['aria-label'] === 'Unlimited daily allowance');
    amount.value = '0'; checkbox.checked = unlimited; checkbox.events.change();
    assert.equal(amount.disabled, unlimited);
    await controls.find(item => item.textContent === 'Save changes').events.click();
    const call = w.calls.filter(call => call.url === `/admin/users/${index+1}` && call.options.method === 'PATCH').at(-1);
    assert.equal(JSON.parse(call.options.body).daily_api_limit, expected);
  }
  assert.equal(users[0].daily_api_limit, 0);
  assert.equal(users[1].daily_api_limit, null);
  assert.match(w.text(w.get('admin-users')), /Unlimited/);
  assert.doesNotMatch(w.text(w.get('admin-models')), /Daily allowance/);
});


test('Devices tab automatically adds discoveries and preserves search and editor drafts',async()=>{
  const first={key:'a',device_id:'a',device_name:'Instrument A',status:'ready',features:['Pipetting']};
  const w=setup({devices:[first]});
  await w.context.window.adminConsole.open();
  w.context.window.adminConsole.selectTab('devices');
  assert.equal(w.timers.size,1);
  const poll=async()=>{
    const [id,callback]=[...w.timers.entries()][0];w.timers.delete(id);await callback();
  };
  const row=w.get('admin-devices').children[0];
  await poll();
  assert.equal(w.get('admin-devices').children[0],row,'unchanged responses leave the live DOM in place');
  const originalFetch=w.context.fetch;
  w.context.fetch=async(url,options)=>url==='/admin/devices/a'
    ? {ok:true,json:async()=>({profile:{features:['Pipetting'],constraints:[]}})} : originalFetch(url,options);
  await row.children.find(child=>child.textContent==='Edit device').events.click();
  const form=row.children.find(child=>child.className==='admin-editor');
  form.children[0].children[0].value='Unsaved feature';
  const search=w.get('admin-device-search');search.value='instrument';search.events.input();
  w.state.devices=[first,{key:'b',device_id:'b',device_name:'Instrument B',status:'ready'}];
  await poll();
  assert.equal(w.get('admin-devices').children.length,2);
  assert.equal(search.value,'instrument');
  assert.equal(form.children[0].children[0].value,'Unsaved feature');
  assert.equal(form.parentElement,w.get('admin-devices').children[0]);
  w.context.window.adminConsole.selectTab('users');
  assert.equal(w.timers.size,0);
});
