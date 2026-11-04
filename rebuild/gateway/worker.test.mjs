import assert from 'node:assert/strict';
import worker, {handleRequest} from './worker.mjs';
const env={LINE_CHANNEL_SECRET:'test-only-channel',MILLIE_GATEWAY_SECRET:'test-only-gateway',GAS_WEB_APP_URL:'https://script.google.com/macros/s/test-only/exec'};
const sign=async s=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(s))).toString('base64');};
const req=(body,sig)=>new Request('https://example.test/webhook',{method:'POST',body,headers:sig?{'x-line-signature':sig}:{}});
let called=0;
const upstream=async(url,opts)=>{called++;const p=JSON.parse(opts.body);assert.equal(p.gatewaySecret,env.MILLIE_GATEWAY_SECRET);assert.equal(p.events[0].webhookEventId,'event1');return Response.json({ok:true});};
const body=JSON.stringify({events:[{webhookEventId:'event1'}]});
assert.equal((await handleRequest(req(body),env,upstream)).status,401);
assert.equal((await handleRequest(req(body,await sign(body+'x')),env,upstream)).status,401);
assert.equal(called,0);
assert.equal((await handleRequest(req(body,await sign(body)),env,upstream)).status,200);
assert.equal(called,1);
assert.equal((await handleRequest(req(body,await sign(body)),env,async()=>Response.json({ok:false}))).status,503);
assert.equal((await handleRequest(req(body,await sign(body)),env,async()=>{throw Error();})).status,503);
const empty='{"events":[]}';assert.equal((await handleRequest(req(empty,await sign(empty)),env,upstream)).status,200);assert.equal(called,1);
const big='x'.repeat(262145);assert.equal((await handleRequest(req(big,await sign(big)),env,upstream)).status,413);
assert.equal((await handleRequest(req(body,await sign(body)),{...env,GAS_WEB_APP_URL:'https://attacker.test/exec'},upstream)).status,503);
assert.equal((await handleRequest(new Request('https://example.test/webhook'),env,upstream)).status,405);
console.log('PASS gateway: valid/tampered/missing signature, size cap, upstream failure, application failure, verification, configuration');

const originalFetch=globalThis.fetch;globalThis.fetch=upstream;
try {assert.equal((await worker.fetch(req(body,await sign(body)),env,{waitUntil(){}})).status,200);}finally{globalThis.fetch=originalFetch;}
console.log('PASS Cloudflare fetch entrypoint ignores ExecutionContext as injected fetcher');
