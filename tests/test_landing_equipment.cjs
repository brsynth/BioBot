const {test}=require('node:test');
const assert=require('node:assert/strict');
const {devicesFor,matchingDevices,resolveDeviceMatch}=require('../biobot/static/landing_equipment.js');

test('all saved devices are listed once regardless of missing, wrong or multiple categories',()=>{
  const devices=devicesFor([
    {key:'a',name:'Maker Model 10',status:'ready',categories:['Wrong family']},
    {key:'a',name:'Duplicate alias',status:'ready',categories:[]},
    {key:'b',name:'Maker Model 20',status:'local'},
    {key:'c',name:'Maker Model 30',status:'queued'},
    {key:'d',name:'Maker Model 40',status:'failed'},
  ]);
  assert.deepEqual(devices.map(device=>device.name),['Maker Model 10','Maker Model 20']);
  assert.equal(matchingDevices(devices,'Wrong family').length,0);
});

test('identity search and Enter resolution keep exact models separate without using categories',()=>{
  const devices=devicesFor([{key:'a',name:'Maker Model 10',manufacturer:'Maker',model:'Model 10',status:'ready'},
    {key:'b',name:'Maker Model 20',model:'Model 20',status:'local',categories:['Imaging']}]);
  assert.equal(resolveDeviceMatch(devices,' MAKER model 10 '),devices[0]);
  assert.equal(resolveDeviceMatch(devices,'Model 20'),devices[1]);
  assert.equal(resolveDeviceMatch(devices,'20 model'),null);
  for(const query of ['Maker','unknown','Imaging',''])assert.equal(resolveDeviceMatch(devices,query),null);
  assert.deepEqual(matchingDevices(devices,'Maker').map(device=>device.key),['a','b']);
});

test('landing suggestions filter locally, highlight names, support keyboard navigation, and open exact devices',async()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  let focused=null;
  class Element {
    constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.dataset={};this.value='';this.textContent='';this.classes=new Set();
      this.classList={contains:name=>this.classes.has(name)};}
    append(...nodes){this.children.push(...nodes);}
    appendChild(node){this.children.push(node);return node;}
    replaceChildren(...nodes){this.children=nodes;this.textContent='';}
    addEventListener(name,fn){this.events[name]=fn;}
    contains(other){return this===other || this.children.some(child=>child.contains?.(other));}
    focus(){focused=this;}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const body=new Element();body.classes.add('landing');
  let requests=0;const chosen=[];
  const devices=[{key:'a',name:'Maker Model 10',status:'ready',categories:['Wrong family']},
    {key:'b',name:'Maker Model 20',status:'local',categories:[]}];
  const input=get('user-input'),menu=get('landing-device-suggestions'),composer=get('landing-composer');
  composer.append(input,menu);
  const context=vm.createContext({document:{body,getElementById:get,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text,children:[]})},
    window:{workspace:{chooseDevice:(...args)=>chosen.push(args)}},AbortController,setTimeout:()=>1,clearTimeout(){},setInterval(){},
    MutationObserver:class{observe(){}},fetch:async()=>{requests++;return {ok:true,json:async()=>devices};}});
  vm.runInContext(fs.readFileSync(`${__dirname}/../biobot/static/landing_equipment.js`,'utf8'),context);
  await new Promise(setImmediate);
  assert.equal(menu.hidden,true);
  input.value='model 10';input.events.input();
  assert.equal(menu.children.length,1);assert.equal(menu.hidden,false);
  assert.ok(menu.children[0].children.some(child=>child.tag==='mark'));
  const suggestion=menu.children[0];
  let prevented=false;
  suggestion.events.pointerdown({button:0,preventDefault(){prevented=true;}});
  // Safari blurs the textbox to the page on pointerdown unless that default is prevented.
  if(!prevented)composer.events.focusout({currentTarget:composer,relatedTarget:null});
  assert.equal(prevented,true);
  assert.equal(menu.hidden,false);
  assert.equal(menu.children[0],suggestion);
  suggestion.events.click();
  assert.deepEqual(chosen[0],['Maker Model 10',null,true]);assert.equal(menu.hidden,true);
  input.value='Maker';input.events.input();assert.equal(menu.children.length,2);
  input.events.keydown({key:'ArrowDown',preventDefault(){}});assert.equal(focused,menu.children[0]);
  menu.children[0].events.keydown({key:'ArrowDown',preventDefault(){}});assert.equal(focused,menu.children[1]);
  menu.children[0].events.keydown({key:'ArrowUp',preventDefault(){}});assert.equal(focused,input);
  composer.events.focusout({currentTarget:composer,relatedTarget:menu.children[0]});assert.equal(menu.hidden,false);
  composer.events.focusout({currentTarget:composer,relatedTarget:null});assert.equal(menu.hidden,true);
  input.value='unknown';input.events.input();assert.equal(menu.hidden,true);
  assert.match(get('landing-equipment-status').textContent,/Enter.*online/);
  input.value='Wrong family';input.events.input();assert.equal(menu.hidden,true);
  input.value='';input.events.input();assert.equal(menu.hidden,true);
  input.value='Maker\nModel 20';input.events.input();assert.equal(input.value,'Maker Model 20');assert.equal(menu.children.length,1);
  input.events.keydown({key:'Escape'});assert.equal(menu.hidden,true);
  assert.equal(requests,1);assert.equal(elements.has('landing-equipment-bubbles'),false);
  input.value='Maker';input.events.input();assert.equal(menu.hidden,false);
  context.window.landingEquipment.beginCheck();assert.equal(menu.hidden,true);
  input.events.focus();assert.equal(menu.hidden,true);
  await context.window.landingEquipment.refresh();assert.equal(menu.hidden,true);
  input.value='Maker Model 10';input.events.input();assert.equal(menu.hidden,false);
  const series={key:'series:a',name:'Maker A Series',kind:'family',status:'local',members:[{name:'Maker A10'},{name:'Maker A20'}]};
  devices.splice(0,devices.length,series);
  const groups=[];context.window.workspace.chooseSeries=group=>groups.push(group);
  await context.window.landingEquipment.refresh();
  input.value='Maker';input.events.input();
  assert.equal(menu.children.length,2); // Both exact models appear immediately, without a family or Back row.
  assert.equal(groups.length,0);assert.equal(chosen.length,1);
  menu.children[1].events.pointerdown({button:0,preventDefault(){}});
  menu.children[1].events.click();
  assert.deepEqual(chosen[1],['Maker A20',null,true]);assert.equal(menu.hidden,true);

});


