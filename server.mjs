import http from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Load a local .env file automatically so Windows users do not need to
// re-enter environment variables every time VoyageDesk starts. Existing
// shell environment variables take priority over values in .env.
async function loadLocalEnv(){
  try{
    const envPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'.env');
    const text=await readFile(envPath,'utf8');
    for(const rawLine of text.split(/\r?\n/)){
      const line=rawLine.trim();
      if(!line||line.startsWith('#'))continue;
      const eq=line.indexOf('=');
      if(eq<1)continue;
      const key=line.slice(0,eq).trim();
      let value=line.slice(eq+1).trim();
      if((value.startsWith('\"')&&value.endsWith('\"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
      if(process.env[key]===undefined)process.env[key]=value;
    }
  }catch(err){
    if(err?.code!=='ENOENT')console.warn('Could not read .env:',err.message);
  }
}
await loadLocalEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataFile = path.join(__dirname, 'data', 'trips.json');
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const AMADEUS_BASE = process.env.AMADEUS_ENV === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
const PEXELS_BASE = 'https://api.pexels.com/v1';

const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
async function readTrips(){ try{return JSON.parse(await readFile(dataFile,'utf8'));}catch{return [];} }
async function saveTrips(trips){ await writeFile(dataFile,JSON.stringify(trips,null,2)); }
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.includes('json')?JSON.stringify(body):body);}
async function parseBody(req){let body='';for await(const chunk of req)body+=chunk;return body?JSON.parse(body):{};}

