const {test}=require('node:test');
const assert=require('node:assert/strict');
const {groupsFor,plan,overlaps,bubblesOverlap,matchingDevices,seriesFor}=require('../biobot/static/landing_equipment.js');
const rows=Array.from({length:12},(_,i)=>({key:`device-${i}`,name:`Device ${i}`,status:'ready',categories:[`Category ${i}`]}));

test('landing categories come from the available catalog and deduplicate physical device links',()=>{
  const groups=groupsFor([
    {key:'a',name:'Instrument A',status:'ready',categories:['Liquid handling','Analysis']},
    {key:'a',name:'Alias A',status:'ready',categories:['Liquid handling']},
    {key:'b',name:'Building instrument',status:'queued',categories:['Imaging']}
  ]);
  assert.deepEqual(groups.map(group=>group.name),['Analysis','Liquid handling']);
  assert.equal(groups[0].devices.length,1);assert.equal(groups[1].devices.length,1);
});
test('constellation keeps categories outside the title and composer and prevents bubble collisions',()=>{
  const protectedRect={x:310,y:230,w:480,h:270};
  {
    const items=plan({width:1100,height:820,protectedRect,groups:groupsFor(rows)});
    assert.ok(items);assert.equal(items.length,12);
    for(const [i,item] of items.entries()) {
      assert.equal(overlaps(item,protectedRect,20),false);
      assert.ok(item.x>=0 && item.y>=0 && item.x+item.w<=1100 && item.y+item.h<=820);
      for(const other of items.slice(i+1))assert.equal(bubblesOverlap(item,other,18),false);
    }
  }
});
test('series expands every model at once with no pages or omitted devices',()=>{
  const groups=groupsFor(Array.from({length:15},(_,i)=>({key:`device-${i}`,manufacturer:'Maker',model:`Series ${i}`,name:`Device ${String(i).padStart(2,'0')}`,status:'ready',categories:['Liquid handling']})));
  const items=plan({width:1500,height:1700,protectedRect:{x:520,y:350,w:460,h:260},groups,open:'Liquid handling',openSeries:'Series'});
  assert.ok(items);
  const devices=items.filter(item=>item.kind==='device');
  assert.equal(devices.length,15);assert.equal(new Set(devices.map(item=>item.name)).size,15);
});
test('narrow screens can fit all categories around the protected center using vertical space',()=>{
  const protectedRect={x:14,y:800,w:272,h:300};
  const items=plan({width:300,height:1950,protectedRect,groups:groupsFor(rows)});
  assert.ok(items);assert.equal(items.length,12);
  for(const item of items)assert.equal(overlaps(item,protectedRect,20),false);
});

test('opening a series keeps the selected category centered on its closed anchor, and closing restores others',()=>{
  const groups=groupsFor([
    ...Array.from({length:13},(_,i)=>({key:`liquid-${i}`,name:`Liquid ${i}`,status:'ready',categories:['Liquid handling']})),
    ...rows.slice(0,6)
  ]);
  const options={width:1100,height:1000,protectedRect:{x:320,y:350,w:460,h:260},groups};
  const closed=plan(options);assert.ok(closed);
  const anchor=closed.find(item=>item.name==='Liquid handling');
  for(const openSeries of [null,'Liquid']) {
    const expanded=plan({...options,open:'Liquid handling',openSeries});assert.ok(expanded);
    const active=expanded.find(item=>item.kind==='category' && item.open);
    assert.equal(active.x+active.w/2,anchor.x+anchor.w/2);
    assert.equal(active.y+active.h/2,anchor.y+anchor.h/2);
    for(const item of expanded)assert.equal(overlaps(item,options.protectedRect),false);
    for(const item of expanded.filter(item=>item.kind==='category' && !item.open)) {
      const before=closed.find(old=>old.name===item.name);
      assert.equal(item.w,before.w);assert.equal(item.h,before.h);
      assert.ok(item.x>=0 && item.y>=0);
    }
  }
  assert.deepEqual(plan(options),closed);
});

test('every category can expand at its existing anchor in a dense desktop constellation',()=>{
  const groups=groupsFor([
    ...Array.from({length:19},(_,i)=>({key:`liquid-${i}`,name:`Liquid ${i}`,status:'ready',categories:['Liquid handling']})),
    ...Array.from({length:10},(_,i)=>({key:`other-${i}`,name:`Other ${i}`,status:'ready',categories:[`Category ${i}`]}))
  ]);
  const options={width:1035,height:920,protectedRect:{x:277.5,y:273,w:480,h:374},groups};
  const closed=plan(options);assert.ok(closed);
  for(const group of groups) {
    const expanded=plan({...options,open:group.name});assert.ok(expanded,group.name);
    const anchor=closed.find(item=>item.name===group.name);
    const active=expanded.find(item=>item.kind==='category' && item.open);
    assert.equal(active.x+active.w/2,anchor.x+anchor.w/2);
    assert.equal(active.y+active.h/2,anchor.y+anchor.h/2);
    const others=expanded.filter(item=>item.kind==='category' && !item.open);
    for(const item of others) {
      const before=closed.find(old=>old.name===item.name);
      assert.equal(item.w,before.w);assert.equal(item.h,before.h);
      assert.ok(item.x>=0 && item.y>=0);
    }
    for(const [i,item] of expanded.entries()) {
      assert.equal(overlaps(item,options.protectedRect),false);
      for(const other of expanded.slice(i+1))assert.equal(bubblesOverlap(item,other),false);
    }
  }
});

