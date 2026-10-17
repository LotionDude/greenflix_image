// All physical writes/process termination target this test's newly created disposable directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn,execFileSync } from 'node:child_process'
import { mkdtemp,mkdir,copyFile,readFile,writeFile,readdir,rm,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve,dirname } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { randomBytes,pbkdf2Sync,createHash,randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Client,waitFor,delay } from './client.mjs'
import { runLoad } from './load.mjs'
import { runSmb } from './smb.mjs'
const project=fileURLToPath(new URL('../..',import.meta.url)),jar=resolve(process.env.GREENFLIX_TEST_JAR??join(project,'backend/target/greenflix-0.1.0-SNAPSHOT.jar'))
const java=process.env.JAVA_EXECUTABLE??'java',fixture=join(project,'deploy/test-results/gate3-media/known-h264-aac.mp4')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const results=join(project,'deploy/test-results')

test('load runner refuses unapproved remote/high load before contacting any host',async()=>{
  let contacted=false
  const client={raw:()=>{contacted=true;throw new Error()}}
  await assert.rejects(()=>runLoad({storageKind:'SMB',assetIds:['1'],allowHeavyLoad:true},client))
  await assert.rejects(()=>runLoad({storageKind:'LOCAL',assetIds:['1']},client))
  await assert.rejects(()=>runSmb({maximumHashBytes:1073741824},client))
  await assert.rejects(()=>runSmb({},client))
  assert.throws(()=>new Client('http://not-approved.invalid'),/HTTPS_REQUIRED/)
  assert.equal(contacted,false)
})

