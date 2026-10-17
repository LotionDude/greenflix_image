import tls from 'node:tls'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Client,input,validateOrigin } from './client.mjs'

export async function runHttps(config,client) {
  const origin=validateOrigin(config.origin),url=new URL(origin),rows=[]
  const connection=await new Promise((resolve,reject)=>{
    const socket=tls.connect({host:url.hostname,port:Number(url.port)||443,servername:url.hostname,minVersion:'TLSv1.2',rejectUnauthorized:true},()=>{
      const certificate=socket.getPeerCertificate(),result={authorized:socket.authorized,protocol:socket.getProtocol(),validTo:certificate.valid_to,fingerprint256:certificate.fingerprint256}
      socket.end();resolve(result)
    })
    socket.setTimeout(10000,()=>socket.destroy(new Error('TLS_TIMEOUT')));socket.once('error',reject)
  })
  rows.push({test:'certificate-chain-and-hostname',status:connection.authorized?'PASS':'FAIL',evidence:connection})
  const anonymous=await fetch(origin+'/api/v1/admin/operations/status',{redirect:'error',signal:AbortSignal.timeout(10000)})
  await anonymous.arrayBuffer();rows.push({test:'private-operations',status:anonymous.status===401?'PASS':'FAIL'})
  const csrf=await client.raw('/api/v1/csrf'),cookie=csrf.headers.getSetCookie().find(v=>v.startsWith('JSESSIONID='))
  await csrf.arrayBuffer()
  // Existing session may suppress Set-Cookie; obtain an independent anonymous bootstrap too.
  const bootstrap=await fetch(origin+'/api/v1/csrf',{redirect:'error',signal:AbortSignal.timeout(10000)}),newCookie=bootstrap.headers.getSetCookie().find(v=>v.startsWith('JSESSIONID='))
  await bootstrap.arrayBuffer()
  rows.push({test:'session-cookie',status:newCookie && /;\s*Secure/i.test(newCookie) && /;\s*HttpOnly/i.test(newCookie) && /;\s*SameSite=Lax/i.test(newCookie)?'PASS':'FAIL'})
  const denied=await client.raw('/api/v1/admin/operations/backup',{method:'POST'});await denied.arrayBuffer()
  rows.push({test:'csrf-required',status:denied.status===403?'PASS':'FAIL'})
  const cross=await client.raw('/api/v1/admin/operations/backup',{method:'POST',headers:{Origin:'https://not-greenflix.invalid','X-CSRF-TOKEN':client.csrf}});await cross.arrayBuffer()
  rows.push({test:'cross-origin-admin-denied',status:cross.status===403?'PASS':'FAIL'})
  if(!/^\d+$/.test(config.assetId))throw new Error('APPROVED_PUBLISHED_ASSET_REQUIRED')
  const path=`/api/v1/playback/assets/${config.assetId}/content`,head=await client.raw(path,{method:'HEAD'}),length=Number(head.headers.get('content-length'))
  rows.push({test:'HEAD-through-ingress',status:head.status===200 && length>4096 && head.headers.get('accept-ranges')==='bytes'?'PASS':'FAIL'})
  const start=Math.floor(length/2),end=Math.min(length-1,start+4095),ranged=await client.raw(path,{headers:{Range:`bytes=${start}-${end}`}})
  rows.push({test:'206-through-ingress',status:ranged.status===206 && ranged.headers.get('content-range')===`bytes ${start}-${end}/${length}` && (await ranged.arrayBuffer()).byteLength===end-start+1?'PASS':'FAIL'})
  const invalid=await client.raw(path,{headers:{Range:`bytes=${length+1}-`}});await invalid.arrayBuffer()
  rows.push({test:'416-through-ingress',status:invalid.status===416 && invalid.headers.get('content-range')===`bytes */${length}`?'PASS':'FAIL'})
  const abort=new AbortController(),cancel=await client.raw(path,{signal:abort.signal,headers:{Range:'bytes=0-'}})
  await cancel.body?.getReader().cancel();abort.abort();rows.push({test:'client-cancellation-request-sent',status:'PASS'})
  for(const name of ['long-lived-response-and-proxy-buffering','Chrome-and-Edge-trusted-playback','internal-firewall-and-public-exposure','ingress-timeouts-under-one-hour-load'])rows.push({test:name,status:'PENDING'})
  return {format:1,observedAt:new Date().toISOString(),status:rows.some(r=>r.status==='FAIL')?'FAIL':'PENDING',rows}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{const {config,password}=await input(),client=new Client(config.origin);await client.login(password);const result=await runHttps(config,client)
    await writeFile(config.resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));if(result.status==='FAIL')process.exitCode=1
  }catch{console.error('{"status":"FAIL","category":"TLS_OR_INGRESS_ACCEPTANCE_FAILED"}');process.exitCode=1}
}
