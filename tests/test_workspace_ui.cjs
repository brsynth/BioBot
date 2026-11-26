const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/workspace.js`, 'utf8');

function setup() {
  class Element {
    constructor() {this.children = []; this.events = {}; this.value = ''; this.style = {}; this.dataset = {}; this.classes = new Set(); this.classList = {
      add: (...names) => names.forEach(n => this.classes.add(n)), remove: (...names) => names.forEach(n => this.classes.delete(n)), contains: n => this.classes.has(n), toggle:(name,on)=>on ? this.classes.add(name) : this.classes.delete(name),
    };}
    get options() {return this.children;}
    addEventListener(name, fn) {this.events[name] = fn;}
    append(...items) {this.children.push(...items);}
    appendChild(item) {this.children.push(item); return item;}
    replaceChildren(...items) {this.children = items;}
    querySelector() {return null;}
    cloneNode() {return new Element();}
    setAttribute() {}
    removeAttribute() {}
    remove() {}
    focus() {}
    select() {}
    showModal() {this.open = true;}
    close() {this.open = false;}
  }
  const elements = new Map();
  const get = id => {if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);};
  const calls = [], state = {code:null, pending:false, layout:null};
  let deviceResult, validationResult, catalogResults = [];
  const saved = [], trashed = []; 
  const context = vm.createContext({
    document: {getElementById:get, body:get('body'), querySelector:selector=>selector==='.parameters-hint' ? null : get('logo'), createElement:()=>new Element(), createTextNode:text=>({textContent:text})},
    Option: function(text,value) {this.textContent = text; this.value = value;},
    window: {getWorkspaceProtocol:()=>state, showDeviceDeck:layout=>{state.layout = layout; context.window.workspace.deckChanged(layout);},
      parseDeckFromCode:async code=>{state.code = code; context.window.workspace.syncActions();}},
    console, DOMException, AbortController, setTimeout:()=>1, clearTimeout(){}, localStorage:{setItem() {}}, navigator:{clipboard:{writeText:async code=>calls.push({copied:code})}},
    userInputElem:get('input'), sendBtn:get('send'), chatHistoryElem:get('history'), currentChatId:null, isTyping:false,
    refreshChatList:async()=>[], selectChatListItem() {}, addMessage:()=>get('message'), alert:message=>{throw Error(message);}, confirm:()=>true,
    fetch:async(url, options={})=>{
      const data = options.body ? JSON.parse(options.body) : null;
      calls.push({url,data,method:options.method});
      let value;
      if (url.startsWith('/devices/discovery/')) value = catalogResults.shift();
      else if (url === '/devices/catalog') value = {status:'pending',counts:{}};
      else if (url === '/devices') value = ['Robot XYZ'];
      else if (url === '/devices/validate') value = validationResult ? await validationResult : {name:data.device,device_id:'robot_xyz'};
      else if (url === '/protocols' && options.method === 'POST') {saved.push({...data,id:'saved'}); value = {id:'saved',name:data.name};}
      else if (url === '/chats?trashed=1') value = [{chat_id:'trashed-chat',name:'Old chat',deleted_at:'2026-11-08T12:00:00+00:00'}];
      else if (url === '/protocols?trashed=1') value = trashed;
      else if (url === '/protocols/saved/restore') {saved.push({...trashed.pop(),device:'Robot XYZ'}); value = {success:true};}
      else if (url === '/protocols') value = saved.map(p=>({id:p.id,name:p.name,device_name:p.device}));
      else if (url === '/protocols/saved' && options.method === 'PATCH') {saved[0].name = data.name; value = {name:data.name};}
      else if (url === '/protocols/saved' && options.method === 'DELETE') {trashed.push(...saved.splice(0).map(protocol=>({...protocol,deleted_at:'2026-11-08T13:00:00+00:00'}))); value = {success:true};}
      else if (url === '/protocols/saved') value = {name:saved[0].name,device_name:saved[0].device,code:saved[0].code};
      else if (url === '/chat') value = {chat_id:'new-chat'};
      else if (url.endsWith('/device')) value = deviceResult ? await deviceResult : {platform:'Robot XYZ',layout_type:'grid',positions:[]};
      else throw Error('Unexpected request '+url);
      return {ok:true,json:async()=>value};
    },
  });
  context.createNewChat = async()=>{context.currentChatId = null; context.window.workspace.landing();};
  vm.runInContext(source, context);
  context.window.workspace.landing();
  return {context, get, calls, state, saved, deferDevice:promise=>deviceResult=promise, deferValidation:promise=>validationResult=promise, deferCatalog:results=>catalogResults=results};
}
const tick = () => new Promise(setImmediate);

test('landing asks for a device, attaches it, and opens chat only after the protocol answer',async()=>{
  const w=setup();await tick();
  assert.equal(await w.context.window.workspace.startDevice('Robot XYZ'),true);
  assert.equal(w.context.currentChatId,null);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(w.get('landing-device-attachment').hidden,false);
  assert.equal(w.get('landing-device-name').textContent,'Robot XYZ');
  assert.match(w.get('landing-question').textContent,/protocol/);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  assert.equal(await w.context.window.workspace.startDevice('Prepare a dilution'),false);
  assert.equal(w.context.currentChatId,'new-chat');
  assert.equal(w.context.document.body.classList.contains('landing'),false);
  assert.equal(w.calls.find(call=>call.url==='/chat').data.prepare_device,true);
});

test('the attached device can be edited while preserving the protocol draft',async()=>{
  const w=setup();await tick();
  await w.context.window.workspace.selectLandingDevice('Robot XYZ',true);
  w.get('input').value='Dilute the sample tenfold';
  w.get('landing-device-attachment').events.click();
  assert.match(w.get('landing-question').textContent,/device/);
  assert.equal(w.context.window.workspace.choosingDevice,true);
  await w.context.window.workspace.selectLandingDevice('Other Model',true);
  assert.equal(w.get('input').value,'Dilute the sample tenfold');
  assert.equal(w.get('landing-device-name').textContent,'Other Model');
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
});

test('saved protocols open as fixed library snapshots and create a chat only when explicitly edited', async()=>{
  const w = setup(); await tick();
  w.state.code = 'updated protocol';
  w.context.window.workspace.deckChanged({platform:'Robot XYZ'});
  w.get('protocol-save-btn').events.click();
  assert.equal(w.get('save-protocol-dialog').open, true);
  w.get('protocol-name').value = 'My experiment';
  await w.get('save-protocol-form').events.submit({preventDefault(){},submitter:{}});
  assert.equal(w.saved[0].code, 'updated protocol');
  assert.equal(w.saved[0].name, 'My experiment');
  assert.equal(w.get('save-protocol-dialog').open, false);
  await w.get('protocol-list').children[0].children[0].children[0].events.click();
  assert.equal(w.context.currentChatId, null);
  assert.equal(w.calls.some(call=>call.url==='/chat'), false);
  assert.equal(w.context.window.workspace.readOnly, true);
  assert.equal(w.context.document.body.classList.contains('protocol-library-view'), true);
  assert.equal(w.get('protocol-edit-chat-btn').hidden, false);
  await w.get('protocol-edit-chat-btn').events.click();
  assert.equal(w.context.window.workspace.readOnly, false);
  assert.equal(w.context.document.body.classList.contains('protocol-library-view'), false);
  assert.equal(w.calls.filter(c=>c.url==='/chat').at(-1).data.protocol_id, 'saved');
  assert.equal(w.state.code, 'updated protocol');
});

test('saved protocols rename inline, move to combined Trash with type badges, and restore without changing open code', async()=>{
  const w = setup(); await tick();
  w.state.code = 'keep this protocol';
  w.get('protocol-name').value = 'Original';
  await w.get('save-protocol-form').events.submit({preventDefault(){},submitter:{}});
  const row = w.get('protocol-list').children[0];
  await row.children[1].children[0].events.click();
  const input = row.children[0].children[1];
  input.value = 'Renamed';
  input.events.keydown({key:'Enter',preventDefault(){}});
  await tick();
  assert.equal(w.saved[0].name, 'Renamed');
  assert.equal(row.children[0].children[0].children[0].textContent, 'Renamed');
  await row.children[1].children[1].events.click();
  assert.equal(w.saved.length, 0);
  assert.equal(w.get('protocol-list').children[0].textContent, 'Protocols you save will appear here.');
  assert.equal(w.state.code, 'keep this protocol');
  const trashRows = w.get('trash-list').children;
  assert.deepEqual(trashRows.map(row=>row.children[1].textContent), ['protocol', 'chat']);
  await trashRows[0].children[2].events.click();
  assert.equal(w.saved[0].name, 'Renamed');
  assert.equal(w.get('trash-list').children.length, 1);
});

test('pending code edits disable exporting, and only physical deck data accompanies generation', async()=>{
  const w = setup(); await tick();
  w.state.code = 'protocol'; w.state.pending = true;
  w.state.layout = {platform:'Robot XYZ',layout_type:'spatial',workspace:{width:100,height:80,label:'Discovered context'},positions:[],_protocol_code:'private code',_library:{author:'someone'},steps:[{volume:'10 uL'}]};
  w.context.window.workspace.syncActions();
  assert.equal(w.get('protocol-copy-btn').disabled, true);
  assert.equal(w.get('protocol-save-btn').disabled, true);
  assert.equal(w.context.window.workspace.busy, true);
  const layout = w.context.window.workspace.generationLayout();
  assert.equal(layout.platform, 'Robot XYZ');
  assert.equal(layout.workspace.label, 'Discovered context');
  for (const key of ['_protocol_code','_library','steps']) assert.equal(key in layout, false);
});

test('a slow device response cannot reopen a deck after starting a new chat', async()=>{
  const w = setup(); await tick();
  w.context.window.workspace.enterChat();
  let finish;
  w.deferDevice(new Promise(resolve=>finish=resolve));
  const choosing = w.context.window.workspace.chooseDevice('Robot XYZ');
  await tick();
  await w.context.createNewChat();
  finish({platform:'Robot XYZ'});
  await choosing;
  assert.equal(w.state.layout, null);
  assert.equal(w.context.document.body.classList.contains('landing'), true);
});


test('choosing a cached device keeps the protocol question on landing without opening a chat', async()=>{
  const w=setup(); await tick();
  assert.equal(w.get('device-select').options[0].textContent,'Selected device');
  w.get('device-select').value='Robot XYZ'; w.get('device-select').events.change();
  await tick();
  assert.equal(w.context.currentChatId,null);
  assert.equal(w.state.layout,null);
  assert.match(w.get('landing-question').textContent,/protocol/);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(w.calls.some(call=>call.url?.endsWith('/stream')),false);
});

test('right-panel name actions rename and trash the saved protocol without changing its code', async()=>{
  const w=setup(); await tick();
  w.state.code='fixed protocol';
  w.get('protocol-name').value='Original';
  await w.get('save-protocol-form').events.submit({preventDefault(){},submitter:{}});
  await w.get('protocol-list').children[0].children[0].children[0].events.click();
  w.get('deck-name-rename').events.click();
  const input=w.get('deck-name').children.at(-1);
  input.value='Renamed protocol';
  input.events.keydown({key:'Enter',preventDefault(){}});
  await tick();
  assert.equal(w.get('deck-heading').textContent,'Renamed protocol');
  assert.equal(w.saved[0].name,'Renamed protocol');
  assert.equal(w.saved[0].code,'fixed protocol');
  assert.equal(w.context.window.workspace.readOnly,true);
  await w.get('deck-name-trash').events.click();
  assert.equal(w.saved.length,0);
  assert.equal(w.context.window.workspace.readOnly,false);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
});

test('right-panel Trash targets the active chat', async()=>{
  const w=setup(); await tick();
  w.context.currentChatId='active-chat';
  let trashed;
  w.context.trashChat=async id=>trashed=id;
  await w.get('deck-name-trash').events.click();
  assert.equal(trashed,'active-chat');
});

test('opening a chat always opens the deck frame before any layout or protocol exists', async()=>{
  const w=setup(); await tick();
  let opened=0;
  w.context.window.ensureDeckWorkspace=()=>opened++;
  w.context.currentChatId='existing-chat';
  w.context.window.workspace.enterChat();
  assert.equal(opened,1);
  assert.equal(w.state.code,null);
  assert.equal(w.state.layout,null);
  assert.equal(w.context.document.body.classList.contains('landing'),false);
});

test('a failed device load replaces the deck spinner with a retry action and releases the composer', async()=>{
  const w=setup(); await tick();
  w.context.window.workspace.enterChat();
  let reject;
  w.deferDevice(new Promise((resolve,fail)=>reject=fail));
  let error;
  w.context.window.showDeckLoadError=(message,retry)=>error={message,retry};
  const opening=w.context.window.workspace.chooseDevice('Robot XYZ');
  await tick(); reject(new Error('Device service unavailable')); await opening;
  assert.equal(error.message,'Device service unavailable');
  assert.equal(typeof error.retry,'function');
  assert.equal(w.context.window.workspace.busy,false);
  assert.equal(w.get('send').disabled,false);
});


test('the landing page and typed device stay in place until dispatch validation succeeds', async()=>{
  const w=setup(); await tick();
  let validate;
  w.deferValidation(new Promise(resolve=>validate=resolve));
  w.get('input').value='Robot XYZ';
  let opened=0; w.context.window.openDeviceWorkspace=()=>opened++;
  const choosing=w.context.window.workspace.chooseDevice('Robot XYZ');
  await tick();
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(w.get('input').value,'Robot XYZ');
  assert.equal(w.context.currentChatId,null);
  assert.equal(opened,0);
  assert.match(w.get('device-choice-status').textContent,/Checking/);
  validate({name:'Robot XYZ',device_id:'robot_xyz'}); await choosing;
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.match(w.get('landing-question').textContent,/protocol/);
  assert.equal(opened,0);
  await w.context.window.workspace.startDevice('Prepare a dilution');
  assert.equal(w.context.document.body.classList.contains('landing'),false);
  assert.equal(opened,1);
});

test('a rejected device stays on landing with correction guidance and creates no deck or chat', async()=>{
  const w=setup(); await tick();
  let reject;
  w.deferValidation(new Promise((resolve,fail)=>reject=fail));
  w.get('input').value='unrelated equipment';
  const choosing=w.context.window.workspace.chooseDevice('unrelated equipment');
  reject(new Error('Enter a liquid handler model.')); await choosing;
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(w.get('input').value,'unrelated equipment');
  assert.equal(w.get('device-choice-status').textContent,'Enter a liquid handler model.');
  assert.equal(w.context.currentChatId,null);
  assert.equal(w.state.layout,null);
  assert.equal(w.get('send').disabled,false);
  assert.equal(w.calls.some(call=>call.url==='/chat' || call.url?.endsWith('/device')),false);
});

test('only an empty chat without a device or a running task needs device choice on restore',async()=>{
  const w=setup(); await tick();
  w.context.window.workspace.rememberChat({chat_id:'empty',device:null,has_messages:false,run:null});
  w.context.window.workspace.rememberChat({chat_id:'configured',device:'Robot XYZ',has_messages:false,run:null});
  w.context.window.workspace.rememberChat({chat_id:'started',device:null,has_messages:true,run:null});
  assert.equal(w.context.window.workspace.needsDevice('empty'),true);
  assert.equal(w.context.window.workspace.needsDevice('configured'),false);
  assert.equal(w.context.window.workspace.needsDevice('started'),false);
});


test('background device preparation finishes on landing without opening its chat', async()=>{
  const w=setup(); await tick();
  w.context.setTimeout=(callback,delay)=>delay===1000 ? setImmediate(callback) : 1;
  w.deferValidation(Promise.resolve({catalog_job:'robotxyz',status:'building',name:'Robot XYZ'}));
  w.deferCatalog([{catalog_job:'robotxyz',status:'building',name:'Robot XYZ'},
    {catalog_job:'robotxyz',status:'ready',name:'Robot XYZ',device_id:'robot_xyz'}]);
  await w.context.window.workspace.chooseDevice('Robot XYZ');
  const polls=w.calls.map((call,index)=>({call,index})).filter(({call})=>call.url.startsWith('/devices/discovery/'));
  assert.equal(polls.length,2);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  assert.equal(w.state.layout,null);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.match(w.get('landing-question').textContent,/protocol/);
});

test('a failed catalog entry displays its error and creates no chat', async()=>{
  const w=setup(); await tick();
  w.deferValidation(Promise.resolve({catalog_job:'robotxyz',status:'failed',error:'Programmability could not be verified.'}));
  await w.context.window.workspace.chooseDevice('Robot XYZ');
  assert.match(w.get('device-choice-status').textContent,/could not be verified/);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  assert.equal(w.get('send').disabled,false);
});


test('a saved device stays on landing after validation until the protocol is submitted', async()=>{
  const w=setup(); await tick();
  let ready;
  w.deferValidation(new Promise(resolve=>ready=resolve));
  const opening=w.context.window.workspace.chooseDevice('Robot XYZ',null,true);
  await tick();
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  ready({name:'Robot XYZ',device_id:'robot_xyz',status:'ready'});
  await opening;
  assert.equal(w.calls.filter(call=>call.url==='/chat').length,0);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(await w.context.window.workspace.startDevice('  '),true);
  assert.equal(w.calls.filter(call=>call.url==='/chat').length,0);
  await w.context.window.workspace.startDevice('Prepare a dilution');
  assert.equal(w.calls.filter(call=>call.url==='/chat').length,1);
});

test('Enter submission resolves cached landing names before falling back to checking an unknown device',async()=>{
  const w=setup();await tick();
  const resolved=[];
  w.context.window.landingEquipment={resolve:name=>{resolved.push(name);return name==='model 10'?{name:'Maker Model 10'}:null;},dismissSearch(){}};
  await w.context.window.workspace.startDevice('model 10');
  assert.equal(w.calls.find(call=>call.url==='/devices/validate').data.device,'Maker Model 10');
  w.context.window.workspace.landing();
  await w.context.window.workspace.startDevice('Unknown device');
  const validations=w.calls.filter(call=>call.url==='/devices/validate');
  assert.equal(validations[1].data.device,'Unknown device');
  assert.deepEqual(resolved,['model 10','Unknown device']);
});


test('submission dismisses autocomplete and shows a checking status while awaiting validation',async()=>{
  const w=setup();await tick();
  let release,checks=0;
  w.context.window.landingEquipment={beginCheck(){checks++;},resolve:()=>null};
  w.deferValidation(new Promise(resolve=>release=resolve));
  const opening=w.context.window.workspace.startDevice('SeriesA');await tick();
  assert.equal(checks,1);
  assert.match(w.get('device-choice-status').textContent,/Checking/);
  release({incomplete:true,scope:'series',query:'SeriesA',message:'Choose an exact model.',options:['Maker SeriesA 10','Maker SeriesA 20'],options_source:'saved'});
  await opening;
  assert.match(w.get('device-choice-status').textContent,/exact physical model/);
  assert.equal(w.get('device-model-choices').children.length,2);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
});

test('Enter lists exact models directly and a series suggestion exposes its members without registration',async()=>{
  const w=setup();await tick();
  const group={kind:'series',name:'Maker A Series',programming_interface:'Shared command API',protocol_format:'Transfer schema',
    members:[{kind:'model',name:'Maker A10'},{kind:'model',name:'Maker A10T Plus'}]};
  w.deferValidation(Promise.resolve({incomplete:true,scope:'series',choices:[group,{kind:'model',name:'Maker B20'}]}));
  await w.context.window.workspace.startDevice('Maker');
  const box=w.get('device-model-choices');
  assert.deepEqual(box.children.map(button=>button.textContent),['Maker A10','Maker A10T Plus','Maker B20']);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  w.context.window.workspace.chooseSeries(group);
  assert.deepEqual(box.children.map(button=>button.textContent),['Maker A10','Maker A10T Plus']);
  assert.match(w.get('device-choice-status').textContent,/Maker A Series/);
  assert.equal(w.calls.filter(call=>call.url==='/devices/validate').length,1);
  w.deferValidation(Promise.resolve({name:'Maker A10T Plus',device_id:'maker_a10t_plus'}));
  await box.children[1].events.click();
  const requested=w.calls.filter(call=>call.url==='/devices/validate').map(call=>call.data.device);
  assert.deepEqual(requested,['Maker','Maker A10T Plus']);
});

test('device preparation keeps its deadline active while validation is pending',async()=>{
  const w=setup();await tick();
  let released,cleared=false,deadline;
  w.context.setTimeout=(callback,ms)=>{deadline={callback,ms};return deadline;};
  w.context.clearTimeout=timer=>{if(timer===deadline)cleared=true;};
  w.deferValidation(new Promise(resolve=>released=resolve));
  const opening=w.context.window.workspace.chooseDevice('Robot XYZ',null,true);
  await tick();
  assert.equal(deadline.ms,90000);
  assert.equal(cleared,false);
  released({name:'Robot XYZ',device_id:'robot_xyz',status:'ready'});
  await opening;
  assert.equal(cleared,true);
});

test('a family discovered during preparation presents exact models without an error or chat',async()=>{
  const w=setup();await tick();
  w.context.setTimeout=(callback,delay)=>delay===1000 ? setImmediate(callback) : 1;
  w.deferValidation(Promise.resolve({catalog_job:'family',status:'building',name:'Maker Family'}));
  w.deferCatalog([{catalog_job:'family',status:'failed',incomplete:true,options:['Maker A10','Maker A20']}]);
  await w.context.window.workspace.chooseDevice('Maker Family');
  assert.deepEqual(w.get('device-model-choices').children.map(button=>button.textContent),['Maker A10','Maker A20']);
  assert.equal(w.get('device-choice-status').classList.contains('is-error'),false);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
});

test('device preparation appears in history without opening chat when the wait times out',async()=>{
  const w=setup();await tick();let expire;
  w.context.setTimeout=(callback,delay)=>{if(delay===90000)expire=callback;return 1;};
  w.deferValidation(Promise.resolve({catalog_job:'robotxyz',status:'building',name:'Robot XYZ',chat_id:'preparing-chat'}));
  const opening=w.context.window.workspace.chooseDevice('Robot XYZ');await tick();
  assert.equal(w.context.currentChatId,null);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(w.calls.some(call=>call.url==='/chat'),false);
  expire();await opening;
  assert.match(w.get('device-choice-status').textContent,/History/);
  assert.equal(w.context.currentChatId,null);
  assert.equal(w.context.document.body.classList.contains('landing'),true);
});

test('protocol submission opens chat while selected-device preparation is still running',async()=>{
  const w=setup();await tick();let verified;
  w.deferValidation(new Promise(resolve=>verified=resolve));
  const preparation=w.context.window.workspace.selectLandingDevice('Robot XYZ',true);
  await tick();
  assert.equal(w.context.document.body.classList.contains('landing'),true);
  assert.equal(w.get('landing-device-name').textContent,'Robot XYZ');
  assert.equal(w.context.window.workspace.busy,false);
  assert.equal(w.context.window.workspace.choosingDevice,false);
  assert.equal(await w.context.window.workspace.startDevice('Prepare a dilution'),false);
  assert.equal(w.context.document.body.classList.contains('landing'),false);
  assert.equal(w.context.currentChatId,'new-chat');
  verified({status:'ready',name:'Robot XYZ',device_id:'robot_xyz'});
  await preparation;await tick();
  assert.equal(w.calls.filter(call=>call.url==='/chat').length,1);
});

test('one prompt containing a device and protocol opens chat without asking for the protocol again', async () => {
  const w = setup(); await tick();
  const prompt = 'DNA dilution, make an example, on Maker Model 10';
  w.deferValidation(Promise.resolve({name:'Maker Model 10',device_id:'maker_model10',status:'ready',has_protocol_request:true}));
  assert.equal(await w.context.window.workspace.startDevice(prompt), false);
  const validation = w.calls.find(call => call.url === '/devices/validate');
  assert.equal(validation.data.prompt, prompt);
  assert.equal(w.context.window.workspace.deviceContext, 'Maker Model 10');
  assert.equal(w.context.document.body.classList.contains('landing'), false);
  assert.equal(w.calls.filter(call => call.url === '/chat').length, 1);
});

test('a combined request opens its chat while device preparation continues in the background', async () => {
  const w = setup(); await tick();
  w.deferValidation(Promise.resolve({name:'Maker Model 10',catalog_job:'maker10',chat_id:'preparing-chat',status:'building',has_protocol_request:true}));
  assert.equal(await w.context.window.workspace.startDevice('Dilute DNA on Maker Model 10'), false);
  assert.equal(w.context.currentChatId, 'preparing-chat');
  assert.equal(w.context.window.workspace.deviceContext, 'Maker Model 10');
  assert.equal(w.context.document.body.classList.contains('landing'), false);
  assert.equal(w.calls.some(call => call.url === '/chat'), false);
  await tick(); w.context.window.workspace.landing();
});
