const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(`${__dirname}/../biobot/static/script.js`,'utf8');
const listCode=source.slice(source.indexOf('async function refreshChatList()'),source.indexOf('// --- Select chat in sidebar ---'));
const accountSource=fs.readFileSync(`${__dirname}/../biobot/static/account.js`,'utf8');
const accessCode=accountSource.slice(accountSource.indexOf('function syncAccountAccess('),accountSource.indexOf('// --- Account controls ---'));
class Element {
  constructor(){this.children=[];this.dataset={};this.events={};this.hidden=false;this.textContent='';this.classList={toggle(){},add(){},remove(){}};}
  appendChild(item){this.children.push(item);return item;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(event,fn){this.events[event]=fn;}
  querySelector(){return new Element();}
}
function setup({fail=false,brokenMetadata=false}={}) {
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const chats=Array.from({length:10},(_,index)=>({chat_id:`chat-${index}`,name:`Conversation ${index}`,device:'Saved device',run:null}));
  const list=new Element(),oldRow=new Element();oldRow.dataset.chatId='previous';list.appendChild(oldRow);
  const context=vm.createContext({document:{getElementById:get,createElement:()=>new Element()},chatListElem:list,showingTrash:false,currentChatId:'chat-0',chatJobs:new Map(),
    fetch:async()=>({ok:!fail,json:async()=>chats}),window:{workspace:{rememberChat(){if(brokenMetadata)throw Error('optional metadata failed');},refreshTrash(){}}},
    setTimeout(){return 1;},clearTimeout(){},resumeChatRun(){},syncChatActivity(){},selectChatListItem(){},loadChatHistory(){},trashChat(){},restoreChat(){},alert(){},console:{error(){}}});
  vm.runInContext(listCode+accessCode,context);
  return {context,get,list,oldRow,chats};
}

test('all ten active chats render together and the sidebar shows the full count',async()=>{
  const w=setup();const result=await w.context.refreshChatList();
  assert.equal(result.length,10);assert.equal(w.list.children.length,10);
  assert.deepEqual(w.list.children.map(row=>row.dataset.chatId),w.chats.map(chat=>chat.chat_id));
  assert.equal(w.get('recent-chat-count').textContent,'10');
  assert.equal(w.get('chat-list-status').hidden,true);
});

test('an optional metadata error cannot truncate the conversation list',async()=>{
  const w=setup({brokenMetadata:true});await w.context.refreshChatList();
  assert.equal(w.list.children.length,10);
  assert.equal(w.list.children.at(-1).dataset.chatId,'chat-9');
});

test('a failed refresh preserves existing conversations and displays retry guidance',async()=>{
  const w=setup({fail:true});await w.context.refreshChatList();
  assert.equal(w.list.children[0],w.oldRow);
  assert.equal(w.get('chat-list-status').hidden,false);
  assert.match(w.get('chat-list-status').textContent,/Refresh recent chats/);
});

test('opening profile after approval replaces pending status and reveals both admin links',()=>{
  const w=setup();w.get('admin-btn').hidden=true;w.get('admin-workspace-link').hidden=true;
  w.context.syncAccountAccess({is_admin:false,admin_status:'requested'});
  assert.match(w.get('profile-admin-access').children[0].textContent,/awaiting approval/);
  w.context.syncAccountAccess({is_admin:true,admin_status:'approved'});
  assert.equal(w.get('admin-btn').hidden,false);assert.equal(w.get('admin-workspace-link').hidden,false);
  assert.equal(w.get('profile-admin-access').children[0].href,'/admin');
  assert.match(w.get('profile-admin-access').children[0].textContent,/approved/);
});

test('revoked access hides admin controls without granting any permission in the browser',()=>{
  const w=setup();w.context.syncAccountAccess({is_admin:false,admin_status:null});
  assert.equal(w.get('admin-btn').hidden,true);assert.equal(w.get('admin-workspace-link').hidden,true);
  assert.equal(w.get('profile-admin-access').children[0].textContent,'Request admin access');
});

test('shared account controls open profile without initializing a chat workspace',async()=>{
  const w=setup();
  w.context.fetch=async()=>({ok:true,json:async()=>({first_name:'Preview',last_name:'Administrator',email:'preview@example.test',country:'France',is_admin:true})});
  vm.runInContext(accountSource,w.context);
  await w.get('settings-btn').events.click();
  assert.equal(w.get('profile-first-name').value,'Preview');
  assert.equal(w.get('profile-first-name').disabled,true);
  assert.equal(w.get('admin-workspace-link').hidden,false);
  assert.equal(typeof w.get('logout-btn').events.click,'function');
  assert.equal(typeof w.get('change-password-btn').events.click,'function');
});
