const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/maintenance.js`, 'utf8');
const tick = () => new Promise(setImmediate);
function setup(response, maintenance=true) {
  const elements = {'maintenance-progress':{}, 'maintenance-detail':{}};
  const timers = new Map(); let serial=0, reloads=0, redirected='';
  vm.runInNewContext(source, {
    document:{getElementById:id=>maintenance ? elements[id] : null}, AbortController,
    window:{location:{reload:()=>reloads++,replace:path=>redirected=path}},
    fetch:async()=>{if(response instanceof Error) throw response;return response;},
    setTimeout:fn=>{timers.set(++serial,fn);return serial;}, clearTimeout:id=>timers.delete(id)
  });
  return {elements,timers,get reloads(){return reloads;},get redirected(){return redirected;}};
}
test('maintenance updates discovery progress and continues polling',async()=>{
  const w=setup({ok:true,json:async()=>({available:false,counts:{ready:3,queued:2,building:1}})});
  await tick();
  assert.match(w.elements['maintenance-progress'].textContent,/3 devices ready · 3 being prepared/);
  assert.equal(w.timers.size,1);
});
test('completion automatically opens the application without another poll',async()=>{
  const w=setup({ok:true,json:async()=>({available:true})});await tick();
  assert.equal(w.reloads,1);assert.equal(w.timers.size,0);
});
test('expired sessions return to sign in',async()=>{
  const w=setup({status:401});await tick();
  assert.equal(w.redirected,'/login');assert.equal(w.timers.size,0);
});
test('temporary connection errors keep retrying',async()=>{
  const w=setup(new Error('offline'));await tick();
  assert.match(w.elements['maintenance-detail'].textContent,/reconnecting automatically/);
  assert.equal(w.timers.size,1);
});


test('an already open workspace switches to maintenance when reset begins',async()=>{
  const w=setup({ok:true,json:async()=>({available:false,status:'resetting'})},false);await tick();
  assert.equal(w.reloads,1);assert.equal(w.timers.size,0);
});
test('a ready workspace keeps checking for resets without reloading',async()=>{
  const w=setup({ok:true,json:async()=>({available:true})},false);await tick();
  assert.equal(w.reloads,0);assert.equal(w.timers.size,1);
});