test('clean candidate: local 5/10/20 ranges, mixed scan/import, ownership, backup, JVM crash, lock recovery, rollback and TLS browsers', {timeout:360000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'greenflix-gate7-')),running=new Set(),logs=[]
  const password=randomBytes(32).toString('base64url'),salt=randomBytes(16),passwordHash=Buffer.concat([salt,pbkdf2Sync(password,salt,310000,32,'sha256')]).toString('hex')
  const app=join(directory,'application'),data=join(app,'data'),library=join(directory,'legacy'),managed=join(directory,'managed'),backups=join(directory,'backups'),external=join(directory,'external')
  for(const path of [app,data,library,managed,backups,external])await mkdir(path,{recursive:true})
  assert.equal(hash(await readFile(fixture)),'3bb938fb70049e3e45f533b37ccae995ae96516e04c2f35b0c1142e47b2a39c1')
  for(let i=0;i<20;i++)await copyFile(fixture,join(library,`Acceptance-${i}.mp4`))
  const config=join(app,'application-fixture.yml'),ffprobe=resolve(process.env.GREENFLIX_TEST_FFPROBE??join(project,'deploy/tools/ffprobe/ffprobe.exe'))
  await writeFile(config,`greenflix:\n  backup:\n    enabled: true\n    directory: ${JSON.stringify(backups)}\n    external-directory: ${JSON.stringify(external)}\n    interval-seconds: 60\n    retain: 2\n  library:\n    scanner:\n      ffprobe-path: ${JSON.stringify(ffprobe)}\n      stability-seconds: 0\n      failure-backoff-seconds: 0\n    imports:\n      write-approved-references: [managed-fixture]\n      bytes-per-second: 262144\n      reserve-bytes: 1048576\n    approved-roots:\n      - reference: fixture\n        path: ${JSON.stringify(library)}\n        revision: 1\n        comparison-mode: WINDOWS_INSENSITIVE\n      - reference: managed-fixture\n        path: ${JSON.stringify(managed)}\n        revision: 1\n        comparison-mode: WINDOWS_INSENSITIVE\n${process.platform==='win32'?'      - reference: disconnected\n        path: "\\\\\\\\unreachable.invalid\\\\fixture"\n        revision: 1\n        comparison-mode: WINDOWS_INSENSITIVE\n':''}`)
  const summary={format:1,scope:'DISPOSABLE_LOCAL_ONLY',candidateJarSha256:hash(await readFile(jar)),checks:[],browsers:[]}
  async function start({database=join(data,'live.db'),candidate=jar,args=[],expectedFailure=false}={}) {
    const begin=performance.now(),process=spawn(java,['--enable-native-access=ALL-UNNAMED','-jar',candidate,`--spring.config.additional-location=${pathToFileURL(config).href}`,...args],{
      cwd:app,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...globalThis.process.env,SERVER_ADDRESS:'127.0.0.1',SERVER_PORT:'0',GREENFLIX_DATABASE_URL:`jdbc:sqlite:${database}`,
        GREENFLIX_ADMIN_PASSWORD_HASH:passwordHash,GREENFLIX_PUBLIC_ORIGIN:'',GREENFLIX_JOURNAL_MODE:'DELETE',GREENFLIX_WAL_VERIFIED:'false'}})
    running.add(process);let output='';process.stdout.on('data',chunk=>{output+=chunk});process.stderr.on('data',chunk=>{output+=chunk})
    process.on('exit',()=>{running.delete(process);logs.push(output)})
    if(expectedFailure) {
      let timeout
      const code=await new Promise((resolve,reject)=>{timeout=setTimeout(()=>{process.kill();reject(new Error('EXPECTED_REFUSAL_TIMEOUT'))},20000);process.once('exit',code=>{clearTimeout(timeout);resolve(code)})})
      assert.notEqual(code,0);return
    }
    const port=await waitFor(()=>{const match=output.match(/Tomcat started on port (\d+)/);if(process.exitCode!==null)throw new Error('CANDIDATE_START_FAILED');return match?.[1]},Boolean,25000)
    const tls=args.some(arg=>arg==='--server.ssl.enabled=true'),origin=`${tls?'https':'http'}://127.0.0.1:${port}`
    const client=new Client(origin,true)
    if(!tls) {await waitFor(async()=>{try{return (await client.raw('/actuator/health/readiness')).status===200}catch{return false}},Boolean,15000);await client.login(password)}
    return {process,origin,client,startupMs:performance.now()-begin,stop:async()=>{if(process.exitCode===null){const exit=new Promise(resolve=>process.once('exit',resolve));process.kill();await exit}}}
  }
  async function scan(client,root) {const s=(await client.call(`/admin/library/discovery/roots/${root}/scans`,'POST',undefined,undefined,202)).data;return waitFor(async()=>(await client.call(`/admin/library/discovery/scans/${s.id}`)).data,s=>!['PENDING','RUNNING'].includes(s.status))}
  try {
    let server=await start(),client=server.client
    summary.startupWithConfiguredDisconnectedUncMs=server.startupMs
    summary.checks.push('candidate starts without contacting configured unavailable UNC')
    await start({expectedFailure:true});summary.checks.push('second JVM refuses SQLite ownership')
    const root=(await client.call('/admin/library/roots','POST',{displayName:'Disposable legacy fixture',classification:'LEGACY',enabled:true,runtimeRef:'fixture'},undefined,201)).data
    const destination=(await client.call('/admin/library/roots','POST',{displayName:'Disposable managed fixture',classification:'MANAGED',enabled:true,runtimeRef:'managed-fixture'},undefined,201)).data
    const destinationTag=(await client.call(`/admin/library/roots/${destination.id}`)).etag
    await client.call(`/admin/library/imports/destinations/${destination.id}/permission`,'PUT',{enabled:true},destinationTag)
    assert.equal((await scan(client,root.id)).status,'COMPLETED')
    const assets=(await client.call(`/admin/library/assets?storageRootId=${root.id}&size=100`)).data.items;assert.equal(assets.length,20)
    const movie=(await client.call('/admin/media','POST',{type:'MOVIE',titleEn:'Gate 7 disposable acceptance',titleHe:'בדיקת קבלה'},undefined,201)).data
    for(const asset of assets) {const tag=(await client.call('/admin/media/'+movie.id)).etag;await client.call('/admin/library/bindings','POST',{assetId:asset.id,targetType:'MOVIE',targetId:movie.id,versionLabel:'Fixture '+asset.id,preferenceOrder:0},tag,201)}
    await client.call(`/admin/media/${movie.id}/publish`,'POST',undefined,(await client.call('/admin/media/'+movie.id)).etag)
    const input={sourceAssetId:assets[0].id,destinationRootId:destination.id,versionLabel:'Mixed-load fixture',exportMetadata:true,preferImported:false}
    const preview=(await client.call('/admin/library/imports/preview','POST',input)).data
    const job=(await client.call('/admin/library/imports','POST',{...input,previewToken:preview.token,requestKey:randomUUID(),confirmed:true},(await client.call('/admin/library/assets/'+assets[0].id)).etag)).data
    const concurrentScan=scan(client,root.id).catch(()=>({status:'UNAVAILABLE'}))
    let hostMonitor,hostFile
    if(process.platform==='win32') {
      hostFile=join(results,'gate7-host-'+randomUUID()+'.json')
      hostMonitor=spawn(process.env.GREENFLIX_TEST_POWERSHELL??'pwsh.exe',['-NoProfile','-NonInteractive','-File',join(project,'deploy/windows/Measure-Host.ps1'),'-JavaProcessId',String(server.process.pid),'-NewOutputFile',hostFile,'-Seconds',String(4*Number(process.env.GREENFLIX_LOCAL_LOAD_SECONDS??6)+8)],{windowsHide:true,stdio:['ignore','pipe','pipe']})
      hostMonitor.stdout.resume();hostMonitor.stderr.resume()
    }
    summary.load=await runLoad({assetIds:assets.map(a=>a.id),storageKind:'LOCAL',allowHeavyLoad:true,seconds:Number(process.env.GREENFLIX_LOCAL_LOAD_SECONDS??6),mbpsPerViewer:4,representativeMedia:false},client)
    console.log(JSON.stringify({localRangePhases:summary.load.phases}))
    assert.equal(summary.load.after.playback.activeTransfers,0)
    assert.ok(summary.load.phases.every(p=>p.errors===p.rejected),'Only explicit bounded transfer-limit rejections are expected under initial overlap')
    assert.equal((await concurrentScan).status,'COMPLETED')
    if(hostMonitor) {
      const exit=hostMonitor.exitCode??await new Promise(resolve=>hostMonitor.once('exit',resolve));assert.equal(exit,0)
      const samples=JSON.parse(await readFile(hostFile,'utf8'));summary.host={evidenceFile:hostFile.split(/[\\/]/).at(-1),counterStatus:samples.CounterStatus,
        samples:samples.Samples.length,first:samples.Samples[0],last:samples.Samples.at(-1),peakHandles:Math.max(...samples.Samples.map(s=>s.Handles)),peakThreads:Math.max(...samples.Samples.map(s=>s.Threads)),peakPrivateBytes:Math.max(...samples.Samples.map(s=>s.PrivateBytes))}
    }
    const complete=await waitFor(async()=>(await client.call('/admin/library/imports/'+job.id)).data,j=>j.state==='COMPLETED' && j.sidecarStatus!=='PENDING')
    assert.equal(complete.sidecarStatus,'EXPORTED');assert.equal(hash(await readFile(join(managed,complete.relativePath))),hash(await readFile(fixture)))
    assert.equal(hash(await readFile(join(library,assets[0].relativePath))),hash(await readFile(fixture)))
    if(process.platform==='win32') {
      const code="$ErrorActionPreference='Stop'; $files=[Console]::In.ReadToEnd()|ConvertFrom-Json; foreach($file in $files){$stream=[IO.File]::Open($file,'Open','Read','None');$stream.Dispose()};'PASS'"
      const checked=execFileSync(process.env.GREENFLIX_TEST_POWERSHELL??'pwsh.exe',['-NoProfile','-NonInteractive','-Command',code],{
        input:JSON.stringify([...assets.map(a=>join(library,a.relativePath)),join(managed,complete.relativePath)]),windowsHide:true,encoding:'utf8'})
      assert.equal(checked.trim(),'PASS');summary.exclusivelyReopenedMediaFiles=21
    }
    summary.checks.push('20 distinct native files and mixed range/scan/import workload','source and published copy hashes equal; metadata sidecar exported')
    await waitFor(async()=>(await client.call('/admin/operations/status')).data,s=>s.backup.lastLocalSuccess && s.backup.lastExternalSuccess)
    summary.checks.push('scheduled local and external verified snapshots')
    const lock=new DatabaseSync(join(data,'live.db'));lock.exec('BEGIN EXCLUSIVE')
    try { const blocked=await client.call('/admin/media','POST',{type:'MOVIE',titleEn:'Must not commit'},undefined,503);assert.equal(blocked.data.code,'DATABASE_BUSY') }
    finally {lock.exec('ROLLBACK');lock.close()}
    assert.equal((await client.raw('/api/v1/media?size=1')).status,200);summary.checks.push('real SQLite exclusive-lock 503 and recovery')
    const response=await client.raw('/api/v1/admin/operations/backup',{method:'POST',headers:{'X-CSRF-TOKEN':client.csrf}});assert.equal(response.status,200)
    const snapshot=join(directory,'verified-backup.sqlite');await writeFile(snapshot,Buffer.from(await response.arrayBuffer()))
    const snapshotHash=hash(await readFile(snapshot))
    const verify=spawn(java,['--enable-native-access=ALL-UNNAMED','-Dloader.main=com.greenflix.operations.DatabaseMaintenance','-cp',jar,'org.springframework.boot.loader.launch.PropertiesLauncher','verify',snapshot,snapshotHash],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    verify.stdout.resume();verify.stderr.resume();assert.equal(await new Promise(resolve=>verify.on('exit',resolve)),0)
    const releaseManifest=JSON.parse(await readFile(join(dirname(jar),'release-manifest.json'),'utf8'))
    const restoreInput=join(directory,'operator-backup');await mkdir(restoreInput);await copyFile(snapshot,join(restoreInput,'database.sqlite'))
    await writeFile(join(restoreInput,'manifest.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),sha256:snapshotHash,schemaSha256:releaseManifest.schemaSha256,bytes:(await readFile(snapshot)).length}))
    const restoreOutput=join(directory,'operator-restored'),restore=spawn(process.env.GREENFLIX_TEST_POWERSHELL??'pwsh.exe',['-NoProfile','-NonInteractive','-File',join(project,'deploy/windows/Restore-Snapshot.ps1'),
      '-BackupDirectory',restoreInput,'-NewDataDirectory',restoreOutput,'-ReleaseDirectory',dirname(jar),'-JavaExe',java,'-ApproveIsolatedRestore'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    restore.stdout.resume();restore.stderr.resume();assert.equal(await new Promise(resolve=>restore.on('exit',resolve)),0)
    const restoredDb=new DatabaseSync(join(restoreOutput,'greenflix.db'),{readOnly:true})
    try{assert.equal(restoredDb.prepare('SELECT count(*) n FROM media').get().n,1);assert.equal(restoredDb.prepare('SELECT count(*) n FROM media_asset').get().n,21)}finally{restoredDb.close()}
    assert.ok(JSON.parse(await readFile(join(restoreOutput,'RESTORE-VERIFIED.json'),'utf8')).sha256===snapshotHash)
    summary.checks.push('operator PowerShell restore script verifies an isolated snapshot and all 21 assets')
    await server.stop();summary.checks.push('abrupt JVM termination with committed catalog/import data')
    server=await start();client=server.client
    assert.equal((await client.call('/admin/library/imports/'+job.id)).data.state,'COMPLETED')
    assert.equal((await client.call('/playback/movies/'+movie.id)).data.sources.length,21)
    await server.stop();summary.checks.push('restart preserves one completed import without duplicate registration')
    const restored=join(data,'restored.db');await copyFile(snapshot,restored)
    const previous=process.env.GREENFLIX_PREVIOUS_JAR
    if(previous){server=await start({database:restored,candidate:resolve(previous)});assert.equal((await server.client.call('/media?q=Gate&locale=en')).data.totalElements,1);await server.stop();summary.checks.push('rollback to preserved Gate 6 JAR with compatible isolated snapshot')}
    else summary.previousReleaseRollback='PENDING_PREVIOUS_JAR_NOT_SUPPLIED'
    // No Windows trust-store changes. A child Node process explicitly trusts ONLY this disposable certificate.
    const keytool=process.env.GREENFLIX_TEST_KEYTOOL??'keytool',keystore=join(directory,'tls.p12'),certificate=join(directory,'tls.crt')
    const tlsSecret=randomBytes(24).toString('hex'),tlsEnv={...process.env,GREENFLIX_LOCAL_TLS_SECRET:tlsSecret}
    execFileSync(keytool,['-genkeypair','-alias','fixture','-keyalg','RSA','-keysize','2048','-validity','2','-dname','CN=localhost','-ext','SAN=IP:127.0.0.1,DNS:localhost','-storetype','PKCS12','-keystore',keystore,'-storepass:env','GREENFLIX_LOCAL_TLS_SECRET'],{env:tlsEnv,windowsHide:true,stdio:'pipe'})
    execFileSync(keytool,['-exportcert','-rfc','-alias','fixture','-keystore',keystore,'-storepass:env','GREENFLIX_LOCAL_TLS_SECRET','-file',certificate],{env:tlsEnv,windowsHide:true,stdio:'pipe'})
    const tlsConfig=join(app,'tls.yml');await writeFile(tlsConfig,`server:\n  ssl:\n    key-store: ${JSON.stringify(pathToFileURL(keystore).href)}\n    key-store-type: PKCS12\n    key-store-password: ${tlsSecret}\n`)
    server=await start({args:['--server.ssl.enabled=true',`--spring.config.additional-location=${pathToFileURL(config).href},${pathToFileURL(tlsConfig).href}`]})
    const tlsResult=join(directory,'https-result.json'),child=spawn(globalThis.process.execPath,[join(project,'deploy/acceptance/https.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_EXTRA_CA_CERTS:certificate}})
    child.stdout.resume();child.stderr.resume();child.stdin.end(JSON.stringify({password,config:{origin:server.origin,assetId:assets[0].id,resultFile:tlsResult}}))
    assert.equal(await new Promise(resolve=>child.on('exit',resolve)),0);summary.https=JSON.parse(await readFile(tlsResult,'utf8'));assert.ok(summary.https.rows.filter(r=>r.status!=='PENDING').every(r=>r.status==='PASS'))
    const {chromium}=await import('../../frontend/node_modules/playwright/index.mjs')
    for(const channel of ['chrome','msedge']) {
      const browser=await chromium.launch({channel});try{
        const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),errors=[]
        page.on('pageerror',e=>errors.push(e.message));await page.goto(server.origin+'/media/'+movie.id)
        const began=performance.now();await page.getByRole('button',{name:/^Play /}).first().click();const video=page.locator('video');await video.evaluate(v=>v.play())
        await waitFor(()=>video.evaluate(v=>v.videoWidth>0&&v.currentTime>0),Boolean,15000)
        const initialMs=performance.now()-began;await video.evaluate(v=>v.pause());const seek=performance.now();await video.evaluate(v=>{v.currentTime=7})
        await waitFor(()=>video.evaluate(v=>!v.seeking&&v.currentTime>=6.9),Boolean,10000);const seekMs=performance.now()-seek;await video.evaluate(v=>v.play());await waitFor(()=>video.evaluate(v=>v.currentTime>7.1),Boolean)
        assert.deepEqual(errors,[]);summary.browsers.push({channel,initialMs,seekMs,decoded:true,certificateScope:'DISPOSABLE_SELF_SIGNED_BROWSER_EXCEPTION_ONLY'})
      }finally{await browser.close()}
    }
    await server.stop();summary.checks.push('direct TLS chain/HEAD/206/416/cookie/CSRF and real Chrome/Edge decode and seek')
    await start({args:['--server.ssl.enabled=true','--server.ssl.key-store=file:/not-present/fixture.p12'],expectedFailure:true});summary.checks.push('invalid TLS configuration fails startup')
    for(const output of logs){assert.equal(output.includes(password),false);assert.equal(output.includes(passwordHash),false);assert.equal(output.includes(tlsSecret),false);assert.equal(output.includes('unreachable.invalid'),false)}
    summary.status='PASS';await writeFile(join(results,'gate7-local-candidate.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:summary.checks.length,load:summary.load.phases,browsers:summary.browsers}))
  } finally {
    if(!summary.status){summary.status='FAIL';await writeFile(join(results,'gate7-local-candidate-failed.json'),JSON.stringify(summary,null,2)+'\n')}
    for(const process of running){if(process.exitCode===null){const exited=new Promise(resolve=>process.once('exit',resolve));process.kill();await exited}}
    const resolved=await realpath(directory),temporary=await realpath(tmpdir());assert.ok(resolved.startsWith(temporary+'\\')||resolved.startsWith(temporary+'/'))
    assert.ok(resolved.includes('greenflix-gate7-'));await rm(resolved,{recursive:true,force:true})
  }
})
