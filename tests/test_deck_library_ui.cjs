const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/deck_universal.js`, 'utf8');
const questions = fs.readFileSync(`${__dirname}/../biobot/static/questions_renderer.js`, 'utf8');
const quantityParser = questions.slice(questions.indexOf('function parseQuestionQuantity('), questions.indexOf('// Numeric relationships'));

function element(tag) {
  const node = { tag, children: [], dataset: {}, style: {}, attributes: {}, events: {}, className: '',
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { return !this.validationMessage; },
    addEventListener(name, fn) { this.events[name] = fn; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const match = node => selector === 'input:invalid' ? node.tag === 'input' && !!node.validationMessage
        : selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector;
      return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
  };
  node.classList = { add(name) { node.className += ` ${name}`; },
    remove(name) { node.className = node.className.split(' ').filter(value => value !== name).join(' '); },
    toggle(name, enabled) { enabled ? this.add(name) : this.remove(name); },
    contains(name) { return node.className.split(' ').includes(name); } };
  return node;
}
function setup() {
  const requests = [];
  const document = { createElement: element, body: { dataset: { userId: '1' } },
    addEventListener() {}, getElementById: () => null, querySelector: () => null };
  const context = vm.createContext({ window: {}, document, currentChatId: 'chat', AbortController,
    clearInterval() {}, clearTimeout() {}, setTimeout() {}, fetch: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      return { ok: true, json: async () => ({ id: 'copy', published: true }) };
    },
  });
  vm.runInContext(quantityParser + source, context);
  const renderInitialDeck = context._renderDeck;
  vm.runInContext('_renderDeck = function(state) { rendered = state; }; _removeTipOverlay = function() {}; _clearCodeBlockHighlights = function() {};', context);
  const library = { selected: { id: 'base', name: 'Device default', owner_id: null, is_default: true },
    alternatives: [{ id: 'base', name: 'Device default', author: 'BioBot', is_default: true },
                   { id: 'public', name: 'Alternative', author: 'Second user', published: true }],
    layout: { platform: 'Device', layout_type: 'grid', grid: { rows: 1, cols: 2 },
      positions: [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 0, col: 1 }] } };
  context.state = { ...structuredClone(library.layout), steps: [{ volume: '10 uL' }], _library: library };
  vm.runInContext('_currentState = state; _currentCode = "protocol";', context);
  return { context, requests, renderInitialDeck, render() {
    const wrapper = element('div');
    context._renderLibraryControls(wrapper, context.state);
    return wrapper;
  } };
}

test('deck slots retain explicit proportions instead of stretching across the view', () => {
  const w = setup();
  const slot = w.context._createSlot({id:'a',type:'empty',aspect_ratio:0.75});
  assert.equal(slot.style.aspectRatio, '0.75');
  assert.equal(w.context._createSlot({id:'b',type:'empty'}).style.aspectRatio, '1.5');
  const grid = w.context._renderGrid(w.context.state);
  assert.equal(grid.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  assert.equal(grid.style.gridTemplateRows, 'repeat(1, auto)');
});

test('a deck request timeout replaces loading with Retry and releases the busy state', async()=>{
  const w=setup(), container=element('div');
  container.replaceChildren=function(...children){this.children=children;this.innerHTML='';};
  w.context.document.getElementById=id=>id==='deck-svg-container' ? container : null;
  w.context.console={error(){}};
  let expire;
  w.context.setTimeout=fn=>{expire=fn; return 1;};
  w.context.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
  const request=w.context.parseDeckFromCode('new protocol');
  expire(); await request;
  assert.match(container.children[0].textContent,/timed out/);
  assert.equal(container.children[1].textContent,'Retry loading deck');
  assert.equal(container.inert,false);
  assert.equal(w.context.window.getWorkspaceProtocol().pending,false);
});

test('saved protocols keep parameters and hardware fixed while their playback remains available', () => {
  const w=setup();
  w.context.window.workspace={readOnly:true};
  const fields=element('div'), panel=element('details');
  fields.replaceChildren=function(){this.children=[];};
  const nodes={'protocol-parameters':panel,'protocol-parameter-fields':fields};
  w.context.document.getElementById=id=>nodes[id] || null;
  w.context.state.parameters=[{id:'volume',label:'Volume',value:'10 µL'}];
  w.context.state.instruments=[{name:'Pipette',model:'instrument_model'}];
  vm.runInContext('_renderApplyBar=function(){}; _validateProtocolParameters=function(){};',w.context);
  w.context._renderProtocolParameters(w.context.state);
  assert.equal(fields.querySelector('input').readOnly,true);
  assert.equal(fields.querySelector('button').disabled,true);
  const area=element('div');
  w.context._bindDeckArea(area,'a',{labware:'plate'});
  assert.equal(area.draggable,undefined);
  assert.deepEqual(Object.keys(area.events),[]);
  const before=JSON.stringify(w.context.state);
  w.context._moveDeckArea('a','b');
  w.context._applyChange('a','other plate','plate');
  assert.equal(JSON.stringify(w.context.state),before);
  assert.equal(w.render().children.length,0);
  assert.equal(typeof w.context._renderPlaybackControls,'function');
});

test('playback keeps occupancy per plate, fills destinations, removes tips, and rewinds cleanly', () => {
  const w=setup();
  const state={steps:[
    {action:'pickup_tip',source:{slot:'tips',wells:['A1']}},
    {action:'transfer',source:{slot:'source',wells:['A1']},destination:{slot:'dest',wells:['A1']}},
    {action:'transfer',source:{slot:'dest',wells:['A1']},destination:{slot:'other',wells:['B2']}},
  ]};
  const initial=w.context._protocolWellState(state,-1);
  assert.equal(initial.get('source').get('A1').occupied,true);
  assert.equal(initial.get('dest').get('A1').occupied,false);
  const after=w.context._protocolWellState(state,2);
  assert.equal(after.get('tips').get('A1').occupied,false);
  assert.equal(after.get('dest').get('A1').occupied,true);
  assert.equal(after.get('other').get('B2').occupied,true);
  assert.equal(after.get('source').get('A1').occupied,true); // Unknown remaining volume is not invented.
  assert.equal(w.context._protocolWellState(state,-1).get('dest').get('A1').occupied,false);
});

test('aspirating reservoir A1 cannot highlight A1 on another plate', () => {
  const w = setup();
  const reservoir = element('div'), plateWell = element('div');
  reservoir.style.setProperty = () => {};
  plateWell.style.setProperty = () => {};
  const container = { querySelector(selector) {
    if (selector === '.deck-slot[data-id="reservoir"]') return reservoir;
    if (selector.includes('.deck-well')) return plateWell;
    return null;
  } };
  const colors = {fill:'green',glow:'green'};
  w.context._highlightSlot(container,'reservoir',colors,['A1']);
  assert.equal(reservoir.classList.contains('slot-anim-highlight'),true);
  assert.equal(plateWell.classList.contains('well-anim-active'),false);
  w.context._highlightSlot(container,'missing',colors,['A1']);
  assert.equal(plateWell.classList.contains('well-anim-active'),false);
  reservoir.querySelector = () => plateWell;
  w.context._highlightSlot(container,'reservoir',colors,['A1']);
  assert.equal(plateWell.classList.contains('well-anim-active'),true);
});

test('declared starting contents and remaining volumes control emptying at the correct step', () => {
  const w=setup();
  const state={initial_wells:[{slot:'source',well:'A1',volume_ul:20},{slot:'dest',well:'B1',volume_ul:90}],steps:[
    {action:'aspirate',source:{slot:'source',wells:['A1']},well_updates:[{slot:'source',well:'A1',volume_ul:10}]},
    {action:'aspirate',source:{slot:'source',wells:['A1']},well_updates:[{slot:'source',well:'A1',volume_ul:0}]},
  ]};
  assert.equal(w.context._protocolWellState(state,-1).get('dest').get('B1').occupied,true);
  assert.equal(w.context._protocolWellState(state,0).get('source').get('A1').occupied,true);
  assert.equal(w.context._protocolWellState(state,1).get('source').get('A1').occupied,false);
  assert.equal(w.context._protocolWellState(state,0).get('source').get('A1').volume_ul,10);
});

test('well inspection shows current liquids, volumes and tip status without opening the hardware selector', () => {
  const w=setup(), panel=element('aside'), container=element('div');
  panel.replaceChildren=function(){this.children=[];};
  const plate=element('div'), tips=element('div'), liquidWell=element('circle'), tipWell=element('circle');
  plate.dataset.id='a'; tips.dataset.id='b'; tips.className='tiprack';
  liquidWell.dataset.well='A1'; tipWell.dataset.well='B2';
  plate.appendChild(liquidWell); tips.appendChild(tipWell);
  liquidWell.className=tipWell.className='deck-well';
  container.querySelectorAll=selector=>selector==='.deck-slot[data-id]' ? [plate,tips]
    : [liquidWell,tipWell].filter(well=>well.classList.contains('well-selected'));
  w.context.document.getElementById=id=>id==='well-details' ? panel : id==='deck-svg-container' ? container : null;
  Object.assign(w.context.state,{positions:[{id:'a',type:'plate',labware:'sample_plate',labware_display:'Samples'},
    {id:'b',type:'tiprack',labware:'tips_api'}],
    initial_wells:[{slot:'a',well:'A1',volume_ul:100,liquids:[{name:'Buffer',volume_ul:80},{name:'Sample',volume_ul:20}]}],
    steps:[{action:'aspirate',source:{slot:'a',wells:['A1']},well_updates:[{slot:'a',well:'A1',volume_ul:50,liquids:[{name:'Buffer',volume_ul:40},{name:'Sample',volume_ul:10}]}]},
      {action:'pickup_tip',source:{slot:'b',wells:['B2']}}]});
  const text=node=>[node.textContent,...node.children.map(text)].filter(Boolean).join('\n');
  const texts=()=>text(panel);
  let stopped=0;
  const event={type:'click',preventDefault(){},stopPropagation(){stopped++;}};
  w.context._paintProtocolWells(w.context.state,-1);
  liquidWell.events.click(event);
  assert.equal(stopped,1);
  assert.equal(panel.hidden,false);
  assert.match(texts(),/Well A1/);
  assert.match(texts(),/Total volume: 100 µL/);
  assert.match(texts(),/Buffer: 80 µL/);
  assert.equal(liquidWell.attributes['aria-pressed'],'true');
  w.context._paintProtocolWells(w.context.state,0);
  assert.match(texts(),/Total volume: 50 µL/);
  assert.match(texts(),/Sample: 10 µL/);
  tipWell.events.keydown({...event,type:'keydown',key:'Enter'});
  assert.match(texts(),/Tip present/);
  w.context._paintProtocolWells(w.context.state,1);
  assert.match(texts(),/No tip/);
  assert.equal(texts().includes('Total volume'),false);
  panel.children[0].children[1].events.click();
  assert.equal(panel.hidden,true);
  assert.equal(tipWell.attributes['aria-pressed'],'false');
});

test('contents after an unresolved transfer never retain outdated liquid volumes', () => {
  const w=setup(), state={initial_wells:[{slot:'a',well:'A1',volume_ul:100,liquids:[{name:'Buffer',volume_ul:100}]}],
    steps:[{action:'aspirate',source:{slot:'a',wells:['A1']}}]};
  const value=w.context._protocolWellState(state,0).get('a').get('A1');
  assert.equal(value.occupied,true);
  assert.equal(value.volume_ul,undefined);
  assert.equal(value.liquids,undefined);
  assert.equal(state.initial_wells[0].volume_ul,100);
});

test('final well volumes carry through resolved transfers and survive mixing and tip disposal', () => {
  const w=setup(), state={initial_wells:[{slot:'a',well:'A1',volume_ul:100}], steps:[
    {action:'transfer',source:{slot:'a',wells:['A1']},destination:{slot:'b',wells:['B1']},
      volume_changes:[{slot:'a',well:'A1',delta_ul:-30},{slot:'b',well:'B1',delta_ul:30}]},
    {action:'aspirate',source:{slot:'b',wells:['B1']},volume_changes:[{slot:'b',well:'B1',delta_ul:-10}]},
    {action:'mix',source:{slot:'b',wells:['B1']}}, {action:'drop_tip'},
  ]};
  const final=w.context._protocolWellState(state,3);
  assert.equal(final.get('a').get('A1').volume_ul,70);
  assert.equal(final.get('b').get('B1').volume_ul,20);
  assert.equal(state.initial_wells[0].volume_ul,100);
  state.initial_wells=[];
  assert.equal(w.context._protocolWellState(state,3).get('a').get('A1').volume_ul,undefined);
  state.initial_wells=[{slot:'a',well:'A1',volume_ul:10}];
  assert.equal(w.context._protocolWellState(state,3).get('a').get('A1').volume_ul,undefined);
});

test('legacy parallel-channel dilution playback calculates every final well volume from saved unit labels', () => {
  const w=setup(), wells=column=>Array.from({length:8},(_,row)=>`${'ABCDEFGH'[row]}${column}`);
  const steps=[{action:'pickup_tip',source:{slot:'tips',wells:wells(1)}}];
  for (let column=1;column<=12;column++) steps.push(
    {action:'aspirate',source:{slot:'reservoir',wells:['A1']},volume:'0.1 mL'},
    {action:'dispense',destination:{slot:'plate',wells:wells(column)},volume:'100 μL'});
  steps.push({action:'aspirate',source:{slot:'reservoir',wells:['A2']},volume:'100µL'},
    {action:'dispense',destination:{slot:'plate',wells:wells(1)},volume:'100µL'});
  for (let column=1;column<=12;column++) steps.push(
    {action:'mix',source:{slot:'plate',wells:wells(column)},volume:'80µL'},
    {action:'aspirate',source:{slot:'plate',wells:wells(column)},volume:'100µL'},
    {action:'dispense',destination:column<12 ? {slot:'plate',wells:wells(column+1)} : {slot:'reservoir',wells:['A12']},volume:'100µL'});
  steps.push({action:'drop_tip'});
  const state={steps,initial_wells:[{slot:'reservoir',well:'A1',volume_ul:11000},{slot:'reservoir',well:'A2',volume_ul:2000},{slot:'reservoir',well:'A12',volume_ul:0}]};
  const final=w.context._protocolWellState(state,steps.length-1);
  for (const value of final.get('plate').values()) assert.equal(value.volume_ul,100);
  assert.equal(final.get('plate').size,96);
  assert.equal(final.get('reservoir').get('A1').volume_ul,1400);
  assert.equal(final.get('reservoir').get('A2').volume_ul,1200);
  assert.equal(final.get('reservoir').get('A12').volume_ul,800);
});

test('well detail drawing clips component bands to the rounded interior and rounds display volumes', () => {
  const w=setup();
  const drawing=w.context._wellDetailDrawing({liquids:[{name:'Buffer',volume_ul:80},{name:'Sample',volume_ul:20}]},false,true);
  assert.match(drawing,/height="80"/);
  assert.match(drawing,/height="20"/);
  assert.match(drawing,/clip-path="url\(#well-detail-interior\)"/);
  assert.match(drawing,/<clipPath/);
  assert.equal(w.context._formatWellVolume(33.333333333), '33.33 µL');
  assert.equal(w.context._formatWellVolume(0.000123456), '0.0001235 µL');
  assert.equal(w.context._formatWellVolume(100), '100 µL');
  assert.equal(w.context._formatWellVolume(undefined), 'volume unknown');
  assert.equal(w.context._wellDetailDrawing({},false,false).includes('<rect'),false);
  assert.match(w.context._wellDetailDrawing({},true,true),/Tip present/);
  const unknown=w.context._wellDetailDrawing({liquids:[{name:'<script>bad</script>'}]},false,true);
  assert.match(unknown,/height="100"/);
  assert.equal(unknown.includes('<script>'),false);
});

test('well information card supports bounded pointer dragging and keyboard movement', () => {
  const w=setup(), handle=element('div'), panel=element('aside');
  panel.parentElement={getBoundingClientRect:()=>({left:100,top:50,width:800,height:600})};
  panel.getBoundingClientRect=()=>({left:100+(parseFloat(panel.style.left)||500),top:50+(parseFloat(panel.style.top)||20),width:250,height:300});
  handle.setPointerCapture=()=>{};
  w.context._bindWellCardDrag(handle,panel);
  handle.events.pointerdown({button:0,target:{closest:()=>null},clientX:600,clientY:70,pointerId:1,preventDefault(){}});
  handle.events.pointermove({clientX:2000,clientY:2000});
  assert.equal(panel.style.left,'542px');
  assert.equal(panel.style.top,'292px');
  handle.events.pointerup();
  handle.events.keydown({target:handle,key:'ArrowLeft',preventDefault(){}});
  assert.equal(panel.style.left,'526px');
  assert.equal(panel.style.right,'auto');
});

test('explicit well geometry wins over names, including nonstandard counts', () => {
  const w=setup();
  const html=w.context._renderSlotInterior('plate',{id:'custom',labware:'custom_plate',well_count:48,well_rows:6,well_columns:8});
  assert.equal((html.match(/data-well=/g)||[]).length,48);
  assert.ok(html.includes('viewBox="0 0 8 6"'));
  assert.ok(html.includes('preserveAspectRatio="xMidYMid meet"'));
  assert.ok(html.includes('data-well="F8"'));
  assert.equal(w.context._renderSlotInterior('plate',{id:'unknown',labware:'custom_plate'}).includes('data-well='),false);
  assert.equal(w.context._renderSlotInterior('plate',{id:'unknown',labware:'96_well_plate'}).includes('data-well='),false);
});

test('instrument mounts come from learned capabilities and support more than two arbitrary identifiers', () => {
  const w=setup();
  w.context.state.mounts=['station_1','station_2','station_3'];
  w.context.state.instruments=[{name:'Probe',model:'probe_a',mount:'station_1'}];
  assert.deepEqual(Array.from(w.context._instrumentMounts({mounts:['station_3','arm_tool']},{mount:'station_1'})),
    ['station_3','arm_tool','station_1','station_2']);
  w.context.state.mounts=[];w.context.state.instruments=[];
  assert.deepEqual(Array.from(w.context._instrumentMounts({},{})),[]);
});

test('changing an unmounted instrument preserves unrelated unmounted instruments', () => {
  const w=setup();
  const original={name:'Probe',model:'probe_a',mount:null},other={name:'Dispenser',model:'dispenser_b',mount:null};
  w.context.state.instruments=[original,other];
  w.context._applyInstrumentChange(original,'probe_c',null);
  assert.equal(w.context.state.instruments.length,2);
  assert.ok(w.context.state.instruments.includes(other));
  assert.equal(w.context.state.instruments.find(item=>item.name==='Probe').model,'probe_c');
});

test('changing hardware uses discovered geometry and never inherits the previous model layout', () => {
  const w=setup(),pos=w.context.state.positions[0];
  Object.assign(pos,{labware:'previous',well_count:96,well_rows:8,well_columns:12});
  w.context._applyChange('a','custom','previous',{type:'plate',well_count:20,well_rows:4,well_columns:5});
  assert.equal(pos.well_count,20);assert.equal(pos.well_columns,5);
  w.context._applyChange('a','unspecified','custom');
  assert.equal(pos.well_count,undefined);assert.equal(pos.well_rows,undefined);
});

test('cached decks refresh playback and parameters without losing pending edits', async () => {
  const w = setup();
  const renders=[];
  w.context._renderDeck = state => {w.context.rendered=state;renders.push(state.steps.length);};
  const cached = {...w.context.state, _parameters_pending:true, _playback_pending:true};
  let finishParameters;
  const parameters = new Promise(resolve=>finishParameters=resolve);
  w.context.fetch = async (url, options) => ({ok:true,json:async()=>JSON.parse(options.body).refresh_parameters
    ? await parameters : cached});
  await w.context.parseDeckFromCode('protocol');
  assert.equal(w.context.rendered, cached);
  assert.equal(cached._parameters_pending, true);
  vm.runInContext('_pendingChanges = [{type:"set_parameter",parameter_id:"amount",label:"Amount",new_value:"20 µL",old_value:"10 µL"}];', w.context);
  const steps=Array.from({length:3},(_,column)=>[
    {action:'aspirate',source:{slot:'a',wells:['A1']}},
    {action:'dispense',destination:{slot:'b',wells:Array.from({length:8},(_,row)=>'ABCDEFGH'[row]+(column+1))}},
  ]).flat();
  cached.positions[0].labware='custom';
  finishParameters({...cached,positions:[{id:'a',labware:'custom',well_count:20,well_rows:4,well_columns:5}],steps,initial_wells:[{slot:'a',well:'A1',occupied:true}],parameters:[{id:'amount',label:'Amount',value:'10 µL'}]});
  await new Promise(setImmediate);
  assert.equal(cached.parameters[0].value, '20 µL');
  assert.equal(vm.runInContext('_originalState.parameters[0].value', w.context), '10 µL');
  assert.equal(cached._parameters_pending, false);
  assert.equal(cached._playback_pending, false);
  assert.deepEqual(cached.steps,steps);
  assert.deepEqual(renders,[1,6]);
  assert.equal(cached.positions[0].well_count,20);
  assert.equal(vm.runInContext('_originalState.steps.length',w.context),6);
  const filledAt=index=>[...w.context._protocolWellState(cached,index).get('b').values()].filter(well=>well.occupied).length;
  assert.equal(filledAt(0),0);
  assert.equal(filledAt(1),8);
  assert.equal(filledAt(2),8);
  assert.equal(filledAt(3),16);
  assert.equal(filledAt(5),24);
});

test('playback controls stay visible during an update and enable when it completes', () => {
  const w=setup(),panel=element('aside'),frame=element('div');
  frame.className='deck-device-frame';panel.appendChild(frame);
  w.context.document.getElementById=id=>id==='deck-panel'?panel:null;
  w.context.state._playback_pending=true;
  const cachedSteps=w.context.state.steps;
  w.context._initAnimation(w.context.state);
  assert.ok(frame.children.at(-1).querySelectorAll('button').every(button=>!button.disabled));
  w.context.state.steps=[];
  w.context._initAnimation(w.context.state);
  const pending=frame.children.at(-1);
  assert.equal(pending.querySelectorAll('button').length,6);
  assert.ok(pending.querySelectorAll('button').every(button=>button.disabled));
  assert.equal(pending.querySelector('.anim-step-desc').textContent,'Updating saved playback…');
  w.context.state._playback_pending=false;
  w.context.state.steps=cachedSteps;
  w.context._initAnimation(w.context.state);
  assert.ok(frame.children.at(-1).querySelectorAll('button').every(button=>!button.disabled));
});

test('an expired metadata update replaces the updating message with an explicit retry', async () => {
  const w=setup(),bar=element('div'),desc=element('div'),panel=element('details'),message=element('p');
  const nodes={'anim-playback-bar':bar,'anim-step-desc':desc,'protocol-parameters':panel,'protocol-parameters-error':message};
  w.context.document.getElementById=id=>nodes[id]||null;
  w.context.state._parameters_pending=true;w.context.state._playback_pending=true;
  w.context.state.steps=[];
  w.context.AbortController=class {constructor(){this.signal={aborted:true}} abort(){}};
  await w.context._loadProtocolParameters('protocol',w.context.state,'chat');
  assert.equal(w.context.state._parameters_pending,false);
  assert.equal(desc.textContent,'Playback could not be updated.');
  assert.equal(bar.querySelector('button').textContent,'Retry');
});

test('parameter checks convert compatible units, reject incompatible units, and recheck relationships live', () => {
  const w = setup();
  const fields = element('div'), panel = element('details'), error = element('p');
  fields.replaceChildren = function() { this.children = []; };
  const nodes = {'protocol-parameters':panel,'protocol-parameter-fields':fields,'protocol-parameters-error':error};
  w.context.document.getElementById = id => nodes[id] || null;
  w.context.state.parameters = [
    {id:'start',label:'Starting concentration',value:'10 mM',type:'number',unit:'mM',units:{mM:1,uM:0.001}},
    {id:'target',label:'Target concentration',value:'5 mM',type:'number',unit:'mM',units:{mM:1,uM:0.001}},
    {id:'count',label:'Replicates',value:'3',type:'number',unit:'',units:{'':1},integer:true},
  ];
  w.context.state.parameter_constraints = [{left:'target',operator:'lt',right:'start',message:'Target must be below the starting concentration.'}];
  vm.runInContext('_originalState = JSON.parse(JSON.stringify(state)); _renderApplyBar = function() {};', w.context);
  w.context._renderProtocolParameters(w.context.state);
  const inputs = fields.querySelectorAll('input');
  inputs[1].value = '500 µM'; inputs[1].events.input();
  assert.equal(error.textContent, '');
  inputs[1].value = '20 mM'; inputs[1].events.input();
  assert.match(error.textContent, /below the starting/);
  inputs[0].value = '30 mM'; inputs[0].events.input();
  assert.equal(error.textContent, '');
  inputs[1].value = '10 mL'; inputs[1].events.input();
  assert.match(error.textContent, /compatible unit/);
  inputs[1].value = '500 uM'; inputs[1].events.input();
  inputs[2].value = '2.5'; inputs[2].events.input();
  assert.match(error.textContent, /whole number/);
  inputs[2].value = '2'; inputs[2].events.input();
  assert.equal(error.textContent, '');
});

test('protocol parameters accept units and track one reversible change per input', () => {
  const w = setup();
  const fields = element('div'), panel = element('details'), error = element('p');
  fields.replaceChildren = function() { this.children = []; };
  const nodes = {'protocol-parameters': panel, 'protocol-parameter-fields': fields, 'protocol-parameters-error': error};
  w.context.document.getElementById = id => nodes[id] || null;
  w.context.state.parameters = [{id:'stock', label:'Starting concentration', value:'10 mM'}];
  vm.runInContext('_originalState = JSON.parse(JSON.stringify(state)); _renderApplyBar = function() {};', w.context);
  w.context._renderProtocolParameters(w.context.state);
  const input = fields.querySelector('input');
  assert.equal(panel.hidden, false);
  assert.equal(input.type, 'text');
  assert.equal(input.value, '10 mM');
  input.value = '5 mM'; input.events.change();
  assert.equal(vm.runInContext('_pendingChanges.length', w.context), 1);
  assert.equal(vm.runInContext('_pendingChanges[0].old_value', w.context), '10 mM');
  input.value = '2 mM'; input.events.change();
  assert.equal(vm.runInContext('_pendingChanges.length', w.context), 1);
  assert.equal(w.context.state.parameters[0].value, '2 mM');
  input.value = '10 mM'; input.events.change();
  assert.equal(vm.runInContext('_pendingChanges.length', w.context), 0);
});

test('a rejected parameter change preserves the current code and pending correction', async () => {
  const w = setup();
  const fields = element('div'), panel = element('details'), error = element('p');
  fields.replaceChildren = function() { this.children = []; };
  const nodes = {'protocol-parameters': panel, 'protocol-parameter-fields': fields, 'protocol-parameters-error': error};
  w.context.document.getElementById = id => nodes[id] || null;
  w.context.state.parameters = [{id:'amount',label:'Amount',value:'invalid quantity'}];
  vm.runInContext('_pendingChanges = [{type:"set_parameter",parameter_id:"amount",new_value:"invalid quantity"}];', w.context);
  w.context.fetch = async () => ({ok:false,json:async()=>({error:'The requested values are incompatible.'})});
  await w.context._commitChanges();
  assert.equal(vm.runInContext('_currentCode', w.context), 'protocol');
  assert.equal(vm.runInContext('_pendingChanges.length', w.context), 1);
  assert.equal(error.textContent, 'The requested values are incompatible.');
  assert.equal(fields.querySelector('input').disabled, false);
});

test('lists published alternatives with attribution and switches using the same protocol', () => {
  const w = setup();
  const select = w.render().querySelector('select');
  assert.equal(select.children[1].textContent, 'Alternative · Second user');
  let selected;
  w.context.parseDeckFromCode = (...args) => selected = args;
  select.value = 'public';
  select.events.change();
  assert.deepEqual(selected, ['protocol', null, 'public']);
});

test('the chat link toggles its active deck without reloading, and opens another protocol when needed', () => {
  const w = setup();
  const link = {};
  w.context.sourceLink = link;
  vm.runInContext('_sourceCodeBlock = sourceLink;', w.context);
  let toggled = 0, opened;
  w.context.toggleDeckPanel = () => toggled++;
  w.context.parseDeckFromCode = (...args) => opened = args;
  w.context.toggleProtocolDeck('protocol', link);
  w.context.toggleProtocolDeck('protocol', link);
  assert.equal(toggled, 2);
  assert.equal(opened, undefined);
  w.context.toggleProtocolDeck('other protocol', link);
  assert.deepEqual(opened, ['other protocol', link]);
});

test('editing creates a separate layout draft and cancel preserves protocol state', () => {
  const w = setup();
  const original = JSON.stringify(w.context.state);
  w.render().querySelectorAll('button').find(button => button.textContent === 'Edit a copy').events.click();
  vm.runInContext('_currentState.positions[0].col = 1;', w.context);
  assert.equal(JSON.stringify(w.context.state), original);
  assert.equal(w.context.rendered.steps, undefined);
  const wrapper = element('div');
  w.context._renderLibraryControls(wrapper, w.context.rendered);
  wrapper.querySelectorAll('button').find(button => button.textContent === 'Cancel').events.click();
  assert.equal(w.context.rendered, w.context.state);
  assert.equal(w.requests.length, 0);
});

test('saving a copy sends layout and lineage without changing code', async () => {
  const w = setup();
  w.render().querySelectorAll('button').find(button => button.textContent === 'Edit a copy').events.click();
  let selected;
  w.context.parseDeckFromCode = (...args) => selected = args;
  await w.context._saveLibraryCopy();
  assert.equal(w.requests[0].url, '/deck/library');
  assert.equal(w.requests[0].body.parent_id, 'base');
  assert.equal(w.requests[0].body.layout.steps, undefined);
  assert.equal(w.requests[0].body.code, undefined);
  assert.deepEqual(selected, ['protocol', null, 'copy']);
});

test('publish is offered only for the current user\'s unpublished copy', async () => {
  const w = setup();
  assert.equal(w.render().querySelectorAll('button').some(button => button.textContent === 'Publish'), false);
  w.context.state._library.selected = { id: 'mine', name: 'My copy', owner_id: 1, published: false };
  assert.equal(w.render().querySelectorAll('button').some(button => button.textContent === 'Publish'), true);
  await w.context._publishLibraryDeck();
  assert.equal(w.requests[0].url, '/deck/library/mine/publish');
  w.context.state._library.selected.owner_id = 2;
  assert.equal(w.render().querySelectorAll('button').some(button => button.textContent === 'Publish'), false);
});

test('library selection is disabled until pending protocol changes are resolved', () => {
  const w = setup();
  vm.runInContext('_pendingChanges = [{ type: "change_labware" }];', w.context);
  const wrapper = w.render();
  assert.equal(wrapper.querySelector('select').disabled, true);
  assert.equal(wrapper.querySelectorAll('button').find(button => button.textContent === 'Edit a copy').disabled, true);
});

test('well maps use declared plate counts and do not invent an unspecified format', () => {
  const w = setup();
  const known = w.context._renderPlateMap({ name: 'Source', format: 384, well_rows:16, well_columns:24 }, 'source', 'source', null);
  assert.equal(known.querySelectorAll('.deck-well').length, 384);
  const unknown = w.context._renderPlateMap({ name: 'Source', format: null }, 'source', 'source', null);
  assert.equal(unknown.querySelectorAll('.deck-well').length, 0);
});

test('slot previews render plates, tips and tubes without a plate-map format variable', () => {
  const w = setup();
  for (const [type, labware, count] of [['plate', '96_well_plate', 96],
      ['plate', '384_well_plate', 384], ['tiprack', '96_tiprack', 96], ['tuberack', '24_tuberack', 24]]) {
    const html = w.context._renderSlotInterior(type, { id: 'a', labware, well_count:count, well_rows:2, well_columns:count/2 });
    assert.equal((html.match(/data-well=/g) || []).length, count);
    assert.ok(html.includes('data-well="A1"'));
  }
});

test('first display renders cached hardware aliases as plate, tip and tube visuals', () => {
  const w = setup();
  for (const [type, labware, css, count] of [
    ['labware', '96_wellplate', 'mini-well', 96],
    ['source plate', '384_wellplate', 'mini-well', 384],
    ['destination plate', '96_wellplate', 'mini-well', 96],
    ['tube_rack', '24_tube_rack', 'mini-tube', 24],
    ['tip rack', '96_tiprack', 'mini-tip', 96],
    ['empty', '96_wellplate', 'mini-well', 96],
  ]) {
    const pos = { id: 'a', type, labware, well_count:count, well_rows:2, well_columns:count/2 };
    const slot = w.context._createSlot(pos);
    assert.equal((slot.innerHTML.match(/data-well=/g) || []).length, count, type);
    assert.ok(slot.innerHTML.includes(css), type);
    assert.ok(slot.className.includes('filled'), type);
    assert.equal(pos.type, type); // Rendering does not rewrite saved device data.
  }
  const empty = w.context._createSlot({ id: 'b', type: 'empty', labware: null });
  assert.equal(empty.innerHTML.includes('data-well='), false);
});

test('linear carrier positions show the same plate visuals on first display', () => {
  const w = setup();
  const carrier = w.context._renderLinear({ carriers: { items: [{ type: 'carrier', track: 1,
    positions: [{ index: 0, labware: '96_wellplate', well_count:96, well_rows:8, well_columns:12 }] }] } });
  const slot = carrier.children[0].children[1];
  assert.equal((slot.innerHTML.match(/data-well=/g) || []).length, 96);
  assert.equal(slot.dataset.id, 'carrier_0');
});

test('deck hardware has permanent labels and no hover tooltip handlers', () => {
  const w = setup();
  for (const type of ['plate', 'tiprack', 'tuberack', 'reservoir', 'module', 'trash', 'empty']) {
    const slot = w.context._createSlot({ id: 'a', type, labware: type === 'empty' ? null : '96_well_plate', labware_display: 'Sample plate' });
    assert.equal(slot.events.pointerenter, undefined, type);
    assert.equal(slot.events.focus, undefined, type);
    if (type !== 'empty') assert.equal(slot.children.find(child => child.className === 'slot-labware-name').textContent, 'Sample plate');
  }
});

test('one click on an empty position opens the add selector without rerendering the deck', () => {
  const w = setup();
  const calls = [];
  w.context._showSelector = (...args) => calls.push(args);
  const empty = w.context._createSlot({ id: 'a', type: 'empty' });
  empty.events.click();
  assert.deepEqual(calls, [['a', null]]);
  const loaded = w.context._createSlot({ id: 'b', type: 'plate', labware: 'plate_api' });
  loaded.events.click();
  assert.equal(calls.length, 1);
  assert.equal(loaded.draggable, true);
  loaded.events.dblclick();
  assert.deepEqual(calls[1], ['b', 'plate_api']);
});

test('dragging hardware preserves geometry and variables and tracks the code update', () => {
  const w = setup();
  Object.assign(w.context.state.positions[0], { labware: 'tips_api', variable: 'tips', type: 'tiprack' });
  w.context.state.steps = [{ source: { slot: 'a', wells: ['A1'] } }];
  w.context.state.instruments = [{ tipracks: ['a'] }];
  vm.runInContext('_originalState = JSON.parse(JSON.stringify(_currentState)); _renderApplyBar = function() {};', w.context);
  const loaded = w.context._createSlot(w.context.state.positions[0]);
  const empty = w.context._createSlot(w.context.state.positions[1]);
  const dataTransfer = { setData(type, value) { this.value = value; } };
  loaded.events.dragstart({ dataTransfer });
  let allowed = false;
  empty.events.dragover({ dataTransfer, preventDefault() { allowed = true; } });
  assert.equal(allowed, true);
  empty.events.drop({ preventDefault() {} });
  assert.equal(w.context.state.positions[0].type, 'empty');
  assert.equal(w.context.state.positions[1].variable, 'tips');
  assert.equal(w.context.state.positions[1].col, 1);
  assert.equal(w.context.state.steps[0].source.slot, 'b');
  assert.equal(w.context.state.instruments[0].tipracks[0], 'b');
  const changes = JSON.parse(vm.runInContext('JSON.stringify(_pendingChanges)', w.context));
  assert.deepEqual(changes, [{ type: 'move_labware', from_slot: 'a', to_slot: 'b', labware: 'tips_api', variable: 'tips' }]);
  w.context._discardChanges();
  assert.equal(w.context.rendered.positions[0].variable, 'tips');
  assert.equal(w.requests.length, 0);
});

test('plate dragging starts only outside the well grid and controls', () => {
  const w=setup();
  const plate=w.context._createSlot({id:'a',labware:'plate_api',type:'plate'});
  let blocked=0, started=0;
  const drag={preventDefault(){blocked++;},dataTransfer:{setData(){started++;}}};
  const grid={closest:selector=>selector==='button' ? null : {}};
  plate.events.pointerdown({target:grid,preventDefault(){}});
  plate.events.dragstart(drag);
  assert.equal(blocked,1);
  assert.equal(started,0);
  plate.events.pointerdown({target:{closest:()=>null},preventDefault(){}});
  plate.events.dragstart(drag);
  assert.equal(started,1);
});

test('moving a newly added plate preserves its wells and contents without protocol code', () => {
  const w = setup();
  vm.runInContext('_currentCode = null; _renderApplyBar = function() {};', w.context);
  w.context._applyChange('a', 'plate_api', null, {name:'Sample plate', type:'plate', well_count:96, well_rows:8, well_columns:12, aspect_ratio:1.5});
  w.context.state.positions[0].role = 'Source';
  w.context.state.initial_wells = [{slot:'a', well:'A1', volume_ul:20}];
  const before = w.context._renderMiniPlate(w.context.state.positions[0], 'mini-well');
  w.context._moveDeckArea('a', 'b');
  const moved = w.context.state.positions[1];
  assert.equal(w.context._renderMiniPlate(moved, 'mini-well'), before);
  assert.equal(moved.role, 'Source');
  assert.equal(moved.aspect_ratio, 1.5);
  assert.equal(moved.labware_display, 'Sample plate');
  assert.equal(w.context.state.initial_wells[0].slot, 'b');
  assert.equal(w.context.state.initial_wells[0].volume_ul, 20);
  assert.equal(w.context.state.positions[0].well_count, undefined);
  assert.equal(w.context.state.positions[0].role, undefined);
  w.context._moveDeckArea('b', 'a');
  assert.equal(w.context._renderMiniPlate(w.context.state.positions[0], 'mini-well'), before);
  assert.equal(w.context.state.initial_wells[0].slot, 'a');
});

test('moves cannot overwrite occupied areas or move fixed hardware', () => {
  const w = setup();
  Object.assign(w.context.state.positions[0], { labware: 'plate_api', type: 'plate' });
  Object.assign(w.context.state.positions[1], { labware: 'fixed_api', type: 'trash' });
  const before = JSON.stringify(w.context.state);
  w.context._moveDeckArea('a', 'b');
  w.context._moveDeckArea('b', 'a');
  assert.equal(JSON.stringify(w.context.state), before);
  assert.equal(w.context._createSlot(w.context.state.positions[1]).draggable, false);
});

test('applying a move sends the change and replaces the protocol with the returned code', async () => {
  const w = setup();
  const updatedState = structuredClone(w.context.state);
  let sent, sourceCode;
  w.context.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ code: 'updated protocol', state: updatedState }) };
  };
  w.context._updateSourceCodeBlock = code => sourceCode = code;
  vm.runInContext('_pendingChanges = [{type: "move_labware", from_slot: "a", to_slot: "b", labware: "plate_api"}];', w.context);
  await w.context._commitChanges();
  assert.equal(sent.url, '/deck/update');
  assert.equal(sent.body.changes[0].to_slot, 'b');
  assert.equal(sent.body.code, 'protocol');
  assert.equal(sourceCode, 'updated protocol');
  assert.equal(vm.runInContext('_currentCode', w.context), 'updated protocol');
  assert.equal(vm.runInContext('_pendingChanges.length', w.context), 0);
});

test('an inferred empty grid position remains available when hardware is added', () => {
  const w = setup();
  w.context.state.positions = [{ id: 'a', row: 0, col: 0, type: 'empty' }];
  w.context.state.grid.labels = ['a', 'b'];
  const grid = w.context._renderGrid(w.context.state);
  assert.equal(grid.children.length, 2);
  assert.equal(w.context.state.positions[1].id, 'b');
  vm.runInContext('_renderApplyBar = function() {};', w.context);
  w.context._applyChange('b', 'plate_api', null);
  assert.equal(w.context.state.positions[1].labware, 'plate_api');
});

test('editable slots offer Remove, while mandatory hardware and saved protocols do not',()=>{
  const w=setup();
  Object.assign(w.context.state.positions[0],{labware:'plate_api',type:'plate'});
  vm.runInContext('_currentCode = null; _renderApplyBar = function() {};',w.context);
  const slot=w.context._createSlot(w.context.state.positions[0]);
  slot.querySelector('.deck-slot-remove').events.click({stopPropagation(){}});
  assert.equal(w.context.state.positions[0].labware,null);
  assert.equal(w.context.state.positions[0].type,'empty');
  assert.equal(vm.runInContext('_pendingChanges[0].type',w.context),'remove_labware');
  assert.equal(w.context._createSlot({id:'fixed',labware:'required',type:'plate',fixed:true}).querySelector('.deck-slot-remove'),null);
  w.context.window.workspace={readOnly:true};
  assert.equal(w.context._createSlot({id:'a',labware:'plate',type:'plate'}).querySelector('.deck-slot-remove'),null);
});

test('removing a source plate clears its plate-map rendering as well as its slot',()=>{
  const w=setup();
  Object.assign(w.context.state,{layout_type:'plates',positions:[{id:'source',labware:'plate_api',type:'plate'}],
    plates:{source:{name:'Source',type:'plate_api',format:96,well_rows:8,well_columns:12}}});
  vm.runInContext('_renderApplyBar = function() {};',w.context);
  const deck=w.context._renderPlates(w.context.state);
  deck.querySelector('.deck-slot-remove').events.click({stopPropagation(){}});
  assert.equal(w.context.state.plates.source,undefined);
  assert.equal(w.context.state.positions[0].labware,null);
});

test('a selected 96-well plate renders all its empty wells without protocol code',()=>{
  const w=setup();
  vm.runInContext('_currentCode = null; _renderApplyBar = function() {};',w.context);
  w.context._applyChange('a','plate_api',null,{name:'96 Well Plate',type:'hardware category',well_count:96,well_rows:8,well_columns:12});
  assert.equal(w.context.state.positions[0].type,'plate');
  assert.equal(w.context.state.positions[0].labware_display,'96 Well Plate');
  const html=w.context._renderMiniPlate(w.context.state.positions[0],'mini-well');
  assert.equal((html.match(/<circle /g)||[]).length,96);
  assert.ok(html.includes('data-well="A1"') && html.includes('data-well="H12"'));
  assert.equal(html.includes('Well layout unspecified'),false);
  assert.equal(html.includes('well-source'),false);
});

test('catalog schematics render non-well hardware without inventing plate contents',()=>{
  const w=setup();
  vm.runInContext('_currentCode = null; _renderApplyBar = function() {};',w.context);
  const visual={parts:[
    {shape:'rect',x:5,y:10,width:90,height:80,radius:8,tone:'body'},
    {shape:'ellipse',x:25,y:30,width:50,height:40,tone:'inset'},
  ]};
  w.context._applyChange('a','hardware_api',null,{name:'Temperature control module',type:'module',visual});
  const pos=w.context.state.positions[0];
  const html=w.context._renderSlotInterior(pos.type,pos);
  assert.match(html,/Hardware schematic/);
  assert.match(html,/<ellipse /);
  assert.equal(/Well layout unspecified|deck-well/.test(html),false);
  assert.equal(w.context._renderSlotInterior('plate',{visual}),html);
  w.context._applyChange('a','plate_api','hardware_api',{type:'plate',well_count:96,well_rows:8,well_columns:12});
  assert.equal(pos.visual,undefined);
  assert.match(w.context._renderSlotInterior(pos.type,pos),/96 wells/);
});

test('hardware drawings accept only bounded shapes and fixed styling',()=>{
  const w=setup();
  assert.equal(w.context._renderHardwareVisual({parts:[
    {shape:'script',x:0,y:0,width:10,height:10},
    {shape:'rect',x:0,y:0,width:101,height:10},
    {shape:'rect',x:'0',y:0,width:10,height:10},
  ]}), '');
  const html=w.context._renderHardwareVisual({parts:[
    {shape:'rect',x:0,y:0,width:20,height:20,tone:'" onload="bad',radius:Infinity},
  ]});
  assert.match(html,/hardware-body/);
  assert.equal(html.includes('onload'),false);
});

test('selecting hardware on a new deck adds it before any protocol code exists and Apply confirms the layout', async()=>{
  const w=setup();
  vm.runInContext('_currentCode = null; _originalState = JSON.parse(JSON.stringify(_currentState)); _renderApplyBar = function() {};',w.context);
  const list=element('div'); list.replaceChildren=function(){this.children=[];}; let closed=false;
  const modal={remove(){closed=true;}};
  w.context._renderCatalogItems(list,{categories:[{name:'Plates',items:[{id:'plate_api',name:'Plate',type:'plate',well_count:48,well_rows:6,well_columns:8}]}]},modal,'a',null);
  list.children[1].events.click();
  assert.equal(closed,true);
  assert.equal(w.context.state.positions[0].labware,'plate_api');
  assert.equal(w.context.state.positions[0].well_count,48);
  assert.equal(vm.runInContext('_pendingChanges.length',w.context),1);
  w.context.window.workspace={confirmLayout:()=>w.context.window.confirmDeviceLayout()};
  await w.context._commitChanges();
  assert.equal(vm.runInContext('_pendingChanges.length',w.context),0);
  w.context._discardChanges();
  assert.equal(w.context.rendered.positions[0].labware,'plate_api');
  assert.equal(w.requests.length,0);
});

test('the entire deck scales to fit in both normal and fullscreen panes', () => {
  const w = setup();
  let fullscreen = true;
  let bar = {};
  const wrapper = { scrollWidth: 1200, scrollHeight: 800, querySelector: selector => selector === '#anim-playback-bar' ? bar : null,
    style: { removeProperty(name) { delete this[name]; } } };
  const container = { clientWidth: 624, clientHeight: 424, querySelector: () => wrapper };
  w.context.document.getElementById = id => id === 'deck-panel'
    ? { classList: { contains: name => name === 'deck-fullscreen' && fullscreen } } : id === 'deck-svg-container' ? container : null;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.5)');
  assert.equal(wrapper.style.left, '12px');
  assert.equal(wrapper.style.top, '0px');
  container.clientHeight = 224;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.25)');
  fullscreen = false;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.25)');
  assert.equal(wrapper.style.width, '600px');
  bar = null;  // before playback exists, its room is kept free under the deck
  container.clientHeight = 424 + 96;
  w.context._fitDeck();
  assert.equal(wrapper.style.transform, 'scale(0.5)');
});

test('active code lines are centered using viewport coordinates regardless of offset parents', () => {
  const w = setup();
  let scroll;
  const pre = { scrollTop: 600, scrollHeight: 2400, clientHeight: 200, clientTop: 1,
    offsetTop: 1200, getBoundingClientRect: () => ({ top: 700 }), scrollTo: value => scroll = value };
  const line = { offsetTop: 50, getBoundingClientRect: () => ({ top: 1201, height: 20 }) };
  w.context._revealCodeLine(pre, line);
  assert.equal(scroll.top, 1010);
  assert.equal(scroll.behavior, 'instant');
  line.getBoundingClientRect = () => ({ top: -500, height: 20 });
  w.context._revealCodeLine(pre, line);
  assert.equal(scroll.top, 0);
  line.getBoundingClientRect = () => ({ top: 3000, height: 20 });
  w.context._revealCodeLine(pre, line);
  assert.equal(scroll.top, 2200);
});

function catalogSetup() {
  const w = setup();
  const close = element('button'), rendered = [];
  let modal, timer, finish;
  w.context.document.body.appendChild = node => {
    modal = node;
    node.isConnected = true;
    node.remove = () => node.isConnected = false;
    node.querySelector = () => ({ value: '' });
  };
  w.context.document.getElementById = id => id === 'deck-selector-close-btn' ? close
    : id === 'deck-selector-modal' && modal?.isConnected ? modal : null;
  w.context._renderCatalog = () => {
    const list = element('div');
    list.customEntryAvailable = true;
    rendered.push(list);
    return list;
  };
  w.context._renderCatalogItems = list => list.suggestionsLoaded = true;
  w.context._filterCatalog = () => {};
  w.context.setTimeout = callback => { timer = callback; return 1; };
  w.context.clearTimeout = () => {};
  let requests = 0;
  w.context.fetch = (url, options) => {
    requests++;
    return new Promise((resolve, reject) => {
      finish = () => resolve({ ok: true, json: async () => ({ categories: [] }) });
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  return { ...w, rendered, close, timeout: () => timer(), finish: () => finish(), requests: () => requests };
}

test('hardware entry is available before lookup completes and successful suggestions are reused', async () => {
  const w = catalogSetup();
  const pending = w.context._showSelector('a', null);
  assert.equal(w.rendered[0].customEntryAvailable, true);
  assert.equal(w.rendered[0].suggestionsLoaded, undefined);
  w.finish();
  await pending;
  assert.equal(w.rendered[0].suggestionsLoaded, true);
  await w.context._showSelector('b', null);
  assert.equal(w.rendered[1].suggestionsLoaded, true);
  assert.equal(w.requests(), 1);
});

test('hardware lookup timeout replaces the spinner without removing custom entry', async () => {
  const w = catalogSetup();
  const pending = w.context._showSelector('a', null);
  w.timeout();
  await pending;
  assert.match(w.rendered[0].textContent, /timed out/);
  assert.equal(w.rendered[0].customEntryAvailable, true);
});

test('closing a dialog leaves shared preload available without updating the closed dialog', async () => {
  const w = catalogSetup();
  const pending = w.context._showSelector('a', null);
  w.close.events.click();
  w.finish();
  await pending;
  assert.equal(w.rendered[0].textContent, undefined);
  assert.equal(w.rendered[0].suggestionsLoaded, undefined);
  await w.context._showSelector('b', 'another_labware');
  assert.equal(w.requests(), 1);
});

test('background preloading and slot selectors share one request per robot', async () => {
  const w = catalogSetup();
  const preload = w.context._loadHardwareCatalog('Device');
  const pending = w.context._showSelector('a', 'existing_labware');
  assert.equal(w.requests(), 1);
  assert.equal(w.context._loadHardwareCatalog(' device '), preload);
  w.finish();
  await Promise.all([preload, pending]);
  await w.context._showSelector('b', null);
  assert.equal(w.requests(), 1);
});

test('a failed background preload can be retried when opening a slot', async () => {
  const w = catalogSetup();
  w.context.preloadHardwareCatalog('Device');
  w.timeout();
  await new Promise(setImmediate);
  const pending = w.context._showSelector('a', null);
  assert.equal(w.requests(), 2);
  w.finish();
  await pending;
  assert.equal(w.rendered[0].suggestionsLoaded, true);
});

test('initial deck rendering starts preloading for its identified robot', () => {
  const w = setup();
  const container = element('div');
  let platform;
  w.context.document.getElementById = id => id === 'deck-svg-container' ? container : null;
  w.context._watchDeckFit = () => {};
  w.context.preloadHardwareCatalog = value => platform = value;
  w.context.state.steps = [];
  w.renderInitialDeck(w.context.state);
  assert.equal(platform, 'Device');
});

test('divider supports dragging and keyboard resizing while keeping both panes available', () => {
  const w = setup();
  let splitter, height = 300;
  const code = { before(node) { splitter = node; }, getBoundingClientRect: () => ({ height }) };
  const panel = { clientHeight: 1000, style: { setProperty(name, value) { this[name] = value; height = parseFloat(value); } },
    querySelector: selector => selector === '.deck-code-panel' ? code
      : selector === '.deck-panel-header' ? { offsetHeight: 60 } : splitter };
  w.context.document.getElementById = id => id === 'deck-panel' ? panel : null;
  w.context._ensureDeckSplitter();
  splitter.offsetHeight = 10;
  let captured = false;
  splitter.focus = () => {};
  splitter.setPointerCapture = () => captured = true;
  splitter.hasPointerCapture = () => captured;
  splitter.releasePointerCapture = () => captured = false;
  splitter.events.pointerdown({ preventDefault() {}, clientY: 500, pointerId: 1 });
  splitter.events.pointermove({ clientY: 400, pointerId: 1 });
  assert.equal(height, 400);
  splitter.events.pointerup({ pointerId: 1 });
  splitter.events.pointermove({ clientY: 0, pointerId: 1 });
  assert.equal(height, 400);
  splitter.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(height, 376);
  splitter.events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(height, 850);
  splitter.events.keydown({ key: 'End', preventDefault() {} });
  assert.equal(height, 80);
});

test('fullscreen shows the current protocol below the deck and restores the normal panel on close', () => {
  const w = setup();
  function node() {
    const result = element('div');
    const classes = new Set();
    result.classList = { contains: name => classes.has(name), add: name => classes.add(name),
      remove: name => classes.delete(name), toggle(name, value) { value ? classes.add(name) : classes.delete(name); } };
    result.replaceChildren = () => result.children = [];
    result.removeAttribute = name => delete result.attributes[name];
    return result;
  }
  const panel = node(), view = node(), button = node(), sidebar = node(), chat = node();
  const elements = { 'deck-panel': panel, 'deck-code-view': view, 'deck-fullscreen-btn': button,
    sidebar, 'chat-panel': chat };
  w.context.document.getElementById = id => elements[id] || null;
  let expanded = 0;
  w.context.detectFormat = () => 'python';
  w.context.buildCodeBlock = code => {
    const block = node();
    block.code = code;
    block.querySelector = selector => selector === '.code-preview-toggle'
      ? { getAttribute: () => 'false', click: () => expanded++, remove() {} } : null;
    return block;
  };
  w.context._renderDeckCode();
  assert.equal(view.children[0].code, 'protocol');
  w.context._setDeckFullscreen(true);
  assert.equal(panel.classList.contains('deck-fullscreen'), true);
  assert.equal(panel.attributes['aria-modal'], 'true');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(sidebar.inert, true);
  assert.equal(chat.inert, true);
  assert.equal(view.children[0].code, 'protocol');
  assert.equal(expanded, 1);
  w.context._renderDeckCode();
  assert.equal(expanded, 1); // Selecting a slot must not rebuild or reset code scrolling.
  vm.runInContext('_currentCode = "updated protocol";', w.context);
  w.context._renderDeckCode();
  assert.equal(view.children[0].code, 'updated protocol');
  w.context.closeDeckPanel();
  assert.equal(panel.classList.contains('deck-fullscreen'), false);
  assert.equal(panel.classList.contains('hidden'), true);
  assert.equal(sidebar.inert, false);
  assert.equal(chat.inert, false);
  assert.equal(view.children[0].code, 'updated protocol');
  assert.equal(button.attributes['aria-pressed'], 'false');
});
