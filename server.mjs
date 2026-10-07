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
const GOOGLE_PLACES_BASE = 'https://places.googleapis.com/v1';
const VIATOR_BASE = process.env.VIATOR_ENV === 'production' ? 'https://api.viator.com/partner' : 'https://api.sandbox.viator.com/partner';
const VIATOR_LANGUAGE = process.env.VIATOR_LANGUAGE || 'en-US';
let viatorDestinationCache={items:[],loadedAt:0};
const VIATOR_DESTINATION_TTL=7*24*60*60*1000;

function normalizeDestinationName(value){
  return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
async function viatorFetch(endpoint,{method='GET',body}={}){
  const key=(process.env.VIATOR_SANDBOX_API_KEY||process.env.VIATOR_API_KEY||'').trim();
  if(!key)throw new Error('VIATOR_API_KEY is not configured.');
  const r=await fetch(`${VIATOR_BASE}${endpoint}`,{
    method,
    headers:{
      'exp-api-key':key,
      'Accept':'application/json;version=2.0',
      'Accept-Language':VIATOR_LANGUAGE,
      ...(body===undefined?{}:{'Content-Type':'application/json'})
    },
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data?.message||data?.error?.message||`Viator request failed (${r.status})`);
  return data;
}
async function viatorDestinations({force=false}={}){
  if(!force&&viatorDestinationCache.items.length&&Date.now()-viatorDestinationCache.loadedAt<VIATOR_DESTINATION_TTL)return viatorDestinationCache.items;
  const data=await viatorFetch('/destinations');
  const items=Array.isArray(data?.destinations)?data.destinations:Array.isArray(data)?data:[];
  viatorDestinationCache={items,loadedAt:Date.now()};
  return items;
}
function rankViatorDestination(query,d){
  const q=normalizeDestinationName(query),name=normalizeDestinationName(d?.name);
  if(!q||!name)return -1;
  let score=name===q?100:name.startsWith(q)?85:q.startsWith(name)?75:name.includes(q)?65:q.includes(name)?55:-1;
  if(score<0)return score;
  const type=String(d?.type||'').toUpperCase();
  if(type==='CITY')score+=8;
  else if(type==='TOWN')score+=5;
  else if(type==='COUNTRY')score-=3;
  return score;
}
async function resolveViatorDestination(query){
  const raw=String(query||'').trim();
  if(!raw)throw new Error('Destination is required.');
  const primary=raw.split(/[;,\n]/)[0].trim();
  const items=await viatorDestinations();
  const matches=items.map(d=>({d,score:rankViatorDestination(primary,d)})).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score||String(a.d.name).localeCompare(String(b.d.name))).slice(0,8);
  return {
    query:primary,
    match:matches[0]?.d||null,
    alternatives:matches.slice(1).map(x=>x.d),
    source:'Viator destination taxonomy',
    taxonomyCachedAt:new Date(viatorDestinationCache.loadedAt).toISOString()
  };
}
async function viatorActivities(destination,{count=10,currency,start=1}={}){
  const destinationId=Number(destination?.destinationId);
  if(!destinationId)throw new Error('A valid Viator destination ID is required.');
  const requestCount=Math.min(20,Math.max(1,Number(count)||10));
  const body={
    filtering:{destination:String(destinationId)},
    sorting:{sort:'TRAVELER_RATING',order:'DESCENDING'},
    pagination:{start:Math.max(1,Number(start)||1),count:requestCount},
    currency:(currency||destination.defaultCurrencyCode||'USD').toUpperCase()
  };
  const data=await viatorFetch('/products/search',{method:'POST',body});
  const products=Array.isArray(data?.products)?data.products:[];
  return {
    destination:{destinationId,name:destination.name,type:destination.type,currency:body.currency},
    count:products.length,
    totalCount:data?.totalCount??null,
    products:products.map(p=>({
      productCode:p.productCode,
      title:p.title,
      description:p.description,
      productUrl:p.productUrl,
      images:p.images||[],
      reviews:p.reviews||null,
      duration:p.duration||null,
      pricing:p.pricing||null,
      destinations:p.destinations||[],
      flags:p.flags||[]
    }))
  };
}
function viatorActivityText(product){
  return [product?.title,product?.description,(product?.flags||[]).join(' ')].filter(Boolean).join(' ').toLowerCase();
}
function travelerActivityProfile(trip={}){
  const interests=Array.isArray(trip.interests)?trip.interests.join(' '):String(trip.interests||'');
  const text=[interests,trip.notes,trip.specialRequests,trip.dietaryNeeds,trip.hotelStyle,trip.travelers].filter(Boolean).join(' ').toLowerCase();
  const themes={
    food:/food|culinary|cuisine|restaurant|cooking|taste|wine|coffee|market/.test(text),
    culture:/culture|cultural|history|historic|museum|architecture|religious|art/.test(text),
    local:/local|neighborhood|neighbourhood|hidden|authentic|market/.test(text),
    photography:/photo|photography|instagram|picture/.test(text),
    private:/private|luxury|exclusive|romantic|couple|honeymoon/.test(text),
    family:/family|child|children|kid|kids/.test(text),
    outdoors:/nature|outdoor|hike|hiking|boat|cruise|water|adventure/.test(text)
  };
  return {text,themes};
}
function scoreViatorProduct(product,trip={}){
  const profile=travelerActivityProfile(trip),text=viatorActivityText(product);
  let score=0;const reasons=[];
  const tests=[
    ['food',/food|culinary|cuisine|cooking|taste|breakfast|lunch|dinner|market/,18,'food and dining interests'],
    ['culture',/culture|history|historic|museum|mosque|church|palace|architecture|art/,15,'culture and history interests'],
    ['local',/local|hidden|neighborhood|neighbourhood|backstreet|market|authentic/,14,'local-neighborhood interests'],
    ['photography',/photo|photography|photoshoot|instagram/,18,'photography interests'],
    ['private',/private|exclusive|personal/,10,'private/personal travel style'],
    ['family',/family|child|children|kid/,12,'family travel'],
    ['outdoors',/nature|outdoor|hike|boat|cruise|water|adventure/,14,'outdoor/adventure interests']
  ];
  for(const [theme,re,points,label] of tests)if(profile.themes[theme]&&re.test(text)){score+=points;reasons.push(label);}
  const rating=Number(product?.reviews?.combinedAverageRating||0),reviews=Number(product?.reviews?.totalReviews||0);
  if(rating>=4.8){score+=8;reasons.push('strong traveler rating');}else if(rating>=4.5)score+=5;
  if(reviews>=100)score+=5;else if(reviews>=25)score+=3;
  if((product?.flags||[]).includes('FREE_CANCELLATION'))score+=3;
  if((product?.flags||[]).includes('PRIVATE_TOUR')&&profile.themes.private)score+=3;
  return {score,reasons:[...new Set(reasons)].slice(0,3)};
}
function rankViatorActivities(products,trip={},limit=5){
  return (products||[]).map(product=>({...product,match:scoreViatorProduct(product,trip)}))
    .sort((a,b)=>b.match.score-a.match.score||Number(b.reviews?.combinedAverageRating||0)-Number(a.reviews?.combinedAverageRating||0)||Number(b.reviews?.totalReviews||0)-Number(a.reviews?.totalReviews||0))
    .slice(0,Math.min(10,Math.max(1,Number(limit)||5)));
}
function viatorDayText(day={}){
  return [day.location,day.title,...(day.morning||[]),...(day.afternoon||[]),...(day.evening||[])].filter(Boolean).join(' ').toLowerCase();
}
function viatorTokens(text=''){
  const stop=new Set(['istanbul','tour','guided','guide','private','experience','with','from','your','this','that','the','and','for','into','around','visit','explore','start','continue','area','city']);
  return [...new Set(String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]{4,}/g)||[])].filter(x=>!stop.has(x));
}
function matchViatorToDays(products,days=[]){
  const used=new Set();
  return (days||[]).map((day,index)=>{
    const dt=viatorDayText(day),dayTokens=viatorTokens(dt);
    // Protect low-capacity travel days. Arrival/departure/rest days should not be
    // turned into long affiliate-tour days, even when the product is relevant.
    const isTravelDay=/arrival|arrive|check[- ]?in|jet lag|departure|depart|check[- ]?out|airport|flight home|fly home|transfer to .*airport|rest day|recovery day/.test(dt);
    const maxTravelDayMinutes=180;
    const ranked=(products||[]).filter(p=>{
      if(used.has(p.productCode))return false;
      if(!isTravelDay)return true;
      const d=p.duration||{},mins=Number(d.fixedDurationInMinutes||d.variableDurationToMinutes||d.variableDurationFromMinutes||0);
      return mins>0&&mins<=maxTravelDayMinutes;
    }).map(p=>{
      const pt=viatorActivityText(p),ptokens=new Set(viatorTokens(pt));
      const shared=dayTokens.filter(t=>ptokens.has(t));
      let dayScore=shared.length*7;
      if(/food|market|taste|culinary|restaurant/.test(dt)&&/food|market|taste|culinary|restaurant/.test(pt))dayScore+=12;
      if(/historic|history|mosque|palace|museum|sultanahmet/.test(dt)&&/historic|history|mosque|palace|museum|sultanahmet|hagia|basilica/.test(pt))dayScore+=12;
      if(/bosphorus|waterfront|ortakoy|besiktas|boat|cruise/.test(dt)&&/bosphorus|boat|cruise|waterfront|ortakoy|besiktas/.test(pt))dayScore+=12;
      if(/beyoglu|galata|karakoy|pera/.test(dt)&&/beyoglu|galata|karakoy|pera/.test(pt))dayScore+=16;
      if(/kadikoy|moda|asian side/.test(dt)&&/kadikoy|moda|asian side/.test(pt))dayScore+=16;
      return {product:p,dayScore,shared};
    }).sort((a,b)=>b.dayScore-a.dayScore||b.product.match.score-a.product.match.score);
    const best=ranked[0];
    // On arrival/departure/rest days, only show a short experience when the
    // geographic/theme fit is unusually strong; otherwise intentionally show none.
    const minimumScore=isTravelDay?20:7;
    if(!best||best.dayScore<minimumScore)return null;
    used.add(best.product.productCode);
    return {day:Number(day.day)||index+1,dayTitle:day.title||'',dayLocation:day.location||'',dayMatchScore:best.dayScore,dayMatchReasons:best.shared.slice(0,3),activity:best.product};
  }).filter(Boolean).slice(0,3);
}
async function personalizedViatorActivities(trip={},limit=5){
  const destination=String(trip.destinations||trip.destination||'').split(/[;,\n]/)[0].trim();
  if(!destination)throw new Error('Destination is required.');
  const resolved=await resolveViatorDestination(destination);
  if(!resolved.match)throw new Error('No Viator destination match found.');
  const currency=(trip.currency||'USD').toUpperCase();
  const priorCodes=new Set((trip.excludeViatorProductCodes||[]).map(String));
  // Keep the strongest first page, but blend in a rotating discovery page so repeated
  // generations surface fresh, still-relevant experiences instead of the same five.
  const discoveryStarts=[21,41,61,81];
  const discoveryStart=discoveryStarts[Math.floor(Math.random()*discoveryStarts.length)];
  const [primary,discovery]=await Promise.all([
    viatorActivities(resolved.match,{count:20,currency,start:1}),
    viatorActivities(resolved.match,{count:20,currency,start:discoveryStart})
  ]);
  const seen=new Set(),combined=[...(primary.products||[]),...(discovery.products||[])].filter(p=>p?.productCode&&!seen.has(p.productCode)&&seen.add(p.productCode));
  let eligible=combined.filter(p=>!priorCodes.has(String(p.productCode)));
  if(eligible.length<Math.max(5,Number(limit)||5))eligible=combined;
  const ranked=rankViatorActivities(eligible,trip,10);
  return {
    resolvedDestination:resolved.match,
    travelerProfile:travelerActivityProfile(trip).themes,
    candidateCount:combined.length,
    discoveryStart,
    recommendations:ranked.slice(0,Math.min(10,Math.max(1,Number(limit)||5))),
    dayMatches:matchViatorToDays(ranked,trip.itinerary?.days||trip.days||[])
  };
}



