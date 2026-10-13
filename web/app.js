/* UI for Tidy's web app. Provider actions remain manual drafts. */
(function () {
  'use strict';
  const C=window.TidyCore, A=window.TidyAssistant, KEY='tidy.app.v1';
  const GROCERY_STORES=Object.freeze({Carrefour:{name:'Carrefour UAE',url:'https://www.carrefouruae.com/'},Waitrose:{name:'Waitrose UAE',url:'https://www.waitrose.ae/'},Kibsons:{name:'Kibsons',url:'https://www.kibsons.com/'}});
  const $=id=>document.getElementById(id);
  const ui={view:'today',editingTask:null,editingAction:null,editingMember:null,lastDraft:null,storage:null,storageLocked:false,recoveryText:null,saveFailed:false,voice:null,listening:false,mealReady:false,mealVerified:false,mealGroceries:[],groceriesApproved:false,mealRequests:new Map(),unsavedDeliveries:new Set(),unsavedCheckin:'',websiteUrl:null};
  let state=C.defaults(), toastTimer;
  function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function button(text,handler,cls='button secondary small'){const node=el('button',text,cls);node.type='button';node.addEventListener('click',handler);return node;}
  function error(id,text){$(id).textContent=text;$(id).hidden=!text;}
  function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},4500);}
  function memberName(id){return state.members.find(member=>member.id===id)?.name||'Unassigned';}
  function prettyDate(date){if(!date)return 'No date';return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));}
  function weekday(date){return new Intl.DateTimeFormat('en-GB',{weekday:'long',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));}
  function clockValue(epoch){const date=new Date(epoch+4*3600000);return date.toISOString().slice(0,16);}
  function id(prefix){return prefix+'-'+(window.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));}
  function safeLink(url){const parsed=new URL(url);if(parsed.protocol!=='https:'||!parsed.hostname||parsed.username||parsed.password)throw Error('Use an HTTPS website without embedded credentials.');return parsed.href;}
  function empty(container,text,action){const node=el('div',undefined,'empty');node.append(el('p',text));if(action)node.append(action);container.append(node);}
  function download(name,text,type='application/json;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type})),a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function storageWarning(text){$('storage-warning').textContent=text;$('storage-warning').hidden=!text;$('save-status').textContent=text?'Not saved locally':'Saved on this browser';$('footer-status').textContent=text?'Changes may be in this tab only · download a backup':'Local saving on this browser · no cloud sync';}
  function save(){
    if(ui.storageLocked){storageWarning('Existing saved data could not be read. It has been preserved. New changes stay in this tab until you restore a valid backup; download a backup before closing.');return false;}
    try{C.persist(ui.storage,state,KEY);ui.saveFailed=false;storageWarning('');return true;}
    catch(problem){ui.saveFailed=true;storageWarning(problem.message+' Changes stay in this tab; download a backup before closing.');return false;}
  }
  function startStorage(){
    try{ui.storage=window.localStorage;state=C.load(ui.storage,KEY)||C.defaults();storageWarning('');}
    catch(problem){
      try{ui.recoveryText=ui.storage?.getItem(KEY)||null;}catch(_){}
      ui.storageLocked=Boolean(ui.recoveryText);ui.saveFailed=true;
      storageWarning(problem.message+' Existing data has not been overwritten. Download a recovery copy or restore a valid backup.');
    }
  }
  function mutate(work,message){
    const previous=C.validateSnapshot(state);
    try{work();state=C.validateSnapshot(state);const saved=save();renderAll();if(message)toast(message+(saved?'':' · not saved locally'));return true;}
    catch(problem){state=previous;renderAll();toast(problem.message+' The previous data was kept.');return false;}
  }
  function showView(view,focus=true){
    if(!['today','assistant','family','routines','tools'].includes(view))view='today';
    if(ui.listening&&view!=='assistant')ui.voice?.abort();
    ui.view=view;for(const section of document.querySelectorAll('.view'))section.hidden=section.id!=='view-'+view;
    for(const nav of document.querySelectorAll('[data-view]')){if(nav.dataset.view===view)nav.setAttribute('aria-current','page');else nav.removeAttribute('aria-current');}
    history.replaceState(null,'','#'+view);renderAll();
    if(focus){const heading=$('view-'+view).querySelector('h1');heading.focus();window.scrollTo({top:0,behavior:'instant'});}
  }
  function populatePeople(select,first='All household',firstValue='all'){
    const selected=select.value;select.replaceChildren();const option=el('option',first);option.value=firstValue;select.append(option);
    for(const member of state.members){const item=el('option',member.name);item.value=member.id;select.append(item);}
    if([...select.options].some(option=>option.value===selected))select.value=selected;
  }
  function sorted(tasks){return tasks.slice().sort((a,b)=>((a.dueDate||'9999')+(a.dueTime||'23:59')).localeCompare((b.dueDate||'9999')+(b.dueTime||'23:59'))||(a.priority==='high'?-1:0)-(b.priority==='high'?-1:0)||a.createdAt-b.createdAt);}
  function taskCard(task,compact=false){
    const row=el('article',undefined,'task-row'+(task.status==='done'?' done':''));row.dataset.taskId=task.id;
    const top=el('div',undefined,'task-top'),copy=el('div',undefined,'task-copy');copy.append(el('div',task.title,'task-title'));
    const metadata=el('div',undefined,'task-meta');metadata.append(el('span',task.category,'pill'),el('span',memberName(task.assigneeId),'pill neutral'));
    if(task.priority==='high')metadata.append(el('span','Important','pill warning'));
    if(task.type==='appointment')metadata.append(el('span','Entered appointment','pill neutral'));
    if(task.quantity)metadata.append(el('span',task.quantity,'pill neutral'));
    if(task.repeat!=='none')metadata.append(el('span',({daily:'Daily',weekly:'Weekly',weekdays:'Weekdays'})[task.repeat],'pill'));
    copy.append(metadata);let when=task.dueDate?`${prettyDate(task.dueDate)}${task.dueTime?' · '+task.dueTime:''}`:'Choose a date when ready';
    if(task.status==='open'&&task.dueDate&&task.dueDate<C.today())when+=' · unfinished';copy.append(el('div',when,'task-time'));
    if(task.remindAt!==null)copy.append(el('div',`${task.deliveredReminderAt===task.remindAt?'Alert shown':'Alert set'} · ${clockValue(task.remindAt).replace('T',' ')} Dubai`,'task-time'));
    top.append(copy);const done=button(task.status==='done'?'↶':'✓',()=>mutate(()=>task.status==='done'?C.reopenTask(state,task.id):C.completeTask(state,task.id),task.status==='done'?'Reopened':'Marked done'),'done-button');done.setAttribute('aria-label',(task.status==='done'?'Reopen ':'Complete ')+task.title);top.append(done);row.append(top);
    if(task.notes&&!compact)row.append(el('p',task.notes));
    const actions=el('div',undefined,'task-actions');actions.append(button('Edit',()=>openTask(task,task.id)));
    if(task.link)actions.append(button('View website',()=>openWebsite(task.link,task.title)));
    if(task.status==='open'&&task.dueDate&&task.dueDate<C.today())actions.append(button('Move to tomorrow',()=>mutate(()=>C.updateTask(state,task.id,{dueDate:C.addDays(C.today(),1),remindAt:null,deliveredReminderAt:null}),'Moved to tomorrow. Choose a new reminder if needed.')));
    if(task.status==='open'&&task.remindAt!==null)actions.append(button('Remind in 1 hour',()=>mutate(()=>C.updateTask(state,task.id,{remindAt:Math.floor(Date.now()/60000)*60000+3600000}),'Reminder moved one hour ahead')));
    if(ui.view==='routines'&&task.repeat!=='none')actions.append(button('Stop repeating',()=>mutate(()=>{for(const occurrence of state.tasks.filter(item=>item.status==='open'&&(item.id===task.id||task.seriesId&&item.seriesId===task.seriesId)))C.updateTask(state,occurrence.id,{repeat:'none'});},'Repetition stopped for this routine. Existing tasks remain.')));
    if(!compact)actions.append(button('Remove',()=>{if(confirm('Remove this item from Tidy? This does not cancel anything with a provider.'))mutate(()=>C.deleteTask(state,task.id),'Removed from Tidy');},'button text small'));
    row.append(actions);return row;
  }
  function taskList(id,tasks,none,compact=false){const target=$(id);target.replaceChildren();for(const task of sorted(tasks))target.append(taskCard(task,compact));if(!tasks.length)empty(target,none);}
  function renderToday(){
    const date=C.today(),open=state.tasks.filter(task=>task.status==='open'),filter=$('today-person').value;
    const visible=open.filter(task=>filter==='all'||task.assigneeId===filter);
    $('today-date').textContent=new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Dubai'}).format(new Date())+' · Dubai time';
    const stats=$('today-stats');stats.replaceChildren();for(const [count,label] of [[open.filter(task=>task.dueDate===date).length,'Due today'],[open.filter(task=>task.dueDate&&task.dueDate<date).length,'Unfinished'],[state.actions.filter(action=>action.status==='needs_review').length,'Drafts to review']]){const card=el('div',undefined,'stat');card.append(el('strong',String(count)),el('span',label));stats.append(card);}
    taskList('today-tasks',visible.filter(task=>task.dueDate&&task.dueDate<=date),'Nothing dated needs attention. Add a task when you need one.');
    taskList('inbox-tasks',visible.filter(task=>!task.dueDate),'Your undated list is clear.');
    taskList('upcoming-tasks',sorted(visible.filter(task=>task.dueDate>date)).slice(0,5),'No upcoming items entered yet.',true);
    const times=new Map();for(const task of visible.filter(task=>task.dueDate===date&&task.dueTime)){times.set(task.dueTime,(times.get(task.dueTime)||0)+1);}
    $('today-conflicts').textContent=[...times].filter(([,count])=>count>1).map(([time,count])=>`${count} items share ${time}; check their timing.`).join(' ');
    const meal=ui.mealVerified?state.mealSummary.find(meal=>meal.day===weekday(date)):null;$('today-meal').replaceChildren(el('p',meal?meal.name:'No approved dinner plan for today.'));if(meal)$('today-meal').append(el('p','From your approved weekday menu.','helper'));
    const requests=state.actions.filter(action=>action.status==='needs_review');$('today-actions').replaceChildren();
    for(const action of requests.slice(0,3))$('today-actions').append(button(action.title,()=>{showView('tools');$('requests-card').scrollIntoView({block:'start'});}));
    if(!requests.length)$('today-actions').append(el('p','No requests awaiting review.','helper'));
  }
  function renderFamily(){
    $('member-list').replaceChildren();for(const member of state.members){const assigned=state.tasks.filter(task=>task.status==='open'&&task.assigneeId===member.id).length;$('member-list').append(button(`${member.name} · ${assigned} open`,()=>openMember(member),'member-button'));}
    const search=$('task-search').value.trim().toLocaleLowerCase(),category=$('category-filter').value,person=$('person-filter').value,status=$('status-filter').value;
    taskList('family-tasks',state.tasks.filter(task=>(category==='all'||task.category===category)&&(person==='all'||task.assigneeId===person)&&(status==='all'||task.status===status)&&(!search||(task.title+' '+task.notes).toLocaleLowerCase().includes(search))),'No matching tasks. Add one or change the filters.');
  }
  function renderRoutines(){
    taskList('routine-tasks',state.tasks.filter(task=>task.status==='open'&&task.repeat!=='none'),'No repeating jobs yet. Add a routine with its first date.');
    $('pause-alerts').textContent=state.settings.remindersPaused?'Resume alerts':'Pause alerts';
    $('reminder-summary').textContent=state.settings.remindersPaused?'All demo alerts are paused.':`Task alerts are active while open. Daily check-in ${state.settings.checkinEnabled?'at '+state.settings.checkinTime+' Dubai time':'is turned off'}.`;
  }
  function renderActions(){
    const target=$('action-list');target.replaceChildren();
    for(const action of state.actions.slice().reverse()){
      const card=el('article',undefined,'request-card');card.dataset.actionId=action.id;card.append(el('h3',action.title));
      const labels={needs_review:'Needs your review',approved_draft:'Draft approved · finish with provider',cancelled:'Draft discarded',manually_completed:'You marked it completed manually'};
      card.append(el('span',labels[action.status],'pill'+(action.status==='needs_review'?' warning':' neutral')));
      card.append(el('p',`${action.kind==='purchase'?'Purchase':action.kind==='booking'?'Booking':'Message'}${action.provider?' · '+action.provider:''}`,'helper'));
      if(action.details)card.append(el('p',action.details,'helper'));
      if(action.status==='approved_draft')card.append(el('p','No message, purchase or booking has been carried out by Tidy. Complete it yourself with the provider.','helper'));
      const actions=el('div',undefined,'actions');actions.append(button('Edit draft',()=>openAction(action,action.id)));
      if(action.status==='needs_review')actions.append(button('Approve draft',()=>mutate(()=>{action.status='approved_draft';},'Draft approved. No external action taken.')));
      if(action.link)actions.append(button('View website',()=>openWebsite(action.link,action.provider||action.title)));
      if(action.status==='approved_draft')actions.append(button('I completed it outside Tidy',()=>{if(confirm('Have you completed this yourself? Tidy cannot verify it with the provider.'))mutate(()=>{action.status='manually_completed';},'Recorded your manual completion');}));
      if(!['cancelled','manually_completed'].includes(action.status))actions.append(button('Discard draft',()=>mutate(()=>{action.status='cancelled';},'Draft discarded; no provider action cancelled'),'button text small'));
      card.append(actions);target.append(card);
    }
    if(!state.actions.length)empty(target,'No prepared requests yet. Ask Tidy to prepare a purchase, booking or message.');
  }
  function readMealGroceries(message){
    ui.mealGroceries=[];ui.groceriesApproved=false;
    const list=message.groceries;
    if(!Array.isArray(list)||list.length>350)return;
    const safe=list.every(item=>item&&typeof item.name==='string'&&item.name.length<=300&&['g','ml','pieces','item'].includes(item.unit)&&Number.isFinite(item.amount)&&item.amount>=0&&item.amount<=2000000000000);
    if(!safe)return;
    ui.mealGroceries=list.map(item=>({name:item.name,amount:item.amount,unit:item.unit}));ui.groceriesApproved=message.groceriesApproved===true;
  }
  function renderShopping(){
    const items=state.tasks.filter(task=>task.status==='open'&&task.type==='grocery');
    taskList('shopping-tasks',items,'No household groceries requested yet. Tell Tidy what you need.');
    const list=$('meal-shopping-items');list.replaceChildren();
    if(ui.mealVerified&&ui.groceriesApproved){
      $('meal-shopping-status').textContent='From your approved grocery draft, after checking the kitchen. No order placed.';
      for(const item of ui.mealGroceries){const row=el('li');row.append(el('span',item.name),el('span',item.amount+' '+item.unit));list.append(row);}
      if(!ui.mealGroceries.length)list.append(el('li','Nothing missing from your reviewed meal plan.'));
    }else $('meal-shopping-status').textContent='Check the kitchen and approve the meal grocery draft to include its ingredients here and in the download.';
    $('download-shopping').disabled=!items.length&&!(ui.mealVerified&&ui.groceriesApproved);
  }
  function downloadShopping(){
    const items=state.tasks.filter(task=>task.status==='open'&&task.type==='grocery'),lines=['Tidy shopping list · '+C.today(),'No order has been placed. Check amounts, package sizes and prices before buying.','','HOUSEHOLD REQUESTS'];
    for(const task of items)lines.push('- '+task.title+' — '+(task.quantity||'quantity to check')+(task.assigneeId?' · '+memberName(task.assigneeId):''));
    if(!items.length)lines.push('None entered.');
    lines.push('','WEEKDAY MEAL GROCERIES');
    if(ui.mealVerified&&ui.groceriesApproved){for(const item of ui.mealGroceries)lines.push('- '+item.name+' — '+item.amount+' '+item.unit);if(!ui.mealGroceries.length)lines.push('Nothing missing.');}
    else lines.push('Not included: approve the meal grocery draft first.');
    lines.push('','Matching names in the two groups stay separate; check them together before buying.');
    download('Tidy-shopping-'+C.today()+'.txt',lines.join('\n')+'\n','text/plain;charset=utf-8');
  }
  function renderAll(){
    populatePeople($('today-person'));populatePeople($('person-filter'));renderToday();renderFamily();renderRoutines();renderActions();renderShopping();
  }
  function response(message){$('assistant-response').textContent=message;$('assistant-response').hidden=false;$('assistant-followup').replaceChildren();}
  function capture(text){
    const result=A.parse(text,{now:Date.now(),members:state.members,tasks:state.tasks});response(result.message);
    if(result.kind==='answer')return;
    if(result.kind==='action'){
      const action={id:id('request'),kind:result.action.kind,title:result.action.title,details:result.action.details||'',provider:'',link:'',status:'needs_review',createdAt:Date.now()};
      if(mutate(()=>{state.actions.push(action);},'Request saved for review')){response('Prepared a local draft: '+action.title+'. '+(ui.saveFailed||ui.storageLocked?'Kept in this tab; download a backup before closing. ':'Saved on this browser. ')+'It needs review. No order, message or booking has been made.');$('assistant-followup').append(button('Review draft',()=>openAction(action,action.id)));}return;
    }
    if(result.kind==='clarify'){
      ui.lastDraft=result.draft||{title:text,category:'Home'};const controls=el('div',undefined,'followup-actions');controls.append(button('Fill in the missing details',()=>openTask(ui.lastDraft,null,result.message,result.reminderRequested===true),'button'));$('assistant-followup').append(controls);return;
    }
    const draft=result.draft;
    if(result.kind==='grocery'){
      const existing=state.tasks.find(task=>task.status==='open'&&task.type==='grocery'&&task.title.toLocaleLowerCase()===draft.title.toLocaleLowerCase());
      if(existing){response(existing.quantity&&draft.quantity&&existing.quantity!==draft.quantity?'This item is already on the list with a different quantity. Review it before changing the amount.':'This item is already on your grocery list.');$('assistant-followup').append(button('Review item',()=>openTask({...existing,quantity:draft.quantity||existing.quantity},existing.id)));return;}
    }
    let created;
    if(mutate(()=>{created=C.createTask(state,draft);},'Saved to Tidy')){response(`${ui.saveFailed||ui.storageLocked?'Kept in this tab; download a backup before closing.':'Saved on this browser.'} ${created.type==='grocery'?'Grocery item':created.type==='appointment'?'Appointment you entered':'Task'}: ${created.title}. ${result.message}${created.remindAt!==null?' The demo must remain open to show this alert.':''}`);$('assistant-followup').append(button('Edit or assign',()=>openTask(created,created.id)));if(created.type==='grocery')$('assistant-followup').append(button('View shopping',()=>{showView('tools');$('shopping-card').scrollIntoView({block:'start'});}));}
  }
  function openTask(draft={},editingId=null,message='',requestReminder=false){
    ui.editingTask=editingId;error('task-error','');$('task-dialog-title').textContent=editingId?'Edit task':'Add a task';$('task-draft-message').textContent=message;
    populatePeople($('task-person'),'Unassigned','');
    $('task-title').value=draft.title||'';$('task-type').value=draft.type||'task';$('task-category').value=draft.category||'Home';$('task-person').value=draft.assigneeId||'';$('task-priority').value=draft.priority||'normal';$('task-date').value=draft.dueDate||'';$('task-time').value=draft.dueTime||'';$('task-repeat').value=draft.repeat||'none';$('task-quantity').value=draft.quantity||'';$('task-notes').value=draft.notes||'';$('task-link').value=draft.link||'';
    $('task-reminder').checked=draft.remindAt!==null&&draft.remindAt!==undefined||requestReminder;
    $('task-reminder-at').value=draft.remindAt?clockValue(draft.remindAt):draft.dueDate&&draft.dueTime&&requestReminder?draft.dueDate+'T'+draft.dueTime:'';
    syncTaskControls();$('task-dialog').showModal();$('task-title').focus();
  }
  function syncTaskControls(){
    $('quantity-label').hidden=$('task-type').value!=='grocery';$('reminder-at-label').hidden=!$('task-reminder').checked;
    $('task-date').required=$('task-type').value==='appointment'||$('task-repeat').value!=='none';$('task-time').required=$('task-type').value==='appointment';$('task-reminder-at').required=$('task-reminder').checked;
  }
  function saveTask(event){
    event.preventDefault();error('task-error','');
    try{
      let remindAt=null;
      if($('task-reminder').checked){const parts=$('task-reminder-at').value.split('T');if(parts.length!==2)throw Error('Choose a reminder date and time.');remindAt=C.dueEpoch(parts[0],parts[1]);const old=state.tasks.find(task=>task.id===ui.editingTask);if(remindAt<=Date.now()&&remindAt!==old?.remindAt)throw Error('Choose a reminder time in the future.');}
      const patch={title:$('task-title').value,category:$('task-category').value,assigneeId:$('task-person').value||null,type:$('task-type').value,priority:$('task-priority').value,dueDate:$('task-date').value,dueTime:$('task-time').value,repeat:$('task-repeat').value,quantity:$('task-quantity').value,notes:$('task-notes').value,link:$('task-link').value,remindAt};
      const task=ui.editingTask?C.updateTask(state,ui.editingTask,patch):C.createTask(state,patch);const saved=save();$('task-dialog').close();renderAll();toast('Saved '+task.title+(saved?'':' · in this tab only'));checkReminders();
    }catch(problem){error('task-error',problem.message);}
  }
  function openAction(action={},editingId=null){ui.editingAction=editingId;error('action-error','');$('action-title').value=action.title||'';$('action-kind').value=action.kind||'purchase';$('action-provider').value=action.provider||'';$('action-link').value=action.link||'';$('action-details').value=action.details||'';$('action-dialog').showModal();}
  function saveAction(event){
    event.preventDefault();error('action-error','');
    try{
      const old=state.actions.find(action=>action.id===ui.editingAction),action={id:old?.id||id('request'),kind:$('action-kind').value,title:$('action-title').value,provider:$('action-provider').value,link:$('action-link').value,details:$('action-details').value,status:'needs_review',createdAt:old?.createdAt||Date.now()};
      const candidate=C.validateSnapshot({...state,actions:old?state.actions.map(item=>item.id===old.id?action:item):[...state.actions,action]});state=candidate;const saved=save();$('action-dialog').close();renderAll();toast('Draft saved for review'+(saved?'':' · in this tab only'));
    }catch(problem){error('action-error',problem.message);}
  }
  function openMember(member=null){ui.editingMember=member?.id||null;$('member-name').value=member?.name||'';error('member-error','');$('member-dialog').showModal();}
  function saveMember(event){event.preventDefault();error('member-error','');try{const member={id:ui.editingMember||id('person'),name:$('member-name').value};const next=C.validateSnapshot({...state,members:ui.editingMember?state.members.map(old=>old.id===member.id?member:old):[...state.members,member]});state=next;const saved=save();$('member-dialog').close();renderAll();toast(saved?'Household name saved':'Household name kept in this tab; download a backup');}catch(problem){error('member-error',problem.message);}}
  function showSettings(){error('backup-error','');$('checkin-enabled').checked=state.settings.checkinEnabled;$('checkin-time').value=state.settings.checkinTime;$('alerts-paused').checked=state.settings.remindersPaused;$('export-recovery').hidden=!ui.recoveryText;updateBrowserStatus();$('settings-dialog').showModal();}
  function updateBrowserStatus(){const permission=window.Notification?.permission;$('browser-alert-status').textContent=!window.Notification?'Browser notifications are unavailable here; in-page alerts still work.':permission==='granted'?'Browser notifications are permitted while this demo is running.':permission==='denied'?'Browser notifications are blocked; in-page alerts still work.':'No notification permission requested. In-page alerts work while open.';$('enable-browser-alerts').disabled=!window.Notification||permission==='denied'||permission==='granted';}
  function checkReminders(){
    try{
      const due=C.dueReminders(state,Date.now()).filter(task=>!ui.unsavedDeliveries.has(task.id+':'+task.remindAt));let checkin=false,deliveryWarning=false;const date=C.today();
      if(!state.settings.remindersPaused&&state.settings.checkinEnabled&&state.settings.checkinLastDate!==date&&ui.unsavedCheckin!==date&&Date.now()>=C.dueEpoch(date,state.settings.checkinTime)){checkin=true;try{state=C.validateSnapshot({...state,settings:{...state.settings,checkinLastDate:date}});}catch(_){ui.unsavedCheckin=date;deliveryWarning=true;}}
      if(!due.length&&!checkin)return;
      const content=$('alert-content');content.replaceChildren(el('strong',checkin?'Ready to review your day?':'A few things need attention.'));
      if(due.length){const list=el('ul');for(const task of due){list.append(el('li',task.title+' · '+memberName(task.assigneeId)));try{C.updateTask(state,task.id,{deliveredReminderAt:task.remindAt});}catch(_){ui.unsavedDeliveries.add(task.id+':'+task.remindAt);deliveryWarning=true;}}content.append(list);}
      if(deliveryWarning)content.append(el('p','The alert was shown, but its delivery record could not fit in the backup. It may appear again after reopening. Remove an old item or shorten large notes.','helper'));
      content.append(button('Open Today',()=>{showView('today');$('alert-banner').hidden=true;},'button text small'));
      $('alert-banner').hidden=false;save();renderAll();
      if(window.Notification?.permission==='granted')try{new Notification('Tidy: '+(due.length?`${due.length} reminder${due.length===1?'':'s'}`:'Your daily check-in'),{body:due.map(task=>task.title).join('\n')||'Open Tidy to review your day.',tag:'tidy-reminders'});}catch(_){/* The in-page alert remains the reliable demo route. */}
    }catch(problem){toast(problem.message);}
  }
  function loadWebsiteView(){
    if(!ui.websiteUrl)return;
    $('website-recovery').hidden=true;$('website-frame').hidden=false;
    $('website-report-problem').disabled=false;$('website-retry').disabled=false;
    $('website-frame').src=ui.websiteUrl;
  }
  function openWebsite(url,title){
    try{
      const validated=safeLink(url);ui.websiteUrl=validated;
      $('website-title').textContent=title;$('website-frame').title=title+' website';
      $('website-open-direct').href=validated;loadWebsiteView();
      if(!$('website-dialog').open)$('website-dialog').showModal();
    }catch(problem){toast(problem.message);}
  }
  function stopWebsiteView(){
    if(!ui.websiteUrl)return;
    $('website-frame').src='about:blank';$('website-frame').hidden=true;
    $('website-report-problem').disabled=true;$('website-recovery').hidden=false;
    $('website-recovery-title').focus();
  }
  function showMeals(){showView('tools');$('meals-section').hidden=false;postMealRestore();$('meals-section').scrollIntoView({block:'start',behavior:'instant'});}
  function postMeal(message){$('meals-frame').contentWindow?.postMessage(message,'*');}
  function postMealRestore(){ui.mealVerified=false;ui.mealGroceries=[];ui.groceriesApproved=false;renderToday();renderShopping();postMeal({type:'tidy-meals-restore',snapshot:state.mealSnapshot});postMeal({type:'tidy-meals-storage-status',saved:!ui.saveFailed&&!ui.storageLocked});}
  function validateMealBackup(snapshot){
    if(snapshot===null)return Promise.resolve();
    return new Promise((resolve,reject)=>{const requestId=id('validate'),timeout=setTimeout(()=>{ui.mealRequests.delete(requestId);reject(Error('The meal planner could not validate this backup yet. Wait for it to load, then try again.'));},5000);ui.mealRequests.set(requestId,{resolve:()=>{clearTimeout(timeout);resolve();},reject:message=>{clearTimeout(timeout);reject(Error(message||'Invalid meal data in the backup.'));}});postMeal({type:'tidy-meals-validate',requestId,snapshot});});
  }
  async function importBackup(event){
    const file=event.target.files[0];if(!file)return;error('backup-error','');
    try{
      if(file.size>1024*1024)throw Error('The backup is too large. Maximum size is 1 MiB.');
      const candidate=C.parseBackup(await file.text());await validateMealBackup(candidate.mealSnapshot);
      if(!confirm(`Replace this browser's Tidy data with ${candidate.tasks.length} tasks and ${candidate.members.length} household names from the backup? Download a backup first if you want to keep the current data.`))return;
      state=candidate;ui.storageLocked=false;ui.recoveryText=null;ui.mealVerified=false;ui.mealGroceries=[];ui.groceriesApproved=false;const saved=save();renderAll();if(state.mealSnapshot===null)postMeal({type:'tidy-meals-reset'});else postMealRestore();
      toast('Backup restored'+(saved?'':' · in this tab only'));
    }catch(problem){error('backup-error',problem.message);}
    finally{event.target.value='';}
  }
  function setupVoice(){
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognition){$('voice-button').disabled=true;$('voice-status').textContent='Direct speech recognition is unavailable in this browser. You can use your phone keyboard’s dictation.';return;}
    $('voice-status').textContent='Optional browser speech recognition may send audio to your browser provider. It starts only when you tap Speak.';
    $('voice-button').addEventListener('click',()=>{
      if(ui.listening){ui.voice?.stop();return;}
      try{const recognition=new Recognition();ui.voice=recognition;recognition.lang='en-US';recognition.continuous=false;recognition.interimResults=false;
        recognition.onstart=()=>{ui.listening=true;$('voice-button').textContent='Stop listening';$('voice-status').textContent='Listening to this request…';};
        recognition.onresult=event=>{$('capture-text').value=event.results[0][0].transcript;$('voice-status').textContent='Words captured. Check them, then tap Tell Tidy.';};
        recognition.onerror=event=>{$('voice-status').textContent=event.error==='not-allowed'?'Microphone access was not allowed. You can type or use keyboard dictation.':'Speech recognition did not complete. You can type or use keyboard dictation.';};
        recognition.onend=()=>{ui.listening=false;$('voice-button').textContent='Speak a request';};recognition.start();
      }catch(_){$('voice-status').textContent='Speech recognition is unavailable here. Type your request or use keyboard dictation.';}
    });
  }
  function loadExamples(){
    if(!confirm('Add clearly labelled example tasks to try Tidy? Your existing tasks will be kept.'))return;
    const date=C.today(),sampleNotes='Example for trying Tidy; replace it with your own details.';
    mutate(()=>{for(const input of [{title:'Get the school bag ready',category:'School',assigneeId:'child',dueDate:date,priority:'high'},{title:'Check the work report',category:'Work',assigneeId:'mum',dueDate:date},{title:'Take out the bins',category:'Home',assigneeId:'dad',dueDate:date,repeat:'daily'},{title:'Call the clinic',category:'Health',assigneeId:'mum',dueDate:C.addDays(date,1),dueTime:'10:00'},{title:'Ketchup',category:'Shopping',type:'grocery',quantity:'1 bottle'}])if(!state.tasks.some(task=>task.title===input.title&&task.notes===sampleNotes))C.createTask(state,{...input,assigneeId:state.members.some(member=>member.id===input.assigneeId)?input.assigneeId:null,notes:sampleNotes});},'Example tasks added');
  }
  startStorage();
  for(const nav of document.querySelectorAll('[data-view]'))nav.addEventListener('click',()=>showView(nav.dataset.view));
  document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();showView('today');});
  $('today-add').addEventListener('click',()=>{showView('assistant');$('capture-text').focus();});$('family-add').addEventListener('click',()=>openTask());$('tools-add-link').addEventListener('click',()=>openTask({},null,'Keep a useful website with the job it helps you finish.'));
  $('add-routine').addEventListener('click',()=>openTask({repeat:'weekly',dueDate:C.today()},null,'Choose the first date. Weekly routines keep this weekday.'));
  $('task-form').addEventListener('submit',saveTask);$('action-form').addEventListener('submit',saveAction);$('member-form').addEventListener('submit',saveMember);
  $('capture-form').addEventListener('submit',event=>{event.preventDefault();try{capture($('capture-text').value);}catch(problem){response(problem.message);}});
  for(const example of document.querySelectorAll('[data-example]'))example.addEventListener('click',()=>{$('capture-text').value=example.dataset.example;$('capture-text').focus();});
  for(const close of document.querySelectorAll('[data-close]'))close.addEventListener('click',()=>$(close.dataset.close).close());
  $('website-dialog').addEventListener('close',()=>{ui.websiteUrl=null;$('website-frame').src='about:blank';$('website-frame').hidden=true;$('website-open-direct').removeAttribute('href');$('website-recovery').hidden=true;});
  $('website-report-problem').addEventListener('click',stopWebsiteView);
  $('website-retry').addEventListener('click',()=>{loadWebsiteView();$('website-report-problem').focus();});
  for(const field of [$('task-type'),$('task-repeat'),$('task-reminder')])field.addEventListener('change',()=>{if(field.id==='task-type'){if(field.value==='grocery')$('task-category').value='Shopping';if(field.value==='appointment')$('task-category').value='Health';}if($('task-reminder').checked&&!$('task-reminder-at').value&&$('task-date').value&&$('task-time').value)$('task-reminder-at').value=$('task-date').value+'T'+$('task-time').value;syncTaskControls();});
  for(const field of [$('task-date'),$('task-time')])field.addEventListener('change',()=>{if(ui.editingTask){$('task-reminder').checked=false;$('task-reminder-at').value='';}else if($('task-reminder').checked&&$('task-date').value&&$('task-time').value)$('task-reminder-at').value=$('task-date').value+'T'+$('task-time').value;syncTaskControls();});
  for(const field of [$('task-search'),$('category-filter'),$('person-filter'),$('status-filter')])field.addEventListener('input',renderFamily);$('today-person').addEventListener('change',renderToday);
  $('add-member').addEventListener('click',()=>openMember());$('new-action').addEventListener('click',()=>openAction());
  $('open-settings').addEventListener('click',showSettings);$('edit-checkins').addEventListener('click',showSettings);
  $('settings-form').addEventListener('submit',event=>{event.preventDefault();try{state=C.validateSnapshot({...state,settings:{...state.settings,checkinEnabled:$('checkin-enabled').checked,checkinTime:$('checkin-time').value,remindersPaused:$('alerts-paused').checked}});const saved=save();renderAll();toast(saved?'Alert preferences saved':'Preferences kept in this tab; download a backup');checkReminders();}catch(problem){toast(problem.message);}});
  $('pause-alerts').addEventListener('click',()=>{mutate(()=>{state.settings.remindersPaused=!state.settings.remindersPaused;},state.settings.remindersPaused?'Alerts resumed':'Alerts paused');checkReminders();});
  $('enable-browser-alerts').addEventListener('click',async()=>{try{await Notification.requestPermission();updateBrowserStatus();}catch(_){$('browser-alert-status').textContent='This browser could not request permission. In-page alerts still work.';}});
  $('dismiss-alert').addEventListener('click',()=>{$('alert-banner').hidden=true;});
  $('export-backup').addEventListener('click',()=>{try{download('Tidy-backup-'+C.today()+'.json',C.backupJSON(state));}catch(problem){error('backup-error',problem.message);}});
  $('export-recovery').addEventListener('click',()=>{if(ui.recoveryText)download('Tidy-saved-data-for-recovery.json',ui.recoveryText);});$('import-backup').addEventListener('change',importBackup);
  $('load-examples').addEventListener('click',loadExamples);$('today-meals').addEventListener('click',showMeals);$('show-meals').addEventListener('click',showMeals);$('hide-meals').addEventListener('click',()=>{$('meals-section').hidden=true;});$('show-requests').addEventListener('click',()=>{$('requests-card').scrollIntoView({block:'start'});});
  $('shopping-meals').addEventListener('click',showMeals);$('download-shopping').addEventListener('click',downloadShopping);
  for(const [key,store] of Object.entries(GROCERY_STORES))$('shopping-store-links').append(button('Open '+key,()=>openWebsite(store.url,store.name)));
  for(const [name,url] of [['Amazon UAE','https://www.amazon.ae/'],['Kibsons','https://www.kibsons.com/'],['Carrefour UAE','https://www.carrefouruae.com/'],['Waitrose UAE','https://www.waitrose.ae/']])$('provider-list').append(button(name,()=>openWebsite(url,name)));
  window.addEventListener('message',event=>{
    if(event.source!==$('meals-frame').contentWindow||!event.data||typeof event.data!=='object')return;
    const message=event.data;
    if(message.type==='tidy-meals-open-store'){if(typeof message.store==='string'&&Object.hasOwn(GROCERY_STORES,message.store)){const store=GROCERY_STORES[message.store];openWebsite(store.url,store.name);}}
    else if(message.type==='tidy-meals-ready'){ui.mealReady=true;postMealRestore();}
    else if(message.type==='tidy-meals-height'&&Number.isFinite(message.height))$('meals-frame').style.height=Math.max(400,Math.min(10000,Math.ceil(message.height)))+'px';
    else if(message.type==='tidy-meals-change'){
      try{const next=C.validateSnapshot({...state,mealSnapshot:message.snapshot,mealSummary:message.summary});state=next;ui.mealVerified=true;readMealGroceries(message);const saved=save();postMeal({type:'tidy-meals-storage-status',saved});if(message.snapshot===null&&typeof message.resetId==='string'&&message.resetId.length>0&&message.resetId.length<=100)postMeal({type:'tidy-meals-reset-ack',resetId:message.resetId,saved});renderToday();renderShopping();}
      catch(problem){postMeal({type:'tidy-meals-storage-status',saved:false});toast(problem.message);}
    }else if(message.type==='tidy-meals-restored'){
      ui.mealVerified=message.valid===true;if(ui.mealVerified){try{state=C.validateSnapshot({...state,mealSummary:message.summary});readMealGroceries(message);}catch(_){ui.mealVerified=false;}}if(!ui.mealVerified){ui.mealGroceries=[];ui.groceriesApproved=false;toast('The saved meal plan needs recovery. Open the meal planner to review it.');}renderToday();renderShopping();
    }else if(message.type==='tidy-meals-validation-result'){
      const request=ui.mealRequests.get(message.requestId);if(!request)return;ui.mealRequests.delete(message.requestId);message.valid===true?request.resolve():request.reject(message.message);
    }
  });
  $('meals-frame').addEventListener('load',()=>{ui.mealReady=true;postMealRestore();});
  window.addEventListener('storage',event=>{if(event.key!==KEY||!event.newValue)return;try{state=C.parseBackup(event.newValue);renderAll();postMealRestore();toast('Saved data updated from another tab on this browser.');}catch(_){storageWarning('Another tab saved data that could not be read. Your current data remains available.');}});
  window.addEventListener('focus',checkReminders);document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkReminders();});
  setupVoice();showView(location.hash.slice(1)||'today',false);setInterval(checkReminders,15000);checkReminders();
  window.TidyDemo=Object.freeze({getState:()=>C.validateSnapshot(state),checkReminders});
  // The iframe may finish loading before the parent registers its listeners.
  postMealRestore();
})();
