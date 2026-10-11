// TripFiver Stage 8A: optional GA4, never loaded before affirmative consent.
(()=>{
'use strict';
const id='G-X29TC3T480',key='tripfiver-analytics-consent-v1';
let enabled=false;
function initialize(){if(enabled)return;enabled=true;window.dataLayer=window.dataLayer||[];window.gtag=function(){window.dataLayer.push(arguments)};window.gtag('js',new Date());window.gtag('config',id,{send_page_view:true});const script=document.createElement('script');script.async=true;script.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(id);document.head.appendChild(script);}
function choice(value){try{localStorage.setItem(key,value)}catch{}if(value==='yes')initialize();document.getElementById('analyticsConsent')?.classList.add('hidden');}
function setup(){let value='';try{value=localStorage.getItem(key)||''}catch{}if(value==='yes')initialize();else if(value!=='no')document.getElementById('analyticsConsent')?.classList.remove('hidden');document.getElementById('analyticsAccept')?.addEventListener('click',()=>choice('yes'));document.getElementById('analyticsReject')?.addEventListener('click',()=>choice('no'));}
window.tripfiverAnalyticsEvent=(name,params={})=>{if(enabled&&typeof window.gtag==='function')window.gtag('event',name,params)};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})();
