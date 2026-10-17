import { Client, input, delay, percentile } from './client.mjs'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Paced byte-range clients. This measures HTTP capacity; browser stall acceptance remains independent. */
export async function runLoad(config, client) {
  const { assetIds, allowHeavyLoad, storageKind, allowSmbLoad, seconds = 300, mbpsPerViewer = 8,
    phases = [{ viewers:5, mode:'same' }, { viewers:10, mode:'same' }, { viewers:20, mode:'same' }, { viewers:20, mode:'different' }] } = config
  if (!allowHeavyLoad || !['LOCAL','SMB'].includes(storageKind) || storageKind === 'SMB' && !allowSmbLoad) throw new Error('EXPLICIT_LOAD_WINDOW_APPROVAL_REQUIRED')
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 100 || assetIds.some(id => !/^\d+$/.test(id))
    || !Number.isInteger(seconds) || seconds < 2 || seconds > 7200 || mbpsPerViewer < 0.1 || mbpsPerViewer > 100
    || !Array.isArray(phases) || phases.length < 1 || phases.length > 12 || phases.some(p => !Number.isInteger(p.viewers) || p.viewers < 1 || p.viewers > 20 || !['same','different'].includes(p.mode) || p.mode==='different' && assetIds.length<p.viewers)) throw new Error('INVALID_BOUNDED_WORKLOAD')
  const lengths = new Map()
  for (const id of assetIds) {
    const response = await client.raw(`/api/v1/playback/assets/${id}/content`, { method:'HEAD' })
    if (response.status !== 200) {
      let category='UNCLASSIFIED';try { const problem=await response.json();if(/^[A-Z_]+$/.test(problem.code))category=problem.code } catch {}
      throw new Error('FIXTURE_HEAD_FAILED_'+response.status+'_'+category)
    }
    const length = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(length) || length < 8192) throw new Error('FIXTURE_TOO_SMALL')
    lengths.set(id,length)
  }
  const result = { format:1, startedAt:new Date().toISOString(), storageKind, configuredMbpsPerViewer:mbpsPerViewer,
    secondsPerPhase:seconds, browserPlayback:'PENDING', representativeMedia:config.representativeMedia === true,
    oneHourAcceptance:'PENDING', phases:[], samples:[], baseline: (await client.call('/admin/operations/status')).data }
  let monitoring = true
  const monitor = (async () => {
    while (monitoring) {
      try { const time=performance.now(), snapshot=(await client.call('/admin/operations/status')).data
        result.samples.push({ elapsedMs:Math.round(performance.now()-time), ...snapshot }) }
      catch { result.samples.push({ error:'DIAGNOSTICS_UNAVAILABLE' }) }
      await delay(2000)
    }
  })()
  try {
    for (const phase of phases) {
      const start=performance.now(), deadline=start+seconds*1000, initial=[], seek=[], complete=[], browse=[]
      let bytes=0, errors=0, rejected=0, intentionalDisconnects=0, intentionalSlowReads=0, simulatedDeadlineMisses=0
      let random=71329
      const rng=() => { random=(Math.imul(random,1664525)+1013904223)>>>0; return random/2**32 }
      async function range(id, offset, kind, slow=false, disconnect=false) {
        const length=lengths.get(id), size=Math.min(1048576,length-offset), began=performance.now()
        try {
          const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),10000)
          try {
            const r=await client.raw(`/api/v1/playback/assets/${id}/content`, { headers:{Cookie:'',Range:`bytes=${offset}-${offset+size-1}`},signal:abort.signal })
            const first=performance.now()-began
            if(r.status === 503) { rejected++; errors++; await r.body?.cancel(); return }
            if(r.status !== 206 || r.headers.get('content-range') !== `bytes ${offset}-${offset+size-1}/${length}`) { errors++; await r.body?.cancel(); return }
            if(disconnect) { intentionalDisconnects++; abort.abort(); await r.body?.cancel().catch(()=>{}); return }
            let received=0
            for await(const chunk of r.body) { received+=chunk.length; if(slow) await delay(25) }
            bytes+=received
            if(received !== size) errors++
            if(kind === 'initial') initial.push(first)
            if(kind === 'seek') seek.push(first)
            const elapsed=performance.now()-began; complete.push(elapsed)
            if(slow) intentionalSlowReads++
            else if(elapsed > size/(mbpsPerViewer*125000)*1000+1000) simulatedDeadlineMisses++
          } finally { clearTimeout(timer) }
        } catch { if(!disconnect) errors++ }
      }
      let browsing=true
      const browseTask=(async()=>{while(browsing) { const begin=performance.now(); try { const r=await client.raw('/api/v1/media?size=24&locale=en',{headers:{Cookie:''}}); await r.arrayBuffer(); if(!r.ok) errors++; else browse.push(performance.now()-begin) } catch{errors++} await delay(500) }})()
      await Promise.all(Array.from({length:phase.viewers},async(_,viewer)=>{
        const id=assetIds[phase.mode==='same' ? 0 : viewer%assetIds.length], length=lengths.get(id)
        // Two overlapping initial requests explicitly exercise browser request overlap at 20 viewers.
        await Promise.all([range(id,0,'initial'),range(id,Math.min(4096,length-8192),'initial')])
        let request=0
        while(performance.now()<deadline) {
          request++
          if(request%7===0) { await delay(750); continue } // pause/resume
          const offset=Math.floor(rng()*Math.max(1,length-8192)), slow=viewer===0 && request%4===0, disconnect=viewer===1 && request%5===0
          const begin=performance.now()
          await range(id,offset,request%3===0?'seek':'read',slow,disconnect)
          const size=Math.min(1048576,length-offset), period=size/(mbpsPerViewer*125000)*1000
          await delay(Math.max(0,Math.min(deadline-performance.now(),period-(performance.now()-begin))))
        }
      }))
      browsing=false; await browseTask
      const elapsed=(performance.now()-start)/1000
      result.phases.push({viewers:phase.viewers,mode:phase.mode,distinctFiles:phase.mode==='same'?1:Math.min(phase.viewers,assetIds.length),
        elapsedSeconds:elapsed,bytes,effectiveMbps:bytes*8/elapsed/1e6,initialP95Ms:percentile(initial,.95),seekP95Ms:percentile(seek,.95),
        requestCompleteP95Ms:percentile(complete,.95),catalogP95Ms:percentile(browse,.95),errors,rejected,simulatedDeadlineMisses,
        intentionalDisconnects,intentionalSlowReads,requests:complete.length,
        proposedLatencyTargets:{initial:initial.length?(percentile(initial,.95)<=3000?'PASS':'FAIL'):'PENDING',seek:seek.length?(percentile(seek,.95)<=2000?'PASS':'FAIL'):'PENDING',catalog:browse.length?(percentile(browse,.95)<=1000?'PASS':'FAIL'):'PENDING'},
        status:errors===0?'PASS':'FAIL'})
    }
    await delay(3000) // Observe admission/handle recovery after clients subside.
    result.after=(await client.call('/admin/operations/status')).data
  } finally { monitoring=false; await monitor }
  result.finishedAt=new Date().toISOString()
  result.status=result.phases.every(p=>p.status==='PASS') && result.after?.playback.activeTransfers===0 ? 'PASS':'FAIL'
  result.targets={initialP95Ms:3000,seekP95Ms:2000,catalogP95Ms:1000,oneHourNoBrowserStalls:'PROPOSED_NOT_EVALUATED_BY_HTTP_CLIENT'}
  return result
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const {config,password}=await input(), client=new Client(config.origin,config.allowLoopbackHttp)
    await client.login(password); const result=await runLoad(config,client)
    if(!config.resultFile) throw new Error('PROTECTED_NEW_RESULT_FILE_REQUIRED')
    await writeFile(config.resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
    console.log(JSON.stringify({status:result.status,phases:result.phases,browserAcceptance:'PENDING'})); if(result.status==='FAIL') process.exitCode=1
  } catch { console.error('{"status":"FAIL","category":"LOAD_RUN_FAILED_OR_NOT_APPROVED"}'); process.exitCode=1 }
}
