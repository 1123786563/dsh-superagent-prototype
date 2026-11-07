import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { settingsValue } from '../settings.js'
const source=await readFile(new URL('../client.js',import.meta.url),'utf8')
async function mount(t,{complete=false,rejectSave=false,locked=false}={}){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:3200'})
 const prior={window:globalThis.window,document:globalThis.document,flag:globalThis.IS_REACT_ACT_ENVIRONMENT}
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const { createRoot }=await import('react-dom/client')
 let module,Component,puts=0;const timers=new Map();let timerId=0
 let data={revision:'revision-1',value:settingsValue(complete?{repository:'owner/repo',plannerCli:'gh-planner',sourceDirectory:'/repo',skillsDirectory:'/skills'}:{}),lockedFields:[],status:{enabled:false,phase:'disabled'}}
 if(locked){data.value.plannerCli={__jsExpr:'config'};data.lockedFields=['plannerCli']}
 const fetch=async(_url,options)=>{
  if(options.method==='PUT'){
   puts++;if(rejectSave)return{ok:false,json:async()=>({error:'配置已在其他页面修改，请重新加载后再保存。'})}
   const body=JSON.parse(options.body);data={...data,revision:'revision-2',value:body.value,status:{enabled:body.value.enabled,phase:body.value.enabled?'ready':'disabled'}}
  }
  return{ok:true,json:async()=>structuredClone(data)}
 }
 dom.window.__ModuleLoader__={load(value){module=value}}
 vm.runInNewContext(source,{window:dom.window,AbortController,AbortSignal,fetch,console,setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id)})
 const plugin=module.factory(name=>{assert.equal(name,'react');return React})
 let dict;const ctx={locale:{register(_ns,d){dict=d;return()=>{}},bind:()=>key=>dict.zh[key]??key,subscribe:()=>()=>{},getSnapshot:()=>0},effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(_options,value)=>{Component=value}}}
 plugin.apply(ctx)
 const root=createRoot(dom.window.document.getElementById('root'))
 await act(async()=>{root.render(React.createElement(Component));await new Promise(resolve=>setImmediate(resolve))})
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();globalThis.window=prior.window;globalThis.document=prior.document;globalThis.IS_REACT_ACT_ENVIRONMENT=prior.flag})
 return{document:dom.window.document,async click(node){await act(async()=>{node.click();await new Promise(resolve=>setImmediate(resolve))})},async poll(status){data.status=status;const first=timers.entries().next().value;assert.ok(first,'status poll scheduled');timers.delete(first[0]);await act(async()=>{await first[1]();await new Promise(resolve=>setImmediate(resolve))})},get puts(){return puts},get data(){return data}}
}
test('enable switch stages changes and cannot save incomplete activation',async t=>{
 const f=await mount(t),toggle=f.document.querySelector('[role=switch]')
 assert.equal(toggle.getAttribute('aria-checked'),'false');await f.click(toggle)
 assert.equal(toggle.getAttribute('aria-checked'),'true');assert.ok(f.document.querySelector('button[type=submit]').disabled)
 assert.ok(f.document.body.textContent.includes('启用前请补全'));assert.equal(f.puts,0)
})
test('configured activation requires explicit save and displays saved runtime status',async t=>{
 const f=await mount(t,{complete:true}),toggle=f.document.querySelector('[role=switch]')
 await f.click(toggle);assert.equal(f.puts,0)
 const save=f.document.querySelector('button[type=submit]');assert.equal(save.textContent,'保存并启用')
 await f.click(save);assert.equal(f.puts,1);assert.equal(f.data.value.enabled,true);assert.ok(f.document.body.textContent.includes('等待下一轮'));assert.ok(save.disabled)
})
test('failed save keeps the staged switch and unsaved changes',async t=>{
 const f=await mount(t,{complete:true,rejectSave:true})
 await f.click(f.document.querySelector('[role=switch]'));await f.click(f.document.querySelector('button[type=submit]'))
 assert.equal(f.puts,1);assert.equal(f.document.querySelector('[role=switch]').getAttribute('aria-checked'),'true')
 assert.ok(f.document.body.textContent.includes('配置已在其他页面修改'));assert.ok(f.document.body.textContent.includes('有未保存的修改'))
})
test('runtime status refreshes after a delayed startup without discarding the staged switch',async t=>{
 const f=await mount(t,{complete:true})
 await f.click(f.document.querySelector('[role=switch]'));assert.ok(f.document.body.textContent.includes('有未保存的修改'))
 await f.poll({enabled:false,phase:'not_ready',error:'planner account is not allowed'})
 assert.ok(f.document.body.textContent.includes('暂未就绪'));assert.ok(f.document.body.textContent.includes('planner account is not allowed'))
 assert.equal(f.document.querySelector('[role=switch]').getAttribute('aria-checked'),'true');assert.equal(f.data.value.enabled,false);assert.equal(f.puts,0)
})
test('dynamic expressions keep the form readable but cannot be saved as literals',async t=>{
 const f=await mount(t,{locked:true})
 assert.ok(f.document.querySelector('[role=switch]').disabled);assert.ok(f.document.querySelector('button[type=submit]').disabled);assert.ok(f.document.body.textContent.includes('配置包含动态表达式'))
})