test('one saved model never turns a family-only query into a specific device',()=>{
  const devices=[{key:'a',name:'Maker SeriesA 10',manufacturer:'Maker',model:'SeriesA 10',status:'ready'}];
  assert.equal(resolveDeviceMatch(devices,'SeriesA'),null);
  assert.equal(resolveDeviceMatch(devices,'Maker'),null);
  assert.equal(resolveDeviceMatch(devices,'SeriesA 10'),devices[0]);
});

test('series suggestions match exact member names but cannot resolve as physical devices',()=>{
  const group={kind:'series',name:'Maker A Series',status:'local',members:[{name:'Maker A10T Plus'}]};
  assert.deepEqual(matchingDevices([group],'A10T Plus'),[group]);
  assert.equal(resolveDeviceMatch([group],'Maker A Series'),null);
  assert.equal(resolveDeviceMatch([group],'Maker A10T Plus'),null);
});

test('device descriptions match cached capabilities across manufacturers without using categories',()=>{
  const devices=devicesFor([
    {key:'a',name:'Maker A100',model:'A100',status:'ready',search_terms:['Microplate reader','absorbance measurement']},
    {key:'b',name:'Other B200',model:'B200',status:'local',search_terms:['Multi-mode plate-reader fluorescence detection']},
    {key:'c',name:'Maker C300',model:'C300',status:'ready',search_terms:['Plate washing and dispensing','barcode reader'],categories:['Plate reader']},
  ]);
  for(const query of ['plate reader','Plate Readers','plate-reader']) {
    assert.deepEqual(matchingDevices(devices,query).map(device=>device.key),['a','b']);
    assert.equal(resolveDeviceMatch(devices,query),null);
  }
  assert.deepEqual(matchingDevices(devices,'absorbance').map(device=>device.key),['a']);
  assert.deepEqual(matchingDevices(devices,'plate fluorescence').map(device=>device.key),['b']);
  assert.equal(resolveDeviceMatch(devices,'absorbance'),null);
  assert.equal(resolveDeviceMatch(devices,'A100'),devices[0]);
});

test('all series and family members appear together in the original suggestion list',()=>{
  const devices=devicesFor([
    {name:'Maker Family',kind:'family',status:'local',members:[{name:'Maker A10'},{name:'Maker A20'}]},
    {name:'Other Series',kind:'series',status:'local',search_terms:['plate reader'],members:[{name:'Other B10'},{name:'Other B20'}]},
  ]);
  assert.deepEqual(devices.map(device=>device.name),['Maker A10','Maker A20','Other B10','Other B20']);
  assert.deepEqual(matchingDevices(devices,'Maker Family').map(device=>device.name),['Maker A10','Maker A20']);
  assert.deepEqual(matchingDevices(devices,'plate reader').map(device=>device.name),['Other B10','Other B20']);
});
