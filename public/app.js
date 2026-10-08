const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let currentTrip=null,currentItinerary=null,cloudEnabled=false,currentUser=null,clientsCache=[];
let viatorRecommendationHistory=[];
let viatorHistoryTripKey='';
const VIATOR_HISTORY_KEY='tripfiver-viator-history-v1';
function loadViatorHistory(tripKey){
  try{const saved=JSON.parse(sessionStorage.getItem(VIATOR_HISTORY_KEY)||'{}');return Array.isArray(saved[tripKey])?saved[tripKey].map(String).slice(-60):[];}catch{return[];}
}
function saveViatorHistory(tripKey,codes){
  try{const saved=JSON.parse(sessionStorage.getItem(VIATOR_HISTORY_KEY)||'{}');saved[tripKey]=[...new Set(codes.map(String))].slice(-60);sessionStorage.setItem(VIATOR_HISTORY_KEY,JSON.stringify(saved));}catch{}
}
const nativeFetch=window.fetch.bind(window);
const SESSION_KEY='voyagedesk-session-v03';
function getSession(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch{return null;}}
function setSession(s){if(s)localStorage.setItem(SESSION_KEY,JSON.stringify(s));else localStorage.removeItem(SESSION_KEY);}
async function refreshSession(){
  const s=getSession();if(!s?.refresh_token)return null;
  const r=await nativeFetch('/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:s.refresh_token})});
  if(!r.ok){setSession(null);return null;}const n=await r.json();setSession(n);return n;
}
window.fetch=async function(input,init={}){
  const url=typeof input==='string'?input:input.url;let options={...init,headers:{...(init.headers||{})}};
  const localApi=typeof url==='string'&&url.startsWith('/api/');
  if(localApi){let s=getSession();if(s?.access_token)options.headers.Authorization=`Bearer ${s.access_token}`;
    let r=await nativeFetch(input,options);
    const isAuthCall=url.startsWith('/api/auth/');
    if(r.status===401&&!isAuthCall&&s?.refresh_token){s=await refreshSession();if(s?.access_token){options.headers.Authorization=`Bearer ${s.access_token}`;r=await nativeFetch(input,options);}}
    return r;
  }
  return nativeFetch(input,options);
};


let recoveryAccessToken='';
function authMessage(msg,error=false){const el=$('#authMessage');if(!el)return;el.textContent=msg||'';el.classList.toggle('error',!!error);}
function setAuthMode(mode){
  const isLogin=mode==='login',isSignup=mode==='signup',isForgot=mode==='forgot',isReset=mode==='reset';
  $('#loginForm').classList.toggle('hidden',!isLogin);
  $('#signupForm').classList.toggle('hidden',!isSignup);
  $('#forgotForm').classList.toggle('hidden',!isForgot);
  $('#resetForm').classList.toggle('hidden',!isReset);
  $('#authTabs').classList.toggle('hidden',isForgot||isReset);
  $('#showLogin').classList.toggle('active',isLogin);
  $('#showSignup').classList.toggle('active',isSignup);
  $('#authTitle').textContent=isReset?'Reset Your Password':isForgot?'Password Recovery':'Your Travel Account';
  $('#authIntro').textContent=isReset?'Choose a new password for your TripFiver account.':isForgot?'Enter your account email and we will send a secure reset link.':'Sign in to save, revisit, and manage your personal trips.';
  $('#authFooter').textContent=isReset?'After changing the password, you can sign in normally.':'Your account keeps your saved trips private.';
  authMessage('');
}
function showAuthTab(tab){setAuthMode(tab);}
$('#showLogin')?.addEventListener('click',()=>setAuthMode('login'));
$('#showSignup')?.addEventListener('click',()=>setAuthMode('signup'));
$('#showForgot')?.addEventListener('click',()=>{if($('#loginEmail').value.trim())$('#forgotEmail').value=$('#loginEmail').value.trim();setAuthMode('forgot');});
$('#forgotBack')?.addEventListener('click',()=>setAuthMode('login'));

function detectRecoverySession(){
  const hash=new URLSearchParams(location.hash.replace(/^#/,''));
  const query=new URLSearchParams(location.search);
  const type=hash.get('type')||query.get('type')||'';
  const token=hash.get('access_token')||query.get('access_token')||'';
  if(type==='recovery'&&token){
    recoveryAccessToken=token;
    setSession(null);
    $('#authGate').classList.remove('hidden');
    setAuthMode('reset');
    return true;
  }
  const error=hash.get('error_description')||query.get('error_description');
  if(error){
    $('#authGate').classList.remove('hidden');
    setAuthMode('login');
    authMessage(decodeURIComponent(error.replace(/\+/g,' ')),true);
  }
  return false;
}

async function verifyCloudSession(){
  if(!cloudEnabled){$('#authGate')?.classList.add('hidden');currentUser=null;return true;}
  if(detectRecoverySession())return false;
  const s=getSession();if(!s?.access_token){currentUser=null;$('#authGate')?.classList.add('hidden');$('#logoutBtn')?.classList.add('hidden');return true;}
  let r=await fetch('/api/auth/user');if(!r.ok){setSession(null);currentUser=null;$('#authGate')?.classList.add('hidden');$('#logoutBtn')?.classList.add('hidden');return true;}
  currentUser=await r.json();$('#authGate')?.classList.add('hidden');$('#signedInEmail').textContent=currentUser.email||'';$('#logoutBtn').classList.remove('hidden');return true;
}
$('#loginForm')?.addEventListener('submit',async e=>{e.preventDefault();authMessage('Signing in…');const r=await nativeFetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#loginEmail').value.trim(),password:$('#loginPassword').value})});const d=await r.json();if(!r.ok)return authMessage(d.error||'Sign in failed.',true);setSession(d);authMessage('Signed in.');await initializeSignedInWorkspace();});
$('#signupForm')?.addEventListener('submit',async e=>{e.preventDefault();authMessage('Creating account…');const r=await nativeFetch('/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#signupName').value.trim(),email:$('#signupEmail').value.trim(),password:$('#signupPassword').value})});const d=await r.json();if(!r.ok)return authMessage(d.error||'Account creation failed.',true);if(d.access_token){setSession(d);authMessage('Account created.');await initializeSignedInWorkspace();}else{setAuthMode('login');$('#loginEmail').value=$('#signupEmail').value.trim();authMessage('Account created. Check your email to confirm it, then sign in.');}});
$('#forgotForm')?.addEventListener('submit',async e=>{
  e.preventDefault();const email=$('#forgotEmail').value.trim();if(!email)return;
  authMessage('Sending reset email…');
  const r=await nativeFetch('/api/auth/recover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,redirectTo:`${location.origin}/`})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)return authMessage(d.error||'Could not send reset email.',true);
  authMessage('Password reset email sent. Open the newest email and click its reset link.');
});
$('#resetForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const password=$('#resetPassword').value,confirmPassword=$('#resetPasswordConfirm').value;
  if(password.length<8)return authMessage('Password must be at least 8 characters.',true);
  if(password!==confirmPassword)return authMessage('The two passwords do not match.',true);
  if(!recoveryAccessToken)return authMessage('The recovery session is missing or expired. Request a new reset email.',true);
  authMessage('Updating password…');
  const r=await nativeFetch('/api/auth/update-password',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${recoveryAccessToken}`},body:JSON.stringify({password})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)return authMessage(d.error||'Could not update password.',true);
  recoveryAccessToken='';
  history.replaceState({},document.title,location.pathname);
  $('#resetPassword').value='';$('#resetPasswordConfirm').value='';
  setAuthMode('login');
  authMessage('Password changed successfully. Sign in with your new password.');
});
$('#accountBtn')?.addEventListener('click',()=>{$('#authGate')?.classList.remove('hidden');setAuthMode('login');});
$('#logoutBtn')?.addEventListener('click',async()=>{try{await fetch('/api/auth/logout',{method:'POST'});}catch{}setSession(null);currentUser=null;clearConversionDashboard();$('#signedInEmail').textContent='';$('#logoutBtn').classList.add('hidden');$('#authGate').classList.add('hidden');});

function setView(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===name));document.querySelectorAll('.nav').forEach(v=>v.classList.toggle('active',v.dataset.view===name));const title=document.querySelector('#pageTitle');if(title)title.textContent={new:'Plan My Trip',trips:'My Trips',conversion:'Revenue & Conversion',clients:'Clients',settings:'Branding'}[name]||'Welcome to TripFiver';if(name==='conversion')loadConversionDashboard();window.scrollTo({top:0,behavior:'smooth'});}document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));document.querySelector('#newTripTop')?.addEventListener('click',()=>setView('new'));document.querySelector('#heroNew')?.addEventListener('click',()=>setView('new'));


// Smart city and airport autocomplete. This local catalogue keeps the MVP fast and predictable;
// a live places provider can replace/extend it later without changing the form workflow.
const LOCATION_CATALOG=[
 {city:'Miami',region:'Florida',country:'United States',cityCode:'MIA',airports:[['MIA','Miami International Airport'],['FLL','Fort Lauderdale-Hollywood International Airport'],['PBI','Palm Beach International Airport']]},
 {city:'London',region:'England',country:'United Kingdom',cityCode:'LON',airports:[['LHR','London Heathrow Airport'],['LGW','London Gatwick Airport'],['LCY','London City Airport'],['LTN','London Luton Airport'],['STN','London Stansted Airport']]},
 {city:'London',region:'Kentucky',country:'United States',cityCode:'LOZ',airports:[['LOZ','London-Corbin Airport / Magee Field']]},
 {city:'London',region:'Ohio',country:'United States',cityCode:'CMH',airports:[['CMH','John Glenn Columbus International Airport'],['LCK','Rickenbacker International Airport']]},
 {city:'Istanbul',region:'Istanbul',country:'Türkiye',cityCode:'IST',airports:[['IST','Istanbul Airport'],['SAW','Sabiha Gökçen International Airport']]},
 {city:'New York',region:'New York',country:'United States',cityCode:'NYC',airports:[['JFK','John F. Kennedy International Airport'],['LGA','LaGuardia Airport'],['EWR','Newark Liberty International Airport']]},
 {city:'Los Angeles',region:'California',country:'United States',cityCode:'LAX',airports:[['LAX','Los Angeles International Airport'],['BUR','Hollywood Burbank Airport'],['LGB','Long Beach Airport'],['SNA','John Wayne Airport']]},
 {city:'Chicago',region:'Illinois',country:'United States',cityCode:'CHI',airports:[['ORD','O’Hare International Airport'],['MDW','Chicago Midway International Airport']]},
 {city:'Paris',region:'Île-de-France',country:'France',cityCode:'PAR',airports:[['CDG','Charles de Gaulle Airport'],['ORY','Paris Orly Airport']]},
 {city:'Rome',region:'Lazio',country:'Italy',cityCode:'ROM',airports:[['FCO','Leonardo da Vinci–Fiumicino Airport'],['CIA','Ciampino Airport']]},
 {city:'Milan',region:'Lombardy',country:'Italy',cityCode:'MIL',airports:[['MXP','Milan Malpensa Airport'],['LIN','Milan Linate Airport'],['BGY','Milan Bergamo Airport']]},
 {city:'Madrid',region:'Community of Madrid',country:'Spain',cityCode:'MAD',airports:[['MAD','Adolfo Suárez Madrid–Barajas Airport']]},
 {city:'Barcelona',region:'Catalonia',country:'Spain',cityCode:'BCN',airports:[['BCN','Josep Tarradellas Barcelona–El Prat Airport']]},
 {city:'Lisbon',region:'Lisbon',country:'Portugal',cityCode:'LIS',airports:[['LIS','Humberto Delgado Airport']]},
 {city:'Athens',region:'Attica',country:'Greece',cityCode:'ATH',airports:[['ATH','Athens International Airport']]},
 {city:'Tel Aviv',region:'Tel Aviv District',country:'Israel',cityCode:'TLV',airports:[['TLV','Ben Gurion Airport']]},
 {city:'Dubai',region:'Dubai',country:'United Arab Emirates',cityCode:'DXB',airports:[['DXB','Dubai International Airport'],['DWC','Al Maktoum International Airport']]},
 {city:'Toronto',region:'Ontario',country:'Canada',cityCode:'YTO',airports:[['YYZ','Toronto Pearson International Airport'],['YTZ','Billy Bishop Toronto City Airport']]},
 {city:'Montreal',region:'Quebec',country:'Canada',cityCode:'YMQ',airports:[['YUL','Montréal–Trudeau International Airport']]},
 {city:'Mexico City',region:'Mexico City',country:'Mexico',cityCode:'MEX',airports:[['MEX','Mexico City International Airport'],['NLU','Felipe Ángeles International Airport']]},
 {city:'Cancún',region:'Quintana Roo',country:'Mexico',cityCode:'CUN',airports:[['CUN','Cancún International Airport']]},
 {city:'San Francisco',region:'California',country:'United States',cityCode:'SFO',airports:[['SFO','San Francisco International Airport'],['OAK','Oakland San Francisco Bay Airport'],['SJC','San José Mineta International Airport']]},
 {city:'Orlando',region:'Florida',country:'United States',cityCode:'ORL',airports:[['MCO','Orlando International Airport'],['SFB','Orlando Sanford International Airport']]},
 {city:'Fort Lauderdale',region:'Florida',country:'United States',cityCode:'FLL',airports:[['FLL','Fort Lauderdale-Hollywood International Airport']]},
 {city:'Boston',region:'Massachusetts',country:'United States',cityCode:'BOS',airports:[['BOS','Boston Logan International Airport']]},
 {city:'Washington',region:'District of Columbia',country:'United States',cityCode:'WAS',airports:[['DCA','Ronald Reagan Washington National Airport'],['IAD','Washington Dulles International Airport'],['BWI','Baltimore/Washington International Airport']]},
 {city:'Atlanta',region:'Georgia',country:'United States',cityCode:'ATL',airports:[['ATL','Hartsfield-Jackson Atlanta International Airport']]},
 {city:'Las Vegas',region:'Nevada',country:'United States',cityCode:'LAS',airports:[['LAS','Harry Reid International Airport']]},
 {city:'Seattle',region:'Washington',country:'United States',cityCode:'SEA',airports:[['SEA','Seattle–Tacoma International Airport']]},
 {city:'Amsterdam',region:'North Holland',country:'Netherlands',cityCode:'AMS',airports:[['AMS','Amsterdam Airport Schiphol']]},
 {city:'Frankfurt',region:'Hesse',country:'Germany',cityCode:'FRA',airports:[['FRA','Frankfurt Airport']]},
 {city:'Munich',region:'Bavaria',country:'Germany',cityCode:'MUC',airports:[['MUC','Munich Airport']]},
 {city:'Vienna',region:'Vienna',country:'Austria',cityCode:'VIE',airports:[['VIE','Vienna International Airport']]},
 {city:'Zurich',region:'Zurich',country:'Switzerland',cityCode:'ZRH',airports:[['ZRH','Zurich Airport']]},
 {city:'Tokyo',region:'Tokyo',country:'Japan',cityCode:'TYO',airports:[['HND','Tokyo Haneda Airport'],['NRT','Narita International Airport']]},
 {city:'Seoul',region:'Seoul',country:'South Korea',cityCode:'SEL',airports:[['ICN','Incheon International Airport'],['GMP','Gimpo International Airport']]},
 {city:'Sydney',region:'New South Wales',country:'Australia',cityCode:'SYD',airports:[['SYD','Sydney Airport']]}
];
const locationLabel=l=>`${l.city}, ${l.region}, ${l.country}`;
const norm=v=>String(v||'').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function cityMatches(q){q=norm(q);if(!q)return[];return LOCATION_CATALOG.filter(l=>norm(`${l.city} ${l.region} ${l.country} ${l.cityCode}`).includes(q)).slice(0,8);}
function airportMatches(q){q=norm(q);if(!q)return[];const out=[];for(const l of LOCATION_CATALOG)for(const [code,name] of l.airports){if(norm(`${code} ${name} ${l.city} ${l.region} ${l.country} ${l.cityCode}`).includes(q))out.push({location:l,code,name,type:'airport'});}return out.slice(0,10);}
function transportMatches(q){q=norm(q);if(!q)return[];const out=[];for(const l of LOCATION_CATALOG){if(norm(`${l.city} ${l.region} ${l.country} ${l.cityCode}`).includes(q))out.push({location:l,code:l.cityCode,name:`All ${l.city} airports / city code`,type:'city'});for(const [code,name] of l.airports)if(norm(`${code} ${name} ${l.city} ${l.region} ${l.country}`).includes(q))out.push({location:l,code,name,type:'airport'});}const seen=new Set();return out.filter(x=>{const k=`${locationLabel(x.location)}|${x.code}`;if(seen.has(k))return false;seen.add(k);return true;}).slice(0,10);}
function closeSuggestions(except=null){$$('.suggestions').forEach(x=>{if(x!==except)x.classList.remove('open');});}
function showSuggestions(input,items,kind){const box=$(`.suggestions[data-for="${input.name}"]`);if(!box)return;box.innerHTML=items.map((x,i)=>kind==='city'?`<div class="suggestion" data-index="${i}"><span class="suggestion-main"><strong>${escapeHtml(x.city)}</strong><small>${escapeHtml(x.region)}, ${escapeHtml(x.country)}</small></span><span class="suggestion-code">${escapeHtml(x.cityCode)}</span></div>`:`<div class="suggestion" data-index="${i}"><span class="suggestion-main"><strong>${escapeHtml(x.code)} · ${escapeHtml(x.name)}</strong><small>${escapeHtml(locationLabel(x.location))}</small></span><span class="suggestion-code">${escapeHtml(x.code)}</span></div>`).join('');box.classList.toggle('open',items.length>0);[...box.children].forEach((row,i)=>row.onmousedown=e=>{e.preventDefault();selectSuggestion(input,items[i],kind);});}
function selectSuggestion(input,item,kind){const f=$('#tripForm');if(kind==='city'){input.value=locationLabel(item);if(input.name==='departureCity'){f.originCode.value=item.airports[0]?.[0]||item.cityCode;}if(input.name==='destinations'){f.destinationCode.value=item.cityCode;}}else{input.value=item.code;if(input.name==='originCode'&&!f.departureCity.value.trim())f.departureCity.value=locationLabel(item.location);if(input.name==='destinationCode'){if(!f.destinations.value.trim())f.destinations.value=locationLabel(item.location);}}closeSuggestions();input.dispatchEvent(new Event('change',{bubbles:true}));}
function setupSmartField(name,kind){const input=$(`#tripForm [name="${name}"]`);if(!input)return;const update=()=>{const q=input.value.trim();let items=[];if(kind==='city')items=cityMatches(q);else if(kind==='transport')items=transportMatches(q);else if(kind==='citycode')items=cityCodeMatches(q);else items=airportMatches(q);showSuggestions(input,items,kind);};input.addEventListener('input',update);input.addEventListener('focus',update);input.addEventListener('keydown',e=>{if(e.key==='Escape')closeSuggestions();});}
setupSmartField('departureCity','city');setupSmartField('destinations','city');setupSmartField('originCode','transport');setupSmartField('destinationCode','transport');
document.addEventListener('mousedown',e=>{if(!e.target.closest('.smart-field'))closeSuggestions();});

const CURRENCIES={USD:{symbol:'$',locale:'en-US'},EUR:{symbol:'€',locale:'de-DE'},GBP:{symbol:'£',locale:'en-GB'},TRY:{symbol:'₺',locale:'tr-TR'},ILS:{symbol:'₪',locale:'he-IL'},CAD:{symbol:'C$',locale:'en-CA'},AUD:{symbol:'A$',locale:'en-AU'},JPY:{symbol:'¥',locale:'ja-JP'},CHF:{symbol:'CHF',locale:'de-CH'},AED:{symbol:'د.إ',locale:'ar-AE'}};
function cleanBudgetAmount(v){const raw=String(v||'').replace(/,/g,'').replace(/[^0-9.]/g,'');const parts=raw.split('.');return parts.length>1?`${parts.shift()}.${parts.join('')}`:raw;}
function groupAngloNumber(v){const raw=cleanBudgetAmount(v);if(!raw)return'';const hasDot=String(v).trim().endsWith('.');const [whole='',dec='']=raw.split('.');const grouped=(whole||'0').replace(/^0+(?=\d)/,'').replace(/\B(?=(\d{3})+(?!\d))/g,',');return dec!==''?`${grouped}.${dec}`:hasDot?`${grouped}.`:grouped;}
function formatBudgetAmount(amount,currency){const n=Number(cleanBudgetAmount(amount));if(!Number.isFinite(n))return'';const meta=CURRENCIES[currency]||{symbol:currency||'',locale:'en-US'};const digits=Number.isInteger(n)?0:2;const formatted=new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:2}).format(n);return `${meta.symbol||currency||''}${meta.symbol?'':' '}${formatted}`.trim();}
function setupBudgetGrouping(){const el=$('#budgetAmount');if(!el)return;const format=()=>{const before=el.value;const after=groupAngloNumber(before);if(after!==before)el.value=after;};el.addEventListener('input',format);el.addEventListener('blur',format);}
function selectedCurrency(){const sel=$('#budgetCurrency')?.value||'USD';return sel==='Other'?($('#customCurrency')?.value||'').trim().toUpperCase():sel;}
function selectedLanguage(){const sel=$('#proposalLanguage')?.value||'English';return sel==='Other'?($('#customLanguage')?.value||'').trim():sel;}
function updateBudgetSymbol(){const currency=selectedCurrency()||'USD';if($('#budgetSymbol'))$('#budgetSymbol').textContent=CURRENCIES[currency]?.symbol||currency||'¤';$('#customCurrency')?.classList.toggle('hidden',$('#budgetCurrency')?.value!=='Other');}
function updateLanguageField(){$('#customLanguage')?.classList.toggle('hidden',$('#proposalLanguage')?.value!=='Other');}
$('#budgetCurrency')?.addEventListener('change',updateBudgetSymbol);$('#customCurrency')?.addEventListener('input',updateBudgetSymbol);$('#proposalLanguage')?.addEventListener('change',updateLanguageField);updateBudgetSymbol();updateLanguageField();setupBudgetGrouping();
function applyTripDefaults(){const b=getBrand();const f=$('#tripForm');if(!f)return;f.proposalLanguage.value=b.defaultLanguage||'English';f.budgetCurrency.value=b.defaultCurrency||'USD';updateBudgetSymbol();updateLanguageField();}
function formData(){const d=Object.fromEntries(new FormData($('#tripForm')).entries());d.originCode=(d.originCode||'').toUpperCase();d.destinationCode=(d.destinationCode||'').toUpperCase();d.hotelCityCode=(d.destinationCode||'').toUpperCase();d.travelers=`${d.adults||1} adult${d.adults==='1'?'':'s'}${Number(d.children)?`, ${d.children} children`:''}`;d.dates=[d.departureDate,d.returnDate].filter(Boolean).join(' – ');d.proposalLanguage=selectedLanguage()||'English';d.budgetCurrency=selectedCurrency()||'USD';d.budgetAmount=cleanBudgetAmount(d.budgetAmount);d.budget=d.budgetAmount?formatBudgetAmount(d.budgetAmount,d.budgetCurrency):'';
d.addPhotos=$('#addPhotos')?.checked===true;delete d.customCurrency;delete d.customLanguage;return d;}

function refreshTripClientSelect(){
  const sel=$('#tripClientSelect');if(!sel)return;const selected=sel.value;
  sel.innerHTML='<option value="">New / unlinked client</option>'+clientsCache.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.email?` · ${escapeHtml(c.email)}`:''}</option>`).join('');
  if([...sel.options].some(o=>o.value===selected))sel.value=selected;
}
$('#tripClientSelect')?.addEventListener('change',()=>{
  const c=clientsCache.find(x=>x.id===$('#tripClientSelect').value);if(!c)return;
  const f=$('#tripForm');f.clientName.value=c.name||'';
  const langs=[...f.proposalLanguage.options].map(o=>o.value);if(c.language&&langs.includes(c.language)){f.proposalLanguage.value=c.language;updateLanguageField();}
  const currencies=[...f.budgetCurrency.options].map(o=>o.value);if(c.currency&&currencies.includes(c.currency)){f.budgetCurrency.value=c.currency;updateBudgetSymbol();}
  if(c.notes&&!f.notes.value.trim())f.notes.value=c.notes;
});

$('#fillDemo').onclick=()=>{const f=$('#tripForm');f.clientName.value='Michael Green';f.departureCity.value='Miami, Florida, United States';f.originCode.value='MIA';f.destinations.value='London, England, United Kingdom';f.destinationCode.value='LON';const now=new Date(),dep=new Date(now);dep.setDate(dep.getDate()+45);const ret=new Date(dep);ret.setDate(ret.getDate()+5);const fmt=d=>d.toISOString().slice(0,10);f.departureDate.value=fmt(dep);f.returnDate.value=fmt(ret);f.adults.value=2;f.children.value=0;f.proposalLanguage.value=getBrand().defaultLanguage||'English';f.budgetCurrency.value=getBrand().defaultCurrency||'USD';f.budgetAmount.value='5,000';updateBudgetSymbol();updateLanguageField();f.hotelLevel.value='4-star';f.interests.value='History, restaurants, theater, sightseeing';f.notes.value='Central hotel. Prefer nonstop flights where practical.';};
function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));}function listHtml(a){return(a||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('');}function money(n,c='USD'){try{return new Intl.NumberFormat('en-US',{style:'currency',currency:c}).format(n);}catch{return `${c} ${n}`;}}

const photoState=new Map();
function photoSearchQuery(day){
  const location=day.location||currentTrip?.destinations||'travel destination';
  const title=day.title||'';
  return `${location} ${title}`.trim();
}
function photoMarkup(day,index){
  if(!currentTrip?.addPhotos)return '';
  return `<div class="day-photo" data-photo-day="${index}">
    <div class="day-photo-placeholder"><span>📷</span><strong>Finding a destination photo…</strong><small>${escapeHtml(photoSearchQuery(day))}</small></div>
    <div class="day-photo-actions">
      <button type="button" class="photo-btn" data-photo-change="${index}">Change Photo</button>
      <label class="photo-btn upload-photo">Upload Own Photo<input type="file" accept="image/png,image/jpeg,image/webp" data-photo-upload="${index}"></label>
      <button type="button" class="photo-btn danger" data-photo-remove="${index}">Remove Photo</button>
    </div>
  </div>`;
}
function renderDayPhoto(index,photo){
  const wrap=document.querySelector(`[data-photo-day="${index}"]`);if(!wrap)return;
  if(!photo){wrap.innerHTML=`<div class="day-photo-placeholder"><span>📷</span><strong>No photo selected</strong></div><div class="day-photo-actions"><button type="button" class="photo-btn" data-photo-change="${index}">Find Photo</button><label class="photo-btn upload-photo">Upload Own Photo<input type="file" accept="image/png,image/jpeg,image/webp" data-photo-upload="${index}"></label></div>`;bindPhotoControls();return;}
  photoState.set(index,photo);
  const credit=photo.source==='upload'?'Traveler photo':`Photo by ${escapeHtml(photo.photographer||'Contributor')} on Pexels`;
  const creditHtml=photo.source==='upload'?`<span>${credit}</span>`:`<a href="${escapeHtml(photo.pexelsUrl||'https://www.pexels.com')}" target="_blank" rel="noopener">${credit}</a>`;
  const focalX=Number.isFinite(Number(photo.focalX))?Number(photo.focalX):50;
  const focalY=Number.isFinite(Number(photo.focalY))?Number(photo.focalY):50;
  photo={...photo,focalX,focalY};photoState.set(index,photo);
  const focusButtons=[['↑',50,25,'Focus higher'],['←',25,50,'Focus left'],['•',50,50,'Center focus'],['→',75,50,'Focus right'],['↓',50,75,'Focus lower']];
  wrap.innerHTML=`<img src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt||'Destination photo')}" style="--photo-x:${focalX}%;--photo-y:${focalY}%"><div class="photo-credit">${creditHtml}</div><div class="photo-focus"><span class="photo-focus-label">Photo focus</span>${focusButtons.map(([label,x,y,title])=>`<button type="button" class="focus-btn ${focalX===x&&focalY===y?'active':''}" data-photo-focus="${index}:${x}:${y}" title="${title}" aria-label="${title}">${label}</button>`).join('')}</div><div class="day-photo-actions"><button type="button" class="photo-btn" data-photo-change="${index}">Change Photo</button><label class="photo-btn upload-photo">Upload Own Photo<input type="file" accept="image/png,image/jpeg,image/webp" data-photo-upload="${index}"></label><button type="button" class="photo-btn danger" data-photo-remove="${index}">Remove Photo</button></div>`;
  bindPhotoControls();
}
async function loadDayPhoto(day,index,forcePicker=false){
  const wrap=document.querySelector(`[data-photo-day="${index}"]`);if(!wrap)return;
  const q=photoSearchQuery(day);
  try{
    const r=await fetch(`/api/photos/search?q=${encodeURIComponent(q)}&per_page=6`),data=await r.json();
    if(!r.ok)throw new Error(data.error||'Photo search failed');
    if(!data.photos?.length)throw new Error('No matching photos found');
    if(forcePicker){showPhotoPicker(index,day,data.photos);return;}
    renderDayPhoto(index,{...data.photos[0],source:'pexels'});
  }catch(err){
    wrap.innerHTML=`<div class="day-photo-placeholder"><span>📷</span><strong>Photos not connected yet</strong><small>${escapeHtml(err.message)}</small></div><div class="day-photo-actions"><button type="button" class="photo-btn" data-photo-change="${index}">Try Again</button><label class="photo-btn upload-photo">Upload Own Photo<input type="file" accept="image/png,image/jpeg,image/webp" data-photo-upload="${index}"></label></div>`;
    bindPhotoControls();
  }
}
function showPhotoPicker(index,day,photos){
  const wrap=document.querySelector(`[data-photo-day="${index}"]`);if(!wrap)return;
  wrap.innerHTML=`<div class="photo-picker-head"><strong>Choose a photo</strong><small>${escapeHtml(photoSearchQuery(day))}</small></div><div class="photo-grid">${photos.map((p,i)=>`<button type="button" class="photo-choice" data-photo-choice="${index}:${i}"><img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.alt||'Photo option')}"><span>${escapeHtml(p.photographer||'Pexels')}</span></button>`).join('')}</div><div class="photo-credit provider-credit"><a href="https://www.pexels.com" target="_blank" rel="noopener">Photos provided by Pexels</a></div>`;
  wrap._photoChoices=photos;
  wrap.querySelectorAll('[data-photo-choice]').forEach(btn=>btn.onclick=()=>{const i=Number(btn.dataset.photoChoice.split(':')[1]);renderDayPhoto(index,{...photos[i],source:'pexels'});});
}
function bindPhotoControls(){
  document.querySelectorAll('[data-photo-change]').forEach(btn=>btn.onclick=()=>{const index=Number(btn.dataset.photoChange);loadDayPhoto(currentItinerary.days[index],index,true);});
  document.querySelectorAll('[data-photo-remove]').forEach(btn=>btn.onclick=()=>{const index=Number(btn.dataset.photoRemove);photoState.delete(index);renderDayPhoto(index,null);});
  document.querySelectorAll('[data-photo-focus]').forEach(btn=>btn.onclick=()=>{const [index,x,y]=btn.dataset.photoFocus.split(':').map(Number),photo=photoState.get(index);if(!photo)return;renderDayPhoto(index,{...photo,focalX:x,focalY:y});});
  document.querySelectorAll('[data-photo-upload]').forEach(inp=>inp.onchange=()=>{const index=Number(inp.dataset.photoUpload),file=inp.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>renderDayPhoto(index,{src:String(reader.result),alt:file.name,source:'upload',focalX:50,focalY:50});reader.readAsDataURL(file);});
}
function loadProposalPhotos(){if(!currentTrip?.addPhotos)return;(currentItinerary?.days||[]).forEach((day,index)=>loadDayPhoto(day,index,false));}

