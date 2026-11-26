const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../biobot/static/script.js`, 'utf8');
const activity = source.slice(source.indexOf('function syncChatActivity()'), source.indexOf('// --- Auto-scroll detection ---'));
const load = source.slice(source.indexOf('async function loadChatHistory('), source.indexOf('// --- Conversation Trash ---'));
const resume = source.slice(source.indexOf('function renderChatMessages('), source.indexOf('// --- Load chat history ---'));
const send = source.slice(source.indexOf('async function* readChatReply('), source.indexOf('// --- Event Listeners ---'));
const newChat = source.slice(source.indexOf('async function createNewChat('), source.indexOf('// --- Thinking indicator ---'));
const tick = () => new Promise(setImmediate);

class Element {
  constructor() {this.children=[]; this.dataset={}; this.style={}; this.value=''; this.classList={add(){},remove(){},toggle(){}};}
  get childNodes() {return [...this.children];}
  append(...nodes) {nodes.forEach(node=>this.appendChild(node));}
  appendChild(node) {node.remove?.(); node.parent=this; this.children.push(node); return node;}
  prepend(node) {node.remove?.(); node.parent=this; this.children.unshift(node);}
  remove() {if(this.parent) this.parent.children=this.parent.children.filter(node=>node!==this); this.parent=null;}
  set innerHTML(value) {this.replaceChildren();}
  replaceChildren(...nodes) {this.children.forEach(node=>node.parent=null); this.children=[]; this.append(...nodes);}
  setAttribute(key,value) {this[key]=value;}
  querySelectorAll(selector) {return this.children.flatMap(node=>[
    ...(node.className?.split(' ').includes(selector.slice(1)) ? [node] : []), ...node.querySelectorAll(selector)]);}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
}
function setup() {
  const jobs=new Map(), history=new Element(), input=new Element(), list=new Element(), streams=new Map(), decks=[], requests=[];
  const badge=new Element(), historyButton=new Element();
  for(const id of ['a','b']) {const row=new Element(); row.dataset.chatId=id; const title=new Element(); title.className='chat-title-row'; row.append(title); list.append(row);}
  const ctx=vm.createContext({
    chatJobs:jobs, chatLoadVersion:0, currentChatId:'a', isTyping:false, chatRequestController:null, chatRequestDone:Promise.resolve(),
    chatHistoryElem:history, chatListElem:list, sendBtn:{},
    document:{getElementById:id=>id==='history-unread-count'?badge:id==='sidebar-toggle'?historyButton:input, createElement:()=>new Element(), createTextNode:text=>Object.assign(new Element(),{textContent:text})},
    window:{workspace:{startDevice:async()=>false,analyzingIcon:()=>new Element(),enterChat(){},restoreChat(){},syncActions(){},switchChat(){},generationLayout(){},get busy(){return false;}},parseDeckFromCode:code=>decks.push({chat:ctx.currentChatId,code})},
    addMessage(text,sender,id,target=history) {const node=new Element(); node._buffer=''; node.textContent=text; target.append(node); return node;},
    addThinkingMessage:()=>1, renderUserMessage(){}, scrollToBottom(){}, closeSidebar(){}, selectChatListItem(){},
    appendChunkToBotMessage(node,text) {node.textContent+=text;}, buildDeckLink:code=>Object.assign(new Element(),{className:'protocol-deck-link',_protocolCode:code}),
    refreshChatList:async()=>ctx.syncChatActivity(), localStorage:{setItem(){},removeItem(){}}, alert(){},
    TextDecoder, AbortController, clearInterval(){}, setTimeout(){}, console:{error(){}},
    fetch:async (url,options={})=>{
      requests.push({url,method:options.method || 'GET'});
      if(!url.endsWith('/stream')) return {ok:true,json:async()=>[]};
      const id=url.split('/')[2]; let finish;
      const pending=new Promise(resolve=>finish=resolve); let done=false;
      streams.set(id,finish);
      return {ok:true,status:200,headers:{get:()=>7},body:{getReader:()=>({read:async()=>{
        if(done) return {done:true}; done=true;
        return {done:false,value:new TextEncoder().encode(await pending)};
      }})}};
    },
  });
  vm.runInContext(activity+resume+load+send,ctx);
  return {ctx,jobs,history,list,streams,decks,requests,badge,historyButton};
}

test('two chats stream independently; navigation preserves running views and completion badges clear on opening', async()=>{
  const w=setup();
  const first=w.ctx.sendMessage({message:'first'}); await tick();
  const firstView=w.jobs.get('a').view;
  await w.ctx.loadChatHistory('b');
  assert.equal(w.ctx.isTyping,false);
  const second=w.ctx.sendMessage({message:'second'}); await tick();
  assert.equal(w.jobs.get('a').status,'running');
  assert.equal(w.jobs.get('b').status,'running');
  assert.equal(w.list.children[0].children[0].className,'chat-status running');
  w.streams.get('a')('__STATUS__:Generating...\nfirst protocol'); await first;
  assert.equal(w.jobs.get('a').status,'done');
  assert.equal(w.ctx.isTyping,true); // B is still running.
  assert.deepEqual(w.decks,[]); // A cannot replace B's deck.
  assert.equal(w.badge.hidden,false);assert.equal(w.badge.textContent,'1');
  assert.match(w.historyButton['aria-label'],/1 unread result/);
  await w.ctx.loadChatHistory('a');
  assert.equal(w.history.children[0],firstView);
  assert.equal(w.jobs.get('a').status,'read');
  assert.equal(w.badge.hidden,true);
  w.streams.get('b')('__FAILED_CODE__:Validation failed'); await second;
  assert.equal(w.jobs.get('b').status,'error');
  assert.equal(w.list.children[1].children[0].className,'chat-status error');
  assert.equal(w.ctx.currentChatId,'a');
  await w.ctx.loadChatHistory('b');
  assert.equal(w.jobs.get('b').status,'read');
  assert.equal(w.ctx.isTyping,false);
});

test('New chat creates and selects its history entry while another response continues', async()=>{
  const w=setup();
  const first=w.ctx.sendMessage({message:'first'}); await tick();
  w.ctx.setTrashView=()=>{};
  w.ctx.window.workspace.landing=()=>{};
  w.ctx.window.workspace.ensureChat=async()=>{
    w.ctx.currentChatId='new';
    const row=new Element(); row.dataset.chatId='new'; w.list.prepend(row);
    w.ctx.selectChatListItem('new');
  };
  let selected;
  w.ctx.selectChatListItem=id=>selected=id;
  vm.runInContext(newChat,w.ctx);
  await w.ctx.createNewChat();
  assert.equal(w.list.children[0].dataset.chatId,'new');
  assert.equal(selected,'new');
  assert.equal(w.jobs.get('a').status,'running');
  assert.equal(w.ctx.isTyping,false);
  w.streams.get('a')('__STATUS__:Generating...\nfinished protocol'); await first;
  assert.equal(w.jobs.get('a').status,'done');
  assert.equal(w.ctx.currentChatId,'new');
});

test('reopening a running chat reattaches its live response without a second request', async()=>{
  const w=setup();
  const first=w.ctx.sendMessage({message:'first'}); await tick();
  const view=w.jobs.get('a').view;
  await w.ctx.loadChatHistory('b'); await w.ctx.loadChatHistory('a');
  assert.equal(w.history.children[0],view);
  assert.equal(w.ctx.isTyping,true);
  w.streams.get('a')('__STATUS__:Generating...\nfinished protocol'); await first;
  assert.equal(w.decks[0].chat,'a');
  assert.equal(w.jobs.get('a').status,'done');
  assert.equal(w.ctx.isTyping,false);
});

test('a fresh page reconnects to an existing server task without posting the prompt again', async()=>{
  const w=setup(); w.ctx.currentChatId='b';
  const reconnect=w.ctx.resumeChatRun({chat_id:'a',device:'Robot XYZ',run:{message_id:7,status:'running'}});
  await tick();
  assert.equal(w.jobs.get('a').status,'running');
  assert.equal(w.ctx.isTyping,false);
  assert.equal(w.requests.filter(request=>request.url==='/chat/a/stream').length,1);
  assert.equal(w.requests.find(request=>request.url==='/chat/a/stream').method,'GET');
  w.streams.get('a')('__STATUS__:Still preparing...\nrecovered protocol');
  await reconnect;
  assert.equal(w.jobs.get('a').status,'done');
  assert.equal(w.jobs.get('a').device,'Robot XYZ');
  assert.deepEqual(w.decks,[]);
  await w.ctx.loadChatHistory('a');
  assert.equal(w.history.children[0],w.jobs.get('a').view);
  assert.equal(w.jobs.get('a').status,'read');
});

test('reopening an unconfigured new chat keeps device choice visible and the deck closed', async()=>{
  const w=setup(); let landed=false, clearOptions;
  w.ctx.window.workspace.needsDevice=id=>id==='new';
  w.ctx.window.workspace.landing=()=>landed=true;
  w.ctx.window.workspace.enterChat=()=>assert.fail('The deck must not open before choosing a device');
  w.ctx.window.clearDeckPanel=options=>clearOptions=options;
  await w.ctx.loadChatHistory('new');
  assert.equal(landed,true);
  assert.equal(clearOptions,undefined);
  assert.equal(w.ctx.currentChatId,'new');
  assert.equal(w.requests.length,0);
});

test('feasibility explanations after progress remain visible and never open as protocol code', async()=>{
  const w=setup();
  const pending=w.ctx.sendMessage({message:'make a short demo'}); await tick();
  const explanation='Please specify compatible source and destination plates.';
  w.streams.get('a')('__STATUS__:Checking feasibility...\n__STATUS__:__FORMAT__:text\n'+explanation);
  await pending;
  const view=w.jobs.get('a').view;
  assert.ok(view.children.some(node=>node.textContent===explanation));
  assert.equal(view.querySelectorAll('.protocol-deck-link').length,0);
  assert.deepEqual(w.decks,[]);
  assert.equal(w.jobs.get('a').status,'done');
});

test('previously saved text fences display explanations instead of hidden code references',()=>{
  const w=setup();
  w.ctx.renderChatMessages([{role:'assistant',content:'```text\nPlease specify the labware.\n```'}]);
  assert.equal(w.history.querySelectorAll('.protocol-deck-link').length,0);
  assert.equal(w.history.children[0].children[0].textContent,'Please specify the labware.\n');
});

test('history badge restores saved unread results, skips running and viewed jobs, and caps its display',()=>{
  const w=setup();
  w.ctx.syncChatActivity.history=new Map([
    ['a',{status:'done',seen:true}],['b',{status:'done',seen:false}],
    ['c',{status:'running',seen:false}],['d',{status:'error',seen:false}]
  ]);
  w.ctx.syncChatActivity();
  assert.equal(w.badge.textContent,'2');assert.equal(w.badge.hidden,false);
  assert.match(w.historyButton.title,/2 unread results/);
  w.jobs.set('b',{status:'read'});w.jobs.set('d',{status:'done',seen:true});
  w.ctx.syncChatActivity();assert.equal(w.badge.hidden,true);
  assert.equal(w.historyButton['aria-label'],'History and saved protocols');
  for(let id=0;id<110;id++)w.ctx.syncChatActivity.history.set('extra'+id,{status:'done',seen:false});
  w.ctx.syncChatActivity();assert.equal(w.badge.textContent,'99+');
});

test('a result completing in a hidden tab stays unread until that chat is visible',async()=>{
  const w=setup();w.ctx.document.visibilityState='hidden';
  const request=w.ctx.sendMessage({message:'demo'});await tick();
  w.streams.get('a')('Prepared demo');await request;
  assert.equal(w.badge.textContent,'1');assert.equal(w.badge.hidden,false);
  assert.equal(w.jobs.get('a').seen,undefined);
  w.ctx.document.visibilityState='visible';w.ctx.syncChatActivity();
  assert.equal(w.jobs.get('a').seen,true);assert.equal(w.badge.hidden,true);
  assert.equal(w.requests.filter(request=>request.url==='/chat/a/read').length,1);
});

test('completion waits for the active deck to finish rendering',async()=>{
  const w=setup();let finishDeck;
  w.ctx.window.parseDeckFromCode=()=>new Promise(resolve=>finishDeck=resolve);
  const request=w.ctx.sendMessage({message:'demo'});await tick();
  w.streams.get('a')('__STATUS__:Generating...\n__STATUS__:__FORMAT__:json\n{"protocol":"demo"}');
  await tick();
  assert.equal(typeof finishDeck,'function');
  assert.equal(w.jobs.get('a').status,'running');assert.equal(w.badge.hidden,true);
  const confirms=()=>w.jobs.get('a').view.children.flatMap(node=>node.children).filter(node=>node.textContent==='Your protocol, deck and playback are ready.');
  assert.equal(confirms().length,0);
  finishDeck({steps:[]});await request;
  assert.equal(w.jobs.get('a').status,'done');
  assert.equal(confirms().length,1);
});

test('a deck rendering failure is an error rather than a completed task',async()=>{
  const w=setup();w.ctx.window.parseDeckFromCode=async()=>false;
  const request=w.ctx.sendMessage({message:'demo'});await tick();
  w.streams.get('a')('__STATUS__:Generating...\n__STATUS__:__FORMAT__:json\n{"protocol":"demo"}');
  await request;
  assert.equal(w.jobs.get('a').status,'error');
});
