/* UI for Tidy's web app. Provider actions remain manual drafts. */
(function () {
  'use strict';
  const C=window.TidyCore, A=window.TidyAssistant, P=window.TidyPlanner, CAL=window.TidyCalendar, CC=window.TidyCalendarConnect, KEY='tidy.app.v1', WELCOME_KEY='tidy.calendar-welcome.v1', CONNECTION_KEY='tidy.calendar-connection-config.v1';
  const GROCERY_STORES=Object.freeze({Carrefour:{name:'Carrefour UAE',url:'https://www.carrefouruae.com/'},Waitrose:{name:'Waitrose UAE',url:'https://www.waitrose.ae/'},Kibsons:{name:'Kibsons',url:'https://www.kibsons.com/'}});
  // Public registration IDs can be deployed here once the provider setup is
  // complete. They are application identifiers, never client secrets.
  const DEFAULT_CONNECTION_CONFIG=Object.freeze({googleClientId:'',microsoftClientId:''});
  const $=id=>document.getElementById(id);
  const ui={view:'today',editingTask:null,editingAction:null,editingMember:null,taskBaseline:null,actionBaseline:null,memberBaseline:null,settingsBaseline:null,healthSquareBaseline:null,healthSquareEditing:false,healthSquareStatus:'',lastDraft:null,storage:null,storageBaseline:null,storageLocked:false,recoveryText:null,saveFailed:false,voice:null,listening:false,mealReady:false,mealVerified:false,mealGroceries:[],groceriesApproved:false,mealRequests:new Map(),mealBaseSnapshot:null,savedMealSnapshot:null,savedMealSummary:[],mealRestoreExpected:null,mealRestorePending:false,mealDirty:false,mealConflict:false,mealDocument:null,unsavedDeliveries:new Set(),unsavedCheckin:'',websiteUrl:null};
  let state=C.defaults(), toastTimer;
  Object.assign(ui,{captureBusy:false,activity:null,taskCapture:null,pendingCapture:null,undoCapture:null,highlightTaskId:null,highlightActionId:null,mealSlide:'breakfast',mealEdits:{breakfast:null,lunch:null},mealBaselines:{breakfast:null,lunch:null},mealStatuses:{breakfast:'',lunch:''}});
  const MEAL_DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday'],MEAL_SLIDES=['breakfast','lunch','dinner'];
  Object.assign(ui,{planningEditing:false,planningBaseline:null,planningStatus:'',planResults:new Map(),calendarImportBusy:false,welcomeChoice:null});
  Object.assign(ui,{connectionConfig:{...DEFAULT_CONNECTION_CONFIG},connectionConfigBaseline:null,connectionConfigEditing:false,connectionConfigStatus:'',connector:null,accountProvider:null,accountBusy:false,accountMessage:''});
  const PROFILE_FIELDS=['enabled','workDays','schoolDays','workStart','workEnd','kidsHome','dayStart','dayEnd','taskMinutes','familyMinutes','bufferMinutes'];
  const PROFILE_INPUTS={workStart:'work-start',workEnd:'work-end',kidsHome:'kids-home',dayStart:'day-start',dayEnd:'day-end',taskMinutes:'task-minutes',familyMinutes:'family-minutes',bufferMinutes:'buffer-minutes'};
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
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
  function mealConflictWarning(){storageWarning('A different meal draft was saved in another tab. Your current meal edits are kept here and have not replaced it. Download a backup before closing; restore a backup to choose which version to keep.');}
  function save(){
    if(ui.storageLocked){storageWarning('Existing saved data could not be read. It has been preserved. New changes stay in this tab until you restore a valid backup; download a backup before closing.');return false;}
    if(ui.mealConflict){mealConflictWarning();return false;}
    try{ui.storageBaseline=C.persistIfUnchanged(ui.storage,state,ui.storageBaseline,KEY);ui.savedMealSnapshot=copy(state.mealSnapshot);ui.savedMealSummary=copy(state.mealSummary);ui.saveFailed=false;storageWarning('');return true;}
    catch(problem){ui.saveFailed=true;storageWarning(problem.message+' Changes stay in this tab; download a backup before closing.');return false;}
  }
  function startStorage(){
    try{ui.storage=window.localStorage;ui.storageBaseline=ui.storage.getItem(KEY);state=ui.storageBaseline===null?C.defaults():C.parseBackup(ui.storageBaseline);ui.savedMealSnapshot=copy(state.mealSnapshot);ui.savedMealSummary=copy(state.mealSummary);storageWarning('');}
    catch(problem){
      try{ui.recoveryText=ui.storage?.getItem(KEY)??null;}catch(_){}
      ui.storageLocked=ui.recoveryText!==null;ui.saveFailed=true;
      storageWarning(problem.message+' Existing data has not been overwritten. Download a recovery copy or restore a valid backup.');
    }
  }
  function refreshSavedData(restoreMeals=true){
    if(!ui.storage)return false;
    let raw;
    try{raw=ui.storage.getItem(KEY);}catch(_){return false;}
    if(raw===ui.storageBaseline)return false;
    if(raw===null){ui.saveFailed=true;storageWarning('Another tab cleared the saved data. Your current data is kept in this tab; download a backup before closing.');return false;}
    let latest;
    try{latest=C.parseBackup(raw);}catch(_){ui.storageLocked=true;ui.saveFailed=true;if(ui.recoveryText===null)ui.recoveryText=raw;storageWarning('Another tab saved data that could not be read. Your current data and the unreadable saved copy have been kept; download backups before closing.');return false;}
    ui.savedMealSnapshot=copy(latest.mealSnapshot);ui.savedMealSummary=copy(latest.mealSummary);
    if(ui.storageLocked||ui.saveFailed||ui.mealConflict){
      if(ui.mealConflict)mealConflictWarning();
      else storageWarning('Another tab updated the saved data. Your unsaved changes are still kept in this tab; download a backup before closing or restore a backup to choose which version to keep.');
      return false;
    }
    const mealChanged=!same(state.mealSnapshot,latest.mealSnapshot);
    state=latest;ui.storageBaseline=raw;
    if(restoreMeals&&mealChanged&&!ui.mealDirty)postMealRestore();
    return true;
  }
  function mergeFields(baseline,latest,draft,fields){
    if(!baseline||!latest)throw Error('This item was removed or replaced in another tab. Your edits are still in this form; cancel and review the latest data.');
    const merged={};
    for(const field of fields){
      const entered=typeof draft[field]==='string'?draft[field].trim():draft[field];
      if(same(entered,baseline[field]))merged[field]=latest[field];
      else if(!same(latest[field],baseline[field])&&!same(entered,latest[field])){const label=({assigneeId:'person responsible',dueDate:'date',dueTime:'time',remindAt:'reminder time',checkinEnabled:'daily check-in preference',checkinTime:'check-in time',remindersPaused:'alert preference',healthSquareUrl:'Health Square website'})[field]||field;throw Error(`The ${label} changed in another tab. Your edits are still in this form; review the latest version before saving.`);}
      else merged[field]=entered;
    }
    return merged;
  }
  function mutate(work,message){
    let previous=C.validateSnapshot(state);
    try{refreshSavedData();previous=C.validateSnapshot(state);work();state=C.validateSnapshot(state);const saved=save();renderAll();if(message)toast(message+(saved?'':' · not saved locally'));return true;}
    catch(problem){state=previous;renderAll();toast(problem.message+' The previous data was kept.');return false;}
  }
  function showView(view,focus=true,replace=false){
    const parts=view.split('/');view=parts[0];if(view==='meals'&&MEAL_SLIDES.includes(parts[1]))ui.mealSlide=parts[1];
    if(!['today','assistant','family','routines','tools','reminders','appointments','meals','shopping','stores','requests','health','household','inbox','upcoming','calendar','planning','planning-settings'].includes(view))view='tools';
    if(ui.listening&&view!=='assistant')ui.voice?.abort();
    ui.view=view;for(const section of document.querySelectorAll('.view'))section.hidden=section.id!=='view-'+view;
    const parentView=['today','assistant','family','reminders','tools'].includes(view)?view:'tools';
    for(const nav of document.querySelectorAll('[data-view]')){if(nav.dataset.view===parentView)nav.setAttribute('aria-current','page');else nav.removeAttribute('aria-current');}
    const route='#'+view+(view==='meals'?'/'+ui.mealSlide:'');
    if(location.hash!==route)history[replace?'replaceState':'pushState'](null,'',route);renderAll();
    if(focus){const heading=$('view-'+view).querySelector('h1');heading.focus();window.scrollTo({top:0,behavior:'instant'});}
  }
  function populatePeople(select,first='All household',firstValue='all'){
    const selected=select.value;select.replaceChildren();const option=el('option',first);option.value=firstValue;select.append(option);
    for(const member of state.members){const item=el('option',member.name);item.value=member.id;select.append(item);}
    if([...select.options].some(option=>option.value===selected))select.value=selected;
  }
  function sorted(tasks){return tasks.slice().sort((a,b)=>((a.dueDate||'9999')+(a.dueTime||'23:59')).localeCompare((b.dueDate||'9999')+(b.dueTime||'23:59'))||(a.priority==='high'?-1:0)-(b.priority==='high'?-1:0)||a.createdAt-b.createdAt);}
  function taskCard(task,compact=false){
    const row=el('article',undefined,'task-row'+(task.status==='done'?' done':'')+(task.id===ui.highlightTaskId?' assistant-highlight':''));row.dataset.taskId=task.id;row.tabIndex=-1;
    const top=el('div',undefined,'task-top'),copy=el('div',undefined,'task-copy');copy.append(el('div',task.title,'task-title'));
    const metadata=el('div',undefined,'task-meta');metadata.append(el('span',task.category,'pill'),el('span',memberName(task.assigneeId),'pill neutral'));
    if(task.priority==='high')metadata.append(el('span','Important','pill warning'));
    if(task.type==='appointment')metadata.append(el('span','Entered appointment','pill neutral'));
    if(task.quantity)metadata.append(el('span',task.quantity,'pill neutral'));
    if(task.repeat!=='none')metadata.append(el('span',({daily:'Daily',weekly:'Weekly',weekdays:'Weekdays'})[task.repeat],'pill'));
    copy.append(metadata);let when=task.dueDate?`${prettyDate(task.dueDate)}${task.dueTime?' · '+task.dueTime:''}`:'Choose a date when ready';
    if(task.status==='open'&&task.dueDate&&task.dueDate<C.today())when+=' · unfinished';copy.append(el('div',when,'task-time'));
    if(task.remindAt!==null)copy.append(el('div',`${task.deliveredReminderAt===task.remindAt?'Alert shown':'Alert set'} · ${clockValue(task.remindAt).replace('T',' ')} Dubai`,'task-time'));
    if(task.durationMinutes)copy.append(el('div',task.durationMinutes+' minutes','task-time'));
    if(task.planningReason)copy.append(el('p',task.planningReason,'helper'));
    top.append(copy);const done=button(task.status==='done'?'↶':'✓',()=>mutate(()=>{const latest=state.tasks.find(item=>item.id===task.id);if(!latest||latest.status!==task.status)throw Error('This task changed in another tab. Review its current status before changing it.');return task.status==='done'?C.reopenTask(state,task.id):C.completeTask(state,task.id);},task.status==='done'?'Reopened':'Marked done'),'done-button');done.setAttribute('aria-label',(task.status==='done'?'Reopen ':'Complete ')+task.title);top.append(done);row.append(top);
    if(task.notes&&!compact)row.append(el('p',task.notes));
    const actions=el('div',undefined,'task-actions');actions.append(button('Edit',()=>openTask(task,task.id)));
    if(task.link)actions.append(button('View website',()=>openWebsite(task.link,task.title)));
    if(task.status==='open'&&task.dueDate&&task.dueDate<C.today())actions.append(button('Move to tomorrow',()=>mutate(()=>C.updateTask(state,task.id,{dueDate:C.addDays(C.today(),1),remindAt:null,deliveredReminderAt:null}),'Moved to tomorrow. Choose a new reminder if needed.')));
    if(task.status==='open'&&task.remindAt!==null)actions.append(button('Remind in 1 hour',()=>mutate(()=>C.updateTask(state,task.id,{remindAt:Math.floor(Date.now()/60000)*60000+3600000}),'Reminder moved one hour ahead')));
    if(ui.view==='routines'&&task.repeat!=='none')actions.append(button('Stop repeating',()=>mutate(()=>C.stopRepeating(state,task.id),'Repetition stopped for this routine. Existing tasks remain.')));
    if(!compact)actions.append(button('Remove',()=>{if(confirm('Remove this item from Tidy? This does not cancel anything with a provider.'))mutate(()=>C.deleteTask(state,task.id),'Removed from Tidy');},'button text small'));
    row.append(actions);return row;
  }
  function taskList(id,tasks,none,compact=false){const target=$(id);target.replaceChildren();const ordered=sorted(tasks);if(['reminder-tasks','appointment-tasks'].includes(id)){const index=ordered.findIndex(task=>task.id===ui.highlightTaskId);if(index>0)ordered.unshift(...ordered.splice(index,1));}for(const task of ordered)target.append(taskCard(task,compact));if(!tasks.length)empty(target,none);}
  function renderToday(){
    const date=C.today(),open=state.tasks.filter(task=>task.status==='open'),filter=$('today-person').value;
    ui.todayDate=date;
    const visible=open.filter(task=>filter==='all'||task.assigneeId===filter);
    $('today-date').textContent=new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Dubai'}).format(new Date())+' · Dubai time';
    const stats=$('today-stats');stats.replaceChildren();for(const [count,label] of [[open.filter(task=>task.dueDate===date).length,'Due today'],[open.filter(task=>task.dueDate&&task.dueDate<date).length,'Unfinished'],[state.actions.filter(action=>action.status==='needs_review').length,'Drafts to review']]){const card=el('div',undefined,'stat');card.append(el('strong',String(count)),el('span',label));stats.append(card);}
    taskList('today-tasks',visible.filter(task=>task.dueDate&&task.dueDate<=date),'Nothing dated needs attention. Add a task when you need one.');
    taskList('inbox-tasks',open.filter(task=>task.type==='task'&&!task.dueDate),'Your undated task list is clear. Groceries and appointments stay in their own sections.');
    taskList('upcoming-tasks',open.filter(task=>task.dueDate>date),'No upcoming items entered yet.');
    const times=new Map();for(const task of visible.filter(task=>task.dueDate===date&&task.dueTime)){times.set(task.dueTime,(times.get(task.dueTime)||0)+1);}
    $('today-conflicts').textContent=[...times].filter(([,count])=>count>1).map(([time,count])=>`${count} items share ${time}; check their timing.`).join(' ');
    const meal=ui.mealVerified?state.mealSummary.find(meal=>meal.day===weekday(date)):null;$('today-meal').replaceChildren(el('p',meal?meal.name:'No approved dinner plan for today.'));if(meal)$('today-meal').append(el('p','From your approved weekday menu.','helper'));
  }
  function renderFamily(){
    $('member-list').replaceChildren();for(const member of state.members){const assigned=state.tasks.filter(task=>task.status==='open'&&task.assigneeId===member.id).length;$('member-list').append(button(`${member.name} · ${assigned} open`,()=>openMember(member),'member-button'));}
    const search=$('task-search').value.trim().toLocaleLowerCase(),category=$('category-filter').value,person=$('person-filter').value,status=$('status-filter').value;
    taskList('family-tasks',state.tasks.filter(task=>task.type==='task'&&(category==='all'||task.category===category)&&(person==='all'||task.assigneeId===person)&&(status==='all'||task.status===status)&&(!search||(task.title+' '+task.notes).toLocaleLowerCase().includes(search))),'No matching tasks. Add one or change the filters. Groceries and appointments have their own sections.');
  }
  function renderRoutines(){
    taskList('routine-tasks',state.tasks.filter(task=>task.type==='task'&&task.status==='open'&&task.repeat!=='none'),'No repeating tasks yet. Add a routine with its first date.');
    $('pause-alerts').textContent=state.settings.remindersPaused?'Resume alerts':'Pause alerts';
    $('reminder-summary').textContent=state.settings.remindersPaused?'All demo alerts are paused.':`Task alerts are active while open. Daily check-in ${state.settings.checkinEnabled?'at '+state.settings.checkinTime+' Dubai time':'is turned off'}.`;
  }
  function actionCard(action){
      const card=el('article',undefined,'request-card'+(action.id===ui.highlightActionId?' assistant-highlight':''));card.dataset.actionId=action.id;card.tabIndex=-1;card.append(el('h3',action.title));
      const labels={needs_review:'Needs your review',approved_draft:'Draft approved · finish with provider',cancelled:'Draft discarded',manually_completed:'You marked it completed manually'};
      card.append(el('span',labels[action.status],'pill'+(action.status==='needs_review'?' warning':' neutral')));
      card.append(el('p',`${action.kind==='purchase'?'Purchase':action.kind==='booking'?'Booking':'Message'}${action.provider?' · '+action.provider:''}`,'helper'));
      if(action.details)card.append(el('p',action.details,'helper'));
      if(action.status==='approved_draft')card.append(el('p','No message, purchase or booking has been carried out by Tidy. Complete it yourself with the provider.','helper'));
      const actions=el('div',undefined,'actions');actions.append(button('Edit draft',()=>openAction(action,action.id)));
      if(action.status==='needs_review')actions.append(button('Approve draft',()=>mutate(()=>changeActionStatus(action,'approved_draft'),'Draft approved. No external action taken.')));
      if(action.link)actions.append(button('View website',()=>openWebsite(action.link,action.provider||action.title)));
      if(action.status==='approved_draft')actions.append(button('I completed it outside Tidy',()=>{if(confirm('Have you completed this yourself? Tidy cannot verify it with the provider.'))mutate(()=>changeActionStatus(action,'manually_completed'),'Recorded your manual completion');}));
      if(!['cancelled','manually_completed'].includes(action.status))actions.append(button('Discard draft',()=>mutate(()=>changeActionStatus(action,'cancelled'),'Draft discarded; no provider action cancelled'),'button text small'));
      card.append(actions);return card;
  }
  function renderActions(){
    const target=$('action-list');target.replaceChildren();
    for(const action of state.actions.slice().reverse())target.append(actionCard(action));
    if(!state.actions.length)empty(target,'No prepared requests yet. Ask Tidy to prepare a purchase, booking or message.');
  }
  function renderReminders(){
    taskList('reminder-tasks',state.tasks.filter(task=>task.remindAt!==null),'No reminders yet. Tell Ask Tidy what to remember and when.');
    $('reminders-delivery-status').textContent=state.settings.remindersPaused?'Alerts are paused. Open reminder settings to resume them.':'Reminders are active while Tidy is open. Browser notifications also depend on your permission.';
  }
  function renderAppointments(){
    taskList('appointment-tasks',state.tasks.filter(task=>task.type==='appointment'),'No appointments entered yet. Add an appointment with its date and time.');
    const target=$('appointment-requests');target.replaceChildren();
    for(const action of state.actions.slice().reverse().filter(action=>action.kind==='booking'))target.append(actionCard(action));
    if(!target.children.length)empty(target,'No appointment requests awaiting preparation. Tidy has not contacted a provider.');
  }
  function changeActionStatus(shown,status){const latest=state.actions.find(action=>action.id===shown.id);if(!latest||!same(shown,latest))throw Error('This request changed in another tab. Review the current draft before changing its approval.');latest.status=status;}
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
    taskList('shopping-tasks',items,'Your grocery list is empty. Add an item above.');
    const list=$('meal-shopping-items');list.replaceChildren();
    if(ui.mealVerified&&ui.groceriesApproved){
      $('meal-shopping-status').textContent='From your approved grocery draft, after checking the kitchen. No order placed.';
      for(const item of ui.mealGroceries){const row=el('li');row.append(el('span',item.name),el('span',item.amount+' '+item.unit));list.append(row);}
      if(!ui.mealGroceries.length)list.append(el('li','Nothing missing from your reviewed meal plan.'));
    }else $('meal-shopping-status').textContent='Check the kitchen and approve the meal grocery draft to include its ingredients here and in the download.';
    $('download-shopping').disabled=!items.length&&!(ui.mealVerified&&ui.groceriesApproved);
  }
  function saveGrocery(event){
    event.preventDefault();error('grocery-error','');$('grocery-status').textContent='';
    try{
      if(refreshSavedData())renderAll();
      const title=$('grocery-title').value.trim(),quantity=$('grocery-quantity').value.trim();
      if(!title)throw Error('Type the item you need.');
      if(title.length>300)throw Error('Keep the item name to 300 characters or fewer.');
      if(quantity.length>120)throw Error('Keep the quantity to 120 characters or fewer.');
      const existing=state.tasks.find(task=>task.type==='grocery'&&task.status==='open'&&task.title.toLocaleLowerCase()===title.toLocaleLowerCase());
      if(existing?.quantity&&quantity&&existing.quantity!==quantity){ui.highlightTaskId=existing.id;renderShopping();throw Error('“'+existing.title+'” is already on your list with quantity “'+existing.quantity+'”. Use its Edit button to review the amount. Your entry has been kept.');}
      const changed=!existing||Boolean(!existing.quantity&&quantity);
      const task=existing?(changed?C.updateTask(state,existing.id,{quantity}):existing):C.createTask(state,{title,quantity,type:'grocery',category:'Shopping'});
      const saved=changed||ui.saveFailed?save():!ui.storageLocked&&!ui.mealConflict;
      ui.highlightTaskId=task.id;renderAll();
      if(saved){$('grocery-title').value='';$('grocery-quantity').value='';$('grocery-status').textContent=existing?(changed?'Quantity saved for “'+task.title+'”.':'“'+task.title+'” is already on your grocery list.'):'Added “'+task.title+'” to your grocery list.';$('grocery-title').focus();}
      else $('grocery-status').textContent='Not saved on this browser. Your item and entry are kept in this tab; download a backup before closing.';
    }catch(problem){error('grocery-error',problem.message);}
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
  function renderHealthSquare(){
    const url=state.settings.healthSquareUrl;
    $('health-square-open').disabled=!url;
    $('health-square-saved-link').textContent=url?'Current website: '+url:'';
    $('health-square-saved-link').hidden=!url;
    if(!ui.healthSquareEditing){$('health-square-url').value=url;ui.healthSquareBaseline={healthSquareUrl:url};}
    $('health-square-cancel').hidden=!ui.healthSquareEditing;
    $('health-square-status').textContent=ui.healthSquareStatus||(url?'Website kept on this browser.':'Save the website address to enable Health Square.');
  }
  function beginHealthSquareEdit(){
    if(!ui.healthSquareEditing){ui.healthSquareBaseline={healthSquareUrl:state.settings.healthSquareUrl};ui.healthSquareEditing=true;}
  }
  function saveHealthSquare(event){
    event.preventDefault();error('health-square-error','');
    try{
      refreshSavedData();
      const draft=C.validateSnapshot({...state,settings:{...state.settings,healthSquareUrl:$('health-square-url').value}}).settings;
      const merged=mergeFields(ui.healthSquareBaseline,state.settings,draft,['healthSquareUrl']);
      state=C.validateSnapshot({...state,settings:{...state.settings,...merged}});
      const saved=save();
      if(saved){ui.healthSquareEditing=false;ui.healthSquareStatus=state.settings.healthSquareUrl?'Health Square website saved on this browser.':'Website removed; Health Square is disabled until you save an address.';}
      else {ui.healthSquareEditing=true;ui.healthSquareStatus='Website change kept in this tab only. Download a backup before closing.';}
      renderAll();
    }catch(problem){error('health-square-error',problem.message);ui.healthSquareStatus='Website change has not been saved.';renderHealthSquare();}
  }
  function renderAll(){
    populatePeople($('today-person'));populatePeople($('person-filter'));renderToday();renderFamily();renderRoutines();renderActions();renderShopping();renderHealthSquare();renderReminders();renderAppointments();renderMealPlans();renderPlanningProfile();renderCalendar();renderDayPlan();renderActivity();
  }
  function planningProfile(){return state.planningProfile||P.defaults();}
  function beginPlanningEdit(){if(!ui.planningEditing){ui.planningEditing=true;ui.planningBaseline=copy(planningProfile());}}
  function renderPlanningProfile(){
    const profile=planningProfile();
    if(!ui.planningEditing){
      $('planning-enabled').checked=profile.enabled;
      for(const box of document.querySelectorAll('[name="planning-workday"]'))box.checked=profile.workDays.includes(Number(box.value));
      for(const box of document.querySelectorAll('[name="planning-schoolday"]'))box.checked=profile.schoolDays.includes(Number(box.value));
      for(const [field,suffix] of Object.entries(PROFILE_INPUTS))$('planning-'+suffix).value=profile[field];
      ui.planningBaseline=copy(profile);
    }
    $('planning-settings-status').textContent=ui.saveFailed||ui.storageLocked?'Local saving needs attention. Download a backup before closing.':ui.planningStatus||(profile.enabled?'Your confirmed hours are saved. Tidy can choose times and reminders for flexible tasks.':'These are editable examples. Confirm your hours and enable planning to let Tidy choose times.');
  }
  function savePlanningProfile(event){
    event.preventDefault();error('planning-settings-error','');
    try{
      refreshSavedData();const draft={enabled:$('planning-enabled').checked,workDays:[...document.querySelectorAll('[name="planning-workday"]:checked')].map(box=>Number(box.value)).sort(),schoolDays:[...document.querySelectorAll('[name="planning-schoolday"]:checked')].map(box=>Number(box.value)).sort()};
      for(const [field,suffix] of Object.entries(PROFILE_INPUTS))draft[field]=field.endsWith('Minutes')?Number($('planning-'+suffix).value):$('planning-'+suffix).value;
      const profile=mergeFields(ui.planningBaseline||planningProfile(),planningProfile(),draft,PROFILE_FIELDS),candidate=C.validateSnapshot({...state,planningProfile:profile});
      state=candidate;const saved=save();
      if(saved){ui.planningEditing=false;ui.planningStatus=profile.enabled?'Your hours are saved. Ask Tidy to plan a flexible task, or use Organise my day.':'Your hours are saved. Automatic planning is switched off.';}
      else {ui.planningEditing=true;ui.planningBaseline=copy(state.planningProfile);ui.planningStatus='Your hours are kept in this tab only; download a backup before closing.';}
      renderAll();
    }catch(problem){error('planning-settings-error',problem.message);ui.planningStatus='Your entered hours have not replaced the saved routine.';renderPlanningProfile();}
  }
  function calendarCoverage(date){
    if(!state.calendar)return '';
    return date<C.today(state.calendar.windowStart)||date>C.today(state.calendar.windowEnd-1)?'The saved calendar does not cover this day. Refresh your account or import a fresh file before I choose a time.':'';
  }
  function calendarSlotCoverage(proposal){
    if(!state.calendar)return '';const start=C.dueEpoch(proposal.date,proposal.time),end=start+proposal.durationMinutes*60000;
    return start<state.calendar.windowStart||end>state.calendar.windowEnd?'The saved calendar does not cover this time. Refresh your account or import a fresh file before I choose a time.':'';
  }
  function calendarEventCard(event){
    const row=el('article',undefined,'task-row');row.dataset.calendarId=event.id;row.append(el('div',event.title,'task-title'));
    row.append(el('div',event.allDay?'All day · '+prettyDate(C.today(event.startAt)):readableTime(event.startAt)+' to '+new Intl.DateTimeFormat('en-GB',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Asia/Dubai'}).format(new Date(event.endAt)),'task-time'));
    row.append(el('p','Saved calendar commitment · fixed time','helper'));return row;
  }
  function calendarRedirectUri(){return new URL('calendar-auth.html',location.href).href;}
  function newConnector(config){return CC.createConnector({...config,redirectUri:calendarRedirectUri()});}
  function startCalendarConnections(){
    try{
      ui.connectionConfigBaseline=window.localStorage.getItem(CONNECTION_KEY);
      if(ui.connectionConfigBaseline!==null){const parsed=JSON.parse(ui.connectionConfigBaseline);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Saved connection settings could not be read.');ui.connectionConfig={googleClientId:parsed.googleClientId||'',microsoftClientId:parsed.microsoftClientId||''};}
      ui.connector=newConnector(ui.connectionConfig);
    }catch(_){ui.connectionConfig={...DEFAULT_CONNECTION_CONFIG};ui.connector=newConnector(ui.connectionConfig);ui.connectionConfigStatus='Saved connection settings need attention. Your calendar events and tasks have not changed.';}
  }
  function beginConnectionConfigEdit(){ui.connectionConfigEditing=true;}
  function renderCalendarConnection(){
    if(!ui.connectionConfigEditing){$('calendar-google-client-id').value=ui.connectionConfig.googleClientId;$('calendar-microsoft-client-id').value=ui.connectionConfig.microsoftClientId;}
    $('calendar-config-origin').value=location.origin;$('calendar-config-redirect').value=calendarRedirectUri();$('calendar-config-status').textContent=ui.connectionConfigStatus;
    for(const id of ['calendar-connect-google','calendar-connect-microsoft','calendar-connection-config-save'])$(id).disabled=ui.accountBusy||ui.calendarImportBusy;
    const session=ui.accountProvider?ui.connector.status(ui.accountProvider):null;
    $('calendar-account-refresh').disabled=ui.accountBusy||ui.calendarImportBusy||!session?.connected;
    $('calendar-account-disconnect').disabled=ui.accountBusy||!ui.accountProvider;
    if(ui.accountBusy)$('calendar-connection-status').textContent=ui.accountMessage||'Waiting for your calendar provider. No new events have been saved yet.';
    else if(ui.accountMessage)$('calendar-connection-status').textContent=ui.accountMessage;
    else if(ui.accountProvider&&session?.connected)$('calendar-connection-status').textContent='Account authorized in this tab. Refresh events when your calendar changes. Planning uses the last saved snapshot.';
    else if(state.calendar?.sourceType==='google'||state.calendar?.sourceType==='microsoft')$('calendar-connection-status').textContent='Saved '+(state.calendar.sourceType==='google'?'Google':'Outlook')+' events are available. Connect that account again to refresh them; this is not an active sign-in after reloading.';
    else $('calendar-connection-status').textContent=ui.connectionConfig.googleClientId||ui.connectionConfig.microsoftClientId?'Choose Google Calendar or Outlook to request read-only access. No account is connected yet.':'No calendar account connected. One-time connection setup is required.';
  }
  async function disconnectCalendarAccount(){
    const provider=ui.accountProvider;ui.accountProvider=null;ui.accountMessage='Disconnected from this tab. Saved events remain available; use Forget saved calendar to remove them.';renderCalendarConnection();
    if(provider)try{await ui.connector.disconnect(provider);}catch(_){error('calendar-connection-error','The local session was cleared. Check your provider’s account settings if you also want to revoke Tidy’s permission.');}
  }
  async function saveConnectionConfig(event){
    event.preventDefault();if(ui.accountBusy)return;error('calendar-config-error','');
    try{
      const config={googleClientId:$('calendar-google-client-id').value.trim(),microsoftClientId:$('calendar-microsoft-client-id').value.trim()},connector=newConnector(config);
      const raw=window.localStorage.getItem(CONNECTION_KEY);if(raw!==ui.connectionConfigBaseline)throw Error('Connection settings changed in another tab. Reload before replacing them; your entered IDs are still here.');
      const encoded=JSON.stringify(config);window.localStorage.setItem(CONNECTION_KEY,encoded);
      const old=ui.connector;ui.connector=connector;ui.connectionConfig=config;ui.connectionConfigBaseline=encoded;ui.connectionConfigEditing=false;ui.connectionConfigStatus='Public connection settings saved on this browser. Provider registration must match the addresses shown above.';ui.accountProvider=null;ui.accountMessage='';renderCalendarConnection();
      for(const provider of ['google','microsoft'])try{await old.disconnect(provider);}catch(_){}
    }catch(problem){error('calendar-config-error',problem.message||'The connection settings could not be saved.');}
  }
  async function connectCalendarAccount(provider,refresh=false){
    if(ui.accountBusy||ui.calendarImportBusy)return;
    error('calendar-connection-error','');
    const configured=provider==='google'?ui.connectionConfig.googleClientId:ui.connectionConfig.microsoftClientId;
    if(!configured){$('calendar-connection-setup').open=true;ui.accountMessage='Connection setup is required before '+(provider==='google'?'Google':'Microsoft')+' can ask for permission. No account has been accessed.';error('calendar-connection-error','Register Tidy with this provider and save its public application ID in Connection setup.');renderCalendarConnection();$('calendar-connection-setup').scrollIntoView({block:'start',behavior:'instant'});return;}
    refreshSavedData();const baseline=copy(state.calendar??null),connector=ui.connector;ui.accountBusy=true;ui.accountMessage=refresh?'Refreshing events from your calendar account…':'Opening your calendar provider’s read-only permission request…';renderCalendar();
    try{
      const snapshot=await (refresh?connector.refresh(provider):connector.connect(provider));
      if(ui.connector!==connector)throw Error('Connection settings changed while signing in. Try again with the current settings.');
      refreshSavedData();if(!same(baseline,state.calendar??null))throw Error('Another tab changed your saved calendar. Its events were kept; review them before connecting again.');
      const candidate=C.validateSnapshot({...state,calendar:snapshot});
      if(state.calendar&&state.calendar.sourceType!==provider&&!confirm('Use '+snapshot.sourceName+' for planning instead of the currently saved calendar? Tidy uses one account source or file snapshot at a time. Your tasks will stay in place.')){await connector.disconnect(provider);ui.accountMessage='Your previous calendar snapshot was kept.';return;}
      const previousProvider=ui.accountProvider;state=candidate;const saved=save();ui.accountProvider=provider;
      ui.accountMessage=(saved?'Calendar events read and saved on this browser.':'Events were read but could not be saved; they remain in this tab only. Download a backup before closing.')+' Planning now uses '+snapshot.sourceName+'. Refresh when your calendar changes.';
      if(previousProvider&&previousProvider!==provider)try{await connector.disconnect(previousProvider);}catch(_){error('calendar-connection-error','The new events were saved. Clear the previous provider permission in its account settings if needed.');}
      renderAll();
    }catch(problem){ui.accountMessage='The account update did not complete. Your previously saved calendar events and tasks were kept.';error('calendar-connection-error',problem.message||'Calendar access could not be completed.');}
    finally{ui.accountBusy=false;renderCalendar();}
  }
  function renderCalendar(){
    renderCalendarConnection();const calendar=state.calendar,events=$('calendar-events');events.replaceChildren();$('calendar-remove').disabled=!calendar||ui.accountBusy;$('calendar-file').disabled=ui.calendarImportBusy||ui.accountBusy;
    if(!calendar){$('calendar-status').textContent='No calendar snapshot saved. Tidy cannot see your phone’s calendar directly.';$('calendar-window').textContent='Connect an account or import a file to include its commitments in planning.';empty(events,'Your saved calendar events will appear here.');return;}
    $('calendar-status').textContent=calendar.events.length+' saved commitments from '+calendar.sourceName+'. '+(ui.saveFailed||ui.storageLocked?'Kept in this tab only; download a backup before closing.':'Saved snapshot on this browser. Refresh the account or re-import the file when events change.');
    $('calendar-window').textContent='Snapshot covers '+readableTime(calendar.windowStart)+' to '+readableTime(calendar.windowEnd)+'. Last imported '+readableTime(calendar.importedAt)+'. '+calendar.warnings.join(' ');
    for(const event of calendar.events.slice().sort((a,b)=>a.startAt-b.startAt))events.append(calendarEventCard(event));
    if(!calendar.events.length)empty(events,'No busy commitments occur in this imported date range.');
  }
  async function importCalendar(event){
    const file=event.target.files?.[0];if(!file||ui.calendarImportBusy||ui.accountBusy)return;ui.calendarImportBusy=true;error('calendar-error','');renderCalendar();
    try{
      refreshSavedData();const baseline=copy(state.calendar??null);
      if(file.size>1024*1024)throw Error('Choose a calendar file smaller than 1 MiB.');
      const imported=CAL.parseICS(await file.text(),{now:Date.now(),horizonDays:60,timeZone:'Asia/Dubai'});
      refreshSavedData();if(!same(baseline,state.calendar??null))throw Error('Another tab changed the imported calendar. Your current calendar was kept; review it before importing again.');
      const candidate=C.validateSnapshot({...state,calendar:{...imported,sourceName:file.name.slice(0,120)||'Calendar.ics'}});
      if(state.calendar&&!confirm('Replace the imported calendar snapshot with '+candidate.calendar.events.length+' commitments from this file? Your Tidy tasks will stay in place.'))return;
      state=candidate;const saved=save();if(ui.accountProvider)await disconnectCalendarAccount();ui.accountMessage='';renderAll();toast(saved?'Calendar snapshot imported':'Calendar kept in this tab only; download a backup');
    }catch(problem){error('calendar-error',problem.message+' The previous calendar and tasks were kept.');}
    finally{ui.calendarImportBusy=false;event.target.value='';renderCalendar();}
  }
  function exportCalendar(){
    error('calendar-error','');try{
      refreshSavedData();const now=Date.now(),today=C.today(now),items=[];
      for(let offset=0;offset<7;offset++){
        const date=C.addDays(today,offset);
        for(const task of state.tasks.filter(task=>task.status==='open'&&planningTaskOccurs(task,date)))items.push({...task,id:task.id+'-'+date,dueDate:date});
      }
      if(!items.length)throw Error('Save a task or appointment with a date and time in the next seven days first.');
      download('Tidy-next-7-days-'+today+'.ics',CAL.exportICS(items,{now,timeZone:'Asia/Dubai',durationMinutes:30}),'text/calendar;charset=utf-8');toast('Next seven days downloaded. Review and import the file in your calendar app.');
    }catch(problem){error('calendar-error',problem.message);}
  }
  function planningTaskOccurs(task,date){
    if(!task.dueDate||!task.dueTime)return false;
    if(task.dueDate===date)return true;if(task.dueDate>date||task.repeat==='none')return false;
    const day=new Date(date+'T12:00:00Z').getUTCDay();return task.repeat==='daily'||task.repeat==='weekdays'&&day>0&&day<6||task.repeat==='weekly'&&day===new Date(task.dueDate+'T12:00:00Z').getUTCDay();
  }
  function renderDayPlan(){
    const date=$('planning-date').value||C.today();if(!$('planning-date').value)$('planning-date').value=date;
    const items=$('planning-items'),pending=$('planning-unscheduled');items.replaceChildren();pending.replaceChildren();
    let start;try{start=C.dueEpoch(date,'00:00');}catch(_){$('planning-summary').textContent='Choose a valid date to see your plan.';return;}
    const scheduled=state.tasks.filter(task=>task.status==='open'&&planningTaskOccurs(task,date)),events=(state.calendar?.events||[]).filter(event=>event.startAt<start+86400000&&event.endAt>start),untimed=state.tasks.filter(task=>task.status==='open'&&task.type==='task'&&!task.dueTime&&(!task.dueDate||task.dueDate<=date));
    $('planning-summary').textContent=prettyDate(date)+': '+scheduled.length+' task slots, '+events.length+' imported calendar commitments; '+untimed.length+' tasks still need a time. '+(planningProfile().enabled?'Planning uses your confirmed hours.':'Confirm your usual hours to let Tidy plan for you.')+' '+(state.calendar?calendarCoverage(date):'No external calendar imported; only Tidy items and your routine are checked.');
    const rows=[...scheduled.map(task=>({at:C.dueEpoch(date,task.dueTime),task})),...events.map(event=>({at:event.startAt,event}))].sort((a,b)=>a.at-b.at);
    for(const row of rows){
      if(row.event)items.append(calendarEventCard(row.event));
      else if(row.task.dueDate===date)items.append(taskCard(row.task));
      else {const card=el('article',undefined,'task-row');card.append(el('div',row.task.title,'task-title'),el('div',row.task.dueTime+' · repeating responsibility','task-time'),button('Review routine',()=>showView('routines')));items.append(card);}
    }
    if(!rows.length)empty(items,'No timed items saved for this day.');
    for(const task of sorted(untimed)){const card=taskCard(task);if(ui.planResults.has(task.id))card.append(el('p',ui.planResults.get(task.id),'helper'));pending.append(card);}
    if(!untimed.length)empty(pending,'Every task in this view has a time.');
  }
  function proposeLocalTask(draft){
    const result=P.proposeTask(draft,{now:Date.now(),profile:planningProfile(),tasks:state.tasks,events:state.calendar?.events||[]});
    if(result.ok){const coverage=calendarSlotCoverage(result);if(coverage)return {ok:false,code:'calendar_outdated',reason:coverage};}
    return result;
  }
  async function organiseDay(){
    if(ui.captureBusy)return;
    if(!planningProfile().enabled){showView('planning-settings');toast('Confirm your usual hours and enable planning first.');return;}
    ui.captureBusy=true;$('planning-run').disabled=true;document.querySelector('#capture-form button[type="submit"]').disabled=true;startActivity();ui.activity.reply='Of course—I’m checking your saved commitments and finding room for your tasks.';renderActivity();
    try{
      await paintActivity();refreshSavedData();const date=$('planning-date').value||C.today();C.dueEpoch(date,'00:00');const coverage=calendarCoverage(date);if(coverage)throw Error(coverage);
      const candidate=C.validateSnapshot(state);let count=0;ui.planResults.clear();
      for(const task of candidate.tasks.filter(task=>task.status==='open'&&task.type==='task'&&!task.dueTime&&(!task.dueDate||task.dueDate===date))){
        const proposal=P.proposeTask({...task,dueDate:date},{now:Date.now(),profile:planningProfile(),tasks:candidate.tasks,events:candidate.calendar?.events||[]});
        if(!proposal.ok){ui.planResults.set(task.id,proposal.reason);continue;}
        const slotCoverage=calendarSlotCoverage(proposal);if(slotCoverage){ui.planResults.set(task.id,slotCoverage);continue;}
        C.updateTask(candidate,task.id,{dueDate:proposal.date,dueTime:proposal.time,remindAt:C.dueEpoch(proposal.date,proposal.time),durationMinutes:proposal.durationMinutes,planningReason:proposal.reason});count++;
      }
      let saved=true;if(count){state=candidate;saved=save();}renderAll();
      ui.activity.status=saved?'done':'error';ui.activity.title=count?'Your day plan is ready':'Your day needs a little attention';ui.activity.reply=saved?'I’ve scheduled '+count+' flexible tasks for '+prettyDate(date)+'. '+(ui.planResults.size?ui.planResults.size+' tasks could not fit and are still waiting for a time. ':'')+'Fixed appointments stayed in place. Keep Tidy open for reminders.':'I planned '+count+' tasks in this tab, but could not save them. Please download a backup before closing.';
      ui.activity.message='Based on confirmed family hours, saved Tidy items'+(state.calendar?' and the imported calendar snapshot.':'. No external calendar is connected.');ui.activity.resume=()=>showView('planning');ui.activity.resumeLabel='Show my day plan';activityStep(0,'done');activityStep(1,saved?'done':'error',saved?'Checked and saved your plan':'Local saving failed');activityStep(2,'done','Opened your day plan');showView('planning');renderActivity();
    }catch(problem){ui.activity.status='error';ui.activity.title='Your plan needs attention';ui.activity.reply='I couldn’t organise that day. '+problem.message;ui.activity.message='Your existing tasks and commitments have not been rescheduled.';renderActivity();}
    finally{ui.captureBusy=false;$('planning-run').disabled=false;document.querySelector('#capture-form button[type="submit"]').disabled=false;renderActivity();}
  }
  function rememberWelcome(choice){ui.welcomeChoice=choice;try{window.localStorage.setItem(WELCOME_KEY,choice);}catch(_){};}
  function showCalendarWelcome(){
    try{if(window.localStorage.getItem(WELCOME_KEY))return;}catch(_){}
    $('calendar-onboarding-dialog').showModal();
  }
  function mealValues(type){return Object.fromEntries(MEAL_DAYS.map(day=>[day,state.mealPlans?.[type]?.[day]||'']));}
  function selectMealSlide(type,focus=false){
    if(!MEAL_SLIDES.includes(type))return;ui.mealSlide=type;
    for(const kind of MEAL_SLIDES){const selected=kind===type,tab=$('meal-tab-'+kind);$('meal-slide-'+kind).hidden=!selected;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
    const index=MEAL_SLIDES.indexOf(type);$('meal-previous').disabled=index===0;$('meal-next').disabled=index===MEAL_SLIDES.length-1;
    $('meal-slide-status').textContent=type[0].toUpperCase()+type.slice(1)+' · '+(index+1)+' of '+MEAL_SLIDES.length;
    if(ui.view==='meals')history.replaceState(null,'','#meals/'+type);
    if(focus)$('meal-tab-'+type).focus();
  }
  function renderMealPlans(){
    for(const type of ['breakfast','lunch']){
      const values=mealValues(type);
      if(!ui.mealEdits[type]){for(const day of MEAL_DAYS)$(type+'-'+day.toLowerCase()).value=values[day];ui.mealBaselines[type]=copy(values);}
      $(type+'-status').textContent=ui.saveFailed||ui.storageLocked?'Local saving needs attention. Download a backup before closing.':ui.mealStatuses[type]||(Object.values(values).some(Boolean)?'Your weekday choices are saved on this browser.':'Type your choices for the weekdays you want to plan.');
    }
    selectMealSlide(ui.mealSlide);
  }
  function beginMealPlanEdit(type){if(!ui.mealEdits[type])ui.mealEdits[type]={baseline:copy(ui.mealBaselines[type]||mealValues(type))};}
  function saveMealPlan(event,type){
    event.preventDefault();error(type+'-error','');
    try{
      refreshSavedData();const draft=Object.fromEntries(MEAL_DAYS.map(day=>[day,$(type+'-'+day.toLowerCase()).value]));
      const merged=mergeFields(ui.mealEdits[type]?.baseline||ui.mealBaselines[type]||mealValues(type),mealValues(type),draft,MEAL_DAYS);
      C.updateMealPlan(state,type,merged);const saved=save();
      if(saved){ui.mealEdits[type]=null;ui.mealStatuses[type]=type[0].toUpperCase()+type.slice(1)+' plan saved on this browser.';}
      else {ui.mealEdits[type]={baseline:copy(mealValues(type))};ui.mealStatuses[type]='Not saved locally. Your choices remain in this tab; download a backup before closing.';}
      renderAll();
    }catch(problem){beginMealPlanEdit(type);error(type+'-error',problem.message);ui.mealStatuses[type]='Your entered choices have not replaced the saved plan.';renderMealPlans();}
  }
  function response(message){$('assistant-response').textContent=message;$('assistant-response').hidden=false;$('assistant-followup').replaceChildren();}
  function renderActivity(){
    const activity=ui.activity;$('assistant-activity').hidden=!activity||activity.dismissed||ui.view!=='assistant'&&ui.view!==activity.view;if(!activity)return;
    $('assistant-activity').dataset.status=activity.status;$('assistant-activity-title').textContent=activity.title;$('assistant-activity-message').textContent=activity.message;$('assistant-activity-reply').textContent=activity.reply;
    const steps=$('assistant-activity-steps');steps.replaceChildren();
    for(const step of activity.steps){const item=el('li',(step.status==='done'?'✓ ':step.status==='error'?'! ':'')+step.label,'activity-step');item.dataset.status=step.status;steps.append(item);}
    $('assistant-activity-open').hidden=!activity.target&&!activity.resume;$('assistant-activity-open').textContent=activity.resume?(activity.resumeLabel||'Continue with the details'):'Show me the result';$('assistant-activity-open').disabled=ui.captureBusy;
    $('assistant-activity-edit').hidden=activity.target?.kind!=='task';$('assistant-activity-edit').disabled=ui.captureBusy;
    $('assistant-activity-undo').hidden=!ui.undoCapture;$('assistant-activity-undo').disabled=ui.captureBusy;
    $('assistant-activity-dismiss').disabled=ui.captureBusy;
  }
  function startActivity(){ui.undoCapture=null;ui.activity={view:ui.view,status:'working',title:'Working on your request',reply:'Of course—give me a moment to check your request.',message:'Checking what you asked Tidy to do.',steps:[{label:'Understand your request',status:'working'},{label:'Save the result',status:'pending'},{label:'Show you the result',status:'pending'}],target:null,resume:null,dismissed:false};renderActivity();$('assistant-activity').scrollIntoView({block:'start',behavior:'instant'});}
  function activityStep(index,status,label){const step=ui.activity.steps[index];step.status=status;if(label)step.label=label;renderActivity();}
  function paintActivity(){return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
  function destination(task){return task.type==='appointment'?'appointments':task.type==='grocery'?'shopping':task.planningReason&&task.dueDate&&task.dueTime?'planning':task.remindAt!==null?'reminders':'family';}
  function readableTime(epoch){return new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Asia/Dubai'}).format(new Date(epoch))+' Dubai time';}
  function taskReply(task,saved,existing){
    const title='“'+task.title+'”';
    if(!saved)return 'I couldn’t save '+title+' on this browser. I’ve kept it in this tab; please download a backup before closing.';
    let reply;
    if(task.type==='grocery')reply=existing?title+' is already on your shopping list. I’ve opened it for you.':'Of course—I’ve added '+title+' to your shopping list and opened it for you.';
    else if(task.type==='appointment')reply='I’ve added '+title+' to your appointments for '+prettyDate(task.dueDate)+' at '+task.dueTime+' Dubai time. Please confirm the booking separately with the provider.';
    else if(task.planningReason)reply='I’ve found time for '+title+'. '+task.planningReason;
    else if(task.remindAt!==null)reply='All set—I’ve saved your reminder for '+title+'.';
    else reply='Of course—I’ve added '+title+' to your tasks and opened them for you.';
    if(task.remindAt!==null)reply+=' '+(state.settings.remindersPaused?'Your reminder is set for '+readableTime(task.remindAt)+', but alerts are paused. Open reminder settings to resume them.':'I’ll remind you at '+readableTime(task.remindAt)+'. Keep Tidy open for the alert.');
    if(task.type==='grocery')reply+=' No order has been placed.';
    return reply;
  }
  function revealActivityTarget(focusCard=false){
    const target=ui.activity?.target;if(!target)return;
    const item=state[target.kind==='action'?'actions':'tasks'].find(item=>item.id===target.id);
    if(!item){toast('This item is no longer in Tidy.');return;}
    ui.highlightTaskId=target.kind==='task'?item.id:null;ui.highlightActionId=target.kind==='action'?item.id:null;
    const view=target.kind==='action'?(item.kind==='booking'?'appointments':'requests'):destination(item);
    if(view==='planning')$('planning-date').value=item.dueDate;
    if(view==='family'){$('task-search').value='';$('category-filter').value='all';$('person-filter').value='all';$('status-filter').value='all';}
    showView(view);
    if(focusCard){const card=[...$('view-'+view).querySelectorAll(target.kind==='action'?'[data-action-id]':'[data-task-id]')].find(card=>(target.kind==='action'?card.dataset.actionId:card.dataset.taskId)===item.id);if(card){card.focus({preventScroll:true});card.scrollIntoView({block:'center',behavior:'instant'});}}
  }
  function finishTaskActivity(task,saved,existing=false){
    if(ui.undoCapture?.id===task.id&&!same(ui.undoCapture.baseline,task))ui.undoCapture=null;
    const reminder=task.remindAt!==null,appointment=task.type==='appointment';
    ui.activity.view=destination(task);ui.activity.target={kind:'task',id:task.id};ui.activity.resume=null;ui.activity.resumeLabel=null;
    ui.activity.status=saved?'done':'error';
    ui.activity.reply=taskReply(task,saved,existing);
    ui.activity.title=!saved?'Not saved on this browser':existing?'Already on your shopping list':appointment?'Appointment added to your plan':reminder?'Reminder set':task.type==='grocery'?'Added to your shopping list':'Task added';
    let message=task.title+'. ';
    if(reminder)message+='Reminder: '+readableTime(task.remindAt)+'. '+(state.settings.remindersPaused?'Alerts are paused; open reminder settings to resume them.':'Keep Tidy open for this alert.');
    else if(appointment)message+=prettyDate(task.dueDate)+' at '+task.dueTime+' Dubai time. This is your local record; Tidy has not booked or confirmed it with a provider.';
    else if(task.type==='grocery')message+='Your list is ready to review. No order has been placed.';
    else message+='Saved in your responsibilities.';
    if(!saved)message+=' This change is kept in this tab only. Download a backup before closing.';
    const assumption=(ui.activity.assumptions||[]).join(' ');if(assumption)ui.activity.reply+=' '+assumption;
    ui.activity.message=message+(task.planningReason?' '+task.planningReason:'')+(assumption?' '+assumption:'');activityStep(0,'done');activityStep(1,saved?'done':'error',existing?'Found your existing item':saved?'Saved on this browser':'Local saving failed');activityStep(2,'done','Opened your '+({appointments:'appointments',reminders:'reminders',shopping:'shopping list',family:'responsibilities',planning:'day plan'})[destination(task)]);
    response(message);revealActivityTarget();renderActivity();
  }
  function clarificationOptions(text){return {text,now:Date.now(),members:state.members,tasks:state.tasks,planningEnabled:planningProfile().enabled,efficientMode:true};}
  function showQuickQuestion(invalidAnswer=false){
    const pending=ui.pendingCapture;if(!pending)return;
    const plan=A.planClarification(pending.result,clarificationOptions(pending.text));
    if(plan.advanced){openCaptureDetails();return;}
    $('assistant-clarify-question').textContent=plan.question;
    $('assistant-clarify-context').textContent=pending.result.draft?.title?'For “'+pending.result.draft.title+'”. I’ve kept the details you already gave me.':'I’ve kept the details you already gave me.';
    $('assistant-clarify-answer').value='';error('assistant-clarify-error',invalidAnswer?pending.result.message:'');
    $('assistant-clarify-status').textContent=pending.result.notice||(/already passed/.test(pending.result.message)?'That time has already passed in Dubai. Please choose a future date and time.':'Nothing new is saved until the missing details are clear.');
    const choices=$('assistant-clarify-choices');choices.replaceChildren();
    for(const choice of plan.choices)choices.append(button(choice.label,()=>void answerQuickQuestion(choice.patch)));
    ui.activity.reply=plan.question;ui.activity.message=pending.result.message;response(plan.question);renderActivity();
    if(!$('assistant-clarify-dialog').open)$('assistant-clarify-dialog').showModal();
    (choices.querySelector('button')||$('assistant-clarify-answer')).focus();
  }
  function openCaptureDetails(){
    const pending=ui.pendingCapture;if(!pending)return;
    ui.pendingCapture=null;$('assistant-clarify-dialog').close();
    const resume=()=>openTask(pending.result.draft||{},null,pending.result.message,pending.result.reminderRequested===true,pending);
    ui.activity.resume=resume;ui.activity.resumeLabel='Review details';resume();renderActivity();
  }
  async function answerQuickQuestion(answer){
    if(ui.captureBusy||!ui.pendingCapture)return;
    if(refreshSavedData())renderAll();
    const pending=ui.pendingCapture,result=A.resolveClarification(pending.result,answer,clarificationOptions(pending.text));
    if(result.kind==='clarify'){pending.result=result;ui.lastDraft=result.draft;showQuickQuestion(true);return;}
    ui.pendingCapture=null;$('assistant-clarify-dialog').close();await capture(pending.text,result);
  }
  function cancelQuickQuestion(){
    if(!ui.pendingCapture)return;ui.pendingCapture=null;
    ui.activity.status='waiting';ui.activity.title='Request cancelled';ui.activity.reply='Okay—I haven’t saved anything new.';ui.activity.message='Nothing new was saved. You can start another request whenever you are ready.';ui.activity.resume=null;ui.activity.resumeLabel=null;
    response(ui.activity.message);renderActivity();
  }
  function undoAssistantTask(){
    if(ui.captureBusy||!ui.undoCapture)return;
    try{
      if(refreshSavedData())renderAll();const receipt=ui.undoCapture,current=state.tasks.find(task=>task.id===receipt.id);
      if(!current||!same(current,receipt.baseline))throw Error('This item changed after I added it. I kept the latest version; use Edit details to review it.');
      if(ui.storageLocked||ui.mealConflict)throw Error('Undo could not be saved safely. Your item is kept; download a backup before changing it.');
      const previous=C.validateSnapshot(state);C.deleteTask(state,receipt.id);
      if(!save()){state=previous;renderAll();throw Error('Undo could not be saved. Your item is kept in this tab; download a backup before closing.');}
      ui.undoCapture=null;ui.activity.target=null;ui.activity.status='done';ui.activity.title='Undone';ui.activity.reply='I’ve removed the item I just added.';ui.activity.message='Removed “'+receipt.baseline.title+'”.';ui.activity.steps=[{label:'Removed the new item',status:'done'}];response(ui.activity.message);renderAll();renderActivity();
    }catch(problem){ui.undoCapture=null;ui.activity.reply=problem.message;ui.activity.message=problem.message;response(problem.message);renderActivity();}
  }
  function waitForTaskDetails(text,result){
    const draft=result.draft||{title:text,category:'Home'},flow={text,result};ui.lastDraft=draft;
    const question=A.planClarification(result,clarificationOptions(text));
    if(!question.advanced){
      ui.pendingCapture=flow;ui.activity.status='waiting';ui.activity.title='One quick question';activityStep(0,'done');activityStep(1,'working','Waiting for one answer');
      ui.activity.resume=()=>showQuickQuestion();ui.activity.resumeLabel='Answer one question';showView('assistant');showQuickQuestion();return;
    }
    ui.activity.status='waiting';ui.activity.title='A little more information';ui.activity.reply='I can help, but I need a little more detail before I save anything. Please check the details below.';ui.activity.message=result.message;activityStep(0,'done');activityStep(1,'working','Waiting for your details');
    const resume=()=>openTask(draft,null,result.message,result.reminderRequested===true,flow);ui.activity.resume=resume;
    $('assistant-followup').append(button('Fill in the missing details',resume,'button'));
    if(result.reminderRequested||result.appointmentRequested||draft.type==='appointment'){ui.activity.view=draft.type==='appointment'?'appointments':'reminders';showView(ui.activity.view);resume();}
    renderActivity();
  }
  async function capture(text,suppliedResult=null){
    if(ui.captureBusy)return;ui.pendingCapture=null;$('assistant-clarify-dialog').close();ui.captureBusy=true;document.querySelector('#capture-form button[type="submit"]').disabled=true;$('capture-form').setAttribute('aria-busy','true');startActivity();
    try{
      await paintActivity();if(refreshSavedData())renderAll();
      const result=suppliedResult||A.parse(text,clarificationOptions(text));ui.activity.assumptions=result.assumptions||[];response(result.message);activityStep(0,'done');
      if(result.kind==='answer'){ui.activity.view='today';ui.activity.status='done';ui.activity.title='Here is your day';ui.activity.reply='Here’s what I found in Tidy. '+result.message;ui.activity.message=result.message;activityStep(1,'done','Read your saved responsibilities');showView('today');activityStep(2,'done','Opened Today');return;}
      if(result.kind==='clarify'){waitForTaskDetails(text,result);return;}
      ui.activity.reply=result.kind==='action'?'Of course—I’m preparing a draft for you to review.':result.kind==='grocery'?'Of course—I’m checking your shopping list for “'+result.draft.title+'”.':result.draft.type==='appointment'?'Of course—I’m adding that appointment to your plan.':result.draft.remindAt!==null?'Of course—I’m setting up your reminder.':'Of course—I’m adding that to your tasks.';
      activityStep(1,'working',result.kind==='action'?'Preparing your draft':'Saving your item');await paintActivity();
      if(refreshSavedData())renderAll();
      if(result.kind==='action'){
        const action={id:id('request'),kind:result.action.kind,title:result.action.title,details:result.action.details||'',provider:'',link:'',status:'needs_review',createdAt:Date.now()};
        state=C.validateSnapshot({...state,actions:[...state.actions,action]});const saved=save();renderAll();
        ui.activity.view=action.kind==='booking'?'appointments':'requests';ui.activity.target={kind:'action',id:action.id};ui.activity.status=saved?'done':'error';ui.activity.title=saved?(action.kind==='booking'?'Appointment request ready for review':'Draft ready for review'):'Draft kept in this tab only';
        ui.activity.message='Prepared: '+action.title+'. '+(saved?'Saved on this browser.':'Not saved locally; download a backup before closing.')+' Your approval is needed. Nothing has been booked, purchased or sent.';
        ui.activity.reply=saved?'I’ve prepared your '+(action.kind==='booking'?'appointment':action.kind==='purchase'?'purchase':'message')+' request for review. Nothing has been booked, purchased or sent.':'I’ve prepared your request in this tab, but I couldn’t save it. Please download a backup before closing. Nothing has been booked, purchased or sent.';
        activityStep(1,saved?'done':'error',saved?'Saved a draft for review':'Local saving failed');revealActivityTarget();activityStep(2,'done',action.kind==='booking'?'Opened appointment requests':'Opened your requests');response(ui.activity.message);$('assistant-followup').append(button('Review draft',()=>openAction(action,action.id)));return;
      }
      const draft=result.draft;
      let planningProblem='';
      if(result.autoPlanRequested){
        const proposal=proposeLocalTask(draft);
        if(proposal.ok)Object.assign(draft,{dueDate:proposal.date,dueTime:proposal.time,remindAt:C.dueEpoch(proposal.date,proposal.time),durationMinutes:proposal.durationMinutes,planningReason:proposal.reason});
        else {
          planningProblem=proposal.reason;
          if(result.reminderRequested){waitForTaskDetails(text,{...result,kind:'clarify',autoPlanRequested:false,draft:{...draft,remindAt:null},missing:['dueDate','dueTime'],clarificationContext:{safe:true,ambiguousHour:null,clockRequested:false,autoPlanEligible:false},notice:'I couldn’t choose a suitable time: '+planningProblem,message:'I couldn’t choose a suitable time: '+planningProblem+' Choose a reminder date and time instead.'});return;}
        }
      }
      if(result.kind==='grocery'){
        const existing=state.tasks.find(task=>task.status==='open'&&task.type==='grocery'&&task.title.toLocaleLowerCase()===draft.title.toLocaleLowerCase());
        if(existing){
          const reminderPatch=draft.remindAt!==null?{dueDate:draft.dueDate,dueTime:draft.dueTime,remindAt:draft.remindAt}:{};
          if(existing.quantity&&draft.quantity&&existing.quantity!==draft.quantity){
            finishTaskActivity(existing,!ui.saveFailed&&!ui.storageLocked,true);ui.activity.status='waiting';ui.activity.reply='“'+existing.title+'” is already on your list with a different quantity. Please review the amount before I change it.';ui.activity.message='This item already has a different quantity. Review it before changing the amount.';ui.activity.resume=()=>openTask({...existing,...reminderPatch,quantity:draft.quantity},existing.id,ui.activity.message,draft.remindAt!==null,{text,result});response(ui.activity.message);$('assistant-followup').append(button('Review item',ui.activity.resume));renderActivity();
          }else if(draft.remindAt!==null||!existing.quantity&&draft.quantity){const updated=C.updateTask(state,existing.id,{...reminderPatch,...(!existing.quantity&&draft.quantity?{quantity:draft.quantity}:{})}),saved=save();renderAll();finishTaskActivity(updated,saved,true);}
          else finishTaskActivity(existing,!ui.saveFailed&&!ui.storageLocked,true);
          return;
        }
      }
      const created=C.createTask(state,draft);const saved=save();ui.undoCapture={id:created.id,baseline:copy(created)};renderAll();finishTaskActivity(created,saved);
      if(planningProblem){ui.planResults.set(created.id,planningProblem);ui.activity.reply+=' I couldn’t choose a suitable time: '+planningProblem;ui.activity.message+=' '+planningProblem;renderActivity();}
      else if(result.flexibleTaskRequested&&!planningProfile().enabled){ui.activity.reply+=' To choose a suitable time for you, I need your usual family hours first.';ui.activity.resume=()=>showView('planning-settings');ui.activity.resumeLabel='Set up family hours';renderActivity();}
      $('assistant-followup').append(button('Edit or assign',()=>openTask(created,created.id)));
    }catch(problem){ui.activity.status='error';ui.activity.title='This request could not be completed';ui.activity.reply='I couldn’t finish that request. Please check the details and try again.';ui.activity.message=problem.message+' Check the details and try again.';const step=ui.activity.steps.find(step=>step.status==='working');if(step)step.status='error';response(ui.activity.message);renderActivity();}
    finally{ui.captureBusy=false;document.querySelector('#capture-form button[type="submit"]').disabled=false;$('capture-form').removeAttribute('aria-busy');renderActivity();}
  }
  function quickTaskChoices(flow){
    const target=$('task-assistant-choices');target.replaceChildren();target.hidden=!flow;if(!flow)return;
    target.append(el('p','Choose any missing date and time. All times are Dubai time.','helper'));
    const sync=()=>{if($('task-reminder').checked&&$('task-date').value&&$('task-time').value)$('task-reminder-at').value=$('task-date').value+'T'+$('task-time').value;};
    if(!$('task-date').value)for(const [label,offset] of [['Today',0],['Tomorrow',1]])target.append(button(label,()=>{$('task-date').value=C.addDays(C.today(),offset);sync();}));
    const clock=flow.text.match(/\bat\s+(\d{1,2})(?:\s*o['’]?clock)?(?=\s|[.,!?]|$)/i),hour=Number(clock?.[1]);
    if(!$('task-time').value&&hour>=1&&hour<=12)for(const [label,clockHour] of [[hour+' am',hour%12],[hour+' pm',hour%12+12]])target.append(button(label,()=>{$('task-time').value=String(clockHour).padStart(2,'0')+':00';sync();}));
  }
  function cancelTaskCapture(){if(!ui.taskCapture)return;ui.taskCapture=null;ui.activity.status='waiting';ui.activity.title='Details have not been saved';ui.activity.reply='That’s okay—I haven’t saved anything new. You can continue with the details when you’re ready.';ui.activity.message='Nothing new has been saved. Continue with the details when you are ready.';renderActivity();}
  function openTask(draft={},editingId=null,message='',requestReminder=false,flow=null){
    ui.taskCapture=flow;
    ui.editingTask=editingId;ui.taskBaseline=editingId?copy(state.tasks.find(task=>task.id===editingId)||null):null;error('task-error','');$('task-dialog-title').textContent=editingId?'Edit task':'Add a task';$('task-draft-message').textContent=message;
    populatePeople($('task-person'),'Unassigned','');
    $('task-title').value=draft.title||'';$('task-type').value=draft.type||'task';$('task-category').value=draft.category||'Home';$('task-person').value=draft.assigneeId||'';$('task-priority').value=draft.priority||'normal';$('task-date').value=draft.dueDate||'';$('task-time').value=draft.dueTime||'';$('task-repeat').value=draft.repeat||'none';$('task-quantity').value=draft.quantity||'';$('task-notes').value=draft.notes||'';$('task-link').value=draft.link||'';
    $('task-reminder').checked=draft.remindAt!==null&&draft.remindAt!==undefined||requestReminder;
    $('task-reminder-at').value=draft.remindAt!==null&&draft.remindAt!==undefined?clockValue(draft.remindAt):draft.dueDate&&draft.dueTime&&requestReminder?draft.dueDate+'T'+draft.dueTime:'';
    if(flow){$('task-dialog-title').textContent=draft.type==='appointment'?'Finish your appointment':requestReminder?'Set your reminder':'Finish the details';}
    $('save-task').textContent=flow?(draft.type==='appointment'?'Save appointment':requestReminder?'Set reminder':'Save task'):'Save task';
    quickTaskChoices(flow);syncTaskControls();$('task-dialog').showModal();$('task-title').focus();
  }
  function syncTaskControls(){
    $('quantity-label').hidden=$('task-type').value!=='grocery';$('reminder-at-label').hidden=!$('task-reminder').checked;
    $('task-date').required=$('task-type').value==='appointment'||$('task-repeat').value!=='none';$('task-time').required=$('task-type').value==='appointment';$('task-reminder-at').required=$('task-reminder').checked;
  }
  function saveTask(event){
    event.preventDefault();error('task-error','');
    try{
      refreshSavedData();
      let remindAt=null;
      if($('task-reminder').checked){const parts=$('task-reminder-at').value.split('T');if(parts.length!==2)throw Error('Choose a reminder date and time.');remindAt=C.dueEpoch(parts[0],parts[1]);}
      let patch={title:$('task-title').value,category:$('task-category').value,assigneeId:$('task-person').value||null,type:$('task-type').value,priority:$('task-priority').value,dueDate:$('task-date').value,dueTime:$('task-time').value,repeat:$('task-repeat').value,quantity:$('task-quantity').value,notes:$('task-notes').value,link:$('task-link').value,remindAt};
      if(ui.taskCapture&&remindAt!==null&&!patch.dueDate){const when=clockValue(remindAt).split('T');patch.dueDate=when[0];patch.dueTime=when[1];}
      const old=state.tasks.find(task=>task.id===ui.editingTask);
      if(ui.editingTask)patch=mergeFields(ui.taskBaseline,old,patch,Object.keys(patch));
      if(patch.remindAt!==null&&patch.remindAt<=Date.now()&&patch.remindAt!==old?.remindAt)throw Error('Choose a reminder time in the future.');
      const task=ui.editingTask?C.updateTask(state,ui.editingTask,patch):C.createTask(state,patch);const saved=save(),flow=ui.taskCapture;ui.taskCapture=null;$('task-dialog').close();renderAll();toast('Saved '+task.title+(saved?'':' · in this tab only'));if(flow||ui.activity?.target?.kind==='task'&&ui.activity.target.id===task.id)finishTaskActivity(task,saved);checkReminders();
    }catch(problem){error('task-error',problem.message);}
  }
  function openAction(action={},editingId=null){ui.editingAction=editingId;ui.actionBaseline=editingId?copy(state.actions.find(item=>item.id===editingId)||null):null;error('action-error','');$('action-title').value=action.title||'';$('action-kind').value=action.kind||'purchase';$('action-provider').value=action.provider||'';$('action-link').value=action.link||'';$('action-details').value=action.details||'';$('action-dialog').showModal();}
  function saveAction(event){
    event.preventDefault();error('action-error','');
    try{
      refreshSavedData();const old=state.actions.find(action=>action.id===ui.editingAction);
      let draft={kind:$('action-kind').value,title:$('action-title').value,provider:$('action-provider').value,link:$('action-link').value,details:$('action-details').value};
      if(ui.editingAction){draft=mergeFields(ui.actionBaseline,old,draft,Object.keys(draft));if(old.status!==ui.actionBaseline.status)throw Error('This request changed its approval status in another tab. Your edits are still in this form; review the current request.');}
      const action={...draft,id:old?.id||id('request'),status:'needs_review',createdAt:old?.createdAt??Date.now()};
      const candidate=C.validateSnapshot({...state,actions:old?state.actions.map(item=>item.id===old.id?action:item):[...state.actions,action]});state=candidate;const saved=save();$('action-dialog').close();renderAll();toast('Draft saved for review'+(saved?'':' · in this tab only'));
    }catch(problem){error('action-error',problem.message);}
  }
  function openMember(member=null){ui.editingMember=member?.id||null;ui.memberBaseline=member?copy(member):null;$('member-name').value=member?.name||'';error('member-error','');$('member-dialog').showModal();}
  function saveMember(event){
    event.preventDefault();error('member-error','');
    try{
      refreshSavedData();let member={id:ui.editingMember||id('person'),name:$('member-name').value.trim()};
      if(ui.editingMember){
        const previous=state.members.find(old=>old.id===member.id);member={...member,...mergeFields(ui.memberBaseline,previous,member,['name'])};const key=member.name.toLocaleLowerCase();
        if(key!==previous?.name.trim().toLocaleLowerCase()&&state.members.some(old=>old.id!==member.id&&old.name.trim().toLocaleLowerCase()===key))throw Error('That household name already exists. Use a different name so assignments stay clear.');
        state=C.validateSnapshot({...state,members:state.members.map(old=>old.id===member.id?member:old)});
      }else C.createMember(state,member);
      const saved=save();$('member-dialog').close();renderAll();toast(saved?'Household name saved':'Household name kept in this tab; download a backup');
    }catch(problem){error('member-error',problem.message);}
  }
  function showSettings(){ui.settingsBaseline=copy(state.settings);error('backup-error','');$('checkin-enabled').checked=state.settings.checkinEnabled;$('checkin-time').value=state.settings.checkinTime;$('alerts-paused').checked=state.settings.remindersPaused;$('export-recovery').hidden=ui.recoveryText===null;updateBrowserStatus();$('settings-dialog').showModal();}
  function updateBrowserStatus(){const permission=window.Notification?.permission;$('browser-alert-status').textContent=!window.Notification?'Browser notifications are unavailable here; in-page alerts still work.':permission==='granted'?'Browser notifications are permitted while this demo is running.':permission==='denied'?'Browser notifications are blocked; in-page alerts still work.':'No notification permission requested. In-page alerts work while open.';$('enable-browser-alerts').disabled=!window.Notification||permission==='denied'||permission==='granted';}
  function checkReminders(){
    try{
      if(refreshSavedData())renderAll();
      const due=C.dueReminders(state,Date.now()).filter(task=>!ui.unsavedDeliveries.has(task.id+':'+task.remindAt));let checkin=false,deliveryWarning=false;const date=C.today();
      if(ui.todayDate!==date)renderAll();
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
    $('website-choice').hidden=true;$('website-guidance').hidden=false;
    $('website-recovery').hidden=true;$('website-frame').hidden=false;
    $('website-report-problem').hidden=false;$('website-report-problem').disabled=false;$('website-retry').disabled=false;
    $('website-frame').src=ui.websiteUrl;
  }
  function openWebsite(url,title){
    try{
      const validated=safeLink(url);ui.websiteUrl=validated;
      const amazon=['amazon.ae','www.amazon.ae'].includes(new URL(validated).hostname);
      $('website-title').textContent=title;$('website-frame').title=title+' website';
      $('website-open-direct').href=validated;$('website-open-direct').textContent=amazon?'Open Amazon in browser':'Open directly';
      $('website-guidance').textContent=amazon?"If Amazon shows a security check, you can try completing it in this view. If it fails, use Open Amazon in browser. On a phone, this may open your browser or Amazon's app.":"If the website shows a security check, you can try completing it in this view. If it fails, use Open directly. On a phone, this may open your browser or the website's app.";
      if(amazon){
        $('website-frame').src='about:blank';$('website-frame').hidden=true;
        $('website-recovery').hidden=true;$('website-choice').hidden=false;$('website-guidance').hidden=true;
        $('website-report-problem').hidden=true;$('website-report-problem').disabled=true;
      }else loadWebsiteView();
      if(!$('website-dialog').open)$('website-dialog').showModal();
    }catch(problem){toast(problem.message);}
  }
  function stopWebsiteView(){
    if(!ui.websiteUrl)return;
    $('website-frame').src='about:blank';$('website-frame').hidden=true;
    $('website-report-problem').disabled=true;$('website-recovery').hidden=false;
    $('website-recovery-title').focus();
  }
  function showMeals(){showView('meals/dinner');$('meals-section').hidden=false;postMealRestore();$('meals-section').scrollIntoView({block:'start',behavior:'instant'});}
  function postMeal(message){$('meals-frame').contentWindow?.postMessage(message,location.origin);}
  function trackMealEdits(){
    const doc=$('meals-frame').contentDocument;if(!doc||doc===ui.mealDocument)return;
    ui.mealDocument=doc;
    for(const name of ['input','change','click','submit'])doc.addEventListener(name,()=>{ui.mealDirty=true;},true);
  }
  function postMealRestore(force=false){
    trackMealEdits();if(!force&&(ui.mealDirty||ui.mealConflict))return;
    if(force){ui.mealDirty=false;ui.mealConflict=false;}
    ui.mealBaseSnapshot=copy(state.mealSnapshot);ui.mealRestoreExpected=copy(state.mealSnapshot);ui.mealRestorePending=true;
    ui.mealVerified=false;ui.mealGroceries=[];ui.groceriesApproved=false;renderToday();renderShopping();postMeal({type:'tidy-meals-restore',snapshot:state.mealSnapshot});postMeal({type:'tidy-meals-storage-status',saved:!ui.saveFailed&&!ui.storageLocked});
  }
  function acceptMealChange(message){
    const wasRestoreEcho=ui.mealRestorePending&&!ui.mealDirty;
    // Validate before accepting either a local change or a restoration echo.
    C.validateSnapshot({...state,mealSnapshot:message.snapshot,mealSummary:message.summary});
    refreshSavedData(false);
    const latest=ui.savedMealSnapshot;
    if(wasRestoreEcho&&(!same(latest,ui.mealRestoreExpected)&&!same(message.snapshot,latest)||ui.mealRestoreExpected!==null&&!same(message.snapshot,ui.mealRestoreExpected))){
      // A delayed echo belongs to an older restore. Ask the frame for the
      // current saved meal, without writing an old task or meal snapshot back.
      ui.mealRestorePending=false;postMealRestore();return;
    }
    const conflict=ui.mealConflict||!same(latest,ui.mealBaseSnapshot)&&!same(latest,message.snapshot);
    state=C.validateSnapshot({...state,mealSnapshot:message.snapshot,mealSummary:message.summary});ui.mealVerified=true;readMealGroceries(message);
    if(conflict){
      ui.mealDirty=true;ui.mealConflict=true;ui.saveFailed=true;ui.mealRestorePending=false;mealConflictWarning();postMeal({type:'tidy-meals-storage-status',saved:false});renderToday();renderShopping();return;
    }
    // Matching restores are acknowledgements, not new mutations. Avoid a
    // storage/restore/save echo between tabs and retain any unsaved task data.
    const unchanged=same(message.snapshot,latest)&&same(message.summary,ui.savedMealSummary);
    const saved=unchanged?!ui.saveFailed&&!ui.storageLocked:save();
    ui.mealRestorePending=false;
    if(saved){ui.mealBaseSnapshot=copy(message.snapshot);ui.mealDirty=false;}
    else ui.mealDirty=true;
    postMeal({type:'tidy-meals-storage-status',saved});
    if(saved&&message.snapshot===null&&typeof message.resetId==='string'&&message.resetId.length>0&&message.resetId.length<=100)postMeal({type:'tidy-meals-reset-ack',resetId:message.resetId,saved:true});
    renderToday();renderShopping();
  }
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
      ui.storageBaseline=ui.storage?.getItem(KEY)??null;state=candidate;ui.storageLocked=false;ui.recoveryText=null;ui.mealConflict=false;ui.mealDirty=false;ui.mealVerified=false;ui.mealGroceries=[];ui.groceriesApproved=false;ui.planningEditing=false;ui.planningStatus='';ui.planResults.clear();for(const type of ['breakfast','lunch']){ui.mealEdits[type]=null;ui.mealStatuses[type]='';}const saved=save();renderAll();if(state.mealSnapshot===null){ui.mealBaseSnapshot=null;postMeal({type:'tidy-meals-reset'});}else postMealRestore(true);
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
  startCalendarConnections();
  $('calendar-connect-google').addEventListener('click',()=>connectCalendarAccount('google'));
  $('calendar-connect-microsoft').addEventListener('click',()=>connectCalendarAccount('microsoft'));
  $('calendar-account-refresh').addEventListener('click',()=>{if(ui.accountProvider)connectCalendarAccount(ui.accountProvider,true);});
  $('calendar-account-disconnect').addEventListener('click',disconnectCalendarAccount);
  $('calendar-connection-config-form').addEventListener('submit',saveConnectionConfig);
  for(const input of [$('calendar-google-client-id'),$('calendar-microsoft-client-id')]){input.addEventListener('focus',beginConnectionConfigEdit);input.addEventListener('input',()=>{beginConnectionConfigEdit();ui.connectionConfigStatus='Your connection settings have not been saved yet.';error('calendar-config-error','');renderCalendarConnection();});}
  $('calendar-file').addEventListener('change',importCalendar);
  $('calendar-remove').addEventListener('click',()=>{if(state.calendar&&confirm('Forget the saved calendar snapshot on this browser? Your Tidy tasks and the original calendar will stay in place.'))mutate(()=>{delete state.calendar;},'Saved calendar forgotten');});
  $('calendar-export').addEventListener('click',exportCalendar);
  $('planning-settings-form').addEventListener('submit',savePlanningProfile);
  for(const input of $('planning-settings-form').querySelectorAll('input')){input.addEventListener('focus',beginPlanningEdit);input.addEventListener('input',()=>{beginPlanningEdit();error('planning-settings-error','');ui.planningStatus='Your changed hours have not been saved yet.';renderPlanningProfile();});}
  $('planning-date').addEventListener('change',renderDayPlan);$('planning-run').addEventListener('click',organiseDay);
  $('calendar-onboarding-start').addEventListener('click',()=>{rememberWelcome('setup');$('calendar-onboarding-dialog').close();showView('calendar');});
  $('calendar-onboarding-later').addEventListener('click',()=>{rememberWelcome('later');$('calendar-onboarding-dialog').close();});
  $('calendar-onboarding-dialog').addEventListener('close',()=>{if(!ui.welcomeChoice)rememberWelcome('later');});
  for(const nav of document.querySelectorAll('[data-view]'))nav.addEventListener('click',()=>showView(nav.dataset.view));
  for(const link of document.querySelectorAll('[data-go]'))link.addEventListener('click',()=>showView(link.dataset.go));
  for(const tab of document.querySelectorAll('button[data-meal]')){
    tab.addEventListener('click',()=>selectMealSlide(tab.dataset.meal));
    tab.addEventListener('keydown',event=>{const index=MEAL_SLIDES.indexOf(tab.dataset.meal);let next;if(event.key==='ArrowRight')next=(index+1)%MEAL_SLIDES.length;else if(event.key==='ArrowLeft')next=(index+MEAL_SLIDES.length-1)%MEAL_SLIDES.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=MEAL_SLIDES.length-1;else return;event.preventDefault();selectMealSlide(MEAL_SLIDES[next],true);});
  }
  $('meal-previous').addEventListener('click',()=>selectMealSlide(MEAL_SLIDES[Math.max(0,MEAL_SLIDES.indexOf(ui.mealSlide)-1)],true));
  $('meal-next').addEventListener('click',()=>selectMealSlide(MEAL_SLIDES[Math.min(MEAL_SLIDES.length-1,MEAL_SLIDES.indexOf(ui.mealSlide)+1)],true));
  for(const type of ['breakfast','lunch']){
    $(type+'-form').addEventListener('submit',event=>saveMealPlan(event,type));
    for(const day of MEAL_DAYS){const input=$(type+'-'+day.toLowerCase());input.addEventListener('focus',()=>beginMealPlanEdit(type));input.addEventListener('input',()=>{beginMealPlanEdit(type);ui.mealStatuses[type]='Your changes have not been saved yet.';error(type+'-error','');renderMealPlans();});}
  }
  document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();showView('tools');});
  $('today-add').addEventListener('click',()=>{showView('assistant');$('capture-text').focus();});$('family-add').addEventListener('click',()=>openTask());$('tools-add-link').addEventListener('click',()=>openTask({},null,'Keep a useful website with the job it helps you finish.'));
  $('add-routine').addEventListener('click',()=>openTask({repeat:'weekly',dueDate:C.today()},null,'Choose the first date. Weekly routines keep this weekday.'));
  $('task-form').addEventListener('submit',saveTask);$('action-form').addEventListener('submit',saveAction);$('member-form').addEventListener('submit',saveMember);
  $('capture-form').addEventListener('submit',event=>{event.preventDefault();void capture($('capture-text').value);});
  $('assistant-activity-open').addEventListener('click',()=>{if(ui.activity?.resume)ui.activity.resume();else revealActivityTarget(true);});
  $('assistant-activity-edit').addEventListener('click',()=>{if(refreshSavedData())renderAll();const task=state.tasks.find(task=>task.id===ui.activity?.target?.id);if(task)openTask(task,task.id);else toast('This item is no longer in Tidy.');});
  $('assistant-activity-undo').addEventListener('click',undoAssistantTask);
  $('assistant-activity-dismiss').addEventListener('click',()=>{if(ui.activity){ui.activity.dismissed=true;renderActivity();}});
  $('assistant-clarify-form').addEventListener('submit',event=>{event.preventDefault();void answerQuickQuestion($('assistant-clarify-answer').value);});
  $('assistant-clarify-details').addEventListener('click',openCaptureDetails);
  $('assistant-clarify-cancel').addEventListener('click',()=>{cancelQuickQuestion();$('assistant-clarify-dialog').close();});
  $('assistant-clarify-dialog').addEventListener('cancel',cancelQuickQuestion);
  $('assistant-clarify-dialog').addEventListener('close',cancelQuickQuestion);
  $('routines-reminders').addEventListener('click',()=>showView('reminders'));
  $('reminders-settings').addEventListener('click',showSettings);
  $('reminders-add').addEventListener('click',()=>{startActivity();waitForTaskDetails('',{kind:'clarify',reminderRequested:true,draft:{title:'Reminder'},message:'Choose the date and time for your reminder. Keep Tidy open for the alert.'});});
  $('appointments-add').addEventListener('click',()=>{startActivity();waitForTaskDetails('',{kind:'clarify',appointmentRequested:true,draft:{type:'appointment',category:'Health'},message:'What is the appointment for, and when is it? This saves a local record; it does not book with a provider.'});});
  $('task-dialog').addEventListener('cancel',cancelTaskCapture);
  for(const example of document.querySelectorAll('[data-example]'))example.addEventListener('click',()=>{$('capture-text').value=example.dataset.example;$('capture-text').focus();});
  for(const close of document.querySelectorAll('[data-close]'))close.addEventListener('click',()=>{if(close.dataset.close==='task-dialog')cancelTaskCapture();$(close.dataset.close).close();});
  $('website-dialog').addEventListener('close',()=>{ui.websiteUrl=null;$('website-frame').src='about:blank';$('website-frame').hidden=true;$('website-open-direct').removeAttribute('href');$('website-recovery').hidden=true;$('website-choice').hidden=true;});
  $('website-try-inside').addEventListener('click',()=>{loadWebsiteView();$('website-report-problem').focus();});
  $('website-report-problem').addEventListener('click',stopWebsiteView);
  $('website-retry').addEventListener('click',()=>{loadWebsiteView();$('website-report-problem').focus();});
  for(const field of [$('task-type'),$('task-repeat'),$('task-reminder')])field.addEventListener('change',()=>{if(field.id==='task-type'){if(field.value==='grocery')$('task-category').value='Shopping';if(field.value==='appointment')$('task-category').value='Health';}if($('task-reminder').checked&&!$('task-reminder-at').value&&$('task-date').value&&$('task-time').value)$('task-reminder-at').value=$('task-date').value+'T'+$('task-time').value;syncTaskControls();});
  for(const field of [$('task-date'),$('task-time')])field.addEventListener('change',()=>{if(ui.editingTask){$('task-reminder').checked=false;$('task-reminder-at').value='';}else if($('task-reminder').checked&&$('task-date').value&&$('task-time').value)$('task-reminder-at').value=$('task-date').value+'T'+$('task-time').value;syncTaskControls();});
  for(const field of [$('task-search'),$('category-filter'),$('person-filter'),$('status-filter')])field.addEventListener('input',renderFamily);$('today-person').addEventListener('change',renderToday);
  $('add-member').addEventListener('click',()=>openMember());$('new-action').addEventListener('click',()=>openAction());
  $('open-settings').addEventListener('click',showSettings);$('edit-checkins').addEventListener('click',showSettings);
  $('settings-form').addEventListener('submit',event=>{event.preventDefault();try{refreshSavedData();const draft={checkinEnabled:$('checkin-enabled').checked,checkinTime:$('checkin-time').value,remindersPaused:$('alerts-paused').checked},merged=mergeFields(ui.settingsBaseline,state.settings,draft,Object.keys(draft));state=C.validateSnapshot({...state,settings:{...state.settings,...merged}});const saved=save();if(saved){ui.settingsBaseline=copy(state.settings);$('checkin-enabled').checked=state.settings.checkinEnabled;$('checkin-time').value=state.settings.checkinTime;$('alerts-paused').checked=state.settings.remindersPaused;}renderAll();toast(saved?'Alert preferences saved':'Preferences kept in this tab; download a backup');checkReminders();}catch(problem){toast(problem.message);}});
  $('pause-alerts').addEventListener('click',()=>{mutate(()=>{state.settings.remindersPaused=!state.settings.remindersPaused;},state.settings.remindersPaused?'Alerts resumed':'Alerts paused');checkReminders();});
  $('enable-browser-alerts').addEventListener('click',async()=>{try{await Notification.requestPermission();updateBrowserStatus();}catch(_){$('browser-alert-status').textContent='This browser could not request permission. In-page alerts still work.';}});
  $('dismiss-alert').addEventListener('click',()=>{$('alert-banner').hidden=true;});
  $('export-backup').addEventListener('click',()=>{try{download('Tidy-backup-'+C.today()+'.json',C.backupJSON(state));}catch(problem){error('backup-error',problem.message);}});
  $('export-recovery').addEventListener('click',()=>{if(ui.recoveryText!==null)download('Tidy-saved-data-for-recovery.json',ui.recoveryText);});$('import-backup').addEventListener('change',importBackup);
  $('load-examples').addEventListener('click',loadExamples);$('show-meals').addEventListener('click',showMeals);$('hide-meals').addEventListener('click',()=>{$('meals-section').hidden=true;$('show-meals').focus();});
  $('grocery-form').addEventListener('submit',saveGrocery);
  $('shopping-meals').addEventListener('click',showMeals);$('download-shopping').addEventListener('click',downloadShopping);
  for(const [name,url] of [['Waitrose UAE','https://www.waitrose.ae/'],['Kibsons','https://www.kibsons.com/'],['Carrefour UAE','https://www.carrefouruae.com/'],['Amazon UAE','https://www.amazon.ae/']])$('provider-list').append(button(name,()=>openWebsite(url,name)));
  $('health-square-url').addEventListener('focus',beginHealthSquareEdit);
  $('health-square-url').addEventListener('input',()=>{beginHealthSquareEdit();error('health-square-error','');ui.healthSquareStatus='Website change not saved yet.';renderHealthSquare();});
  $('health-square-form').addEventListener('submit',saveHealthSquare);
  $('health-square-cancel').addEventListener('click',()=>{ui.healthSquareEditing=false;ui.healthSquareStatus='';error('health-square-error','');renderHealthSquare();});
  $('health-square-open').addEventListener('click',()=>{try{if(refreshSavedData())renderAll();if(state.settings.healthSquareUrl)openWebsite(state.settings.healthSquareUrl,'Health Square');}catch(problem){toast(problem.message);}});
  window.addEventListener('message',event=>{
    if(event.source!==$('meals-frame').contentWindow||event.origin!==location.origin||!event.data||typeof event.data!=='object')return;
    const message=event.data;
    if(message.type==='tidy-meals-open-store'){if(typeof message.store==='string'&&Object.hasOwn(GROCERY_STORES,message.store)){const store=GROCERY_STORES[message.store];openWebsite(store.url,store.name);}}
    else if(message.type==='tidy-meals-ready'){ui.mealReady=true;trackMealEdits();postMealRestore();}
    else if(message.type==='tidy-meals-height'&&Number.isFinite(message.height))$('meals-frame').style.height=Math.max(400,Math.min(10000,Math.ceil(message.height)))+'px';
    else if(message.type==='tidy-meals-change'){
      try{acceptMealChange(message);}
      catch(problem){postMeal({type:'tidy-meals-storage-status',saved:false});toast(problem.message);}
    }else if(message.type==='tidy-meals-restored'){
      if(message.message==='Current edits kept.')ui.mealDirty=true;
      ui.mealVerified=message.valid===true;if(ui.mealVerified){try{state=C.validateSnapshot({...state,mealSummary:message.summary});readMealGroceries(message);}catch(_){ui.mealVerified=false;}}if(!ui.mealVerified){ui.mealGroceries=[];ui.groceriesApproved=false;toast('The saved meal plan needs recovery. Open the meal planner to review it.');}renderToday();renderShopping();
    }else if(message.type==='tidy-meals-validation-result'){
      const request=ui.mealRequests.get(message.requestId);if(!request)return;ui.mealRequests.delete(message.requestId);message.valid===true?request.resolve():request.reject(message.message);
    }
  });
  $('meals-frame').addEventListener('load',()=>{ui.mealReady=true;trackMealEdits();postMealRestore();});
  window.addEventListener('storage',event=>{if(event.key!==KEY&&event.key!==null)return;try{if(refreshSavedData()){renderAll();toast('Saved data updated from another tab on this browser.');}}catch(_){storageWarning('Another tab saved data that could not be read. Your current data remains available.');}});
  window.addEventListener('focus',checkReminders);document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkReminders();});
  window.addEventListener('hashchange',()=>showView(location.hash.slice(1)||'tools',true,true));
  setupVoice();showView(location.hash.slice(1)||'tools',false,true);setInterval(checkReminders,15000);checkReminders();
  window.TidyDemo=Object.freeze({getState:()=>C.validateSnapshot(state),checkReminders});
  // The iframe may finish loading before the parent registers its listeners.
  postMealRestore();
  showCalendarWelcome();
})();
