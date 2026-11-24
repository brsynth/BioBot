/* Shared physical-layout editing; no protocol generation or device-specific rules. */
(() => {
  const container = document.getElementById('admin-device-deck');
  if (!container) return;
  const api = (...args) => window.adminConsole.api(...args);
  const status = document.getElementById('admin-deck-status');
  let key = '', layout = null, saved = null, selected = null, dirty = false, version = 0, drag = null;
  function node(tag, text) {const el=document.createElement(tag); if(text!==undefined) el.textContent=text; return el;}
  function svgNode(tag, attrs) {const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [name,value] of Object.entries(attrs)) el.setAttribute(name,String(value));return el;}
  function notice(text,error=false) {status.textContent=text;status.classList.toggle('is-error',error);}
  function changed() {dirty=true;document.getElementById('admin-deck-dirty').textContent='Unsaved edits';}
  function records(state) {
    if (state.positions?.length) return state.positions.map((pos,index)=>({pos,id:pos.id,index,list:state.positions}));
    return (state.carriers?.items || []).flatMap(carrier=>(carrier.positions || []).map(pos=>({pos,carrier,id:`${carrier.type}_${pos.index}`,list:carrier.positions})));
  }
  function geometry(state) {
    const items=records(state);
    if(state.layout_type==='spatial') return {width:state.workspace.width,height:state.workspace.height,shape:state.workspace.shape || 'rectangle',schematic:state.workspace.units!=='mm',
      positions:items.map(item=>({...item,x:item.pos.x,y:item.pos.y,width:item.pos.width,height:item.pos.height,shape:item.pos.shape || 'rectangle'}))};
    if(state.layout_type==='plates') {
      const facing=state.arrangement==='facing';
      const positions=items.map((item,index)=>{
        const destination=/dest/i.test(item.id),source=/source/i.test(item.id);
        const ordinal=source?0:destination?1:index;
        return {...item,x:facing?10:10+ordinal*140,y:facing?(ordinal===0?125:10):10,
          width:120,height:90,shape:'rectangle'};
      });
      return {width:facing?140:Math.max(280,items.length*140),height:facing?225:110,
        shape:'rectangle',schematic:true,positions};
    }
    const linear=state.layout_type==='linear';
    const cellWidth=linear ? 22 : 120, cellHeight=linear ? 220 : 100;
    const positions=items.map((item,index)=>({...item,x:(item.carrier ? item.carrier.track : item.pos.col ?? index)*cellWidth,
      y:(item.carrier ? item.pos.index : item.pos.row ?? 0)*cellHeight,width:cellWidth-3,height:cellHeight-10,shape:'rectangle'}));
    return {width:Math.max(cellWidth,...positions.map(p=>p.x+p.width+3)),height:Math.max(cellHeight,...positions.map(p=>p.y+p.height+10)),shape:'rectangle',schematic:true,positions};
  }
  function field(parent,label,value,change,type='text') {
    const wrapper=node('label',label);wrapper.className='admin-field';
    const input=node('input');input.type=type;input.value=value ?? '';if(type==='number') input.step='any';
    input.addEventListener('change',()=>{
      const next=type==='number' ? Number(input.value) : input.value;
      if(type==='number' && (!input.value || !Number.isFinite(next))) {notice('Enter a valid number.',true);return;}
      change(next);changed();renderPreview();
    });wrapper.appendChild(input);parent.appendChild(wrapper);return input;
  }
  function checkbox(parent,label,value,change) {
    const wrapper=node('label');wrapper.className='admin-toggle';const input=node('input');input.type='checkbox';input.checked=!!value;
    input.addEventListener('change',()=>{change(input.checked);changed();renderPreview();});wrapper.append(input,document.createTextNode(label));parent.appendChild(wrapper);
  }
  function choosePosition(item) {selected=item.pos;renderPreview();renderProperties();highlightRows();}
  function highlightRows() {for(const row of document.getElementById('admin-deck-positions').children) row.classList.toggle('selected',row._position===selected);}
  function renderPreview() {
    if(!layout) return;
    const stage=document.getElementById('admin-deck-stage');stage.replaceChildren();
    const model=geometry(layout), svg=svgNode('svg',{viewBox:`0 0 ${model.width} ${model.height}`,role:'group','aria-label':`${layout.platform || 'Device'} physical workspace`});
    svg.style.width=`${Number(document.getElementById('admin-deck-zoom').value || 1)*100}%`;
    const background=model.shape==='ellipse' ? svgNode('ellipse',{cx:model.width/2,cy:model.height/2,rx:model.width/2,ry:model.height/2}) : svgNode('rect',{x:0,y:0,width:model.width,height:model.height,rx:4});
    background.setAttribute('fill','#e5ede9');background.setAttribute('stroke','#c0d0c9');svg.appendChild(background);
    for(const item of model.positions) {
      const {pos}=item;
      const group=svgNode('g',{tabindex:0,role:'button','aria-label':`Position ${item.id}`});group.style.cursor='pointer';
      const shape=item.shape==='ellipse' ? svgNode('ellipse',{cx:item.x+item.width/2,cy:item.y+item.height/2,rx:item.width/2,ry:item.height/2}) : svgNode('rect',{x:item.x,y:item.y,width:item.width,height:item.height,rx:Math.min(3,item.width/8)});
      shape.setAttribute('fill',pos===selected ? '#b8e7d2' : pos.fixed ? '#c7d4d2' : '#f8fbf9');shape.setAttribute('stroke',pos===selected ? '#12704f' : '#78988a');shape.setAttribute('vector-effect','non-scaling-stroke');
      const text=svgNode('text',{x:item.x+item.width/2,y:item.y+item.height/2,'text-anchor':'middle','dominant-baseline':'middle','font-size':Math.max(.5,Math.min(13,model.width/65,item.width/(String(item.id).length*.65+1),item.height/4)),fill:'#254d40'});text.textContent=item.id;
      const title=svgNode('title',{});title.textContent=[item.id,pos.labware_display || pos.module || pos.labware || pos.type].filter(Boolean).join(' · ');
      group.append(shape,text,title);svg.appendChild(group);
      group.addEventListener('click',()=>choosePosition(item));group.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();choosePosition(item);}});
      group.addEventListener('pointerdown',event=>{
        if(layout.layout_type!=='spatial') return;
        event.preventDefault();selected=pos;const bounds=svg.getBoundingClientRect();
        const scale=Math.min(bounds.width/model.width,bounds.height/model.height);
        drag={pos,startX:event.clientX,startY:event.clientY,x:pos.x,y:pos.y,scale};svg.setPointerCapture(event.pointerId);
      });
    }
    svg.addEventListener('pointermove',event=>{
      if(!drag) return;
      drag.pos.x=Math.round(Math.max(0,Math.min(model.width-drag.pos.width,drag.x+(event.clientX-drag.startX)/drag.scale))*100)/100;
      drag.pos.y=Math.round(Math.max(0,Math.min(model.height-drag.pos.height,drag.y+(event.clientY-drag.startY)/drag.scale))*100)/100;
      changed();
      // Keep the capturing SVG alive until pointerup; update only the drawn component.
      const index=model.positions.findIndex(item=>item.pos===drag.pos), group=svg.children[index+1];
      group.setAttribute('transform',`translate(${drag.pos.x-drag.x},${drag.pos.y-drag.y})`);
    });
    svg.addEventListener('pointerup',()=>{if(drag){drag=null;renderPreview();renderProperties();renderPositions();}});
    svg.addEventListener('pointercancel',()=>{drag=null;renderPreview();});stage.appendChild(svg);
    document.getElementById('admin-deck-caption').textContent=model.schematic ? 'Saved positions · relative / schematic geometry' : `Documented geometry · ${layout.workspace.units}`;
  }
  function renderProperties() {
    const panel=document.getElementById('admin-deck-properties');panel.replaceChildren(node('h2','Workspace'));
    if(layout.layout_type==='spatial') {
      for(const axis of ['width','height']) field(panel,`Workspace ${axis}`,layout.workspace[axis],value=>layout.workspace[axis]=value,'number');
      field(panel,'Context label',layout.workspace.label || '',value=>layout.workspace.label=value);
      field(panel,'Units (mm or relative)',layout.workspace.units || 'relative',value=>layout.workspace.units=value);
    } else if(layout.layout_type==='plates') {
      field(panel,'Plate arrangement (facing or side_by_side)',layout.arrangement || 'side_by_side',value=>layout.arrangement=value);
      for(const role of ['source','destination']) {
        layout.plates ||= {};layout.plates[role] ||= {};
        field(panel,`${role} plate type`,layout.plates[role].type || '',value=>layout.plates[role].type=value);
        field(panel,`${role} well count`,layout.plates[role].format,value=>layout.plates[role].format=value,'number');
      }
      panel.appendChild(node('p','Edit plate properties here, or convert to coordinates to drag the physical positions.'));
    } else if(layout.layout_type==='grid') {
      for(const axis of ['rows','cols']) field(panel,axis==='cols'?'Columns':'Rows',layout.grid[axis],value=>layout.grid[axis]=value,'number');
    } else panel.appendChild(node('p','This saved layout uses ordinal positions. Convert it to coordinate geometry to drag components.'));
    if(!selected) {panel.appendChild(node('p','Select a position on the diagram to edit its dimensions and fixed hardware.'));return;}
    panel.appendChild(node('h2',`Position ${selected.id ?? selected.index}`));
    field(panel,'Hardware label',selected.labware_display || '',value=>selected.labware_display=value);
    field(panel,'Hardware identifier',selected.labware || '',value=>selected.labware=value || null);
    field(panel,'Hardware type',selected.type || 'empty',value=>selected.type=value);
    checkbox(panel,'Fixed hardware',selected.fixed,value=>selected.fixed=value);
    if(layout.layout_type==='spatial') {
      for(const dimension of ['x','y','width','height']) field(panel,dimension,selected[dimension],value=>{selected[dimension]=value;renderPositions();},'number');
      field(panel,'Shape (rectangle or ellipse)',selected.shape || 'rectangle',value=>selected.shape=value);
    }
  }
  function renderPositions() {
    const list=document.getElementById('admin-deck-positions');list.replaceChildren();
    for(const item of records(layout)) {
      const row=node('div');row.className='admin-position-row';row._position=item.pos;
      if(item.carrier) {
        field(row,'Carrier track',item.carrier.track,value=>item.carrier.track=value,'number');
        field(row,'Position index',item.pos.index,value=>item.pos.index=value,'number');
      } else {
        field(row,'Position ID',item.pos.id,value=>item.pos.id=value);
        const axes=layout.layout_type==='spatial' ? ['x','y'] : ['row','col'];
        for(const axis of axes) field(row,axis,item.pos[axis] ?? 0,value=>item.pos[axis]=value,'number');
      }
      const edit=node('button','Details');edit.className='btn';edit.type='button';edit.addEventListener('click',()=>choosePosition(item));
      const remove=node('button','Remove');remove.className='btn';remove.type='button';remove.addEventListener('click',()=>{
        item.list.splice(item.list.indexOf(item.pos),1);if(selected===item.pos) selected=null;changed();render();
      });row.append(edit,remove);list.appendChild(row);
    }highlightRows();
  }
  function render() {
    document.getElementById('admin-deck-editor').hidden=false;renderPreview();renderProperties();renderPositions();
    const sources=document.getElementById('admin-deck-sources');sources.replaceChildren();
    for(const source of layout.sources || []) {const p=node('p',`${source.claim}: ${source.source}`);p.className='admin-deck-source';sources.appendChild(p);}
    document.getElementById('admin-deck-dirty').textContent=dirty ? 'Unsaved edits' : 'Saved layout';
  }
  function syncToggles() {window.adminConsole?.syncEditorToggles?.();}
  function isOpen(nextKey) {return key === nextKey && !!layout && !container.hidden;}
  async function toggle(nextKey) {
    if (key === nextKey && layout) {container.hidden = !container.hidden; syncToggles(); return true;}
    return open(nextKey);
  }
  async function open(nextKey,force=false) {
    if (key === nextKey && layout && !force) {container.hidden=false;syncToggles();return true;}
    if(dirty && !force && !confirm('Discard unsaved deck edits before opening another deck?')) {return false;}
    const request=++version;window.adminConsole.selectTab('devices');container.hidden=false;notice('Loading saved geometry…');
    try {
      const detail=await api(`/admin/devices/${encodeURIComponent(nextKey)}`);if(request!==version)return false;
      key=nextKey;
      document.getElementById('admin-selected-device').textContent=`Deck · ${detail.name || detail.profile?.name || nextKey}`;
      layout=detail.layout || {platform:detail.name,layout_type:'spatial',workspace:{width:100,height:100,units:'relative',label:'Administrator-defined workspace'},positions:[],instruments:[],sources:[]};
      saved=JSON.parse(JSON.stringify(layout));selected=null;dirty=false;render();notice(layout.layout_type==='spatial' ? 'Drag a position to move it, or use the fields for exact coordinates.' : 'Saved geometry loaded. Empty positions are shown without inventing carriers.');
      syncToggles(); return true;
    } catch(error) {notice(error.message,true);syncToggles();return false;}
  }
  document.getElementById('admin-deck-zoom').addEventListener('input',renderPreview);
  document.getElementById('admin-deck-save').addEventListener('click',async event=>{
    if(!layout)return;event.target.disabled=true;
    try {await api(`/admin/devices/${encodeURIComponent(key)}/layout`,'PATCH',{layout});saved=JSON.parse(JSON.stringify(layout));dirty=false;render();notice('Shared deck saved. Reopen a device workspace to load this layout.');}
    catch(error){notice(error.message,true);}finally{event.target.disabled=false;}
  });
  document.getElementById('admin-deck-discard').addEventListener('click',()=>{if(saved){layout=JSON.parse(JSON.stringify(saved));dirty=false;selected=null;render();notice('Unsaved deck edits discarded.');}});
  document.getElementById('admin-deck-add').addEventListener('click',()=>{
    if(!layout)return;layout.positions ||= [];
    if(!layout.positions.length && layout.carriers?.items?.length){notice('Convert this carrier-based layout to coordinate geometry before adding a new position.');return;}
    let number=layout.positions.length+1;while(layout.positions.some(pos=>pos.id===`position_${number}`))number++;
    const pos={id:`position_${number}`,type:'empty',labware:null};
    if(layout.layout_type==='spatial') Object.assign(pos,{x:0,y:0,width:Math.min(10,layout.workspace.width),height:Math.min(10,layout.workspace.height),shape:'rectangle'});
    else Object.assign(pos,{row:0,col:0});layout.positions.push(pos);selected=pos;changed();render();
  });
  document.getElementById('admin-deck-coordinates').addEventListener('click',()=>{
    if(!layout || layout.layout_type==='spatial')return;
    const model=geometry(layout);
    layout={...layout,layout_type:'spatial',workspace:{width:model.width,height:model.height,units:'relative',shape:model.shape,view:'top',label:'Administrator-defined relative geometry'},
      positions:model.positions.map(item=>({...item.pos,id:item.id,x:item.x,y:item.y,width:item.width,height:item.height,shape:item.shape})),carriers:{items:[]}};
    layout.sources=[...(layout.sources || []),{claim:'Relative geometry converted by an administrator; physical dimensions require verification.',source:'Administrator edit'}];
    selected=null;changed();render();notice('Converted to relative coordinates. Adjust the proportions before saving.');
  });
  function close() {
    if (dirty && !confirm('Discard unsaved deck edits before selecting another device?')) return false;
    ++version; dirty=false; key='';layout=null;saved=null;selected=null;container.hidden=true;
    document.getElementById('admin-deck-editor').hidden=true;
    syncToggles(); return true;
  }
  window.adminDeckEditor={open,close,toggle,isOpen,geometry};
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
})();
