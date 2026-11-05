/** LINE verifies the unmodified request body before forwarding to Apps Script. */
export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== '/webhook') return new Response('Not found', {status:404});
  if (request.method !== 'POST') return new Response('Method not allowed', {status:405,headers:{Allow:'POST'}});
  if (!env.LINE_CHANNEL_SECRET || !env.MILLIE_GATEWAY_SECRET || !env.GAS_WEB_APP_URL) {
    return new Response('Gateway not configured', {status:503});
  }
  let target;
  try { target = new URL(env.GAS_WEB_APP_URL); } catch { return new Response('Invalid upstream configuration',{status:503}); }
  if (target.protocol !== 'https:' || target.hostname !== 'script.google.com' || !/^\/macros\/s\/[^/]+\/exec$/.test(target.pathname)) {
    return new Response('Invalid upstream configuration',{status:503});
  }
  // Modest cap bounds memory; actual LINE webhook messages are much smaller.
  if (Number(request.headers.get('content-length') || 0) > 262144) return new Response('Too large',{status:413});
  const reader=request.body?.getReader();
  const chunks=[];let size=0;
  if(reader){while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(value);}}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const signature=request.headers.get('x-line-signature');
  if (!signature) return new Response('Missing signature',{status:401});
  let sig;
  try { sig=Uint8Array.from(atob(signature),c=>c.charCodeAt(0)); } catch { return new Response('Invalid signature',{status:401}); }
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if (!(await crypto.subtle.verify('HMAC',key,sig,bytes))) return new Response('Invalid signature',{status:401});
  let payload;
  try { payload=JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response('Invalid JSON',{status:400}); }
  if (!Array.isArray(payload.events) || payload.events.length>100) return new Response('Invalid events',{status:400});
  if (!payload.events.length) return new Response('OK'); // LINE verification request
  try {
    const response=await fetcher(target.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gatewaySecret:env.MILLIE_GATEWAY_SECRET,events:payload.events}),redirect:'follow',signal:AbortSignal.timeout(20000)});
    if (!response.ok) return new Response('Upstream error',{status:502});
    const result=await response.json();
    // GAS ContentService usually returns HTTP 200 even when the application rejects a request.
    if (result.ok !== true) return new Response('Processing incomplete',{status:503});
    return new Response('OK');
  } catch { return new Response('Upstream unavailable',{status:503}); }
}
export default {fetch(request, env) { return handleRequest(request, env); }};