const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
async function readTrips(){ try{return JSON.parse(await readFile(dataFile,'utf8'));}catch{return [];} }
async function saveTrips(trips){ await writeFile(dataFile,JSON.stringify(trips,null,2)); }
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.includes('json')?JSON.stringify(body):body);}
async function parseBody(req){let body='';for await(const chunk of req)body+=chunk;return body?JSON.parse(body):{};}

function buildPrompt(trip,restaurantCandidates=[]){
  const mode=trip.generationMode==='detailed'?'detailed':'fast';
  const isRegeneration=!!trip.previousItinerary;
  const depth=mode==='fast'
    ? '- FAST MODE: Be concise. Use 1–3 practical bullets per daypart. Keep travel tips brief and avoid decorative prose or repetition.'
    : '- DETAILED MODE: Give a richer but practical itinerary. Use up to 2–3 useful bullets per daypart when they add value, with concise travel tips.';
  const coreRules=`You are TripFiver, a consumer travel-planning assistant. Create a practical, polished trip plan directly for the traveler.
Rules:
- Never invent live prices, availability, flight schedules, hotel inventory, opening hours, or booking status. Live flight/hotel results are shown separately.
- Respect dietary, accessibility, religious, budget, child, mobility, scheduling, party, date, hotel-style, and special-request constraints.
- PERSONALIZE around the traveler's interests and constraints; do not return a generic first-time-visitor checklist.
- Keep each day realistic with morning / afternoon / evening structure, a distinct theme or geographic focus, minimal backtracking, and a useful mix of iconic and interest-matched local experiences.
- For multi-day trips, distribute days across appropriate neighborhoods/districts rather than repeatedly centering the same tourist zone.
- Write every client-facing field in the requested proposal language. Preserve proper nouns, airport codes, URLs, and currency codes where appropriate.
- Use Anglo-American number formatting in prose.
${depth}
- Return ONLY valid JSON matching this shape:
{"title":"string","summary":"string","estimatedBudgetNote":"string","days":[{"day":1,"title":"string","location":"string","morning":["string"],"afternoon":["string"],"evening":["string"],"advisorNotes":["string"],"restaurants":[{"name":"string","meal":"Lunch or Dinner","reason":"string","rating":4.8,"userRatingCount":1200,"priceLevel":"PRICE_LEVEL_MODERATE","address":"string","googleMapsUri":"string"}]}],"verifyBeforeSending":["string"],"followUpQuestions":["string"]}`;

  const regenerationRules=isRegeneration?`
REGENERATION RULES — HARD REQUIREMENTS:
- Treat previousItinerary as AVOID/COMPARE, not a template. Preserve only true must-see anchors, explicit requests, or exceptionally strong interest matches.
- When alternatives exist, replace at least 70% of OPTIONAL sightseeing experiences and at least 60% of prior neighborhood/day-theme combinations. Rewording, reordering, splitting, merging, or only changing restaurants does not count.
- Deliberately build a different compatible geographic backbone and trip angle. Previously used optional districts, markets, museums, waterfront stops, and local-life areas are temporary exclusions unless explicitly requested.
- For trips with 5+ sightseeing days, create at least two genuinely NEW DAY CONCEPTS whose principal area and main experiences differ from the prior plan when the destination supports it.
- Prefer different verified restaurants when suitable alternatives exist.
- Before returning JSON, self-check the replacement targets and revise if needed.
- Never sacrifice safety, geographic logic, traveler constraints, explicit must-sees, or destination quality merely to be different.
`:''; 

  const restaurantRules=restaurantCandidates.length?`
VERIFIED RESTAURANT RULES:
- Named restaurants may ONLY come from VERIFIED RESTAURANT CANDIDATES below.
- Attach a restaurant to a day only when its address is in, adjacent to, or naturally on that day's route. A geographically wrong restaurant is worse than no named restaurant.
- For full sightseeing days, include named lunch/dinner choices when geographically appropriate; when food is an interest, give up to 2 choices per meal when practical.
- Copy name, rating, userRatingCount, priceLevel, address, and googleMapsUri exactly into the day's restaurants array; set meal and add a short reason.
- Do not invent reservations, availability, prices, ratings, awards, hours, restaurant names, or altered Google metadata. Tell the traveler to verify current operation/availability.
VERIFIED RESTAURANT CANDIDATES:
${JSON.stringify(restaurantCandidates)}
`:`
RESTAURANT RULES:
- No verified restaurant candidates are available in this generation. Do not invent restaurant names. Leave restaurants arrays empty and use a brief local-verification note where useful.
`;

  // previousItinerary is already represented by the regeneration module and can be
  // large; keep it only for regenerations and avoid pretty-print whitespace.
  const tripForPrompt={...trip};
  if(!isRegeneration)delete tripForPrompt.previousItinerary;
  return coreRules+regenerationRules+restaurantRules+`Trip information:
${JSON.stringify(tripForPrompt)}`;
}
function extractOutputText(data){return data?.output_text||data?.output?.flatMap(o=>o.content||[]).find(c=>c.type==='output_text')?.text||'';}
function parseJsonText(text){return JSON.parse(String(text||'').trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim());}
function apiTuning(mode='fast'){
  // Fast mode is the consumer default: itinerary quality comes from the prompt and
  // deterministic post-processing, so avoid spending latency on hidden reasoning
  // and keep client-facing prose compact. Detailed mode preserves the richer path.
  return mode==='detailed'
    ? {reasoning:{effort:'low'},text:{verbosity:'medium'}}
    : {reasoning:{effort:'none'},text:{verbosity:'low'}};
}
async function restaurantCandidatesForTrip(trip){
  if(!process.env.GOOGLE_PLACES_API_KEY)return [];
  const destination=String(trip.destinations||'').split(/[,;\n]/)[0].trim();
  if(!destination)return [];
  const interests=Array.isArray(trip.interests)?trip.interests.join(' '):String(trip.interests||'');
  const notes=[trip.notes,trip.specialRequests,trip.dietaryNeeds].filter(Boolean).join(' ');
  const foodText=(interests+' '+notes).trim();
  const cuisine=/turkish/i.test(foodText)?'Turkish':/seafood/i.test(foodText)?'seafood':/italian/i.test(foodText)?'Italian':/vegetarian|vegan/i.test(foodText)?'vegetarian':'local';
  try{const interestHint=foodText?` ${foodText.slice(0,120)}`:'';return await googlePlacesTextSearch(`${cuisine} restaurants ${interestHint} in ${destination}`,20);}
  catch(err){console.warn('Google Places itinerary enrichment skipped:',err.message);return [];}
}

