/* Instant suggestions from the saved device inventory; online checks happen only on submission. */
(() => {
  function devicesFor(rows) {
    const devices=new Map(),names=new Set();
    for(const row of rows) {
      if(!row || typeof row.name!=='string' || !['ready','local'].includes(row.status))continue;
      const models=['series','family'].includes(row.kind)
        ?(row.members||[]).map(member=>({...member,status:'local',family_name:row.name,search_terms:row.search_terms||[]})):[row];
      for(const model of models) {
        if(typeof model.name!=='string')continue;
        const name=model.name.toLocaleLowerCase(),key=model.key || name;
        if(!devices.has(key) && !names.has(name)) {devices.set(key,model);names.add(name);}
      }
    }
    return [...devices.values()].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  }
  function searchWords(text) {
    return String(text).normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(word=>word.length>3?word.replace(/s$/,''):word);
  }
  function matchingDevices(devices,query='',identityOnly=false) {
    const words=searchWords(query);
    return devices.filter(device=>{
      const fields=[device.name,device.manufacturer,device.model,device.family_name,...(device.members||[]).map(member=>member.name)];
      const identity=searchWords(fields.filter(Boolean).join(' ')).join(' ');
      if(words.every(word=>identity.includes(word)))return true;
      // Keep each capability separate: plate creation plus a barcode reader is not a plate reader.
      return !identityOnly && (device.search_terms||[]).some(term=>{
        const text=searchWords(term).join(' ');
        return words.every(word=>text.includes(word));
      });
    });
  }
  function resolveDeviceMatch(devices,query) {
    const name=query.trim().toLocaleLowerCase();
    if(!name)return null;
    devices=devices.filter(device=>!['series','family'].includes(device.kind));
    const exact=devices.filter(device=>device.name.toLocaleLowerCase()===name);
    if(exact.length===1)return exact[0];
    const matches=matchingDevices(devices,query,true);
    if(matches.length!==1)return null;
    const device=matches[0],model=device.model;
    const normalize=value=>value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    // A single matching saved device is not evidence that a family-only query selected its model.
    return typeof model==='string' && normalize(model) && normalize(query).includes(normalize(model))?device:null;
  }
  if(typeof module!=='undefined' && module.exports) {module.exports={devicesFor,matchingDevices,resolveDeviceMatch};return;}
  const input=document.getElementById('user-input'),menu=document.getElementById('landing-device-suggestions');
  if(!input || !menu)return;
  const status=document.getElementById('landing-equipment-status');
  let devices=[],dismissed=false,pending=false,submitted=false;
  function node(tag,text){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
  function highlight(element,text,query) {
    const words=query.trim().split(/\s+/).filter(Boolean);
    const lower=text.toLocaleLowerCase(),ranges=[];
    for(const word of words) {
      const needle=word.toLocaleLowerCase();
      let index=0;
      while((index=lower.indexOf(needle,index))!==-1) {ranges.push([index,index+needle.length]);index+=needle.length;}
    }
    ranges.sort((a,b)=>a[0]-b[0]);
    const merged=[];
    for(const range of ranges) {
      const last=merged[merged.length-1];
      if(last && range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push(range);
    }
    element.replaceChildren();let start=0;
    for(const [a,b] of merged) {element.append(document.createTextNode(text.slice(start,a)),node('mark',text.slice(a,b)));start=b;}
    element.appendChild(document.createTextNode(text.slice(start)));
  }
  function searchQuery() {
    return !submitted && !dismissed && document.body.classList.contains('landing') && !window.workspace?.busy && window.workspace?.choosingDevice!==false?input.value.trim():'';
  }
  function dismissSearch(){dismissed=true;renderSearch();}
  function renderSearch() {
    const query=searchQuery(),matches=query?matchingDevices(devices,query):[];
    menu.replaceChildren();menu.hidden=!matches.length;
    status.textContent=query
      ?matches.length?`${matches.length} saved ${matches.length===1?'device matches':'devices match'}. Choose a suggestion or press Enter.`
        :'No saved device matches. Press Enter to check this device online.' : '';
    for(const [index,device] of matches.entries()) {
      const button=node('button');button.type='button';highlight(button,device.name,query);
      // Keep focus in the composer until click: Safari can blur to the page instead of the button.
      button.addEventListener('pointerdown',event=>{if(event.button===0)event.preventDefault();});
      button.addEventListener('click',()=>{
        submitted=true;dismissSearch();
        if(window.workspace?.selectLandingDevice)window.workspace.selectLandingDevice(device.name,true);
        else window.workspace?.chooseDevice(device.name,null,true);
      });
      button.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();input.focus();dismissSearch();}
        if(event.key==='ArrowDown' || event.key==='ArrowUp') {
          event.preventDefault();
          const next=index+(event.key==='ArrowDown'?1:-1);
          if(next<0)input.focus();else menu.children[next%matches.length]?.focus();
        }
      });
      menu.appendChild(button);
    }
  }
  input.addEventListener('input',()=>{input.value=input.value.replace(/[\r\n]+/g,' ');submitted=false;dismissed=false;window.workspace?.clearDeviceChoices?.();renderSearch();});
  input.addEventListener('focus',()=>{dismissed=false;renderSearch();});
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape')dismissSearch();
    if(event.key==='ArrowDown' && !menu.hidden){event.preventDefault();menu.children[0]?.focus();}
  });
  document.getElementById('landing-composer').addEventListener('focusout',event=>{
    if(!event.currentTarget.contains(event.relatedTarget))dismissSearch();
  });
  async function refresh() {
    if(pending || !document.body.classList.contains('landing'))return;
    pending=true;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch('/devices/equipment?series=1',{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error('Catalog unavailable');
      const rows=await response.json();if(!Array.isArray(rows))throw Error('Invalid catalog');
      devices=devicesFor(rows);renderSearch();
    } catch(_) {if(!devices.length)status.textContent='Saved devices could not be loaded. Enter a device name to check it online.';}
    finally {pending=false;clearTimeout(timeout);}
  }
  new MutationObserver(()=>{
    if(document.body.classList.contains('landing')){dismissed=false;renderSearch();refresh();}else dismissSearch();
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.landingEquipment={refresh,dismissSearch,editDevice(){submitted=false;dismissed=false;renderSearch();},beginCheck(){submitted=true;dismissSearch();},renderSearch,resolve:query=>resolveDeviceMatch(devices,query)};
  refresh();setInterval(refresh,15000);
})();
