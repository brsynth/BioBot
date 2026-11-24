/* Category discovery around a protected, usable landing-page center. */
(() => {
  function groupsFor(rows) {
    const groups = new Map(), seen = new Set();
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || row.status !== 'ready' || seen.has(row.key || row.name)) continue;
      seen.add(row.key || row.name);
      for (const category of new Set(row.categories?.length ? row.categories : ['Other equipment'])) {
        if (typeof category !== 'string') continue;
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(row);
      }
    }
    return [...groups].sort(([a],[b]) => a.localeCompare(b)).map(([name,devices]) =>
      ({name,devices:devices.sort((a,b) => a.name.localeCompare(b.name))}));
  }
  function matchingDevices(devices,query='') {
    const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return devices.filter(device=>words.every(word=>device.name.toLocaleLowerCase().includes(word)));
  }
  function overlaps(a,b,pad=0) {
    return a.x < b.x+b.w+pad && a.x+a.w+pad > b.x && a.y < b.y+b.h+pad && a.y+a.h+pad > b.y;
  }
  function bubblesOverlap(a,b,pad=0) {
    return Math.hypot(a.x+a.w/2-b.x-b.w/2,a.y+a.h/2-b.y-b.h/2)<a.w/2+b.w/2+pad;
  }
  function seriesFor(devices) {
    // Navigation groups do not change physical-model identity or merge device records.
    const stem=device=>{
      const model=device.model || device.name.replace(device.manufacturer || '', '').trim();
      return (model.match(/^([\p{L}][\p{L} -]*?)(?=\s*\d|[- ]+\d)/u)?.[1] || '').trim();
    };
    const stems=new Map();
    for(const device of devices) {const root=stem(device).toLocaleLowerCase();if(root)stems.set(root,(stems.get(root)||0)+1);}
    const groups=new Map();
    for(const device of devices) {
      const root=stem(device),name=root && stems.get(root.toLocaleLowerCase())>1 ? root : device.manufacturer || device.name.split(/\s+/)[0];
      const key=name.toLocaleLowerCase();
      if(!groups.has(key))groups.set(key,{name,devices:[]});
      groups.get(key).devices.push(device);
    }
    return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name));
  }
  function plan({width,height,protectedRect,groups,open=null,openAnchor=null,openSeries=null,seriesAnchor=null,positions={},anchorHeight=height}) {
    const placed=[], occupied=[], edge=14;
    function place(item,target,{gap=18,top=70,step=22}={}) {
      let best=null, score=Infinity;
      const xs=new Set([target.x,edge,width-item.w-edge,protectedRect.x-item.w-20,protectedRect.x+protectedRect.w+20]);
      for(let x=edge;x<=width-item.w-edge;x+=22)xs.add(x);
      const ys=new Set([target.y]);
      for(let y=top;y<=height-item.h-30;y+=step)ys.add(y);
      for (const y of ys) for (const x of xs) {
        if(y<14 || y+item.h>height-30 || x<edge || x+item.w>width-edge)continue;
        const rect={x,y,w:item.w,h:item.h};
        if (overlaps(rect,protectedRect,20) || occupied.some(other=>bubblesOverlap(rect,other,gap))) continue;
        const distance=(x-target.x)**2+(y-target.y)**2;
        if(distance<score) {score=distance;best=rect;}
      }
      if (!best) return null;
      const result={...item,...best};placed.push(result);occupied.push(result);return result;
    }
    function savedTarget(key,w,h,fallback) {
      const saved=positions[key];
      return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? {x:Math.max(edge,Math.min(width-w-edge,saved.x*width-w/2)),
           y:Math.max(14,Math.min(height-h-30,saved.y*anchorHeight-h/2))} : fallback;
    }
    const ordered=groups.map((group,i)=>({group,i})).sort((a,b)=>
      Number(!!positions[`category:${b.group.name}`])-Number(!!positions[`category:${a.group.name}`]));
    for(const {group,i} of ordered) {
      const target=savedTarget(`category:${group.name}`,106,106,
        {x:width*(.06+((i*.618)%1)*.77),y:70+((i*.414)%1)*(anchorHeight-200)});
      if(!place({kind:'category',name:group.name,count:group.devices.length,w:106,h:106,open:false},target))return null;
    }
    const active=groups.find(group=>group.name===open);
    if(!active)return placed;
    const anchors=placed.slice(),original=anchors.find(item=>item.name===open),anchor=openAnchor || original;
    placed.length=0;occupied.length=0;
    const parent={...original,x:anchor.x-10,y:anchor.y-10,w:anchor.w+20,h:anchor.h+20,open:true};
    if(overlaps(parent,protectedRect) || parent.x<0 || parent.y<0 || parent.x+parent.w>width || parent.y+parent.h>height)return null;
    placed.push(parent);occupied.push(parent);
    const branches=seriesFor(active.devices),selected=branches.find(branch=>branch.name===openSeries);
    const orbit=Math.max(170,Math.sqrt(branches.length)*65);
    const branchNodes=[];
    // The selected branch is placed first to keep its clicked center fixed.
    for(const branch of [...branches].sort((a,b)=>Number(b===selected)-Number(a===selected))) {
      const index=branches.indexOf(branch),angle=-Math.PI/2+index*2*Math.PI/branches.length;
      const size=branch===selected?114:96,identity=`series:${open}:${branch.name}`;
      const target=branch===selected && seriesAnchor
        ? {x:seriesAnchor.x+(seriesAnchor.w-size)/2,y:seriesAnchor.y+(seriesAnchor.h-size)/2}
        : savedTarget(identity,size,size,{x:parent.x+parent.w/2+Math.cos(angle)*orbit-size/2,y:parent.y+parent.h/2+Math.sin(angle)*orbit-size/2});
      const item=place({kind:'series',identity,name:branch.name,count:branch.devices.length,w:size,h:size,open:branch===selected,parent:`category:${open}`},target,{gap:14,top:14,step:12});
      if(!item)return null;branchNodes.push(item);
    }
    const selectedNode=branchNodes.find(item=>item.open);
    if(selectedNode)for(const [i,device] of selected.devices.entries()) {
      const ring=Math.floor(i/8),angle=-Math.PI/2+(i%8)*2*Math.PI/Math.min(8,selected.devices.length)+ring*.3,radius=145+ring*110;
      if(!place({kind:'device',device,name:device.name,w:96,h:96,parent:selectedNode.identity},
        savedTarget(`device:${open}:${device.key || device.name}`,96,96,
          {x:selectedNode.x+selectedNode.w/2+Math.cos(angle)*radius-48,y:selectedNode.y+selectedNode.h/2+Math.sin(angle)*radius-48}),
        {gap:12,top:14,step:12}))return null;
    }
    for(const item of anchors.filter(item=>item.name!==open)) {
      const dx=item.x+item.w/2-parent.x-parent.w/2,dy=item.y+item.h/2-parent.y-parent.h/2,distance=Math.hypot(dx,dy);
      const push=distance<orbit+180?Math.max(90,orbit+180-distance):0;
      if(!place(item,{x:item.x+(distance?dx/distance*push:0),y:item.y+(distance?dy/distance*push:0)},{gap:14,top:14,step:12}))return null;
    }
    return placed;
  }
  if (typeof module !== 'undefined' && module.exports) {module.exports={groupsFor,plan,overlaps,bubblesOverlap,matchingDevices,seriesFor};return;}
  const stage=document.getElementById('landing-stage');
  if(!stage)return;
  const pane=document.getElementById('chat-panel'),layer=document.getElementById('landing-equipment-bubbles');
  const lines=document.getElementById('landing-equipment-lines'),status=document.getElementById('landing-equipment-status');
  let groups=[],open=null,openAnchor=null,openSeries=null,seriesAnchor=null,openGeometry=null,pending=false,frame=null,signature='';
  const motionStarted=performance.now();
  const storageKey=`biobot-bubble-positions:${document.body.dataset.userId || 'guest'}`;
  let positions={};
  try {const saved=JSON.parse(localStorage.getItem(storageKey) || '{}');if(saved && typeof saved==='object' && !Array.isArray(saved))positions=saved;} catch(_) {}
  let dragging=false;
  function savePositions(){try{localStorage.setItem(storageKey,JSON.stringify(positions));}catch(_) {}}
  function makeDraggable(bubble,item,width,height) {
    let gesture=null,suppressClick=false;
    bubble.addEventListener('dragstart',event=>event.preventDefault());
    bubble.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      gesture={id:event.pointerId,x:event.clientX,y:event.clientY,left:item.x,top:item.y,moved:false};
    });
    bubble.addEventListener('pointermove',event=>{
      if(!gesture || gesture.id!==event.pointerId)return;
      const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
      if(!gesture.moved && Math.hypot(dx,dy)<6)return;
      if(!gesture.moved){gesture.moved=true;dragging=true;bubble.setPointerCapture(event.pointerId);bubble.getAnimations().forEach(animation=>animation.cancel());bubble.classList.add('is-dragging');}
      event.preventDefault();
      bubble.style.left=`${Math.max(14,Math.min(width-item.w-14,gesture.left+dx))}px`;
      bubble.style.top=`${Math.max(14,Math.min(height-item.h-30,gesture.top+dy))}px`;
    });
    function finish(event) {
      if(!gesture || gesture.id!==event.pointerId)return;
      const moved=gesture.moved;gesture=null;dragging=false;
      if(!moved)return;
      suppressClick=true;bubble.classList.remove('is-dragging');
      if(bubble.hasPointerCapture(event.pointerId))bubble.releasePointerCapture(event.pointerId);
      if(event.type!=='pointercancel') {
        const key=item.identity || (item.kind==='category'?`category:${item.name}`:`device:${open}:${item.device.key || item.name}`);
        positions[key]={x:(bubble.offsetLeft+item.w/2)/width,y:(bubble.offsetTop+item.h/2)/(openGeometry?.height || height)};
        savePositions();
        if(item.kind==='category' && item.open)openAnchor=null;
        if(item.kind==='series' && item.open)seriesAnchor=null;
      }
      signature='';schedule();
    }
    bubble.addEventListener('pointerup',finish);bubble.addEventListener('pointercancel',finish);
    bubble.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}},true);
  }
  function node(tag,text,classes) {const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(classes)el.className=classes;return el;}
  function browseDevices(group) {
    const dialog=node('dialog',undefined,'equipment-browser');
    const header=node('div',undefined,'equipment-browser-header');
    const heading=node('h2',`${group.name} · all ${group.devices.length} devices`);
    heading.id='equipment-browser-title';dialog.setAttribute('aria-labelledby',heading.id);
    const close=node('button','×');close.type='button';close.setAttribute('aria-label','Close device browser');
    close.addEventListener('click',()=>dialog.close());header.append(heading,close);
    const search=node('input');search.type='search';search.placeholder='Search devices…';search.setAttribute('aria-label',`Search ${group.name} devices`);
    const count=node('p',undefined,'equipment-browser-count');count.setAttribute('role','status');
    const list=node('div',undefined,'equipment-browser-list');
    function renderMatches() {
      const matches=matchingDevices(group.devices,search.value);list.replaceChildren();
      count.textContent=`${matches.length} of ${group.devices.length} devices`;
      for(const device of matches) {
        const link=node('a');link.href=`/?landing=1&device=${encodeURIComponent(device.name)}`;
        const query=search.value.trim(),index=device.name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if(query && index>=0)link.append(document.createTextNode(device.name.slice(0,index)),node('mark',device.name.slice(index,index+query.length)),document.createTextNode(device.name.slice(index+query.length)));
        else link.textContent=device.name;
        link.addEventListener('click',event=>{
          if(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
          event.preventDefault();dialog.close();window.workspace?.chooseDevice(device.name,null,true);
        });list.appendChild(link);
      }
      if(!matches.length)list.appendChild(node('p','No matching devices in this category.'));
    }
    search.addEventListener('input',renderMatches);
    dialog.addEventListener('close',()=>dialog.remove());
    dialog.append(header,search,count,list);document.body.appendChild(dialog);renderMatches();dialog.showModal();search.focus();
  }
  function schedule() {cancelAnimationFrame(frame);frame=requestAnimationFrame(layout);}
  function bounds(el,origin) {const r=el.getBoundingClientRect();return {x:r.left-origin.left,y:r.top-origin.top,w:r.width,h:r.height};}
  function layout() {
    if(dragging || !document.body.classList.contains('landing') || !groups.length)return;
    const width=stage.clientWidth,base=Math.max(pane.clientHeight,560);
    if(!width)return;
    if(openGeometry && (openGeometry.width!==width || openGeometry.viewportHeight!==pane.clientHeight)){openAnchor=null;seriesAnchor=null;openGeometry=null;}
    stage.classList.toggle('has-open-category',!!(open && openGeometry));
    if(openGeometry)stage.style.setProperty('--landing-open-top',`${openGeometry.introTop}px`);
    const itemCount=groups.length;
    let height=width<600 ? Math.max(base,350+Math.ceil(itemCount/Math.max(1,Math.floor(width/180)))*112) : base;
    let items=null;
    for(let attempt=0;attempt<20 && !items;attempt++) {
      stage.style.height=`${height}px`;
      const origin=stage.getBoundingClientRect(),a=bounds(document.getElementById('landing-intro'),origin),b=bounds(stage.querySelector('.input-area'),origin);
      const protectedRect={x:Math.min(a.x,b.x),y:a.y,w:Math.max(a.x+a.w,b.x+b.w)-Math.min(a.x,b.x),h:b.y+b.h-a.y};
      const closed=plan({width,height,protectedRect,groups,positions});
      if(!closed){height+=100;continue;}
      if(!open){items=closed;break;}
      items=plan({width,height,protectedRect,groups,open,openAnchor,openSeries,seriesAnchor,positions,anchorHeight:openGeometry?.height || height});
      if(!items)height+=120;
    }
    if(!items){status.textContent='Resize the window to explore all categories. You can still enter a device name.';return;}
    const next=JSON.stringify({open,openSeries,items});
    if(next===signature)return;signature=next;
    const focusedIdentity=document.activeElement?.closest('.equipment-bubble')?.dataset.identity;
    const focusedLabel=document.activeElement?.getAttribute('aria-label');
    const previous=new Map([...layer.children].map(el=>[el.dataset.identity,el.getBoundingClientRect()]));
    layer.replaceChildren();lines.replaceChildren();
    lines.setAttribute('viewBox',`0 0 ${width} ${height}`);
    for(const [index,item] of items.entries()) {
      const bubble=node('div',undefined,`equipment-bubble ${item.kind==='device'?'equipment-device':`equipment-category${item.kind==='series'?' equipment-series':''}`}${item.open?' is-open':''}`);
      bubble.dataset.identity=item.identity || `${item.kind}:${item.name}`;
      Object.assign(bubble.style,{left:`${item.x}px`,top:`${item.y}px`,width:`${item.w}px`,height:`${item.h}px`});
      bubble.style.setProperty('--bubble-delay',`${-((Math.max(0,groups.findIndex(group=>group.name===item.name))%8)+(performance.now()-motionStarted)/1000)}s`);bubble.style.setProperty('--bubble-hue',String(([...item.name].reduce((sum,char)=>sum+char.charCodeAt(0),0)*41+150)%360));
      if(item.kind==='category' || item.kind==='series') {
        const button=node('button',undefined,'equipment-category-toggle');button.type='button';
        button.append(node('span',item.name,'equipment-category-name'),node('span',`${item.count} ${item.count===1?'device':'devices'}`,'equipment-category-count'));
        button.setAttribute('aria-expanded',String(item.open));
        button.setAttribute('aria-controls','landing-equipment-bubbles');
        button.addEventListener('click',()=>{
          if(item.kind==='series') {
            openSeries=openSeries===item.name?null:item.name;
            const rect=bubble.getBoundingClientRect(),origin=stage.getBoundingClientRect();
            seriesAnchor=openSeries?{x:rect.left-origin.left,y:rect.top-origin.top,w:item.w,h:item.h}:null;
          } else if(open===item.name){open=null;openAnchor=null;openGeometry=null;openSeries=null;seriesAnchor=null;}
          else {
            const rect=bubble.getBoundingClientRect(),origin=stage.getBoundingClientRect();
            // Capture the clicked bubble, including its current float offset, before any reflow.
            openAnchor={x:rect.left-origin.left+(rect.width-bubble.offsetWidth)/2,
              y:rect.top-origin.top+(rect.height-bubble.offsetHeight)/2,w:bubble.offsetWidth,h:bubble.offsetHeight,
              viewportWidth:stage.clientWidth,viewportHeight:pane.clientHeight};
            if(!openGeometry)openGeometry={width:stage.clientWidth,viewportHeight:pane.clientHeight,height:stage.clientHeight,introTop:document.getElementById('landing-intro').offsetTop};
            open=item.name;openSeries=null;seriesAnchor=null;
          }
          signature='';schedule();
        });
        bubble.appendChild(button);
      } else {
        const link=node('a',undefined,'equipment-device-link');link.appendChild(node('span',item.name));link.title=item.name;link.href=`/?landing=1&device=${encodeURIComponent(item.name)}`;
        link.addEventListener('click',event=>{
          if(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
          event.preventDefault();window.workspace?.chooseDevice(item.name,null,true);
        });bubble.appendChild(link);
      }
      if(item.parent) {
        const origin=items.find(candidate=>(candidate.identity || `${candidate.kind}:${candidate.name}`)===item.parent);
        if(origin){
          const path=document.createElementNS('http://www.w3.org/2000/svg','path');
          const x=origin.x+origin.w/2,y=origin.y+origin.h/2,tx=item.x+item.w/2,ty=item.y+item.h/2;
          path.setAttribute('d',`M${x},${y} Q${(x+tx)/2+18},${(y+ty)/2-22} ${tx},${ty}`);lines.appendChild(path);
        }
      }
      makeDraggable(bubble,item,width,height);
      layer.appendChild(bubble);
      if(bubble.dataset.identity===focusedIdentity) {
        const controls=[...bubble.querySelectorAll('button,a')];
        (controls.find(control=>!control.disabled && focusedLabel && control.getAttribute('aria-label')===focusedLabel) || controls[0])?.focus({preventScroll:true});
      }
      const old=previous.get(bubble.dataset.identity);
      if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches && bubble.animate) {
        if(old) {
          const now=bubble.getBoundingClientRect(),dx=old.x+old.width/2-now.x-now.width/2,dy=old.y+old.height/2-now.y-now.height/2;
          if(Math.abs(dx)>.25 || Math.abs(dy)>.25 || Math.abs(old.width-now.width)>.25 || Math.abs(old.height-now.height)>.25)
            bubble.animate([{translate:`${dx}px ${dy}px`,scale:`${old.width/now.width} ${old.height/now.height}`},
              {translate:'0px 0px',scale:'1 1'}],{duration:600,easing:'cubic-bezier(.22,.7,.25,1)'});
        } else if(item.kind==='device') bubble.animate([{opacity:0,scale:'.94'},{opacity:1,scale:'1'}],{duration:400,easing:'ease-out'});
      }
    }
    status.replaceChildren();
    if(open) {
      const group=groups.find(group=>group.name===open);
      const browse=node('button',`Browse all ${group.devices.length} ${open} devices`,'equipment-browse-all');browse.type='button';
      browse.addEventListener('click',()=>browseDevices(group));status.appendChild(browse);
      status.appendChild(node('span','Choose a series bubble to show all its models. Drag bubbles to arrange them.'));
    } else status.textContent='Choose a category, or enter any programmable instrument. Drag bubbles to arrange them.';
  }
  async function refresh() {
    if(pending || !document.body.classList.contains('landing'))return;
    pending=true;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch('/devices/equipment',{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error('Catalog unavailable');
      const rows=await response.json();if(!Array.isArray(rows))throw Error('Invalid catalog');
      const next=groupsFor(rows);
      if(JSON.stringify(next)!==JSON.stringify(groups)) {
        groups=next;const active=groups.find(group=>group.name===open);
        if(!active){open=null;openAnchor=null;openGeometry=null;openSeries=null;seriesAnchor=null;}
        signature='';schedule();
      }
      if(!groups.length)status.textContent='Categories will appear as devices become ready. You can enter a device name now.';
    } catch(_) {
      if(!groups.length) {status.replaceChildren(node('span','Equipment categories could not be loaded. '));const retry=node('button','Retry');retry.type='button';retry.addEventListener('click',refresh);status.appendChild(retry);}
    } finally {pending=false;clearTimeout(timeout);}
  }
  new ResizeObserver(schedule).observe(pane);
  for(const id of ['landing-intro','user-input'])new ResizeObserver(schedule).observe(document.getElementById(id));
  new MutationObserver(()=>{if(document.body.classList.contains('landing')){schedule();refresh();}}).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.landingEquipment={refresh};status.textContent='Loading equipment categories…';refresh();
  setInterval(refresh,15000);
})();
