import {readFile,writeFile,stat} from 'node:fs/promises'
import {relative,join} from 'node:path'
import {createHash} from 'node:crypto'
// Importing release-manifest has a CLI entry point; keep this utility standalone.
import {readdir} from 'node:fs/promises'
const hash=b=>createHash('sha256').update(b).digest('hex'),[directory,version]=process.argv.slice(2)
const files=[]
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isSymbolicLink())throw Error('Release symlink refused');if(item.isDirectory())await walk(path);else {const name=relative(directory,path).replaceAll('\\','/');if(['package-manifest.json','SHA256SUMS'].includes(name))continue;files.push({path:name,bytes:(await stat(path)).size,sha256:hash(await readFile(path))})}}}
await walk(directory);files.sort((a,b)=>a.path.localeCompare(b.path))
const source=JSON.parse(await readFile(join(directory,process.argv[4] === 'docker' ? 'source-identity.json' : 'app/source-identity.json'),'utf8').catch(()=>readFile(join(directory,'source-identity.json'),'utf8')))
await writeFile(join(directory,'package-manifest.json'),JSON.stringify({format:1,version,sourceCommit:source.commit,sourceDirty:source.dirty,sourceContentSha256:source.contentSha256,productionV1Frozen:false,files},null,2)+'\n',{flag:'wx'})
await writeFile(join(directory,'SHA256SUMS'),files.map(f=>`${f.sha256}  ${f.path}`).join('\n')+'\n'+hash(await readFile(join(directory,'package-manifest.json')))+'  package-manifest.json\n',{flag:'wx'})
console.log(JSON.stringify({status:'PASS',files:files.length,sourceContentSha256:source.contentSha256}))