function itineraryTerms(itinerary){
  const stop=new Set(['the','and','for','with','from','into','your','this','that','day','istanbul','arrival','departure','restaurant','lunch','dinner','hotel','walk','visit','explore','area']);
  const text=(itinerary?.days||[]).flatMap(d=>[d.location,d.title,...(d.morning||[]),...(d.afternoon||[]),...(d.evening||[])]).join(' ').toLowerCase();
  return new Set((text.match(/[a-zÀ-žİıŞşĞğÜüÖöÇç]{4,}/g)||[]).filter(w=>!stop.has(w)));
}
function regenerationOverlap(previousItinerary,itinerary){
  if(!previousItinerary||!itinerary)return 0;
  const a=itineraryTerms(previousItinerary),b=itineraryTerms(itinerary);
  if(!a.size||!b.size)return 0;
  let common=0;for(const x of a)if(b.has(x))common++;
  return common/Math.min(a.size,b.size);
}
function diversityRepairPrompt(trip,restaurantCandidates,draft,overlap){
  return buildPrompt({...trip,previousItinerary:trip.previousItinerary})+
    `\n\nSERVER DIVERSITY CHECK FAILED: The first regenerated draft still overlaps too heavily with the previous itinerary (similarity score ${Math.round(overlap*100)}%). Rewrite the itinerary one time before returning it. Preserve only true must-see anchors or experiences explicitly requested by the traveler. Replace optional repeated districts, markets, museums, waterfront zones, and local-life experiences with equally strong destination-appropriate alternatives. For trips with 5+ sightseeing days, aim for at least 3 full sightseeing days whose principal geography and main experiences were absent from the previous itinerary when the destination supports this. Do not simply reorder, split, merge, or rename prior days. Keep the restaurant geographic-fit rules.\n\nREJECTED FIRST DRAFT:\n${JSON.stringify(draft,null,2)}`;
}
async function requestItinerary(prompt,mode='fast'){
  const key=process.env.OPENAI_API_KEY;if(!key)throw new Error('OPENAI_API_KEY is not set.');
  const started=Date.now();
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,input:prompt,...apiTuning(mode)})});
  const data=await response.json();if(!response.ok)throw new Error(data?.error?.message||'OpenAI request failed');
  const text=extractOutputText(data);if(!text)throw new Error('No itinerary text returned.');
  console.log('[tripfiver-ai-timing]',JSON.stringify({mode,model:MODEL,ms:Date.now()-started,promptChars:prompt.length,outputChars:text.length}));
  return parseJsonText(text);
}
async function enforceRegenerationDiversity(trip,restaurantCandidates,itinerary){
  if(!trip.previousItinerary)return itinerary;
  const overlap=regenerationOverlap(trip.previousItinerary,itinerary);
  if(overlap<=0.58)return itinerary;
  console.log(`TripFiver diversity retry: overlap ${Math.round(overlap*100)}%`);
  return await requestItinerary(diversityRepairPrompt(trip,restaurantCandidates,itinerary,overlap),trip.generationMode||'fast');
}

