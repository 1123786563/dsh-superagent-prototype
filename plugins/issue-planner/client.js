window.__ModuleLoader__.load({
 id:'@local/dsh-issue-planner',
 factory(require){
  const React=require('react'),h=React.createElement
  const dictionaries={
   zh:{title:'Issue 定时规划',intro:'选择一张符合条件的最小编号 Issue，编写实施计划后交接执行。',enabled:'启用定时规划',onHelp:'启用后会定时读取仓库、调用模型，并使用规划账号发布交接评论。',offHelp:'关闭后停止新规划和评论；已经交接的工单继续执行。',basic:'基础配置',advanced:'运行与卡住处理',repository:'GitHub 仓库',plannerCli:'独立规划账号 CLI',executorLogin:'执行账号',sourceDirectory:'源码目录',skillsDirectory:'Superpowers 技能目录',pollSeconds:'轮询间隔（秒）',planTimeoutSeconds:'单次规划超时（秒）',maxAttempts:'每张 Issue 最多规划次数',reconcileSeconds:'不确定评论对账间隔（秒）',handoffTimeoutMinutes:'未收到工单提示（分钟）',executionStallHours:'无进展提示（小时）',accountHelp:'使用与执行账号不同、且有权发起工单的账号。此处填写已登录该账号的 CLI 命令。',pathHelp:'使用本机绝对路径；源码目录需要包含目标仓库最新的默认分支 commit。',rule:'按最小编号优先；卡住的任务单独隔离，其余独立任务继续。不会自动重派正在实施的 Issue。',save:'保存设置',enableSave:'保存并启用',disableSave:'保存并关闭',saving:'正在保存…',loading:'正在读取配置…',reload:'重新加载',discard:'撤销修改',dirty:'有未保存的修改',saved:'设置已保存。',missing:'启用前请补全仓库、独立规划账号 CLI、源码目录和技能目录。',locked:'配置包含动态表达式，请先在插件配置中处理表达式。此表单暂不允许保存。',loadError:'无法读取设置，请检查插件是否已加载后重试。',saveError:'无法保存，修改已保留，请重试。',status:'实际运行状态',disabled:'已关闭',ready:'等待下一轮',scanning:'正在读取 Issue',planning:'正在编写计划',handed_off:'已交接执行',publish_uncertain:'部分评论等待对账',not_ready:'暂未就绪',retry_wait:'规划失败，等待重试',needs_attention:'需要人工处理',stale:'计划已失效，等待重新规划',unavailable:'暂时无法读取',starting:'正在启动',waiting:'设置已保存，等待运行配置加载。',required:'必填'},
   en:{title:'Issue planning',intro:'Plan the smallest eligible issue number, then hand the complete plan to the executor.',enabled:'Enable scheduled planning',onHelp:'Reads the repository on a schedule, calls the model, and publishes handoff comments using the planner account.',offHelp:'Turning this off stops new planning and comments. Existing implementation tickets continue.',basic:'Basic configuration',advanced:'Scheduling and stalled work',repository:'GitHub repository',plannerCli:'Independent planner CLI',executorLogin:'Executor account',sourceDirectory:'Source directory',skillsDirectory:'Superpowers skills directory',pollSeconds:'Polling interval (seconds)',planTimeoutSeconds:'Planning timeout (seconds)',maxAttempts:'Planning attempts per issue',reconcileSeconds:'Uncertain comment reconciliation (seconds)',handoffTimeoutMinutes:'Missing ticket warning (minutes)',executionStallHours:'No progress warning (hours)',accountHelp:'Use an account different from the executor that is allowed to originate work. Enter the CLI command already signed in to that account.',pathHelp:'Use absolute local paths. The source directory must contain the latest default branch commit.',rule:'Smallest issue number first. Stalled issues are isolated while independent work continues. Active implementations are never automatically reassigned.',save:'Save settings',enableSave:'Save and enable',disableSave:'Save and turn off',saving:'Saving…',loading:'Loading configuration…',reload:'Reload',discard:'Discard changes',dirty:'Unsaved changes',saved:'Settings saved.',missing:'Before enabling, complete the repository, independent planner CLI, source directory, and skills directory.',locked:'This configuration contains dynamic expressions. Resolve them in plugin configuration before using this form.',loadError:'Could not load settings. Check that the plugin is loaded, then retry.',saveError:'Could not save. Your changes have been kept; please retry.',status:'Actual runtime status',disabled:'Off',ready:'Waiting for next cycle',scanning:'Reading issues',planning:'Writing a plan',handed_off:'Handed off',publish_uncertain:'Comments awaiting reconciliation',not_ready:'Not ready',retry_wait:'Planning failed; waiting to retry',needs_attention:'Needs attention',stale:'Plan invalidated; waiting to replan',unavailable:'Unavailable',starting:'Starting',waiting:'Settings saved; waiting for the runtime configuration to load.',required:'Required'}
  }
  const numeric={pollSeconds:[60,3600],planTimeoutSeconds:[60,3600],maxAttempts:[1,10],reconcileSeconds:[60,3600],handoffTimeoutMinutes:[1,1440],executionStallHours:[1,168]}
  const basic=['repository','plannerCli','executorLogin','sourceDirectory','skillsDirectory']
  const css=`.ip-settings{max-width:760px;padding:24px;color:var(--dsw-alias-label-primary);font:inherit;min-width:0}.ip-settings *{box-sizing:border-box}.ip-settings h2{font-size:22px;line-height:30px;letter-spacing:-.025em;font-weight:600;margin:0 0 8px}.ip-settings p{font-size:13px;line-height:1.65;margin:0 0 16px;max-width:70ch}.ip-muted{color:var(--dsw-alias-label-secondary)}.ip-switch-row{display:flex;align-items:center;justify-content:space-between;gap:24px;margin:28px 0 12px;padding:0 0 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}.ip-switch-row strong{font-size:14px;font-weight:600}.ip-switch{flex:none;appearance:none;width:40px;height:24px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}.ip-switch span{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary)}.ip-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.ip-switch[aria-checked=true] span{transform:translateX(15px);background:var(--dsw-alias-bg-base)}.ip-settings button:focus-visible,.ip-settings input:focus-visible,.ip-settings summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.ip-settings button:disabled{cursor:default;opacity:.5}.ip-runtime{display:flex;gap:12px;align-items:baseline;font-size:13px;margin:0 0 24px}.ip-runtime strong{font-weight:500}.ip-runtime[data-error=true] strong{color:var(--dsw-alias-state-warn-primary)}.ip-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px 20px}.ip-field{display:flex;flex-direction:column;gap:7px;min-width:0;font-size:13px}.ip-field[data-wide=true]{grid-column:1/-1}.ip-field input{width:100%;min-width:0;height:36px;padding:7px 10px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;caret-color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}.ip-field input::placeholder{color:var(--dsw-alias-label-secondary)}.ip-settings h3{font-size:14px;font-weight:600;margin:28px 0 16px}.ip-settings details{border-top:1px solid var(--dsw-alias-border-l1);margin-top:28px;padding-top:18px}.ip-settings summary{cursor:pointer;font-size:13px;font-weight:500;margin-bottom:18px}.ip-note{margin-top:12px!important}.ip-message{font-size:13px;line-height:1.6;margin:16px 0;color:var(--dsw-alias-state-warn-primary)}.ip-message[role=alert]{color:var(--dsw-alias-state-error-primary)}.ip-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:28px;padding-top:20px}.ip-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:8px 14px;min-height:36px;cursor:pointer;font:inherit;font-size:13px}.ip-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.ip-primary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.ip-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(.94)}.ip-actions small{font-size:12px}.ip-settings ::selection{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}@media(max-width:640px){.ip-settings{padding:18px 12px}.ip-fields{grid-template-columns:minmax(0,1fr)}.ip-field[data-wide=true]{grid-column:auto}.ip-switch-row{gap:16px}.ip-actions{align-items:stretch}.ip-actions button{flex:1}.ip-actions small{width:100%}}`
  return{inject:['slots','locale'],apply(ctx){
   ctx.effect(()=>ctx.locale.register('issue-planner-settings',dictionaries))
   const t=ctx.locale.bind('issue-planner-settings')
   async function request(method,body,signal){
    const response=await fetch('/issue-planner/api/settings',{method,headers:{'x-issue-planner-request':'1',...body?{'content-type':'application/json'}:{}},...body?{body:JSON.stringify(body)}:{},signal})
    const result=await response.json()
    if(!response.ok)throw new Error(result.error||t(method==='GET'?'loadError':'saveError'))
    return result
   }
   function Settings(){
    React.useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot())
    const [loaded,setLoaded]=React.useState(null),[draft,setDraft]=React.useState(null),[error,setError]=React.useState(''),[saving,setSaving]=React.useState(false),[notice,setNotice]=React.useState(''),[refresh,setRefresh]=React.useState(0)
    const lifetime=React.useRef(null)
    React.useEffect(()=>{
     const controller=new AbortController();lifetime.current=controller
     request('GET',null,controller.signal).then(data=>{setLoaded(data);setDraft({...data.value});setError('');setNotice('')}).catch(e=>{if(!controller.signal.aborted)setError(e.message||t('loadError'))})
     return()=>controller.abort()
    },[refresh])
    React.useEffect(()=>{
     if(!loaded)return
     const controller=new AbortController();let timer,stopped=false
     async function poll(){
      try{
       const data=await request('GET',null,AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]))
       if(!stopped)setLoaded(old=>old?{...old,status:data.status}:old)
      }catch{if(!stopped)setLoaded(old=>old?{...old,status:{phase:'unavailable',enabled:null}}:old)}
      finally{if(!stopped)timer=setTimeout(poll,5000)}
     }
     timer=setTimeout(poll,5000)
     return()=>{stopped=true;clearTimeout(timer);controller.abort()}
    },[!!loaded])
    const dirty=!!draft&&!!loaded&&JSON.stringify(draft)!==JSON.stringify(loaded.value)
    const locked=!!loaded?.lockedFields?.length
    const missing=!locked&&draft?.enabled===true&&(!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(draft.repository)||!draft.plannerCli.trim()||!draft.sourceDirectory.startsWith('/')||!draft.skillsDirectory.startsWith('/'))
    const update=(key,value)=>{setDraft(old=>({...old,[key]:value}));setNotice('')}
    async function save(event){
     event.preventDefault();if(!dirty||saving||locked||missing)return
     setSaving(true);setError('');setNotice('')
     try{
      const data=await request('PUT',{revision:loaded.revision,value:draft},lifetime.current?.signal)
      setLoaded(data);setDraft({...data.value});setNotice(t('saved'))
     }catch(e){if(!lifetime.current?.signal.aborted)setError(e.message||t('saveError'))}
     finally{if(!lifetime.current?.signal.aborted)setSaving(false)}
    }
    const field=key=>{
     const range=numeric[key],isNumber=!!range,wide=['sourceDirectory','skillsDirectory'].includes(key),id='ip-'+key
     return h('label',{key,className:'ip-field','data-wide':wide||undefined,htmlFor:id},h('span',null,t(key)),h('input',{id,name:key,type:isNumber?'number':'text',value:typeof draft[key]==='object'?'':draft[key],disabled:saving||locked,required:draft.enabled&&!isNumber,min:range?.[0],max:range?.[1],step:isNumber?1:undefined,autoComplete:'off',spellCheck:false,placeholder:key==='repository'?'owner/repo':key==='plannerCli'?'gh-planner':undefined,onChange:e=>update(key,isNumber?(e.target.value===''?'':Number(e.target.value)):e.target.value)}))
    }
    const phase=loaded?.status?.phase??'unavailable',statusText=dictionaries.en[phase]?t(phase):phase
    const runtimeMismatch=loaded&&typeof loaded.status?.enabled==='boolean'&&loaded.status.enabled!==loaded.value.enabled
    return h('section',{className:'ip-settings','aria-label':t('title')},h('style',null,css),h('h2',null,t('title')),h('p',{className:'ip-muted'},t('intro')),
     !draft?h(React.Fragment,null,h('p',{role:error?'alert':'status',className:error?'ip-message':'ip-muted'},error||t('loading')),error&&h('button',{type:'button',className:'ip-button',onClick:()=>setRefresh(v=>v+1)},t('reload'))):
     h('form',{onSubmit:save},
      h('div',{className:'ip-switch-row'},h('strong',{id:'ip-enabled-label'},t('enabled')),h('button',{type:'button',className:'ip-switch',role:'switch','aria-checked':draft.enabled===true,'aria-labelledby':'ip-enabled-label','aria-describedby':'ip-enabled-help',disabled:saving||locked,onClick:()=>update('enabled',!draft.enabled)},h('span',{'aria-hidden':true}))),
      h('p',{id:'ip-enabled-help',className:'ip-muted'},t(draft.enabled?'onHelp':'offHelp')),
      h('div',{className:'ip-runtime','data-error':['not_ready','unavailable','needs_attention','publish_uncertain'].includes(phase)||undefined},h('span',{className:'ip-muted'},t('status')),h('strong',null,statusText,loaded.status?.currentIssue?' · #'+loaded.status.currentIssue:'')),
      runtimeMismatch&&h('p',{className:'ip-message',role:'status'},t('waiting')),
      loaded.status?.error&&h('p',{role:'status',className:'ip-message'},loaded.status.error),
      h('h3',null,t('basic')),h('div',{className:'ip-fields'},...basic.map(field),field('pollSeconds')),
      h('p',{className:'ip-muted ip-note'},t('accountHelp')),h('p',{className:'ip-muted'},t('pathHelp')),
      h('details',null,h('summary',null,t('advanced')),h('div',{className:'ip-fields'},...Object.keys(numeric).filter(k=>k!=='pollSeconds').map(field)),h('p',{className:'ip-muted ip-note'},t('rule'))),
      locked&&h('p',{role:'alert',className:'ip-message'},t('locked')),
      missing&&h('p',{role:'status',className:'ip-message'},t('missing')),
      error&&h('div',{role:'alert',className:'ip-message'},error,' ',h('button',{type:'button',className:'ip-button',disabled:saving,onClick:()=>{if(!dirty||window.confirm(t('discard')+'?'))setRefresh(v=>v+1)}},t('reload'))),
      h('div',{className:'ip-actions'},h('button',{type:'submit',className:'ip-button ip-primary',disabled:!dirty||saving||locked||missing},t(saving?'saving':draft.enabled&&!loaded.value.enabled?'enableSave':!draft.enabled&&loaded.value.enabled?'disableSave':'save')),
       h('button',{type:'button',className:'ip-button',disabled:!dirty||saving,onClick:()=>{setDraft({...loaded.value});setError('');setNotice('')}},t('discard')),
       h('small',{role:'status',className:'ip-muted'},notice||(dirty?t('dirty'):'')))) )
   }
   ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'issue-planner',order:45,label:()=>t('title')},Settings))
  }}
 }
})
