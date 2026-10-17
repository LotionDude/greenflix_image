import { Client,input,waitFor } from './client.mjs'
import { readFile,writeFile,open,lstat } from 'node:fs/promises'
import { createHash,randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { win32,dirname,join } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash=async(file,maximum)=>{const sum=createHash('sha256'), stream=(await open(file,'r')).createReadStream({end:maximum});let bytes=0;for await(const chunk of stream){bytes+=chunk.length;if(bytes>maximum)throw new Error('HASH_READ_LIMIT');sum.update(chunk)}return sum.digest('hex')}
async function inventory(client,root) {
  const items=[]
  for(let page=0;page<1000;page++) { const result=(await client.call(`/admin/library/assets?storageRootId=${root}&size=100&page=${page}`)).data;items.push(...result.items);if(page+1>=result.totalPages)return items }
  throw new Error('FIXTURE_ROOT_TOO_LARGE')
}
async function scan(client,root) {
  const start=(await client.call(`/admin/library/discovery/roots/${root}/scans`,'POST',undefined,undefined,202)).data
  return waitFor(async()=>(await client.call(`/admin/library/discovery/scans/${start.id}`)).data,s=>!['PENDING','RUNNING'].includes(s.status),180000)
}
async function bytes(client,asset,length) {
  const path=`/api/v1/playback/assets/${asset}/content`, head=await client.raw(path,{method:'HEAD'})
  if(head.status!==200 || Number(head.headers.get('content-length'))!==length)throw new Error('HEAD_FAILED')
  const offsets=[0,Math.floor(length/2),Math.max(0,length-4096)]
  await Promise.all(offsets.map(async start=>{
    const end=Math.min(length-1,start+4095), r=await client.raw(path,{headers:{Range:`bytes=${start}-${end}`}})
    if(r.status!==206 || r.headers.get('content-range')!==`bytes ${start}-${end}/${length}` || (await r.arrayBuffer()).byteLength!==end-start+1)throw new Error('RANGE_FAILED')
  }))
  const invalid=await client.raw(path,{headers:{Range:`bytes=${length+1}-`}});await invalid.arrayBuffer();if(invalid.status!==416)throw new Error('INVALID_RANGE_FAILED')
}
async function probe(exe,file) {
  await new Promise((resolve,reject)=>{
    const p=spawn(exe,['-v','error','-protocol_whitelist','file','-format_whitelist','mov,matroska,webm,avi','-enable_drefs','0','-use_absolute_path','0',
      '-probesize','5000000','-analyzeduration','5000000','-max_alloc','67108864','-show_entries','format=format_name:stream=codec_name,codec_type','-of','json',file],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output='',size=0;const timer=setTimeout(()=>{p.kill();reject(new Error('PROBE_TIMEOUT'))},30000)
    p.stdout.on('data',chunk=>{size+=chunk.length;if(size>1048576){p.kill();reject(new Error('PROBE_OUTPUT_LIMIT'))}else output+=chunk})
    p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(new Error('PROBE_START_FAILED'))})
    p.on('exit',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code!==0 || !result.format?.format_name?.includes('mp4') || !result.streams?.some(s=>s.codec_name==='h264'))throw new Error();resolve()}catch{reject(new Error('PROBE_FAILED'))}})
  })
}
export async function runSmb(config,client) {
  const maximum=config.maximumHashBytes??268435456
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>107374182400||maximum>268435456&&(!config.allowHeavyLoad||!config.allowSmbLoad))throw new Error('BOUNDED_HASH_AND_EXPLICIT_HEAVY_SMB_APPROVAL_REQUIRED')
  if(!config.approveFixtureCatalogChanges || config.scanRootIsDisposableFixtureOnly!==true || !/^\d+$/.test(config.rootId) || !/^\d+$/.test(config.fixtureMovieId))throw new Error('APPROVED_DISPOSABLE_CATALOG_AND_SCAN_ROOT_REQUIRED')
  const rows=[],add=(test,status,evidence)=>rows.push({test,status,evidence})
  const report={format:1,startedAt:new Date().toISOString(),mode:config.mode??'normal',rows,realSmbAcceptance:'PENDING',serviceTokenAcceptance:'PENDING'}
  const before=await inventory(client,config.rootId)
  if(['outage','permission','recovery'].includes(config.mode)) {
    const baseline=JSON.parse(await readFile(config.baselineFile,'utf8'))
    const state=await scan(client,config.rootId),after=await inventory(client,config.rootId)
    const was=new Map(baseline.inventory.map(a=>[a.id,a.availability]))
    const newMissing=after.filter(a=>was.get(a.id)!==a.availability && a.availability==='MISSING').length
    const unavailable=config.mode!=='recovery'
    add(config.mode,unavailable ? (!state.authoritative && state.status!=='COMPLETED' && newMissing===0?'PASS':'FAIL') : state.status==='COMPLETED'?'PASS':'FAIL',
      {scanStatus:state.status,authoritative:state.authoritative,newMissing})
    const catalog=await client.raw('/api/v1/media?size=1');await catalog.arrayBuffer();add('catalog-during-storage-drill',catalog.status===200?'PASS':'FAIL')
    report.inventory=after.map(a=>({id:a.id,availability:a.availability,contentGeneration:a.contentGeneration}))
    return report
  }
  if(config.mode==='baseline') {report.inventory=before.map(a=>({id:a.id,availability:a.availability,contentGeneration:a.contentGeneration}));add('baseline','PASS',{assets:before.length});return report}
  const first=await scan(client,config.rootId);add('discovery',first.status==='COMPLETED'?'PASS':'FAIL',{status:first.status,authoritative:first.authoritative})
  if(first.status!=='COMPLETED')return report
  const assets=await inventory(client,config.rootId),asset=assets.find(a=>a.relativePath===config.sampleRelativePath)
  if(!asset)throw new Error('SELECTED_FIXTURE_NOT_DISCOVERED')
  const second=await scan(client,config.rootId);add('incremental-rescan',second.status==='COMPLETED' && (await inventory(client,config.rootId)).length===assets.length?'PASS':'FAIL',{newAssets:second.newAssets,unchanged:second.unchangedAssets})
  // A generated proposal is advice. Selecting this exact operator-named target still requires approval below.
  await client.call('/admin/library/matching/run','POST',{storageRootId:config.rootId,size:100,all:false})
  const detail=await client.call(`/admin/library/assets/${asset.id}`)
  if(detail.data.technical.probeStatus!=='SUCCEEDED' || !detail.data.technical.videoCodecs.includes('h264') || first.probeFailures!==0)throw new Error('REAL_SCANNER_PROBE_NOT_VERIFIED')
  let proposal=await client.call(`/admin/library/matching/assets/${asset.id}/select`,'POST',{targetType:'MOVIE',targetId:config.fixtureMovieId},detail.etag)
  await client.call(`/admin/library/matching/proposals/${proposal.data.id}/approve`,'POST',undefined,proposal.etag)
  add('explicit-matching-and-association','PASS')
  const resolution=(await client.call(`/playback/movies/${config.fixtureMovieId}`)).data
  // Publication is intentionally never performed by this toolkit. Operator must publish only its fixture target.
  await bytes(client,asset.id,asset.fileSize);add('original-playback-and-arbitrary-ranges','PASS',{parallelRanges:3,head:200,range:206,invalid:416})
  add('ffprobe-via-scanner','PASS',{probeStatus:detail.data.technical.probeStatus,videoCodecs:detail.data.technical.videoCodecs})
  if(config.ffprobeExe && config.sourceUncRoot) {
    if(!config.sourceUncRoot.startsWith('\\\\') || config.sampleRelativePath.includes('..') || win32.isAbsolute(config.sampleRelativePath))throw new Error('UNC_FIXTURE_REQUIRED')
    const file=win32.join(config.sourceUncRoot,config.sampleRelativePath), info=await lstat(file)
    if(info.isSymbolicLink() || !info.isFile() || info.size>maximum)throw new Error('BOUNDED_FIXTURE_REQUIRED')
    const original=await hash(file,maximum);await probe(config.ffprobeExe,file);add('direct-ffprobe-over-smb','PASS')
    if(config.managedRootId) {
      if(!config.approveDisposableManagedWrites || !config.managedDisposableDirectory?.startsWith('\\\\') || !config.managedReference)throw new Error('EXPLICIT_DISPOSABLE_DIRECTORY_APPROVAL_REQUIRED')
      const root=(await client.call(`/admin/library/roots/${config.managedRootId}`)).data
      if(root.runtimeRef!==config.managedReference || root.classification!=='MANAGED')throw new Error('MANAGED_ROOT_APPROVAL_MISMATCH')
      const request={sourceAssetId:asset.id,destinationRootId:config.managedRootId,versionLabel:'Acceptance '+randomUUID().slice(0,8),exportMetadata:true,preferImported:false}
      const preview=(await client.call('/admin/library/imports/preview','POST',request)).data
      const source=await client.call(`/admin/library/assets/${asset.id}`)
      const submitted=(await client.call('/admin/library/imports','POST',{...request,previewToken:preview.token,requestKey:randomUUID(),confirmed:true},source.etag)).data
      const job=await waitFor(async()=>(await client.call('/admin/library/imports/'+submitted.id)).data,j=>['COMPLETED','FAILED','RECOVERY_REQUIRED','CANCELLED'].includes(j.state),config.importTimeoutMs??300000)
      if(job.state!=='COMPLETED' || job.sha256!==original)throw new Error('MANAGED_IMPORT_NOT_VERIFIED')
      const imported=win32.join(config.managedDisposableDirectory,job.relativePath)
      if(!imported.startsWith(config.managedDisposableDirectory.replace(/[\\/]+$/,'')+'\\'))throw new Error('MANAGED_CONTAINMENT_FAILED')
      const metadata=JSON.parse(await readFile(win32.join(win32.dirname(imported),'metadata.json'),'utf8'))
      if(await hash(imported,maximum)!==original || await hash(file,maximum)!==original || metadata.schemaVersion!==1)throw new Error('MANAGED_OR_SOURCE_VERIFICATION_FAILED')
      await bytes(client,job.resultingAssetId,info.size)
      add('managed-stage-hash-publication-registration-sidecar-source-preserved','PASS',{jobState:job.state,sidecar:job.sidecarStatus})
    }
  } else add('direct-ffprobe-and-source-preservation','PENDING','Supply bounded approved UNC fixture and pinned executable')
  for(const drill of ['file-change-during-playback','network-interruption-and-recovery','share-permission-failure','restart-with-disconnected-share','managed-termination-and-explicit-retry','cold-reboot-without-login'])add(drill,'PENDING','Run approved disposable fault drill and attach evidence; toolkit never changes shares or kills the production service')
  return report
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{const {config,password}=await input(),client=new Client(config.origin,config.allowLoopbackHttp);await client.login(password);const result=await runSmb(config,client)
    result.status=result.rows.some(r=>r.status==='FAIL')?'FAIL':'PENDING';if(!config.resultFile)throw new Error('RESULT_REQUIRED')
    await writeFile(config.resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,rows:result.rows}));if(result.status==='FAIL')process.exitCode=1
  }catch{console.error('{"status":"FAIL","category":"SMB_SUITE_FAILED_OR_NOT_APPROVED"}');process.exitCode=1}
}
