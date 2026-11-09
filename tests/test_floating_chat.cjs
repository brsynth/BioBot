const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(`${__dirname}/../biobot/static/floating_chat.js`,'utf8');
function setup() {
  function element() {
    const classes=new Set();
    return {style:{},events:{},attributes:{},children:[],classList:{add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name),toggle:(name,on)=>on ? classes.add(name) : classes.delete(name)},
      addEventListener(name,fn){this.events[name]=fn;},setAttribute(name,value){this.attributes[name]=value;},setPointerCapture(){},
      appendChild(node){if(node.parentElement) node.parentElement.children=node.parentElement.children.filter(child=>child!==node); this.children.push(node); node.parentElement=this;}};
  }
  const home=element(),frame=element(),panel=element(),handle=element(),toggle=element(),body=element();
  home.appendChild(panel); panel.children.push({value:'Unsent experiment'});
  let width=800,height=600,resize;
  frame.getBoundingClientRect=()=>({left:0,top:0,width,height});
  panel.getBoundingClientRect=()=>({left:parseFloat(panel.style.left)||16,top:parseFloat(panel.style.top)||16,width:panel.classList.contains('chat-collapsed') ? 210 : 360,height:panel.classList.contains('chat-collapsed') ? 52 : 560});
  const nodes={'chat-panel':panel,'chat-drag-handle':handle,'chat-collapse-btn':toggle};
  let stored;
  const window={workspace:{readOnly:false}};
  vm.runInNewContext(source,{window,document:{getElementById:id=>nodes[id],querySelector:()=>frame,body},
    sessionStorage:{getItem:()=>stored,setItem:(key,value)=>stored=value},requestAnimationFrame:fn=>fn(),
    ResizeObserver:class {constructor(fn){resize=fn;} observe(){}}});
  return {home,frame,panel,handle,toggle,window,resize:(w,h)=>{width=w;height=h;resize();}};
}
test('chat floats within deck bounds, supports dragging and keyboard movement, and keeps content when collapsed',()=>{
  const w=setup(); w.window.floatingChat.attach();
  assert.equal(w.panel.parentElement,w.frame);
  w.handle.events.pointerdown({button:0,clientX:16,clientY:16,pointerId:1});
  w.handle.events.pointermove({clientX:2000,clientY:2000}); w.handle.events.pointerup();
  assert.equal(w.panel.style.left,'432px'); assert.equal(w.panel.style.top,'32px');
  w.toggle.events.click();
  assert.equal(w.toggle.attributes['aria-expanded'],'false');
  assert.equal(w.panel.children[0].value,'Unsent experiment');
  w.resize(400,300);
  assert.equal(w.panel.style.left,'182px');
  w.handle.events.keydown({key:'ArrowLeft',preventDefault(){}});
  assert.equal(w.panel.style.left,'166px');
  w.window.floatingChat.detach();
  assert.equal(w.panel.parentElement,w.home);
  assert.equal(w.panel.classList.contains('chat-collapsed'),false);
  assert.equal(w.panel.style.left,'');
});
test('a saved protocol viewer does not open a floating editor',()=>{
  const w=setup(); w.window.workspace.readOnly=true; w.window.floatingChat.attach();
  assert.equal(w.panel.parentElement,w.home);
});
