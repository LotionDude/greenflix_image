import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile,copyFile,rename,readdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomBytes,pbkdf2Sync,createHash} from 'node:crypto'
import {Client,waitFor,delay} from '../acceptance/client.mjs'
import {runLoad} from '../acceptance/load.mjs'
import {chromium} from '../../frontend/node_modules/playwright/index.mjs'
import {createServer} from 'node:net'
const launcher=resolve(process.env.GREENFLIX_TEST_LAUNCHER),project=process.cwd()
const directory=resolve('deploy/test-results/packaging/portable-'+Date.now()),state=join(directory,'state'),config=join(directory,'config'),media=join(directory,'media-original')
const hash=b=>createHash('sha256').update(b).digest('hex')
test('actual portable EXE: external config, native runtime/probe, relocation, browsers, capacity, persistence and graceful stop',{timeout:240000},async()=>{
  for(const path of [state,config,media,join(config,'secrets')])await mkdir(path,{recursive:true})
  await copyFile('deploy/test-results/gate3-media/known-h264-aac.mp4',join(media,'Portable.Movie.2024.mp4'))
  const password=randomBytes(32).toString('base64url'),salt=randomBytes(16),passwordHash=Buffer.concat([salt,pbkdf2Sync(password,salt,310000,32,'sha256')]).toString('hex')
  await writeFile(join(config,'secrets/greenflix-admin-password-hash'),passwordHash)
  const sourceHash=hash(await readFile(join(media,'Portable.Movie.2024.mp4')))
  let process,output='',logs=[],origin,client,mapped=media
  const evidence={format:1,status:'FAIL',scope:'DISPOSABLE_LOCAL_WINDOWS',checks:[],browsers:[],productionReady:false}
  const env={...globalThis.process.env}
  for(const key of ['JAVA_HOME','JDK_HOME','GREENFLIX_ADMIN_PASSWORD_HASH','GREENFLIX_FFPROBE_PATH','GREENFLIX_DATABASE_URL','SPRING_CONFIG_LOCATION','SPRING_PROFILES_ACTIVE'])delete env[key]
  // Hide host Java and ffprobe from PATH. The native launcher must find its own runtime/tools.
  env.PATH=globalThis.process.env.SystemRoot+'\\System32'
  async function configuration(extra=''){
    await writeFile(join(config,'application.yml'),`spring:\n  config:\n    import: ${JSON.stringify('configtree:'+join(config,'secrets').replaceAll('\\','/')+'/')}\nserver:\n  address: 127.0.0.1\n  port: 0\ngreenflix:\n  state-directory: ${JSON.stringify(state)}\n  storage:\n    url: ${JSON.stringify('jdbc:sqlite:'+join(state,'portable.db'))}\n  auth:\n    password-hash: \${greenflix-admin-password-hash}\n  library:\n    scanner:\n      stability-seconds: 0\n    approved-roots:\n      - reference: portable-legacy\n        path: ${JSON.stringify(mapped)}\n        revision: 1\n        comparison-mode: WINDOWS_INSENSITIVE\n    imports:\n      write-approved-references: []\n${extra}`)
  }
  async function command(args){return new Promise((done,reject)=>{const child=spawn(launcher,[`--config-dir=${config}`,...args],{cwd:state,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.on('error',reject);child.on('exit',code=>done({code,text}))})}
  async function start(database='portable.db'){output='';process=spawn(launcher,[`--config-dir=${config}`,`--greenflix.storage.url=jdbc:sqlite:${join(state,database)}`],{cwd:state,env,windowsHide:true,stdio:['ignore','pipe','pipe']});process.stdout.on('data',b=>output+=b);process.stderr.on('data',b=>output+=b)
    const port=await waitFor(()=>{if(process.exitCode!==null)throw Error('EXE_START_FAILED '+output.slice(-1800));return output.match(/Tomcat started on port (\d+)/)?.[1]},Boolean,30000)
    origin='http://127.0.0.1:'+port;client=new Client(origin,true);await waitFor(async()=>{try{return(await client.raw('/actuator/health/readiness')).ok}catch{return false}},Boolean)
    await client.login(password);await waitFor(()=>readFile(join(state,'greenflix.running'),'utf8').catch(()=>null),Boolean)
  }
  async function stop(){if(process?.exitCode===null){const result=await command(['--stop']);assert.equal(result.code,0,result.text);await waitFor(()=>process.exitCode,code=>code!==null,45000);assert.match(output,/Graceful shutdown complete/);logs.push(output)}}
  async function scan(root){const job=(await client.call(`/admin/library/discovery/roots/${root}/scans`,'POST',undefined,undefined,202)).data;return waitFor(async()=>(await client.call(`/admin/library/discovery/scans/${job.id}`)).data,j=>!['PENDING','RUNNING'].includes(j.status),30000)}
  try{
    await configuration();const verified=await command(['--verify-config']);assert.equal(verified.code,0,verified.text);assert.match(verified.text,/CONFIGURATION_ONLY/);assert.deepEqual(await readdir(state),[]);evidence.checks.push('configtree/YAML verification creates no database or migration')
    await start()
    const pid=Number(await readFile(join(state,'greenflix.running'),'utf8'))
    const moduleCheck=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${pid}).Modules | Where-Object ModuleName -eq 'jvm.dll' | Select-Object -ExpandProperty FileName`],{encoding:'utf8',windowsHide:true})
    assert.ok(moduleCheck.toLowerCase().includes('\\greenflix\\runtime\\bin\\server\\jvm.dll'));evidence.checks.push('Greenflix.exe loads bundled JVM with no host Java/probe in PATH')
    const root=(await client.call('/admin/library/roots','POST',{displayName:'Portable legacy',runtimeRef:'portable-legacy',classification:'LEGACY',enabled:true},undefined,201)).data
    assert.equal((await scan(root.id)).status,'COMPLETED')
    const asset=(await client.call('/admin/library/assets?size=100')).data.items[0]
    await waitFor(async()=>(await client.call('/admin/library/assets/'+asset.id)).data,d=>d.technical?.probeStatus==='SUCCEEDED',30000)
    evidence.checks.push('bundled FFprobe inspects real H264/AAC during native discovery')
    const movie=(await client.call('/admin/media','POST',{type:'MOVIE',titleEn:'Portable Movie',releaseYear:2024},undefined,201)).data
    await client.call('/admin/library/matching/run','POST',{storageRootId:root.id,all:true})
    const proposals=(await client.call('/admin/library/matching/proposals?assetId='+asset.id)).data.items
    assert.ok(proposals.length>0);evidence.matchingPreview=true
    await client.call('/admin/library/bindings','POST',{assetId:asset.id,targetType:'MOVIE',targetId:movie.id,preferenceOrder:0},(await client.call('/admin/media/'+movie.id)).etag,201)
    await client.call(`/admin/media/${movie.id}/publish`,'POST',undefined,(await client.call('/admin/media/'+movie.id)).etag)
    for(const channel of ['chrome','msedge']){
      const browser=await chromium.launch({channel})
      try{const page=await browser.newPage();const responses=[];page.on('response',r=>{if(r.url().endsWith('/content'))responses.push({method:r.request().method(),status:r.status()})})
        await page.goto(origin+'/media/'+movie.id);await page.getByRole('button',{name:/^Watch /}).click();const video=page.locator('video');await waitFor(()=>video.evaluate(v=>v.videoWidth>0&&v.currentTime>.2),Boolean,15000)
        await video.evaluate(v=>v.pause());await video.evaluate(v=>{v.currentTime=7});await waitFor(()=>video.evaluate(v=>!v.seeking&&v.currentTime>=6.9),Boolean)
        await page.getByRole('button',{name:'Close player'}).click();await waitFor(async()=>(await client.call('/admin/operations/status')).data.playback.activeTransfers,n=>n===0)
        evidence.browsers.push({channel,decoded:true,seekSeconds:7,requests:responses})
      }finally{await browser.close()}
    }
    evidence.load=await runLoad({assetIds:[asset.id],storageKind:'LOCAL',allowHeavyLoad:true,seconds:6,mbpsPerViewer:4,phases:[{viewers:5,mode:'same'},{viewers:10,mode:'same'},{viewers:20,mode:'same'}]},client)
    assert.equal(evidence.load.after.playback.activeTransfers,0)
    assert.ok(evidence.load.phases.every(p=>p.errors===p.rejected));evidence.capacityBlocker='FAIL: retained until representative overlap and one-hour VM acceptance pass'
    const snapshot=await client.raw('/api/v1/admin/operations/backup',{method:'POST',headers:{'X-CSRF-TOKEN':client.csrf}});assert.equal(snapshot.status,200)
    await writeFile(join(directory,'snapshot.sqlite'),Buffer.from(await snapshot.arrayBuffer()));evidence.checks.push('consistent administrator SQLite snapshot')
    const content=await client.raw(`/api/v1/playback/assets/${asset.id}/content`,{headers:{Range:'bytes=100-199'}});assert.equal(content.status,206);assert.equal((await content.arrayBuffer()).byteLength,100)
    const killed=new Promise(done=>process.once('exit',done));process.kill('SIGKILL');await killed;logs.push(output)
    await start();assert.equal((await client.call(`/playback/movies/${movie.id}`)).data.sources[0].assetId,asset.id)
    evidence.checks.push('actual forced EXE exit recovers a dead-PID marker after SQLite ownership, preserving catalog/media')
    await stop();mapped=join(directory,'media-relocated');await rename(media,mapped);await configuration();await start()
    assert.equal((await client.call('/admin/library/roots')).data[0].id,root.id);assert.equal((await scan(root.id)).status,'COMPLETED')
    const after=(await client.call('/admin/library/assets?size=100')).data.items;assert.equal(after.length,1);assert.equal(after[0].id,asset.id);assert.equal(after[0].contentGeneration,asset.contentGeneration)
    assert.equal((await client.call(`/playback/movies/${movie.id}`)).data.sources[0].assetId,asset.id)
    const relocated=await client.raw(`/api/v1/playback/assets/${asset.id}/content`,{headers:{Range:'bytes=0-99'}});assert.equal(relocated.status,206);await relocated.arrayBuffer()
    assert.equal(hash(await readFile(join(mapped,asset.relativePath))),sourceHash);evidence.checks.push('same tree relocated: root/asset/binding IDs, generation, content and playback persist')
    await stop()
    const snapshotFile=join(directory,'snapshot.sqlite'),snapshotHash=hash(await readFile(snapshotFile))
    const runtime=join(resolve(launcher,'..'),'runtime/bin/java.exe'),jar=join(resolve(launcher,'..'),'app/greenflix.jar')
    const maintenance=execFileSync(runtime,['--enable-native-access=ALL-UNNAMED','-Dloader.main=com.greenflix.operations.DatabaseMaintenance','-cp',jar,'org.springframework.boot.loader.launch.PropertiesLauncher','verify',snapshotFile,snapshotHash],{encoding:'utf8',windowsHide:true})
    assert.match(maintenance,/PASS/);await copyFile(snapshotFile,join(state,'restored.db'));await start('restored.db')
    assert.equal((await client.call('/media?q=Portable&locale=en')).data.totalElements,1);assert.equal((await client.call(`/playback/movies/${movie.id}`)).data.sources[0].assetId,asset.id);await stop()
    evidence.checks.push('bundled runtime independently verifies and launches isolated snapshot restore with search/bindings')
    const before=hash(await readFile(join(state,'portable.db')));await configuration('    # ordinary logging override below\nlogging:\n  level:\n    root: WARN\n')
    const check=await command(['--verify-config']);assert.equal(check.code,0,check.text);assert.equal(hash(await readFile(join(state,'portable.db'))),before)
    for(const overrides of [
      ['--greenflix.playback.max-transfers=65'],
      ['--greenflix.library.scanner.ffprobe-path=C:/not-present/ffprobe.exe'],
      ['--greenflix.storage.url=jdbc:sqlite:C:/not-present/greenflix.db'],
      [`--greenflix.library.approved-roots[0].path=${state}`],
      ['--server.ssl.enabled=true','--server.ssl.key-store=file:/not-present/server.p12','--server.ssl.key-store-password=']
    ]){const invalid=await command(['--verify-config',...overrides]);assert.equal(invalid.code,1);assert.equal(invalid.text.includes(passwordHash),false)}
    const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done))
    try{assert.equal((await command(['--verify-config','--server.port='+listener.address().port])).code,1)}finally{await new Promise(done=>listener.close(done))}
    assert.equal(hash(await readFile(join(state,'portable.db'))),before)
    evidence.checks.push('invalid paths, missing probe, overlapping roots, bounds, TLS and occupied port fail config-only checks without database mutation')
    evidence.checks.push('external configuration override and config-only check leave existing SQLite byte-identical')
    for(const log of logs){assert.equal(log.includes(password),false);assert.equal(log.includes(passwordHash),false)}
    evidence.status='PASS'
  }finally{
    try{await stop()}catch{if(process?.exitCode===null)process.kill()}
    await writeFile('deploy/test-results/packaging/portable-acceptance.json',JSON.stringify(evidence,null,2)+'\n')
    // Retain this isolated test tree for review; it is ignored and contains no developer data.
    console.log(JSON.stringify({status:evidence.status,checks:evidence.checks,browsers:evidence.browsers,load:evidence.load?.phases}))
  }
})