test('switching from one opened category anchors the next at its current displaced position',()=>{
  const groups=groupsFor([
    ...Array.from({length:19},(_,i)=>({key:`liquid-${i}`,name:`Liquid ${i}`,status:'ready',categories:['Liquid handling']})),
    ...Array.from({length:10},(_,i)=>({key:`other-${i}`,name:`Other ${i}`,status:'ready',categories:[`Category ${i}`]}))
  ]);
  const options={width:1035,height:920,protectedRect:{x:277.5,y:273,w:480,h:374},groups};
  const closed=plan(options),first=plan({...options,open:'Liquid handling'});assert.ok(first);
  for(const clicked of first.filter(item=>item.kind==='category' && !item.open)) {
    const currentAnchor={x:clicked.x,y:clicked.y-2.5,w:clicked.w,h:clicked.h};
    const second=plan({...options,open:clicked.name,openAnchor:currentAnchor});assert.ok(second,clicked.name);
    const expanded=second.find(item=>item.kind==='category' && item.open);
    assert.equal(expanded.x+expanded.w/2,currentAnchor.x+currentAnchor.w/2);
    assert.equal(expanded.y+expanded.h/2,currentAnchor.y+currentAnchor.h/2);
    assert.equal(overlaps(expanded,options.protectedRect),false);
    const paged=plan({...options,open:clicked.name,openAnchor:currentAnchor,openSeries:seriesFor(groups.find(group=>group.name===clicked.name).devices)[0].name});
    const pagedBubble=paged.find(item=>item.kind==='category' && item.open);
    assert.deepEqual(pagedBubble,expanded);
  }
  assert.deepEqual(plan(options),closed);
});

 test('opening visibly repels nearby categories even without a collision',()=>{
  const groups=groupsFor(rows.slice(0,6));
  const options={width:1400,height:1000,protectedRect:{x:500,y:380,w:400,h:240},groups};
  const closed=plan(options);
  let moved=0;
  for(const group of groups){
    const expanded=plan({...options,open:group.name,pageSize:1});assert.ok(expanded);
    const anchor=closed.find(item=>item.name===group.name);
    for(const item of expanded.filter(item=>item.kind==='category' && !item.open)){
      const before=closed.find(old=>old.name===item.name);
      const distance=Math.hypot(before.x-anchor.x,before.y-anchor.y);
      if(distance<360 && Math.hypot(item.x-before.x,item.y-before.y)>=34)moved++;
    }
  }
  assert.ok(moved>=4,'Nearby categories should visibly move, including when they already fit');
});

test('saved category centers are restored and scale with the available space',()=>{
  const groups=groupsFor(rows.slice(0,1));
  const options={width:1100,height:1000,protectedRect:{x:400,y:350,w:300,h:280},groups,
    positions:{'category:Category 0':{x:.2,y:.25}}};
  const restored=plan(options)[0];
  assert.equal(restored.x+restored.w/2,220);
  assert.equal(restored.y+restored.h/2,250);
  const resized=plan({...options,width:1300,height:1200})[0];
  assert.equal(resized.x+resized.w/2,260);
  assert.equal(resized.y+resized.h/2,300);
  const opened=plan({...options,open:'Category 0'})[0];
  assert.equal(opened.x+opened.w/2,220);
  assert.equal(opened.y+opened.h/2,250);
});
test('saved drops inside the composer or outside the window are safely repositioned',()=>{
  const groups=groupsFor(rows.slice(0,2));
  const protectedRect={x:350,y:300,w:400,h:300};
  const items=plan({width:1100,height:1000,protectedRect,groups,positions:{
    'category:Category 0':{x:.5,y:.45},'category:Category 1':{x:10,y:-5}}});
  assert.ok(items);
  for(const item of items){
    assert.equal(overlaps(item,protectedRect,20),false);
    assert.ok(item.x>=14 && item.x+item.w<=1086 && item.y>=14);
  }
});

test('the full category browser finds devices beyond the floating page without losing either Opentrons model',()=>{
  const devices=[...rows.map(row=>({...row,categories:['Liquid handling']})),...['Opentrons OT-2','Opentrons Flex'].map(name=>({key:name,name,status:'ready',categories:['Liquid handling']}))];
  const group=groupsFor(devices).find(group=>group.name==='Liquid handling');
  assert.ok(group.devices.slice(0,6).every(device=>!device.name.includes('Opentrons')));
  assert.deepEqual(matchingDevices(group.devices,'opentrons').map(device=>device.name),['Opentrons Flex','Opentrons OT-2']);
  assert.deepEqual(matchingDevices(group.devices,'ot-2 opentrons').map(device=>device.name),['Opentrons OT-2']);
  assert.equal(matchingDevices(group.devices,'missing').length,0);
  assert.equal(matchingDevices(group.devices,'').length,group.devices.length);
});

test('series grouping discovers shared product roots and manufacturers without merging hardware',()=>{
  const devices=[
    {name:'Opentrons OT-2',manufacturer:'Opentrons',model:'OT-2'},
    {name:'Opentrons Flex',manufacturer:'Opentrons',model:'Flex'},
    {name:'Labcyte Echo 525',manufacturer:'Labcyte',model:'Echo 525'},
    {name:'Beckman Coulter Echo 650',manufacturer:'Beckman Coulter',model:'Echo 650'},
  ];
  const branches=seriesFor(devices);
  assert.deepEqual(branches.map(branch=>branch.name),['Echo','Opentrons']);
  assert.equal(branches[0].devices.length,2);assert.equal(branches[1].devices.length,2);
  assert.equal(new Set(branches.flatMap(branch=>branch.devices)).size,4);
});