function compactHighlight(item){return String(item||'').split(/[.;—]/)[0].trim();}
function viatorImage(product){const cover=(product.images||[]).find(x=>x.isCover)||(product.images||[])[0];const variants=cover?.variants||[];return variants.find(x=>x.width>=480)?.url||variants[variants.length-1]?.url||'';}
function viatorDuration(duration={}){const mins=duration.fixedDurationInMinutes||duration.variableDurationFromMinutes;if(!mins)return'';const max=duration.variableDurationToMinutes;const fmt=m=>m>=60?(Number.isInteger(m/60)?`${m/60} hr`:`${(m/60).toFixed(1)} hr`):`${m} min`;return max&&max!==mins?`${fmt(mins)}–${fmt(max)}`:fmt(mins);}
function viatorPrice(product){const p=product.pricing?.summary?.fromPrice,c=product.pricing?.currency;if(p==null)return'';try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c||'USD',maximumFractionDigits:0}).format(p);}catch{return `${p} ${c||''}`.trim();}}
function renderViatorExperiences(data){
  window.tripFiverViatorData=data;
  const shown=(data?.recommendations||[]).map(x=>String(x.productCode||'')).filter(Boolean);
  viatorRecommendationHistory=[...new Set([...viatorRecommendationHistory,...shown])].slice(-60);
  if(viatorHistoryTripKey)saveViatorHistory(viatorHistoryTripKey,viatorRecommendationHistory);
  const host=$('#viatorExperiences');if(!host)return;
  const items=(data?.recommendations||[]).slice(0,3);
  if(!items.length){host.classList.add('hidden');host.innerHTML='';return;}
  host.innerHTML=`<div class="experience-head"><div><span class="experience-kicker">PERSONALIZED FOR YOUR TRIP</span><h3>Recommended Experiences for You</h3><p>TripFiver matched these experiences to your travel interests.</p></div><span class="experience-provider">Activities by Viator</span></div><div class="experience-grid">${items.map(p=>{const img=viatorImage(p),rating=p.reviews?.combinedAverageRating,reviews=p.reviews?.totalReviews,duration=viatorDuration(p.duration),price=viatorPrice(p),why=(p.match?.reasons||[]).join(' · ');return `<article class="experience-card">${img?`<img src="${escapeHtml(img)}" alt="${escapeHtml(p.title||'Travel experience')}" loading="lazy">`:''}<div class="experience-body"><h4>${escapeHtml(p.title||'Experience')}</h4><div class="experience-meta">${rating?`<span>★ ${escapeHtml(rating)}${reviews?` (${escapeHtml(reviews)})`:''}</span>`:''}${duration?`<span>⏱ ${escapeHtml(duration)}</span>`:''}</div>${why?`<p class="experience-why"><strong>Why TripFiver picked this:</strong> ${escapeHtml(why)}</p>`:''}<div class="experience-foot">${price?`<div><small>From</small><strong>${escapeHtml(price)}</strong></div>`:''}<a class="primary experience-btn" data-viator-click="1" data-product-code="${escapeHtml(p.productCode||'')}" href="${escapeHtml(p.productUrl||'#')}" target="_blank" rel="noopener sponsored">View Experience</a></div></div></article>`;}).join('')}</div>`;
  host.classList.remove('hidden');
  renderDayViatorMatches(data?.dayMatches||[]);
  bindViatorClickTracking();
}
function dayViatorCard(match){
  const p=match?.activity;if(!p)return'';const img=viatorImage(p),rating=p.reviews?.combinedAverageRating,duration=viatorDuration(p.duration),price=viatorPrice(p);
  return `<div class="day-experience"><div class="day-experience-label">✦ TripFiver experience match</div><div class="day-experience-card">${img?`<img src="${escapeHtml(img)}" alt="${escapeHtml(p.title||'Experience')}" loading="lazy">`:''}<div><strong>${escapeHtml(p.title||'Experience')}</strong><div class="experience-meta">${rating?`<span>★ ${escapeHtml(rating)}</span>`:''}${duration?`<span>⏱ ${escapeHtml(duration)}</span>`:''}${price?`<span>From ${escapeHtml(price)}</span>`:''}</div><a class="day-experience-link" data-viator-click="1" data-product-code="${escapeHtml(p.productCode||'')}" data-day="${escapeHtml(match.day)}" href="${escapeHtml(p.productUrl||'#')}" target="_blank" rel="noopener sponsored">View matched experience →</a></div></div></div>`;
}
function renderDayViatorMatches(matches=[]){
  document.querySelectorAll('.day-experience').forEach(x=>x.remove());
  matches.forEach(m=>{const cards=[...document.querySelectorAll('.consumer-day')];const card=cards.find(x=>Number(x.dataset.day)===Number(m.day));if(!card)return;const details=card.querySelector('.day-details');if(details)details.insertAdjacentHTML('beforeend',dayViatorCard(m));});
}
function trackConversion(event,extra={}){
  const payload={event,destination:currentTrip?.destinations||'',origin:currentTrip?.origin||'',...extra};
  const body=JSON.stringify(payload);
  try{navigator.sendBeacon('/api/conversion-event',new Blob([body],{type:'application/json'}));}
  catch{fetch('/api/conversion-event',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});}
}
function trackViatorClick(el){
  const payload={destination:currentTrip?.destinations||'',productCode:el.dataset.productCode||'',day:el.dataset.day||null,source:el.dataset.day?'itinerary-day':'recommended-experiences'};
  const body=JSON.stringify(payload);try{navigator.sendBeacon('/api/viator/click',new Blob([body],{type:'application/json'}));}catch{fetch('/api/viator/click',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});}
  trackConversion('viator_click',{productCode:payload.productCode,day:payload.day,source:payload.source});
}
async function openVerifiedViatorProduct(el,event){
  event.preventDefault();
  const productCode=el.dataset.productCode||'';
  if(!productCode)return;
  const originalText=el.textContent;
  el.textContent='Opening…';
  try{
    const d=await fetchJsonWithTimeout('/api/viator/product-link?productCode='+encodeURIComponent(productCode),{},8000);
    if(!d.productUrl)throw new Error('No product URL returned');
    trackViatorClick(el);
    window.open(d.productUrl,'_blank','noopener');
  }catch(err){
    console.warn('[TripFiver Viator] verified product link unavailable',productCode,err);
    el.textContent='Link unavailable — try again';
    setTimeout(()=>{el.textContent=originalText;},2500);
  }
}
function bindViatorClickTracking(){document.querySelectorAll('[data-viator-click]').forEach(el=>{if(el.dataset.trackingBound)return;el.dataset.trackingBound='1';el.addEventListener('click',e=>openVerifiedViatorProduct(el,e));});}
function bindExpediaConversionTracking(){
  const widget=$('#expediaAffiliateWidget');if(!widget||widget.dataset.trackingBound)return;
  widget.dataset.trackingBound='1';
  // Expedia's Creator widget renders partner-controlled UI. Track engagement
  // at the TripFiver widget boundary without changing affiliate attribution.
  // Expedia renders an isolated iframe: clicks inside it do not bubble to this page.
  // A focus transition from the TripFiver page into the widget iframe is an
  // observable engagement signal. Count once per proposal view, not every focus.
  let counted=false;
  const record=()=>{if(counted)return;counted=true;trackConversion('expedia_widget_click',{source:'expedia-widget-focus'});};
  widget.addEventListener('pointerdown',record,{capture:true});
  window.addEventListener('blur',()=>{
    setTimeout(()=>{
      const active=document.activeElement;
      if(active?.tagName==='IFRAME'&&widget.contains(active))record();
    },150);
  });
}
function clearConversionDashboard(message='Sign in as an administrator to view revenue metrics.'){
  for(const id of ['metricTrips','metricViator','metricExpedia','metricEvents']){
    const el=$('#'+id);if(el)el.textContent='—';
  }
  const table=$('#conversionDestinations');
  if(table)table.innerHTML='<tr><td colspan="4">'+escapeHtml(message)+'</td></tr>';
}
async function loadConversionDashboard(){
  clearConversionDashboard('Loading revenue metrics…');
  try{
    const r=await fetch('/api/conversion-summary');const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load conversion metrics');
    const counts=d.counts||{};
    if($('#metricTrips'))$('#metricTrips').textContent=Number(counts.trip_created||0).toLocaleString('en-US');
    if($('#metricViator'))$('#metricViator').textContent=Number(counts.viator_click||0).toLocaleString('en-US');
    if($('#metricExpedia'))$('#metricExpedia').textContent=Number(counts.expedia_widget_click||0).toLocaleString('en-US');
    if($('#metricEvents'))$('#metricEvents').textContent=Number(d.totalEvents||0).toLocaleString('en-US');
    const rows=(d.topDestinations||[]).map(x=>`<tr><td>${escapeHtml(x.destination)}</td><td>${Number(x.trip_created||0)}</td><td>${Number(x.viator_click||0)}</td><td>${Number(x.expedia_widget_click||0)}</td></tr>`).join('');
    if($('#conversionDestinations'))$('#conversionDestinations').innerHTML=rows||'<tr><td colspan="4">No conversion activity tracked yet.</td></tr>';
  }catch(err){clearConversionDashboard(err.message==='Sign in to access Revenue.'?'Sign in as an administrator to view revenue metrics.':err.message==='Revenue is restricted to administrators.'?'Revenue is restricted to administrators.':'Revenue metrics are unavailable. Sign in as an administrator and refresh.');}
}
document.addEventListener('click',e=>{
  const btn=e.target.closest('#refreshConversion');if(!btn)return;
  e.preventDefault();
  if(btn.dataset.loading==='1')return;
  btn.dataset.loading='1';const original=btn.textContent;btn.textContent='Refreshing…';btn.disabled=true;
  loadConversionDashboard().finally(()=>{btn.dataset.loading='0';btn.textContent=original;btn.disabled=false;});
});
async function fetchJsonWithTimeout(url,options={},timeoutMs=12000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{...options,signal:controller.signal});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||d.message||'Request failed');
    return d;
  }finally{clearTimeout(timer);}
}
async function loadViatorExperiences(){
  const host=$('#viatorExperiences');if(!host||!currentTrip)return;
  const tripKey=[currentTrip.destinations||'',currentTrip.startDate||'',currentTrip.endDate||'',currentTrip.interests||''].join('|').toLowerCase();
  if(viatorHistoryTripKey!==tripKey){viatorHistoryTripKey=tripKey;viatorRecommendationHistory=loadViatorHistory(tripKey);window.tripFiverViatorData=null;}
  host.classList.remove('hidden');host.innerHTML='<div class="experience-loading">Finding personalized experiences for your trip…</div>';
  const destination=String(currentTrip.destinations||'').split(/[;\n]/)[0].trim();
  try{
    const d=await fetchJsonWithTimeout('/api/viator/recommendations',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...currentTrip,itinerary:currentItinerary,excludeViatorProductCodes:viatorRecommendationHistory,limit:3})
    },10000);
    if(!(d.recommendations||[]).length)throw new Error('No personalized Viator recommendations returned');
    renderViatorExperiences(d);
    return;
  }catch(err){
    console.warn('[TripFiver Viator] personalized recommendations unavailable; using destination fallback',err);
  }
  try{
    const d=await fetchJsonWithTimeout('/api/viator/activities?destination='+encodeURIComponent(destination)+'&limit=3&currency=USD',{},10000);
    if(!(d.products||[]).length)throw new Error('No Viator fallback products returned');
    renderViatorExperiences({provider:'Viator',recommendations:d.products||[],dayMatches:[]});
  }catch(err){
    console.warn('[TripFiver Viator] destination fallback unavailable',err);
    host.classList.remove('hidden');
    host.innerHTML='<div class="experience-loading">Experiences could not load right now. <button type="button" class="secondary" id="retryViator">Try again</button></div>';
    $('#retryViator')?.addEventListener('click',loadViatorExperiences,{once:true});
  }
}
function renderProposal(it){
  currentItinerary=it;
  $('#proposalTitle').textContent=it.title||'Your Trip';
  $('#proposalSummary').textContent=it.summary||'';
  $('#budgetNote').textContent=it.estimatedBudgetNote||'';
  $('#days').innerHTML=(it.days||[]).map((d,index)=>{
    const highlights=[...(d.morning||[]),...(d.afternoon||[]),...(d.evening||[])].map(compactHighlight).filter(Boolean).slice(0,3);
    const restaurant=(d.restaurants||[])[0];
    return `<details class="day-card consumer-day" data-day="${escapeHtml(d.day)}">
      <summary>
        <div class="consumer-day-main"><div class="day-meta">DAY ${escapeHtml(d.day)} · ${escapeHtml(d.location||'')}</div><h3>${escapeHtml(d.title||'')}</h3><div class="day-highlights">${highlights.map(x=>`<span>${escapeHtml(x)}</span>`).join('')}</div>${restaurant?`<div class="day-restaurant">🍽 ${escapeHtml(restaurant.name||'Restaurant pick')}${restaurant.rating?` · ★ ${escapeHtml(restaurant.rating)}`:''}</div>`:''}</div>
        <span class="day-toggle">View day ▾</span>
      </summary>
      <div class="day-details">${photoMarkup(d,index)}<div class="day-columns"><div class="day-block"><strong>Morning</strong><ul>${listHtml(d.morning)}</ul></div><div class="day-block"><strong>Afternoon</strong><ul>${listHtml(d.afternoon)}</ul></div><div class="day-block"><strong>Evening</strong><ul>${listHtml(d.evening)}</ul></div></div>${(d.restaurants||[]).length?`<div class="restaurant-picks"><strong>Restaurant picks</strong><ul>${d.restaurants.map(r=>`<li><b>${escapeHtml(r.meal||'Meal')}: ${escapeHtml(r.name||'Restaurant')}</b>${r.rating?` · ★ ${escapeHtml(r.rating)}`:''}${r.priceLevel?` · ${escapeHtml(r.priceLevel.replace('PRICE_LEVEL_','').toLowerCase().replaceAll('_',' '))}`:''}${r.reason?` — ${escapeHtml(r.reason)}`:''}${r.googleMapsUri?` <a href="${escapeHtml(r.googleMapsUri)}" target="_blank" rel="noopener">Google Maps</a>`:''}</li>`).join('')}</ul></div>`:''}${(d.advisorNotes||[]).length?`<div class="advisor-note"><strong>Travel tip:</strong> ${escapeHtml(d.advisorNotes.join(' · '))}</div>`:''}</div>
    </details>`;
  }).join('');
  document.querySelectorAll('.consumer-day').forEach(card=>card.addEventListener('toggle',()=>{const t=card.querySelector('.day-toggle');if(t)t.textContent=card.open?'Hide day ▴':'View day ▾';}));
  $('#verifyList').innerHTML=listHtml(it.verifyBeforeSending);
  $('#questionsList').innerHTML=listHtml(it.followUpQuestions);
  applyBrand();$('#proposal').classList.remove('hidden');bindPhotoControls();bindExpediaConversionTracking();
  // Fast-first render: the itinerary is complete at this point. Secondary
  // enrichment must never delay or block the traveler from using it.
  requestAnimationFrame(()=>{
    loadProposalPhotos();
    setTimeout(()=>loadViatorExperiences(),0);
  });
}
async function readNdjsonStream(response,onEvent){if(!response.ok&&!response.body){throw new Error(`Request failed (${response.status})`);}const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let nl;while((nl=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,nl).trim();buffer=buffer.slice(nl+1);if(!line)continue;let evt;try{evt=JSON.parse(line);}catch{continue;}onEvent(evt);}}if(buffer.trim()){try{onEvent(JSON.parse(buffer.trim()));}catch{}}}
$('#tripForm').addEventListener('submit',async e=>{e.preventDefault();const data=formData();if(currentItinerary&&currentTrip&&String(currentTrip.destinations||'').trim().toLowerCase()===String(data.destinations||'').trim().toLowerCase()){data.previousItinerary=currentItinerary;}currentTrip={...data};delete currentTrip.previousItinerary;const btn=$('#generateBtn'),status=$('#generatorStatus');btn.disabled=true;btn.textContent='✦ Creating Your Trip…';status.classList.remove('hidden');status.classList.add('trip-progress');const steps=['✈️ Building your personalized trip…','🗺️ Organizing the best route for each day…','🍽️ Finding restaurant recommendations…','✨ Matching experiences to your interests…','📸 Preparing your destination itinerary…','🧳 Putting the finishing touches on your trip…'];let step=0,finalEvent=null;status.innerHTML=`<div class="trip-progress-spinner"></div><div><strong>${steps[0]}</strong><span>Please stay with us — your personalized itinerary is being prepared.</span></div>`;status.scrollIntoView({behavior:'smooth',block:'center'});const timer=setInterval(()=>{step=(step+1)%steps.length;const strong=status.querySelector('strong');if(strong)strong.textContent=steps[step];},2200);try{const r=await fetch('/api/generate-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});await readNdjsonStream(r,evt=>{if(evt.type==='progress'){const strong=status.querySelector('strong');if(strong)strong.textContent=evt.message||'Building your itinerary…';}else if(evt.type==='done'){finalEvent=evt;}else if(evt.type==='error'){throw new Error(evt.error||'Generation failed');}});if(!finalEvent)throw new Error('No completed proposal was returned.');clearInterval(timer);renderProposal(finalEvent.itinerary);trackConversion('trip_created',{source:'ai-trip-plan'});if(finalEvent.timing)console.info('TripFiver generation timing',finalEvent.timing);status.classList.remove('trip-progress');status.classList.add('hidden');status.innerHTML='';$('#proposal').scrollIntoView({behavior:'smooth',block:'start'});}catch(err){clearInterval(timer);status.classList.remove('trip-progress');status.textContent='We could not create your trip right now. Please try again.';}finally{btn.disabled=false;btn.textContent='✦ Create My AI Trip Plan';}});
$('#translateProposal').onclick=async()=>{syncProposalEdits();const language=$('#translateLanguage').value;if(!currentItinerary){$('#generatorStatus').classList.remove('hidden');$('#generatorStatus').textContent='Generate a proposal before translating.';return;}if(!language){$('#generatorStatus').classList.remove('hidden');$('#generatorStatus').textContent='Choose a language in “Translate to…” first.';return;}const btn=$('#translateProposal');btn.disabled=true;btn.textContent='Translating…';$('#generatorStatus').classList.remove('hidden');let chars=0,finalEvent=null;const started=Date.now();$('#generatorStatus').textContent=`Starting fast translation to ${language}…`;try{const r=await fetch('/api/translate-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itinerary:currentItinerary,language})});await readNdjsonStream(r,evt=>{if(evt.type==='delta'){chars+=evt.delta?.length||0;const secs=Math.max(1,Math.round((Date.now()-started)/1000));$('#generatorStatus').textContent=`Translating to ${language}… ${chars.toLocaleString('en-US')} characters received · ${secs}s`;}else if(evt.type==='done'){finalEvent=evt;}else if(evt.type==='error'){throw new Error(evt.error||'Translation failed');}});if(!finalEvent)throw new Error('No completed translation was returned.');renderProposal(finalEvent.itinerary);currentTrip={...(currentTrip||{}),proposalLanguage:language};$('#proposalLanguage').value=[...$('#proposalLanguage').options].some(o=>o.value===language)?language:'Other';if($('#proposalLanguage').value==='Other')$('#customLanguage').value=language;updateLanguageField();$('#generatorStatus').textContent=`Proposal translated to ${language}. Review the wording before sending.`;}catch(err){$('#generatorStatus').textContent='Translation error: '+err.message;}finally{btn.disabled=false;btn.textContent='AI Translate';}};
$('#printProposal').onclick=()=>{syncProposalEdits();applyBrand();window.print();};
$('#saveTrip').onclick=async()=>{syncProposalEdits();if(!currentTrip||!currentItinerary)return;const payload={...currentTrip,itinerary:currentItinerary,title:currentItinerary.title,photos:Object.fromEntries(photoState)};const existingId=currentTrip.id;const r=await fetch(existingId?`/api/trips/${existingId}`:'/api/trips',{method:existingId?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(r.ok){const saved=await r.json();currentTrip={...currentTrip,...saved};$('#saveTrip').textContent='✓ Saved';setTimeout(()=>$('#saveTrip').textContent='Save Trip',1200);await loadTrips();}};
function getBrand(){try{return JSON.parse(localStorage.getItem('voyagedesk-brand')||'{}');}catch{return{};}}
function setBrand(b){localStorage.setItem('voyagedesk-brand',JSON.stringify(b));applyBrand();loadBrandForm();}
function applyBrand(){
  const b=getBrand(),name=b.name||'TripFiver',advisor=b.advisor||'Travel Advisor',tagline=b.tagline||'Your journey. Our expertise.';
  $('#brandNamePrint').textContent=name;
  $('#brandContactPrint').textContent=[advisor,b.email,b.phone,b.website,b.address].filter(Boolean).join(' · ');
  if($('#sidebarAgencyName'))$('#sidebarAgencyName').textContent=name;if($('#sidebarAdvisor'))$('#sidebarAdvisor').textContent=advisor;if($('#sidebarTagline'))$('#sidebarTagline').textContent=tagline;
  if($('#sidebarPhone'))$('#sidebarPhone').textContent=b.phone?`☎ ${b.phone}`:'☎ Add phone';if($('#sidebarEmail'))$('#sidebarEmail').textContent=b.email?`✉ ${b.email}`:'✉ Add email';if($('#sidebarWebsite'))$('#sidebarWebsite').textContent=b.website?`◎ ${b.website}`:'◎ Add website';if($('#sidebarAddress'))$('#sidebarAddress').textContent=b.address?`⌖ ${b.address}`:'⌖ Add address';
  const logo=b.logo||'';
  for(const id of ['brandLogoPrint','sidebarLogo','settingsLogoPreview']){const el=$('#'+id);if(!el)continue;if(logo){el.src=logo;el.classList.remove('hidden');}else{el.removeAttribute('src');el.classList.add('hidden');}}
  $('#sidebarLogoPlaceholder')?.classList.toggle('hidden',!!logo);$('#settingsLogoPlaceholder')?.classList.toggle('hidden',!!logo);$('#removeLogo')?.classList.toggle('hidden',!logo);
}
function loadBrandForm(){const b=getBrand();$('#brandName').value=b.name||'';$('#advisorName').value=b.advisor||'';$('#brandEmail').value=b.email||'';$('#brandPhone').value=b.phone||'';$('#brandWebsite').value=b.website||'';$('#brandAddress').value=b.address||'';$('#brandTagline').value=b.tagline||'';$('#defaultLanguage').value=b.defaultLanguage||'English';$('#defaultCurrency').value=b.defaultCurrency||'USD';applyBrand();}
async function saveBrandForm(){const old=getBrand();const profile={...old,name:$('#brandName').value.trim(),advisor:$('#advisorName').value.trim(),email:$('#brandEmail').value.trim(),phone:$('#brandPhone').value.trim(),website:$('#brandWebsite').value.trim(),address:$('#brandAddress').value.trim(),tagline:$('#brandTagline').value.trim(),defaultLanguage:$('#defaultLanguage').value||'English',defaultCurrency:$('#defaultCurrency').value||'USD'};setBrand(profile);if(cloudEnabled&&currentUser){const r=await fetch('/api/agency-profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(profile)});if(!r.ok){const d=await r.json().catch(()=>({}));alert(d.error||'Branding saved locally, but cloud save failed.');}}applyTripDefaults();$('#saveBrand').textContent='✓ Saved';setTimeout(()=>$('#saveBrand').textContent='Save Branding',1400);}
$('#saveBrand').onclick=saveBrandForm;
$('#sidebarBrandEdit')?.addEventListener('click',()=>setView('settings'));$('#sidebarContactEdit')?.addEventListener('click',()=>setView('settings'));
$('#changeLogo')?.addEventListener('click',()=>$('#logoFile')?.click());$('#settingsChooseLogo')?.addEventListener('click',()=>$('#logoFile')?.click());
$('#logoFile')?.addEventListener('change',e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>2*1024*1024){alert('Please choose a logo smaller than 2 MB.');e.target.value='';return;}const reader=new FileReader();reader.onload=()=>{const b=getBrand();setBrand({...b,logo:reader.result});};reader.readAsDataURL(file);e.target.value='';});
function removeLogo(){const b=getBrand();delete b.logo;setBrand(b);}$('#removeLogo')?.addEventListener('click',removeLogo);$('#settingsRemoveLogo')?.addEventListener('click',removeLogo);

async function loadCloudBrand(){
  if(!cloudEnabled||!currentUser)return;
  try{const r=await fetch('/api/agency-profile');if(r.ok){const p=await r.json();if(p&&!p.local&&Object.keys(p).length){setBrand(p);}}}catch{}
}
function clientRow(c){return `<tr><td><strong>${escapeHtml(c.name||'—')}</strong></td><td><span>${escapeHtml(c.email||'')}</span><small>${escapeHtml(c.phone||'')}</small></td><td>${escapeHtml(c.language||'—')}</td><td>${escapeHtml(c.currency||'—')}</td><td class="client-notes-cell">${escapeHtml(c.notes||'—')}</td><td><div class="row-actions"><button type="button" data-client-trip="${escapeHtml(c.id)}">New Trip</button><button type="button" data-client-edit="${escapeHtml(c.id)}">Edit</button><button type="button" class="danger" data-client-delete="${escapeHtml(c.id)}">Delete</button></div></td></tr>`;}
function renderClients(){
  const q=norm($('#clientSearch')?.value||'');const rows=clientsCache.filter(c=>!q||norm(`${c.name} ${c.email} ${c.phone} ${c.notes}`).includes(q));
  $('#clientsTable').innerHTML=rows.map(clientRow).join('');$('#clientsEmpty').classList.toggle('hidden',rows.length>0);refreshTripClientSelect();
  $$('[data-client-edit]').forEach(b=>b.onclick=()=>openClientEditor(clientsCache.find(c=>c.id===b.dataset.clientEdit)));
  $$('[data-client-delete]').forEach(b=>b.onclick=()=>deleteClient(b.dataset.clientDelete));
  $$('[data-client-trip]').forEach(b=>b.onclick=()=>{setView('new');$('#tripClientSelect').value=b.dataset.clientTrip;$('#tripClientSelect').dispatchEvent(new Event('change'));window.scrollTo({top:0,behavior:'smooth'});});
}
async function loadClients(){
  if(!cloudEnabled){clientsCache=[];$('#clientCloudNotice').classList.remove('hidden');renderClients();return;}
  $('#clientCloudNotice').classList.add('hidden');const r=await fetch('/api/clients');if(!r.ok){clientsCache=[];renderClients();return;}clientsCache=await r.json();renderClients();
}
function openClientEditor(c=null){$('#clientEditor').classList.remove('hidden');$('#clientEditorTitle').textContent=c?'Edit Client':'Add Client';$('#clientId').value=c?.id||'';$('#clientName').value=c?.name||'';$('#clientEmail').value=c?.email||'';$('#clientPhone').value=c?.phone||'';$('#clientLanguage').value=c?.language||getBrand().defaultLanguage||'English';$('#clientCurrency').value=c?.currency||getBrand().defaultCurrency||'USD';$('#clientNotes').value=c?.notes||'';$('#clientEditor').scrollIntoView({behavior:'smooth'});}
$('#newClientBtn')?.addEventListener('click',()=>{if(!cloudEnabled)return alert('Configure Supabase cloud storage first to save client records.');openClientEditor();});
$('#closeClientEditor')?.addEventListener('click',()=>$('#clientEditor').classList.add('hidden'));
$('#clientSearch')?.addEventListener('input',renderClients);
$('#saveClientBtn')?.addEventListener('click',async()=>{if(!cloudEnabled)return;const id=$('#clientId').value;const body={name:$('#clientName').value.trim(),email:$('#clientEmail').value.trim(),phone:$('#clientPhone').value.trim(),language:$('#clientLanguage').value.trim(),currency:$('#clientCurrency').value.trim().toUpperCase(),notes:$('#clientNotes').value.trim()};if(!body.name)return alert('Client name is required.');const r=await fetch(id?`/api/clients/${id}`:'/api/clients',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)return alert(d.error||'Could not save client.');$('#clientEditor').classList.add('hidden');await loadClients();});
async function deleteClient(id){const c=clientsCache.find(x=>x.id===id);if(!c||!confirm(`Delete ${c.name}? Existing trips will remain.`))return;const r=await fetch(`/api/clients/${id}`,{method:'DELETE'});if(!r.ok)return alert('Could not delete client.');await loadClients();}

loadBrandForm();applyTripDefaults();

// Keep agent edits synchronized with the itinerary object so Save Trip and PDF use the advisor's words.
function syncProposalEdits(){if(!currentItinerary)return;currentItinerary.title=$('#proposalTitle').innerText.trim();currentItinerary.summary=$('#proposalSummary').innerText.trim();currentItinerary.estimatedBudgetNote=$('#budgetNote').innerText.trim();}
['proposalTitle','proposalSummary','budgetNote'].forEach(id=>$('#'+id).addEventListener('input',syncProposalEdits));
let savedTripsCache=[];
function tripDateLabel(t){return t.dates||[t.departureDate,t.returnDate].filter(Boolean).join(' – ')||'—';}
function tripUpdatedLabel(t){const raw=t.updatedAt||t.createdAt;if(!raw)return'—';try{return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date(raw));}catch{return raw;}}
function tripRow(t){
  const archived=(t.status||'Draft')==='Archived';
  return `<tr>
    <td><strong>${escapeHtml(t.clientName||'—')}</strong><small>${escapeHtml(t.title||'Untitled trip')}</small></td>
    <td>${escapeHtml(t.destinations||'—')}</td>
    <td>${escapeHtml(tripDateLabel(t))}</td>
    <td>${escapeHtml(t.budget||'—')}</td>
    <td><select class="trip-status-select" data-trip-status="${escapeHtml(t.id)}">${['Draft','Sent','Approved','Booked','Completed','Archived'].map(s=>`<option ${s===(t.status||'Draft')?'selected':''}>${s}</option>`).join('')}</select></td>
    <td>${escapeHtml(tripUpdatedLabel(t))}</td>
    <td><div class="row-actions"><button type="button" data-trip-open="${escapeHtml(t.id)}">Open</button><button type="button" data-trip-duplicate="${escapeHtml(t.id)}">Duplicate</button><button type="button" data-trip-archive="${escapeHtml(t.id)}">${archived?'Restore':'Archive'}</button><button type="button" class="danger" data-trip-delete="${escapeHtml(t.id)}">Delete</button></div></td>
  </tr>`;
}
function renderTripManager(){
  const q=norm($('#tripSearch')?.value||''),status=$('#tripStatusFilter')?.value||'';
  const trips=savedTripsCache.filter(t=>(!status||(t.status||'Draft')===status)&&(!q||norm(`${t.clientName||''} ${t.title||''} ${t.destinations||''} ${t.dates||''} ${t.budget||''}`).includes(q)));
  $('#allTrips').innerHTML=trips.map(tripRow).join('');
  $('#tripEmpty')?.classList.toggle('hidden',trips.length>0);
  bindTripActions();
}
function restorePhotos(t){
  photoState.clear();
  const photos=t.photos||{};
  for(const [k,v] of Object.entries(photos))photoState.set(Number(k),v);
  if(t.addPhotos&&t.itinerary?.days){setTimeout(()=>{for(const [k,v] of photoState.entries())renderDayPhoto(Number(k),v);},50);}
}
function openSavedTrip(id){
  const t=savedTripsCache.find(x=>x.id===id);if(!t)return;
  currentTrip={...t};currentItinerary=t.itinerary||null;
  if(!currentItinerary){alert('This saved trip does not contain a proposal yet.');return;}
  renderProposal(currentItinerary);restorePhotos(t);setView('new');$('#proposal').scrollIntoView({behavior:'smooth'});$('#saveTrip').textContent='Save Changes';
}
async function updateTrip(id,patch){const r=await fetch(`/api/trips/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});if(!r.ok)throw new Error('Could not update trip');await loadTrips();}
async function duplicateTrip(id){
  const t=savedTripsCache.find(x=>x.id===id);if(!t)return;
  const copy={...t};delete copy.id;delete copy.createdAt;delete copy.updatedAt;copy.clientName=`${t.clientName||'Client'} — Copy`;copy.title=`${t.title||'Trip'} — Copy`;copy.status='Draft';
  const r=await fetch('/api/trips',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(copy)});if(!r.ok)return alert('Could not duplicate trip.');await loadTrips();
}
async function deleteTrip(id){const t=savedTripsCache.find(x=>x.id===id);if(!t)return;if(!confirm(`Delete ${t.clientName||'this trip'}? This cannot be undone.`))return;const r=await fetch(`/api/trips/${id}`,{method:'DELETE'});if(!r.ok)return alert('Could not delete trip.');await loadTrips();}
function bindTripActions(){
  $$('[data-trip-open]').forEach(b=>b.onclick=()=>openSavedTrip(b.dataset.tripOpen));
  $$('[data-trip-duplicate]').forEach(b=>b.onclick=()=>duplicateTrip(b.dataset.tripDuplicate));
  $$('[data-trip-delete]').forEach(b=>b.onclick=()=>deleteTrip(b.dataset.tripDelete));
  $$('[data-trip-archive]').forEach(b=>b.onclick=()=>{const t=savedTripsCache.find(x=>x.id===b.dataset.tripArchive);updateTrip(t.id,{status:(t.status||'Draft')==='Archived'?'Draft':'Archived'});});
  $$('[data-trip-status]').forEach(s=>s.onchange=()=>updateTrip(s.dataset.tripStatus,{status:s.value}));
}
$('#tripSearch')?.addEventListener('input',renderTripManager);$('#tripStatusFilter')?.addEventListener('change',renderTripManager);
async function loadTrips(){const r=await fetch('/api/trips');savedTripsCache=await r.json();$('#tripCount').textContent=savedTripsCache.length;$('#draftCount').textContent=savedTripsCache.filter(t=>(t.status||'Draft')==='Draft').length;renderTripManager();$('#recentTrips').innerHTML=savedTripsCache.length?savedTripsCache.slice(0,4).map(t=>`<div class="trip-row clickable" data-recent-open="${escapeHtml(t.id)}"><div><strong>${escapeHtml(t.title||t.clientName||'Untitled trip')}</strong><small>${escapeHtml(t.clientName||'')}</small></div><div>${escapeHtml(t.destinations||'')}</div><div>${escapeHtml(tripDateLabel(t))}</div><span class="status-pill">${escapeHtml(t.status||'Draft')}</span></div>`).join(''):'No trips yet.';$$('[data-recent-open]').forEach(x=>x.onclick=()=>openSavedTrip(x.dataset.recentOpen));}
async function status(){try{const r=await fetch('/api/status'),s=await r.json();cloudEnabled=!!s.supabase;$('#providerStatus').textContent=`OpenAI ${s.openai?'connected':'not connected'} · Amadeus ${s.amadeus?'connected':'not connected'} · Cloud ${s.supabase?'connected':'local mode'}`;$('#liveStatus').textContent=s.amadeus?'Ready':'Setup';$('#storageBadge').textContent=s.supabase?'CLOUD':'LOCAL';$('#storageBadge').classList.toggle('cloud',!!s.supabase);$('#cloudModeLabel').textContent=s.supabase?'Private cloud account':'Local prototype mode';return s;}catch{return {supabase:false};}}
async function initializeSignedInWorkspace(){const ok=await verifyCloudSession();if(!ok)return;await loadCloudBrand();loadBrandForm();applyTripDefaults();await Promise.all([loadTrips(),loadClients()]);}
async function initApp(){await status();const ok=await verifyCloudSession();if(!ok)return;if(currentUser){await loadCloudBrand();loadBrandForm();applyTripDefaults();await Promise.all([loadTrips(),loadClients()]);}else{$('#authGate')?.classList.add('hidden');$('#logoutBtn')?.classList.add('hidden');applyTripDefaults();}}
initApp();


// v0.4 consumer home shortcuts
function setupQuickCityField(id){
  const input=$('#'+id),box=$(`.suggestions[data-quick-for="${id}"]`);if(!input||!box)return;
  const close=()=>box.classList.remove('open');
  const update=()=>{
    const items=cityMatches(input.value);
    box.innerHTML=items.map((x,i)=>`<div class="suggestion" data-index="${i}"><span class="suggestion-main"><strong>${escapeHtml(x.city)}</strong><small>${escapeHtml(x.region)}, ${escapeHtml(x.country)}</small></span><span class="suggestion-code">${escapeHtml(x.cityCode)}</span></div>`).join('');
    box.classList.toggle('open',items.length>0);
    [...box.children].forEach((row,i)=>row.onmousedown=e=>{e.preventDefault();input.value=locationLabel(items[i]);close();});
  };
  input.addEventListener('input',update);input.addEventListener('focus',update);input.addEventListener('blur',()=>setTimeout(close,120));
}
setupQuickCityField('quickOrigin');
setupQuickCityField('quickDestination');
function openPlannerWithQuickValues(destination='',origin='',departure='',returnDate=''){
  const form=$('#tripForm');
  if(!form)return;
  if(destination){
    form.elements.destinations.value=destination;
    const match=cityMatches(destination)[0];
    form.elements.destinationCode.value=match?.cityCode||match?.airports?.[0]?.[0]||'';
  }
  if(origin){
    form.elements.departureCity.value=origin;
    const match=cityMatches(origin)[0];
    form.elements.originCode.value=match?.airports?.[0]?.[0]||match?.cityCode||'';
  }
  if(departure)form.elements.departureDate.value=departure;
  if(returnDate)form.elements.returnDate.value=returnDate;
  setView('new');
  requestAnimationFrame(()=>{
    document.querySelector('#new')?.scrollIntoView({behavior:'smooth',block:'start'});
    form.elements.destinations?.focus();
  });
}
$('#quickCreate')?.addEventListener('click',e=>{
  e.preventDefault();
  openPlannerWithQuickValues(
    $('#quickDestination')?.value.trim()||'',
    $('#quickOrigin')?.value.trim()||'',
    $('#quickDepart')?.value||'',
    $('#quickReturn')?.value||''
  );
});
$$('[data-destination]').forEach(card=>card.addEventListener('click',()=>openPlannerWithQuickValues(card.dataset.destination)));
$$('.nav-coming').forEach(btn=>btn.addEventListener('click',()=>alert('This feature is planned for a future TripFiver update.')));