async function callOpenAI(trip){
  const restaurantCandidates=await restaurantCandidatesForTrip(trip);
  const itinerary=await requestItinerary(buildPrompt(trip,restaurantCandidates),trip.generationMode||'fast');
  return await enforceRegenerationDiversity(trip,restaurantCandidates,itinerary);
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
function demoItinerary(trip){const destination=trip.destinations||'the destination';const traveler=trip.clientName||'Traveler';return{title:`${traveler} — ${destination} Journey`,summary:`A sample itinerary for ${trip.travelers||'the travelers'}. Live inventory is displayed separately when a travel provider is connected.`,estimatedBudgetNote:trip.budget?`Target budget: ${trip.budget}. Verify all live inventory before quoting.`:'Confirm the trip budget before quoting.',days:[1,2,3].map(d=>({day:d,title:d===1?'Arrival & Easy Introduction':d===2?'Signature Experiences':'Flexible Local Discovery',location:destination,morning:[d===1?'Arrival, transfer, and hotel check-in or luggage drop.':'Begin with one high-priority traveler interest.'],afternoon:['Allow time for lunch, transit, and one primary sightseeing experience.'],evening:['Recommend a relaxed dinner and optional neighborhood walk or cultural activity.'],advisorNotes:['Verify reservations, local transportation, dietary requirements, and current details.']})),verifyBeforeSending:['Flight schedules and fares','Hotel availability and cancellation terms','Attraction hours/tickets','Restaurant hours and dietary requirements'],followUpQuestions:['Would the traveler prefer a faster or more relaxed pace?','Are there any must-do experiences?']};}

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


async function googlePlacesTextSearch(query, maxResultCount=10){
  const key=process.env.GOOGLE_PLACES_API_KEY;
  if(!key)throw new Error('Google Places is not connected.');
  const r=await fetch(`${GOOGLE_PLACES_BASE}/places:searchText`,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Goog-Api-Key':key,
      'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.primaryType,places.priceLevel,places.rating,places.userRatingCount,places.googleMapsUri'
    },
    body:JSON.stringify({textQuery:query,includedType:'restaurant',strictTypeFiltering:true,maxResultCount:Math.min(20,Math.max(1,Number(maxResultCount)||10))})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data?.error?.message||`Google Places request failed (${r.status})`);
  return (data.places||[]).map(p=>({
    id:p.id,
    name:p.displayName?.text||'Restaurant',
    address:p.formattedAddress||'',
    type:p.primaryType||'',
    priceLevel:p.priceLevel||'',
    rating:p.rating??null,
    userRatingCount:p.userRatingCount??null,
    googleMapsUri:p.googleMapsUri||''
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
  if(url.pathname==='/api/status'&&req.method==='GET')return send(res,200,{openai:!!process.env.OPENAI_API_KEY,amadeus:!!(process.env.AMADEUS_API_KEY&&process.env.AMADEUS_API_SECRET),amadeusEnv:process.env.AMADEUS_ENV||'test',pexels:!!process.env.PEXELS_API_KEY,googlePlaces:!!process.env.GOOGLE_PLACES_API_KEY,viator:!!(process.env.VIATOR_SANDBOX_API_KEY||process.env.VIATOR_API_KEY),viatorEnv:process.env.VIATOR_ENV||'sandbox',supabase:CLOUD_ENABLED,storageMode:CLOUD_ENABLED?'cloud':'local'});
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
  if(url.pathname==='/api/generate-stream'&&req.method==='POST'){const body=await parseBody(req);res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','Transfer-Encoding':'chunked'});const emit=obj=>res.write(JSON.stringify(obj)+'\n');const started=Date.now();try{
    // Speed stage: for a brand-new trip, do not block the core itinerary on Google Places.
    // Restaurant enrichment remains available for regenerations, where quality/variety matters more.
    const isRegeneration=!!body.previousItinerary;
    emit({type:'progress',stage:'itinerary',message:'Building your itinerary…'});
    const placesStarted=Date.now();
    const restaurantCandidates=isRegeneration?await restaurantCandidatesForTrip(body):[];
    const placesMs=Date.now()-placesStarted;
    const aiStarted=Date.now();
    const itinerary=await requestItinerary(buildPrompt(body,restaurantCandidates),body.generationMode||'fast');
    const aiMs=Date.now()-aiStarted;
    let finalItinerary=itinerary,diversityMs=0;
    if(isRegeneration){
      emit({type:'progress',stage:'personalization',message:'Checking itinerary variety…'});
      const diversityStarted=Date.now();
      finalItinerary=await enforceRegenerationDiversity(body,restaurantCandidates,itinerary);
      diversityMs=Date.now()-diversityStarted;
    }
    emit({type:'done',mode:'ai',itinerary:finalItinerary,timing:{totalMs:Date.now()-started,placesMs,aiMs,diversityMs,isRegeneration}});
  }catch(err){const itinerary=demoItinerary(body);itinerary.demoReason=err.message;emit({type:'done',mode:'demo',itinerary,timing:{totalMs:Date.now()-started}});}return res.end();}
  if(url.pathname==='/api/translate-stream'&&req.method==='POST'){const body=await parseBody(req);res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','Transfer-Encoding':'chunked'});try{if(!body.language)throw new Error('Choose a translation language.');const prompt=`Translate the travel proposal JSON below into ${body.language}. Preserve the exact JSON structure, array structure, numbers, airport/IATA codes, currency codes, URLs, brand names, and proper nouns when they should not be translated. Translate client-facing prose naturally and concisely. Preserve Anglo-American number formatting: comma thousands separators and period decimals. Return ONLY valid JSON, no markdown.\n\n${JSON.stringify(body.itinerary)}`;await streamOpenAIJson(res,{prompt,mode:'fast',donePayload:itinerary=>({itinerary,language:body.language})});}catch(err){res.write(JSON.stringify({type:'error',error:err.message||'Translation failed'})+'\n');}return res.end();}
  if(url.pathname==='/api/generate'&&req.method==='POST'){const body=await parseBody(req);let itinerary,mode='ai';try{itinerary=await callOpenAI(body);}catch(err){mode='demo';itinerary=demoItinerary(body);itinerary.demoReason=err.message;}return send(res,200,{mode,itinerary});}
  if(url.pathname==='/api/translate'&&req.method==='POST'){const body=await parseBody(req);try{return send(res,200,{itinerary:await translateItinerary(body.itinerary,body.language),language:body.language});}catch(err){return send(res,400,{error:err.message||'Translation failed'});}}
  if(url.pathname==='/api/live/flights'&&req.method==='POST'){const body=await parseBody(req);try{return send(res,200,{provider:'Amadeus',results:await liveFlights(body)});}catch(err){return send(res,503,{error:err.message,provider:'Amadeus'});}}
  if(url.pathname==='/api/live/hotels'&&req.method==='POST'){const body=await parseBody(req);try{return send(res,200,{provider:'Amadeus',results:await liveHotels(body)});}catch(err){return send(res,503,{error:err.message,provider:'Amadeus'});}}
  if(url.pathname==='/api/photos/search'&&req.method==='GET'){const q=url.searchParams.get('q')||'';if(!q.trim())return send(res,400,{error:'Photo search needs a location or attraction.'});try{return send(res,200,{provider:'Pexels',photos:await pexelsSearch(q,url.searchParams.get('per_page')||6)});}catch(err){return send(res,503,{error:err.message,provider:'Pexels'});}}
  if(url.pathname==='/api/places/restaurants'&&req.method==='GET'){
    const destination=(url.searchParams.get('destination')||'').trim();
    const area=(url.searchParams.get('area')||'').trim();
    const cuisine=(url.searchParams.get('cuisine')||'').trim();
    if(!destination)return send(res,400,{error:'Destination is required.'});
    const query=[cuisine,'restaurants',area?`in ${area}`:'',`in ${destination}`].filter(Boolean).join(' ');
    try{return send(res,200,{provider:'Google Places',query,results:await googlePlacesTextSearch(query,url.searchParams.get('limit')||10)});}
    catch(err){return send(res,503,{error:err.message,provider:'Google Places'});}
  }
  if(url.pathname==='/api/viator/destinations'&&req.method==='GET'){
    const query=(url.searchParams.get('query')||url.searchParams.get('destination')||'').trim();
    if(!query)return send(res,400,{error:'Destination is required.'});
    try{
      const result=await resolveViatorDestination(query);
      if(!result.match)return send(res,404,{error:'No Viator destination match found.',...result});
      return send(res,200,{provider:'Viator',...result});
    }catch(err){return send(res,503,{error:err.message,provider:'Viator'});}
  }
  if(url.pathname==='/api/viator/activities'&&req.method==='GET'){
    const query=(url.searchParams.get('destination')||url.searchParams.get('query')||'').trim();
    if(!query)return send(res,400,{error:'Destination is required.'});
    try{
      const resolved=await resolveViatorDestination(query);
      if(!resolved.match)return send(res,404,{error:'No Viator destination match found.',provider:'Viator',query});
      const results=await viatorActivities(resolved.match,{count:url.searchParams.get('limit')||10,currency:url.searchParams.get('currency')||resolved.match.defaultCurrencyCode});
      return send(res,200,{provider:'Viator',query,resolvedDestination:resolved.match,...results});
    }catch(err){return send(res,503,{error:err.message,provider:'Viator'});}
  }
  if(url.pathname==='/api/viator/recommendations-test'&&req.method==='GET'){
    const destination=(url.searchParams.get('destination')||'').trim();
    if(!destination)return send(res,400,{error:'Destination is required.'});
    const interests=(url.searchParams.get('interests')||'').split(',').map(x=>x.trim()).filter(Boolean);
    const notes=(url.searchParams.get('notes')||'').trim();
    try{
      const result=await personalizedViatorActivities({destinations:destination,interests,notes},url.searchParams.get('limit')||5);
      return send(res,200,{provider:'Viator',testMode:true,input:{destination,interests,notes},...result});
    }catch(err){return send(res,503,{error:err.message,provider:'Viator'});}
  }
  if(url.pathname==='/api/viator/recommendations'&&req.method==='POST'){
    const body=await parseBody(req);
    try{
      const result=await personalizedViatorActivities(body,body.limit||5);
      return send(res,200,{provider:'Viator',...result});
    }catch(err){return send(res,503,{error:err.message,provider:'Viator'});}
  }
  if(url.pathname==='/api/viator/click'&&req.method==='POST'){
    const body=await parseBody(req);
    const destination=String(body.destination||'').slice(0,120),productCode=String(body.productCode||'').slice(0,80);
    console.log('[viator-click]',JSON.stringify({at:new Date().toISOString(),destination,productCode,day:Number(body.day)||null,source:String(body.source||'trip-proposal').slice(0,60)}));
    return send(res,200,{ok:true});
  }
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
server.listen(PORT,()=>console.log(`TripFiver v0.4 running at http://localhost:${PORT}`));