function buildPrompt(trip){
  const mode=trip.generationMode==='detailed'?'detailed':'fast';
  const depth=mode==='fast'
    ? '- FAST MODE: Be concise. Use one practical bullet for morning, afternoon, and evening. Keep advisor notes brief. Avoid decorative prose and repetition.'
    : '- DETAILED MODE: Give a richer but practical itinerary. Use up to 2–3 useful bullets per daypart when they add value, with concise advisor notes.';
  return `You are an assistant to a professional travel advisor. Create a practical, polished travel proposal from the client information below.\nRules:\n- Never invent live prices, availability, flight schedules, hotel inventory, opening hours, or booking status.\n- Live flight/hotel results are shown separately by the application.\n- Treat itinerary experiences as advisor suggestions unless externally verified.\n- Respect dietary, accessibility, religious, budget, child, mobility, and scheduling constraints.\n- Keep each day realistic and include morning / afternoon / evening structure.\n- REQUIRED RESTAURANT NAMES: On every full sightseeing day, include at least 2 specific, real restaurant names: normally one lunch option and one dinner option. If dining/food is one of the traveler interests, include 2–3 named restaurant choices for the most relevant lunch/dinner periods. Never write only generic phrases such as "a refined Turkish restaurant", "a seafood restaurant", "a well-reviewed restaurant", or "dinner near the hotel" when a named suggestion can be given. Put each restaurant name directly in the relevant afternoon/evening item and add a short reason it fits the neighborhood and traveler preferences. Prefer established restaurants you know with high confidence. Do not invent restaurant names, reservations, availability, prices, ratings, awards, or opening hours. Clearly tell the traveler to verify current operation, details, and availability before booking.\n- Write every client-facing field in the requested proposal language. Keep airport codes, proper nouns, URLs, and currency codes unchanged where appropriate.\n- Use Anglo-American number formatting in prose: commas for thousands (5,000; 25,000) and a period for decimals (1,250.50). Preserve the selected currency symbol/code.\n${depth}\n- Return ONLY valid JSON matching this shape:\n{"title":"string","summary":"string","estimatedBudgetNote":"string","days":[{"day":1,"title":"string","location":"string","morning":["string"],"afternoon":["string"],"evening":["string"],"advisorNotes":["string"]}],"verifyBeforeSending":["string"],"followUpQuestions":["string"]}\nClient information:\n${JSON.stringify(trip,null,2)}`;
}
function extractOutputText(data){return data?.output_text||data?.output?.flatMap(o=>o.content||[]).find(c=>c.type==='output_text')?.text||'';}
function parseJsonText(text){return JSON.parse(String(text||'').trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim());}
function apiTuning(mode='fast'){return mode==='detailed'?{reasoning:{effort:'low'},text:{verbosity:'medium'}}:{reasoning:{effort:'none'},text:{verbosity:'low'}};}
async function callOpenAI(trip){
  const key=process.env.OPENAI_API_KEY;if(!key)throw new Error('OPENAI_API_KEY is not set.');
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,input:buildPrompt(trip),...apiTuning(trip.generationMode)})});
  const data=await response.json();if(!response.ok)throw new Error(data?.error?.message||'OpenAI request failed');
  const text=extractOutputText(data);if(!text)throw new Error('No itinerary text returned.');
  return parseJsonText(text);
}
async function translateItinerary(itinerary, language){
  const key=process.env.OPENAI_API_KEY;if(!key)throw new Error('OPENAI_API_KEY is not set.');
  if(!language)throw new Error('Choose a translation language.');
  const prompt=`Translate the travel proposal JSON below into ${language}. Preserve the exact JSON structure, array structure, numbers, airport/IATA codes, currency codes, URLs, brand names, and proper nouns when they should not be translated. Translate client-facing prose naturally and concisely for a professional travel proposal. Preserve Anglo-American number formatting: comma thousands separators and period decimals. Return ONLY valid JSON, no markdown.\n\n${JSON.stringify(itinerary)}`;
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,input:prompt,reasoning:{effort:'none'},text:{verbosity:'low'}})});
  const data=await response.json();if(!response.ok)throw new Error(data?.error?.message||'OpenAI translation failed');
  const text=extractOutputText(data);if(!text)throw new Error('No translation returned.');
  return parseJsonText(text);
}
async function streamOpenAIJson(res,{prompt,mode='fast',donePayload}){
  const key=process.env.OPENAI_API_KEY;if(!key)throw new Error('OPENAI_API_KEY is not set.');
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,input:prompt,stream:true,...apiTuning(mode)})});
  if(!r.ok){const data=await r.json().catch(()=>({}));throw new Error(data?.error?.message||'OpenAI request failed');}
  const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='',text='',completedText='';
  const emit=obj=>res.write(JSON.stringify(obj)+'\n');
  while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let split;while((split=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,split);buffer=buffer.slice(split+2);for(const line of event.split('\n')){if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(!raw||raw==='[DONE]')continue;let data;try{data=JSON.parse(raw);}catch{continue;}if(data.type==='response.output_text.delta'&&typeof data.delta==='string'){text+=data.delta;emit({type:'delta',delta:data.delta});}if(data.type==='response.completed'&&data.response){completedText=extractOutputText(data.response)||completedText;}if(data.type==='error')throw new Error(data.message||data.error?.message||'OpenAI streaming error');}}}
  const finalText=text||completedText;if(!finalText)throw new Error('No AI text returned.');
  emit({type:'done',...donePayload(parseJsonText(finalText))});
}
function demoItinerary(trip){const destination=trip.destinations||'the destination';const client=trip.clientName||'Client';return{title:`${client} — ${destination} Journey`,summary:`A sample itinerary for ${trip.travelers||'the travelers'}. Live inventory is displayed separately when a travel provider is connected.`,estimatedBudgetNote:trip.budget?`Target budget: ${trip.budget}. Verify all live inventory before quoting.`:'Confirm the trip budget before quoting.',days:[1,2,3].map(d=>({day:d,title:d===1?'Arrival & Easy Introduction':d===2?'Signature Experiences':'Flexible Local Discovery',location:destination,morning:[d===1?'Arrival, transfer, and hotel check-in or luggage drop.':'Begin with one high-priority client interest.'],afternoon:['Allow time for lunch, transit, and one primary sightseeing experience.'],evening:['Recommend a relaxed dinner and optional neighborhood walk or cultural activity.'],advisorNotes:['Verify reservations, local transportation, dietary requirements, and current details.']})),verifyBeforeSending:['Flight schedules and fares','Hotel availability and cancellation terms','Attraction hours/tickets','Restaurant hours and dietary requirements'],followUpQuestions:['Would the client prefer a faster or more relaxed pace?','Are there any must-do experiences?']};}

