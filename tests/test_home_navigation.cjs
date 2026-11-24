const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(`${__dirname}/../biobot/static/script.js`,'utf8');
const startup=source.slice(source.indexOf('// --- Init ---'));
async function start(search,{protocol=false}={}) {
  const calls=[];
  const context=vm.createContext({URLSearchParams,
    refreshChatList:async()=>[{chat_id:'saved-chat'}],
    localStorage:{getItem:()=> 'saved-chat'},
    loadChatHistory:async id=>calls.push(['chat',id]),
    createNewChat:async options=>calls.push(['landing',options.persist]),
    window:{location:{search},history:{state:null,replaceState:(_state,_title,url)=>calls.push(['url',url])},
      workspace:{chooseDevice:async name=>calls.push(['device',name]),restoreProtocol:async()=>{calls.push(['protocol']);return protocol;}}}
  });
  await vm.runInContext(startup,context);
  return calls;
}
test('explicit logo navigation lands without restoring either a saved chat or protocol',async()=>{
  for(const protocol of [false,true]) {
    assert.deepEqual(await start('?landing=1',{protocol}),[['landing',false],['url','/']]);
  }
});
test('ordinary user navigation still restores the last saved chat',async()=>{
  assert.deepEqual(await start(''),[['protocol'],['chat','saved-chat']]);
});
test('ordinary user navigation still restores a saved protocol',async()=>{
  assert.deepEqual(await start('',{protocol:true}),[['protocol']]);
});

test('device links can open an instrument from the landing catalog in a new tab',async()=>{
  assert.deepEqual(await start('?landing=1&device=Robot%20XYZ'),[['landing',false],['url','/'],['device','Robot XYZ']]);
});
