const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(`${__dirname}/../biobot/static/admin_decks.js`,'utf8');
function editor() {
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{addEventListener(){},value:'',classList:{toggle(){}}});return elements.get(id);};
  const context=vm.createContext({document:{getElementById:get},window:{adminConsole:{api(){}},addEventListener(){}}});
  vm.runInContext(source,context);
  return context.window.adminDeckEditor;
}

test('admin preview draws empty saved track positions and retains physical IDs',()=>{
  const state={layout_type:'linear',positions:[{id:'a',row:0,col:0},{id:'b',row:0,col:1},{id:'fixed',row:0,col:2,fixed:true}],carriers:{items:[]}};
  const before=JSON.stringify(state), model=editor().geometry(state);
  assert.equal(model.positions.length,3);
  assert.deepEqual(Array.from(model.positions,item=>item.id),['a','b','fixed']);
  assert.ok(model.positions[1].x>model.positions[0].x);
  assert.equal(model.positions[2].pos.fixed,true);
  assert.equal(model.schematic,true);
  assert.equal(JSON.stringify(state),before);
});

test('admin preview uses documented dimensions and shapes for spatial layouts',()=>{
  const state={layout_type:'spatial',workspace:{width:200,height:100,units:'mm',shape:'ellipse'},positions:[{id:'stage',x:20,y:10,width:80,height:50,shape:'ellipse'}]};
  const model=editor().geometry(state);
  assert.equal(model.width,200);assert.equal(model.height,100);assert.equal(model.shape,'ellipse');
  assert.equal(model.schematic,false);assert.equal(model.positions[0].x,20);assert.equal(model.positions[0].width,80);
  assert.equal(model.positions[0].shape,'ellipse');
});

test('legacy carrier positions remain available for editing without changing stored data',()=>{
  const state={layout_type:'linear',carriers:{items:[{type:'carrier',track:2,positions:[{index:0,labware:'plate'},{index:1,labware:null}]}]}};
  const model=editor().geometry(state);
  assert.equal(model.positions.length,2);
  assert.equal(model.positions[0].id,'carrier_0');
  assert.equal(model.positions[0].carrier,state.carriers.items[0]);
  assert.ok(model.positions[1].y>model.positions[0].y);
});

test('paired-plate decks show the saved facing arrangement and editable positions',()=>{
  const state={layout_type:'plates',arrangement:'facing',positions:[{id:'Source Plate'},{id:'Destination Plate'}]};
  const model=editor().geometry(state);
  assert.equal(model.positions.length,2);
  assert.equal(model.positions[0].x,model.positions[1].x);
  assert.ok(model.positions[0].y>model.positions[1].y);
  assert.equal(model.positions[0].pos,state.positions[0]);
});
