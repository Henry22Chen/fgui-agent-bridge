// 执行实际编译插件，重点验证几何顺序及输入预检；真实 Editor API 另由 live_editing_validation 覆盖。
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict'), path=require('node:path');
const calls=[];
const obj={id:'icon',name:'icon',objectType:'loader',x:10,y:20,width:60,height:40,pivotX:0,pivotY:0,anchor:false,autoSize:false,useSourceSize:false,
  SetSize(w,h,ignorePivot){calls.push('size');if(!ignorePivot){this.x-=10;this.y-=10;}this.width=w;this.height=h;},
  SetXY(x,y){calls.push('xy');this.x=x;this.y=y;},SetPivot(x,y,a){calls.push('pivot');this.pivotX=Math.fround(x);this.pivotY=Math.fround(y);this.anchor=a;}};
const doc={content:{numChildren:1,GetChildAt:()=>obj},isModified:false,savedVersion:1,SetModified(v){this.isModified=v;},RefreshInspectors(){}};
const ctx=vm.createContext({exports:{},require:()=>({}),CS:{FairyEditor:{App:{}},UnityEngine:{Application:{runInBackground:false}},System:{IO:{File:{},Directory:{},Path:{},FileInfo:{},SearchOption:{}}}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8').split('App.add_onUpdate(onUpdate);')[0],ctx);
ctx.getActiveDocument=()=>doc;ctx.resolveObject=()=>obj;
const write=properties=>ctx.setProperties({target:{id:'icon'},properties});
const result=write({x:55,width:90,pivotX:0.1,height:70,y:65});
assert.deepEqual(calls,['pivot','size','xy']);
assert.equal(result.after.x,55);assert.equal(result.after.y,65);assert.equal(result.after.width,90);
assert.equal(result.saved,false);assert.equal(result.persisted,false);
calls.length=0;doc.isModified=false;
assert.throws(()=>write({width:99,typo:true}),/未知字段/);
assert.throws(()=>write({width:99,font:'fake'}),/没有可持久化属性/);
assert.throws(()=>write({width:99,autoSize:true}),/自动尺寸/);
assert.equal(obj.width,90);assert.equal(obj.autoSize,false);assert.equal(doc.isModified,false);assert.equal(calls.length,0);
doc.content.numChildren=0;
assert.throws(()=>write({width:10}),/直属对象/);
assert.throws(()=>ctx.createObject({objectType:'group',save:true}),/空分组/);
console.log('PASS: native geometry ordering, float tolerance, default unsaved semantics, input preflight and ownership');

// 根 Write() 是实例覆盖；保存验证必须使用完整组件定义，普通对象仍使用 Write()。
ctx.gearXmlData=node=>node;ctx.clearAgentHistory=()=>{};ctx.componentXmlNode=()=>({kind:'definition',size:'800,600'});
const root={Write(){throw new Error('root instance serializer must not be used');},Write_editMode(){return {kind:'definition',size:'800,600'};}};
doc.content=root;doc.Save=()=>{doc.isModified=false;};
assert.equal(ctx.finishEditingWrite(doc,root,{}, {},{save:true},true).persisted,true);
ctx.componentXmlNode=()=>({kind:'instance',size:'20,30'});
const child={Write(){return {kind:'instance',size:'20,30'};}};
assert.equal(ctx.finishEditingWrite(doc,child,{}, {},{save:true},true).persisted,true);
console.log('PASS: root definition and child instance persistence snapshots use their native serializers');
