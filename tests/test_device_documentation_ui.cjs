const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(`${__dirname}/../biobot/static/device_documentation.js`,'utf8');
const tick=()=>new Promise(setImmediate);
function setup(device='Maker Device') {
  class Element {
    constructor(tag='div'){this.tagName=tag;this.children=[];this.events={};this.textContent='';this.value='';this.hidden=false;}
    addEventListener(name,fn){this.events[name]=fn;}
    append(...nodes){this.children.push(...nodes);}
    appendChild(node){this.children.push(node);}
    replaceChildren(...nodes){this.children=nodes;}
    setAttribute(name,value){this[name]=value;}
    focus(){}
    showModal(){this.open=true;}
    close(){this.open=false;this.events.close();}
  }
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const data={device:'Maker Device',total:1,documents:[{file:'manual.txt',name:'<manual>.txt',format:'TXT'}],sources:['https://manufacturer.example/manual','javascript:alert(1)'],preparing:false};
  const calls=[],timers=new Map();let serial=0;
  const context={document:{getElementById:get,createElement:tag=>new Element(tag)},window:{workspace:{deviceContext:device}},AbortController,URLSearchParams,
    fetch:async url=>{calls.push(url);return {ok:true,json:async()=>url.includes('/file?')?{text:'<script>Text only</script>'}:data};},
    setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(source,context);
  return {get,data,calls,timers};
}
test('book opens documentation with safe links, downloads and plain text preview',async()=>{
  const w=setup();w.get('device-documentation-toggle').events.click();await tick();
  assert.equal(w.get('device-documentation').open,true);
  const row=w.get('documentation-list').children[0];
  assert.equal(row.children[0].textContent,'<manual>.txt');
  assert.match(row.children[2].href,/file=manual.txt/);
  assert.equal(w.get('documentation-source-links').children.length,1);
  await row.children[0].events.click();
  assert.equal(w.get('documentation-text').textContent,'<script>Text only</script>');
  assert.equal(w.get('documentation-list').hidden,true);
  assert.equal(w.get('documentation-preview').hidden,false);
  await w.get('documentation-back').events.click();
  assert.equal(w.get('documentation-list').hidden,false);
});
test('search is debounced and preparing documentation updates automatically',async()=>{
  const w=setup();w.data.preparing=true;
  w.get('device-documentation-toggle').events.click();await tick();
  assert.match(w.get('documentation-status').textContent,/Preparing documentation/);
  assert.equal(w.timers.size,1);
  w.get('documentation-search').value='transfer';w.get('documentation-search').events.input();
  assert.equal(w.timers.size,1);
  const [id,callback]=[...w.timers.entries()][0];w.timers.delete(id);await callback();
  assert.match(w.calls.at(-1),/q=transfer/);
  w.get('documentation-close').events.click();assert.equal(w.timers.size,0);
});
test('missing device gives a useful message without making requests',async()=>{
  const w=setup('');w.get('device-documentation-toggle').events.click();await tick();
  assert.match(w.get('documentation-status').textContent,/Choose a device/);
  assert.equal(w.calls.length,0);
});
