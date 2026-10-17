import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomBytes,pbkdf2Sync,createHash,randomUUID} from 'node:crypto'
import {Client,waitFor} from '../acceptance/client.mjs'
import {chromium} from '../../frontend/node_modules/playwright/index.mjs'
const image=process.env.GREENFLIX_TEST_IMAGE??'greenflix:2.0.0-rc.2',prefix='greenflix-package-'+randomBytes(5).toString('hex')
const directory=resolve('deploy/test-results/packaging/'+prefix),volumes=[],containers=[]
const hash=b=>createHash('sha256').update(b).digest('hex')
function docker(args,options={}){const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:120000,...options});assert.equal(r.status,0,(r.stderr||r.error?.message||'Docker operation failed').slice(-1500));return r.stdout.trim()}
test('Linux image and Compose: real probe, matching, imports, range/browser playback, recreation, config and restore',{timeout:240000},async()=>{
  const evidence={format:1,status:'FAIL',scope:'DISPOSABLE_DOCKER_LINUX_AMD64',checks:[],browsers:[],productionReady:false}
  const config=join(directory,'config'),secrets=join(directory,'secrets');await mkdir(config,{recursive:true});await mkdir(secrets)
  const password=randomBytes(32).toString('base64url'),salt=randomBytes(16),passwordHash=Buffer.concat([salt,pbkdf2Sync(password,salt,310000,32,'sha256')]).toString('hex')
  await writeFile(join(secrets,'greenflix-admin-password-hash'),passwordHash)
  const fixture=resolve('deploy/test-results/gate3-media/known-h264-aac.mp4'),original=hash(await readFile(fixture))
  const data=prefix+'-data',legacy=prefix+'-legacy',managed=prefix+'-managed'
  const mounts=['-v',data+':/data','-v',legacy+':/media/legacy:ro','-v',managed+':/media/managed','-v',config+':/config:ro','-v',secrets+':/run/secrets:ro']
  const environment=['-e','GREENFLIX_STATE_DIR=/data','-e','GREENFLIX_SECRETS_DIR=/run/secrets','-e','SPRING_CONFIG_LOCATION=classpath:/application.yml,classpath:/application-distribution.yml,file:/config/application.yml']
  const configText=port=>`spring:\n  config:\n    import: configtree:/run/secrets/\nserver:\n  address: 0.0.0.0\n  port: ${port}\ngreenflix:\n  media:\n    posix-immutable-tree: true # This disposable fixture tree only.\n  state-directory: /data\n  storage:\n    url: jdbc:sqlite:/data/greenflix.db\n  auth:\n    password-hash: \${greenflix-admin-password-hash}\n  library:\n    approved-roots:\n      - reference: legacy\n        path: /media/legacy\n        revision: 1\n        comparison-mode: SENSITIVE\n      - reference: managed\n        path: /media/managed\n        revision: 1\n        comparison-mode: SENSITIVE\n    scanner:\n      stability-seconds: 0\n    imports:\n      write-approved-references: [managed]\n      reserve-bytes: 1048576\n`
  let current
  async function start(port=8080,storage=data){const name=prefix+'-'+containers.length;containers.push(name);current=name
    const actualMounts=[...mounts];actualMounts[1]=storage+':/data'
    docker(['run','-d','--name',name,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs','/tmp:rw,exec,nosuid,size=256m','-p',`127.0.0.1::${port}`,...actualMounts,...environment,'-e',`GREENFLIX_HEALTH_PORT=${port}`,image])
    const host=docker(['port',name,port+'/tcp']).split(':').at(-1),origin='http://127.0.0.1:'+host,client=new Client(origin,true)
    await waitFor(async()=>{if(docker(['inspect','--format','{{.State.Running}}',name])!=='true')throw Error(docker(['logs',name]).slice(-1500));try{return(await client.raw('/actuator/health/readiness')).ok}catch{return false}},Boolean,45000)
    await client.login(password);return {client,origin}
  }
  async function scan(client,id){const job=(await client.call(`/admin/library/discovery/roots/${id}/scans`,'POST',undefined,undefined,202)).data;return waitFor(async()=>(await client.call(`/admin/library/discovery/scans/${job.id}`)).data,j=>!['PENDING','RUNNING'].includes(j.status),45000)}
  try{
    for(const volume of [data,legacy,managed]){docker(['volume','create',volume]);volumes.push(volume)}
    docker(['run','--rm','--user','0','--entrypoint','/bin/sh','-v',legacy+':/legacy','-v',managed+':/managed','-v',fixture+':/fixture:ro',image,'-ec','cp /fixture /legacy/Docker.Movie.2024.mp4; chmod 0444 /legacy/*; chmod 0555 /legacy; chgrp 0 /managed; chmod 2770 /managed'])
    docker(['run','--rm','--entrypoint','/bin/sh','-v',legacy+':/legacy',image,'-ec','test ! -w /legacy; test ! -w /legacy/Docker.Movie.2024.mp4'])
    evidence.checks.push('legacy OS permissions independently deny writes on a writable mount')
    await writeFile(join(config,'application.yml'),configText(8080))
    const verified=docker(['run','--rm','--read-only','--tmpfs','/tmp:rw,exec,nosuid,size=256m',...mounts,...environment,image,'--verify-config']);assert.match(verified,/CONFIGURATION_ONLY/)
    let {client,origin}=await start()
    const root=(await client.call('/admin/library/roots','POST',{displayName:'Docker legacy',runtimeRef:'legacy',classification:'LEGACY',enabled:true},undefined,201)).data
    const destination=(await client.call('/admin/library/roots','POST',{displayName:'Docker managed',runtimeRef:'managed',classification:'MANAGED',enabled:true},undefined,201)).data
    const discovery=await scan(client,root.id);evidence.discovery=discovery;assert.equal(discovery.status,'COMPLETED',JSON.stringify(discovery))
    const asset=(await client.call('/admin/library/assets?size=100')).data.items[0]
    const detail=await waitFor(async()=>(await client.call('/admin/library/assets/'+asset.id)).data,d=>d.technical?.probeStatus==='SUCCEEDED',45000)
    assert.ok(detail.technical.videoCodecs.includes('h264'));assert.ok(detail.technical.audioCodecs.includes('aac'))
    const movie=(await client.call('/admin/media','POST',{type:'MOVIE',titleEn:'Docker Movie',releaseYear:2024},undefined,201)).data
    await client.call('/admin/library/matching/run','POST',{storageRootId:root.id,all:true})
    const proposal=(await client.call('/admin/library/matching/proposals?assetId='+asset.id)).data.items[0]
    const review=await client.call('/admin/library/matching/proposals/'+proposal.id)
    await client.call('/admin/library/matching/proposals/'+proposal.id+'/approve','POST',undefined,review.etag)
    await client.call('/admin/media/'+movie.id+'/publish','POST',undefined,(await client.call('/admin/media/'+movie.id)).etag)
    evidence.checks.push('bundled Linux FFprobe, discovery, matching and explicit association approval')
    const content=`/api/v1/playback/assets/${asset.id}/content`
    assert.equal((await client.raw(content,{method:'HEAD'})).status,200)
    const partial=await client.raw(content,{headers:{Range:'bytes=10-109'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,100)
    assert.equal((await client.raw(content,{headers:{Range:'bytes=999999999-'}})).status,416)
    await client.call(`/admin/library/imports/destinations/${destination.id}/permission`,'PUT',{enabled:true},(await client.call('/admin/library/roots/'+destination.id)).etag)
    const input={sourceAssetId:asset.id,destinationRootId:destination.id,versionLabel:'Docker verified copy',exportMetadata:true,preferImported:false}
    const preview=(await client.call('/admin/library/imports/preview','POST',input)).data
    const job=(await client.call('/admin/library/imports','POST',{...input,previewToken:preview.token,requestKey:randomUUID(),confirmed:true},(await client.call('/admin/library/assets/'+asset.id)).etag)).data
    const done=await waitFor(async()=>(await client.call('/admin/library/imports/'+job.id)).data,j=>j.state==='COMPLETED'&&j.sidecarStatus!=='PENDING',45000)
    assert.equal(done.sidecarStatus,'EXPORTED')
    const sums=docker(['exec',current,'sha256sum','/media/legacy/'+asset.relativePath,'/media/managed/'+done.relativePath]);assert.ok(sums.split('\n').every(line=>line.startsWith(original)))
    evidence.checks.push('confirmed managed copy and metadata export; original/copy hashes equal')
    for(const channel of ['chrome','msedge']){const browser=await chromium.launch({channel});try{const page=await browser.newPage();await page.goto(origin+'/media/'+movie.id);await page.getByRole('button',{name:/^Watch /}).click();const video=page.locator('video');await waitFor(()=>video.evaluate(v=>v.videoWidth>0&&v.currentTime>.2),Boolean,15000);await video.evaluate(v=>{v.pause();v.currentTime=7});await waitFor(()=>video.evaluate(v=>!v.seeking&&v.currentTime>=6.9),Boolean);evidence.browsers.push({channel,decoded:true,seekSeconds:7});await page.getByRole('button',{name:'Close player'}).click()}finally{await browser.close()}}
    const backup=await client.raw('/api/v1/admin/operations/backup',{method:'POST',headers:{'X-CSRF-TOKEN':client.csrf}});assert.equal(backup.status,200);const snapshot=join(directory,'snapshot.sqlite');await writeFile(snapshot,Buffer.from(await backup.arrayBuffer()))
    docker(['run','--rm','--read-only','--tmpfs','/tmp:rw,exec,nosuid,size=256m','--entrypoint','java','-v',snapshot+':/restore/snapshot.sqlite:ro',image,'--enable-native-access=ALL-UNNAMED','-Dloader.main=com.greenflix.operations.DatabaseMaintenance','-cp','/app/app.jar','org.springframework.boot.loader.launch.PropertiesLauncher','verify','/restore/snapshot.sqlite',hash(await readFile(snapshot))])
    docker(['stop','-t','45',current]);assert.match(docker(['logs',current]),/Graceful shutdown complete/)
    await writeFile(join(config,'application.yml'),configText(8082));({client,origin}=await start(8082))
    assert.equal((await client.call('/admin/library/roots')).data[0].id,root.id);assert.equal((await client.call(`/playback/movies/${movie.id}`)).data.sources.length,2)
    evidence.checks.push('container recreation and external YAML port change preserve SQLite, roots, associations and imports')
    docker(['stop','-t','45',current])
    const restored=prefix+'-restore';docker(['volume','create',restored]);volumes.push(restored)
    docker(['run','--rm','--user','0','--entrypoint','/bin/sh','-v',restored+':/data','-v',snapshot+':/snapshot:ro',image,'-ec','cp /snapshot /data/greenflix.db; chgrp 0 /data /data/greenflix.db; chmod 2770 /data; chmod 0660 /data/greenflix.db'])
    ;({client}=await start(8082,restored));assert.equal((await client.call('/media?q=Docker&locale=en')).data.totalElements,1);assert.equal((await client.call(`/playback/movies/${movie.id}`)).data.sources.length,2)
    evidence.checks.push('isolated verified snapshot restore preserves search and media associations')
    docker(['stop','-t','45',current])
    // Local Compose smoke has its own volume/project; it cannot touch developer data.
    await writeFile(join(config,'application.yml'),configText(8080))
    const composeEnv={...process.env,GREENFLIX_IMAGE:image,GREENFLIX_CONFIG_DIR:config,GREENFLIX_ADMIN_HASH_FILE:join(secrets,'greenflix-admin-password-hash'),GREENFLIX_PORT:'0'}
    const compose=['compose','-p',prefix,'-f',resolve('compose.yaml')]
    try{docker([...compose,'config','--quiet'],{env:composeEnv});docker([...compose,'up','-d','--no-build'],{env:composeEnv});const name=docker([...compose,'ps','-q'],{env:composeEnv});await waitFor(()=>docker(['inspect','--format','{{.State.Health.Status}}',name]),s=>s==='healthy',60000);evidence.checks.push('production Compose config validation and actual healthy startup')}
    finally{docker([...compose,'down','-v'],{env:composeEnv})}
    const metadataVolume=prefix+'-metadata';volumes.push(metadataVolume);docker(['volume','create','--driver','local','--opt','type=cifs','--opt','device=//unavailable.invalid/disposable','--opt','o=ro,username=NONSECRET_PLACEHOLDER',metadataVolume])
    const options=JSON.parse(docker(['volume','inspect',metadataVolume]))[0].Options;assert.ok(options.o.includes('NONSECRET_PLACEHOLDER'));evidence.cifs={metadataOptionsInspectable:true,authenticatedMount:'PENDING_NO_APPROVED_SERVER_OR_CREDENTIALS',kernel:docker(['run','--rm','--entrypoint','/bin/sh',image,'-c','uname -r; grep cifs /proc/filesystems || true; command -v mount.cifs || true'])}
    evidence.status='PASS'
  }finally{for(const container of containers)docker(['rm','-f',container]);for(const volume of volumes)docker(['volume','rm',volume]);await writeFile('deploy/test-results/packaging/docker-acceptance.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))}
})