let tokenCache={token:null,expiresAt:0};
async function amadeusToken(){
  const id=process.env.AMADEUS_API_KEY, secret=process.env.AMADEUS_API_SECRET;
  if(!id||!secret)throw new Error('Amadeus credentials are not configured. Add AMADEUS_API_KEY and AMADEUS_API_SECRET.');
  if(tokenCache.token && Date.now()<tokenCache.expiresAt-60000)return tokenCache.token;
  const body=new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret});
  const r=await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  const data=await r.json();if(!r.ok)throw new Error(data?.error_description||data?.errors?.[0]?.detail||'Amadeus authentication failed');
  tokenCache={token:data.access_token,expiresAt:Date.now()+(data.expires_in||1800)*1000};return tokenCache.token;
}
async function amadeusGet(endpoint,params){const token=await amadeusToken();const u=new URL(`${AMADEUS_BASE}${endpoint}`);Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,String(v));});const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`}});const data=await r.json();if(!r.ok)throw new Error(data?.errors?.[0]?.detail||data?.error_description||'Amadeus request failed');return data;}

function mapFlight(f){const first=f.itineraries?.[0]?.segments?.[0];const last=f.itineraries?.[0]?.segments?.at(-1);return{id:f.id,price:Number(f.price?.grandTotal||f.price?.total||0),currency:f.price?.currency||'',airline:(f.validatingAirlineCodes||[])[0]||first?.carrierCode||'',origin:first?.departure?.iataCode||'',destination:last?.arrival?.iataCode||'',departure:first?.departure?.at||'',arrival:last?.arrival?.at||'',stops:Math.max(0,(f.itineraries?.[0]?.segments?.length||1)-1),duration:f.itineraries?.[0]?.duration||'',raw:f};}
async function liveFlights(q){const data=await amadeusGet('/v2/shopping/flight-offers',{originLocationCode:q.origin,destinationLocationCode:q.destination,departureDate:q.departureDate,returnDate:q.returnDate,adults:q.adults||1,children:q.children||0,currencyCode:q.currency||'USD',max:q.max||8});return(data.data||[]).map(mapFlight);}

async function liveHotels(q){
  let hotelIds=q.hotelIds;
  if(!hotelIds){const list=await amadeusGet('/v1/reference-data/locations/hotels/by-city',{cityCode:q.cityCode,radius:q.radius||20,radiusUnit:'KM',hotelSource:'ALL'});hotelIds=(list.data||[]).slice(0,20).map(h=>h.hotelId).join(',');}
  if(!hotelIds)return [];
  const data=await amadeusGet('/v3/shopping/hotel-offers',{hotelIds,adults:q.adults||1,checkInDate:q.checkInDate,checkOutDate:q.checkOutDate,currency:q.currency||'USD',bestRateOnly:'true'});
  return(data.data||[]).map(x=>{const offer=x.offers?.[0]||{};return{id:x.hotel?.hotelId,name:x.hotel?.name||'Hotel',cityCode:x.hotel?.cityCode||q.cityCode,price:Number(offer.price?.total||offer.price?.base||0),currency:offer.price?.currency||q.currency||'USD',room:offer.room?.typeEstimated?.category||offer.room?.description?.text||'',checkInDate:offer.checkInDate,checkOutDate:offer.checkOutDate,available:offer.available!==false};});
}


async function pexelsSearch(query, perPage=6){
  const key=process.env.PEXELS_API_KEY;
  if(!key)throw new Error('Pexels is not connected. Add PEXELS_API_KEY to enable destination photos.');
  const u=new URL(`${PEXELS_BASE}/search`);
  u.searchParams.set('query',query);
  u.searchParams.set('orientation','landscape');
  u.searchParams.set('per_page',String(Math.min(12,Math.max(1,Number(perPage)||6))));
  const r=await fetch(u,{headers:{Authorization:key}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data?.error||`Pexels request failed (${r.status})`);
  return (data.photos||[]).map(p=>({
    id:p.id,
    width:p.width,
    height:p.height,
    alt:p.alt||query,
    photographer:p.photographer||'Pexels photographer',
    photographerUrl:p.photographer_url||'https://www.pexels.com',
    pexelsUrl:p.url||'https://www.pexels.com',
    src:p.src?.large2x||p.src?.large||p.src?.medium||''
  }));
}


const SUPABASE_URL=(process.env.SUPABASE_URL||'').trim().replace(/\/$/,'');
const SUPABASE_KEY=(process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'').trim();
const CLOUD_ENABLED=!!(SUPABASE_URL&&SUPABASE_KEY);
function bearer(req){const h=req.headers.authorization||'';return h.startsWith('Bearer ')?h.slice(7):'';}
async function supaFetch(endpoint,{method='GET',token='',body,headers={}}={}){
  if(!CLOUD_ENABLED)throw new Error('Supabase cloud is not configured.');
  const r=await fetch(`${SUPABASE_URL}${endpoint}`,{method,headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token||SUPABASE_KEY}`,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data=text;}
  if(!r.ok)throw new Error(data?.msg||data?.message||data?.error_description||data?.error||`Supabase request failed (${r.status})`);
  return {data,response:r};
}
async function cloudUser(req){
  const token=bearer(req);if(!token)throw new Error('Sign in is required.');
  const {data}=await supaFetch('/auth/v1/user',{token});if(!data?.id)throw new Error('Your session is no longer valid. Please sign in again.');
  return {token,user:data};
}
function tripRowToApp(row){return {...(row.data||{}),id:row.id,status:row.status||row.data?.status||'Draft',title:row.title||row.data?.title,clientName:row.client_name||row.data?.clientName,destinations:row.destination||row.data?.destinations,dates:row.travel_dates||row.data?.dates,budget:row.budget||row.data?.budget,createdAt:row.created_at,updatedAt:row.updated_at};}
function clientRowToApp(row){return {id:row.id,name:row.name,email:row.email||'',phone:row.phone||'',language:row.language||'',currency:row.currency||'',notes:row.notes||'',preferences:row.preferences||{},createdAt:row.created_at,updatedAt:row.updated_at};}
async function cloudTrips(req){
  const {token}=await cloudUser(req);
  const {data}=await supaFetch('/rest/v1/trips?select=*&order=updated_at.desc.nullslast,created_at.desc',{token});
  return (data||[]).map(tripRowToApp);
}
async function cloudCreateTrip(req,body){
  const {token,user}=await cloudUser(req);
  const row={user_id:user.id,client_id:body.clientId||null,title:body.title||body.clientName||'Untitled trip',client_name:body.clientName||'',destination:body.destinations||'',travel_dates:body.dates||'',budget:body.budget||'',status:body.status||'Draft',data:body};
  const {data}=await supaFetch('/rest/v1/trips',{method:'POST',token,body:row,headers:{Prefer:'return=representation'}});
  return tripRowToApp(data?.[0]||row);
}
async function cloudUpdateTrip(req,id,body){
  const {token}=await cloudUser(req);
  const row={title:body.title||body.clientName||'Untitled trip',client_id:body.clientId||null,client_name:body.clientName||'',destination:body.destinations||'',travel_dates:body.dates||'',budget:body.budget||'',status:body.status||'Draft',data:body,updated_at:new Date().toISOString()};
  const {data}=await supaFetch(`/rest/v1/trips?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',token,body:row,headers:{Prefer:'return=representation'}});
  if(!data?.length)throw new Error('Trip not found or access denied.');
  return tripRowToApp(data[0]);
}
async function cloudDeleteTrip(req,id){const {token}=await cloudUser(req);await supaFetch(`/rest/v1/trips?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',token,headers:{Prefer:'return=minimal'}});return {deleted:true,id};}
async function cloudClients(req){
  const {token}=await cloudUser(req);const {data}=await supaFetch('/rest/v1/clients?select=*&order=updated_at.desc.nullslast,created_at.desc',{token});
  return (data||[]).map(clientRowToApp);
}
async function cloudCreateClient(req,body){
  const {token,user}=await cloudUser(req);const row={user_id:user.id,name:body.name||'',email:body.email||null,phone:body.phone||null,language:body.language||null,currency:body.currency||null,notes:body.notes||null,preferences:body.preferences||{}};
  const {data}=await supaFetch('/rest/v1/clients',{method:'POST',token,body:row,headers:{Prefer:'return=representation'}});
  return clientRowToApp(data?.[0]||row);
}
async function cloudUpdateClient(req,id,body){
  const {token}=await cloudUser(req);const row={name:body.name||'',email:body.email||null,phone:body.phone||null,language:body.language||null,currency:body.currency||null,notes:body.notes||null,preferences:body.preferences||{},updated_at:new Date().toISOString()};
  const {data}=await supaFetch(`/rest/v1/clients?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',token,body:row,headers:{Prefer:'return=representation'}});
  if(!data?.length)throw new Error('Client not found or access denied.');return clientRowToApp(data[0]);
}
async function cloudDeleteClient(req,id){const {token}=await cloudUser(req);await supaFetch(`/rest/v1/clients?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',token,headers:{Prefer:'return=minimal'}});return {deleted:true,id};}
async function cloudProfile(req){
  const {token}=await cloudUser(req);const {data}=await supaFetch('/rest/v1/agency_profiles?select=profile&limit=1',{token});return data?.[0]?.profile||{};
}
async function cloudSaveProfile(req,body){
  const {token,user}=await cloudUser(req);const {data}=await supaFetch('/rest/v1/agency_profiles',{method:'POST',token,body:{user_id:user.id,profile:body,updated_at:new Date().toISOString()},headers:{Prefer:'resolution=merge-duplicates,return=representation'}});
  return data?.[0]?.profile||body;
}

function bookingLinks(q){
  const city=encodeURIComponent(q.destinationName||q.destination||'');
  const origin=encodeURIComponent(q.origin||'');
  const destination=encodeURIComponent(q.destination||'');
  const expediaHotel=`https://www.expedia.com/Hotel-Search?destination=${city}&startDate=${encodeURIComponent(q.checkInDate||'')}&endDate=${encodeURIComponent(q.checkOutDate||'')}`;
  const expediaFlight=`https://www.expedia.com/Flights-Search?flight-type=on&mode=search&trip=roundtrip&leg1=from:${origin},to:${destination},departure:${encodeURIComponent(q.departureDate||'')}&leg2=from:${destination},to:${origin},departure:${encodeURIComponent(q.returnDate||'')}`;
  const booking=`https://www.booking.com/searchresults.html?ss=${city}&checkin=${encodeURIComponent(q.checkInDate||'')}&checkout=${encodeURIComponent(q.checkOutDate||'')}`;
  const googleFlights=`https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${q.origin||''} to ${q.destination||''} on ${q.departureDate||''} returning ${q.returnDate||''}`)}`;
  return {expediaHotel,expediaFlight,booking,googleFlights};
}

const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host}`);
  if(url.pathname==='/api/status'&&req.method==='GET')return send(res,200,{openai:!!process.env.OPENAI_API_KEY,amadeus:!!(process.env.AMADEUS_API_KEY&&process.env.AMADEUS_API_SECRET),amadeusEnv:process.env.AMADEUS_ENV||'test',pexels:!!process.env.PEXELS_API_KEY,supabase:CLOUD_ENABLED,storageMode:CLOUD_ENABLED?'cloud':'local'});
  if(url.pathname==='/api/auth/signup'&&req.method==='POST'){if(!CLOUD_ENABLED)return send(res,503,{error:'Cloud login is not configured yet.'});const body=await parseBody(req);try{const {data}=await supaFetch('/auth/v1/signup',{method:'POST',body:{email:body.email,password:body.password,data:{full_name:body.name||''}}});return send(res,200,data);}catch(err){return send(res,400,{error:err.message});}}
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){if(!CLOUD_ENABLED)return send(res,503,{error:'Cloud login is not configured yet.'});const body=await parseBody(req);try{const {data}=await supaFetch('/auth/v1/token?grant_type=password',{method:'POST',body:{email:body.email,password:body.password}});return send(res,200,data);}catch(err){return send(res,400,{error:err.message});}}
  if(url.pathname==='/api/auth/recover'&&req.method==='POST'){
    if(!CLOUD_ENABLED)return send(res,503,{error:'Cloud login is not configured yet.'});
    const body=await parseBody(req);
    if(!body.email)return send(res,400,{error:'Email is required.'});
    const redirectTo=(body.redirectTo||`http://${req.headers.host}/`).trim();
    try{await supaFetch(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,{method:'POST',body:{email:body.email}});return send(res,200,{ok:true});}
    catch(err){return send(res,400,{error:err.message});}
  }
  if(url.pathname==='/api/auth/update-password'&&req.method==='POST'){
    if(!CLOUD_ENABLED)return send(res,503,{error:'Cloud login is not configured yet.'});
    const token=bearer(req),body=await parseBody(req);
    if(!token)return send(res,401,{error:'Recovery session is missing or expired. Request a new password reset email.'});
    if(!body.password||body.password.length<8)return send(res,400,{error:'Password must be at least 8 characters.'});
    try{const {data}=await supaFetch('/auth/v1/user',{method:'PUT',token,body:{password:body.password}});return send(res,200,{ok:true,user:data});}
    catch(err){return send(res,400,{error:err.message});}
  }
  if(url.pathname==='/api/auth/refresh'&&req.method==='POST'){if(!CLOUD_ENABLED)return send(res,503,{error:'Cloud login is not configured yet.'});const body=await parseBody(req);try{const {data}=await supaFetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:body.refresh_token}});return send(res,200,data);}catch(err){return send(res,400,{error:err.message});}}
  if(url.pathname==='/api/auth/user'&&req.method==='GET'){try{const {user}=await cloudUser(req);return send(res,200,user);}catch(err){return send(res,401,{error:err.message});}}
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){if(!CLOUD_ENABLED)return send(res,200,{ok:true});try{const token=bearer(req);if(token)await supaFetch('/auth/v1/logout',{method:'POST',token});return send(res,200,{ok:true});}catch{return send(res,200,{ok:true});}}
  if(url.pathname==='/api/trips'&&req.method==='GET'){if(CLOUD_ENABLED){try{return send(res,200,await cloudTrips(req));}catch(err){return send(res,401,{error:err.message});}}return send(res,200,await readTrips());}
  if(url.pathname==='/api/trips'&&req.method==='POST'){const body=await parseBody(req);if(CLOUD_ENABLED){try{return send(res,201,await cloudCreateTrip(req,body));}catch(err){return send(res,401,{error:err.message});}}const trips=await readTrips();const trip={id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'Draft',...body};trips.unshift(trip);await saveTrips(trips);return send(res,201,trip);}
  if(url.pathname==='/api/clients'&&req.method==='GET'){if(!CLOUD_ENABLED)return send(res,200,[]);try{return send(res,200,await cloudClients(req));}catch(err){return send(res,401,{error:err.message});}}
  if(url.pathname==='/api/clients'&&req.method==='POST'){if(!CLOUD_ENABLED)return send(res,503,{error:'Clients require cloud mode. Configure Supabase first.'});try{return send(res,201,await cloudCreateClient(req,await parseBody(req)));}catch(err){return send(res,400,{error:err.message});}}
  if(url.pathname==='/api/agency-profile'&&req.method==='GET'){if(!CLOUD_ENABLED)return send(res,200,{local:true});try{return send(res,200,await cloudProfile(req));}catch(err){return send(res,401,{error:err.message});}}
  if(url.pathname==='/api/agency-profile'&&req.method==='PUT'){if(!CLOUD_ENABLED)return send(res,200,{local:true,...await parseBody(req)});try{return send(res,200,await cloudSaveProfile(req,await parseBody(req)));}catch(err){return send(res,400,{error:err.message});}}
  if(url.pathname==='/api/generate-stream'&&req.method==='POST'){const body=await parseBody(req);res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','Transfer-Encoding':'chunked'});try{await streamOpenAIJson(res,{prompt:buildPrompt(body),mode:body.generationMode||'fast',donePayload:itinerary=>({mode:'ai',itinerary})});}catch(err){const itinerary=demoItinerary(body);itinerary.demoReason=err.message;res.write(JSON.stringify({type:'done',mode:'demo',itinerary})+'\n');}return res.end();}
  if(url.pathname==='/api/translate-stream'&&req.method==='POST'){const body=await parseBody(req);res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','Transfer-Encoding':'chunked'});try{if(!body.language)throw new Error('Choose a translation language.');const prompt=`Translate the travel proposal JSON below into ${body.language}. Preserve the exact JSON structure, array structure, numbers, airport/IATA codes, currency codes, URLs, brand names, and proper nouns when they should not be translated. Translate client-facing prose naturally and concisely. Preserve Anglo-American number formatting: comma thousands separators and period decimals. Return ONLY valid JSON, no markdown.\n\n${JSON.stringify(body.itinerary)}`;await streamOpenAIJson(res,{prompt,mode:'fast',donePayload:itinerary=>({itinerary,language:body.language})});}catch(err){res.write(JSON.stringify({type:'error',error:err.message||'Translation failed'})+'\n');}return res.end();}
  if(url.pathname==='/api/generate'&&req.method==='POST'){const body=await parseBody(req);let itinerary,mode='ai';try{itinerary=await callOpenAI(body);}catch(err){mode='demo';itinerary=demoItinerary(body);itinerary.demoReason=err.message;}return send(res,200,{mode,itinerary});}
  if(url.pathname==='/api/translate'&&req.method==='POST'){const body=await parseBody(req);try{return send(res,200,{itinerary:await translateItinerary(body.itinerary,body.language),language:body.language});}catch(err){return send(res,400,{error:err.message||'Translation failed'});}}
  if(url.pathname==='/api/live/flights'&&req.method==='POST'){const body=await parseBody(req);try{return send(res,200,{provider:'Amadeus',results:await liveFlights(body)});}catch(err){return send(res,503,{error:err.message,provider:'Amadeus'});}}
  if(url.pathname==='/api/live/hotels'&&req.method==='POST'){const body=await parseBody(req);try{return send(res,200,{provider:'Amadeus',results:await liveHotels(body)});}catch(err){return send(res,503,{error:err.message,provider:'Amadeus'});}}
  if(url.pathname==='/api/photos/search'&&req.method==='GET'){const q=url.searchParams.get('q')||'';if(!q.trim())return send(res,400,{error:'Photo search needs a location or attraction.'});try{return send(res,200,{provider:'Pexels',photos:await pexelsSearch(q,url.searchParams.get('per_page')||6)});}catch(err){return send(res,503,{error:err.message,provider:'Pexels'});}}
  if(url.pathname==='/api/booking-links'&&req.method==='POST')return send(res,200,bookingLinks(await parseBody(req)));
  const match=url.pathname.match(/^\/api\/trips\/([^/]+)$/);
  if(match&&req.method==='PUT'){
    const body=await parseBody(req);
    if(CLOUD_ENABLED){try{return send(res,200,await cloudUpdateTrip(req,match[1],body));}catch(err){return send(res,400,{error:err.message});}}
    const trips=await readTrips(),i=trips.findIndex(t=>t.id===match[1]);
    if(i<0)return send(res,404,{error:'Trip not found'});
    trips[i]={...trips[i],...body,updatedAt:new Date().toISOString()};
    await saveTrips(trips);return send(res,200,trips[i]);
  }
  if(match&&req.method==='DELETE'){
    if(CLOUD_ENABLED){try{return send(res,200,await cloudDeleteTrip(req,match[1]));}catch(err){return send(res,400,{error:err.message});}}
    const trips=await readTrips(),i=trips.findIndex(t=>t.id===match[1]);
    if(i<0)return send(res,404,{error:'Trip not found'});
    const [removed]=trips.splice(i,1);await saveTrips(trips);return send(res,200,{deleted:true,id:removed.id});
  }
  const clientMatch=url.pathname.match(/^\/api\/clients\/([^/]+)$/);
  if(clientMatch&&req.method==='PUT'){
    if(!CLOUD_ENABLED)return send(res,503,{error:'Clients require cloud mode.'});
    try{return send(res,200,await cloudUpdateClient(req,clientMatch[1],await parseBody(req)));}catch(err){return send(res,400,{error:err.message});}
  }
  if(clientMatch&&req.method==='DELETE'){
    if(!CLOUD_ENABLED)return send(res,503,{error:'Clients require cloud mode.'});
    try{return send(res,200,await cloudDeleteClient(req,clientMatch[1]));}catch(err){return send(res,400,{error:err.message});}
  }
  let requested=url.pathname==='/'?'/index.html':url.pathname;const safe=path.normalize(requested).replace(/^\.\.(\/|\\|$)+/,'');const filePath=path.join(publicDir,safe);if(!filePath.startsWith(publicDir))return send(res,403,'Forbidden','text/plain');try{const s=await stat(filePath);if(s.isFile())return send(res,200,await readFile(filePath),mime[path.extname(filePath)]||'application/octet-stream');}catch{}return send(res,404,'Not found','text/plain');
}catch(err){return send(res,500,{error:err.message||'Server error'});}});
server.listen(PORT,()=>console.log(`VoyageDesk AI v0.3.2 running at http://localhost:${PORT}`));
