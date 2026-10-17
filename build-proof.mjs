import { readFile,readdir,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function inputs(repository) {
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','backend/src','backend/pom.xml','frontend/src','frontend/tests','frontend/package.json','frontend/package-lock.json'],{cwd:repository,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean).sort()
  const list=[];for(const file of files)list.push([file,hash(await readFile(join(repository,file)))])
  return hash(JSON.stringify(list))
}
const [mode,repository,jar,proofFile,frontendLog]=process.argv.slice(2)
if(mode==='create') {
  let tests=0,failures=0,errors=0,skipped=0
  const reportDirectory=join(repository,'backend/target/surefire-reports')
  for(const file of await readdir(reportDirectory))if(file.startsWith('TEST-')&&file.endsWith('.xml')){
    const xml=await readFile(join(reportDirectory,file),'utf8'),head=xml.match(/<testsuite\b[^>]*>/)?.[0]
    for(const [name,add] of [['tests',v=>tests+=v],['failures',v=>failures+=v],['errors',v=>errors+=v],['skipped',v=>skipped+=v]])add(Number(head?.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1]??NaN))
  }
  const frontend=await readFile(frontendLog,'utf8'),passed=Number(frontend.match(/pass (\d+)/)?.[1]),failed=Number(frontend.match(/fail (\d+)/)?.[1])
  if(!Number.isInteger(tests)||tests<228||failures||errors||skipped||!Number.isInteger(passed)||passed<114||failed!==0)throw new Error('COMPLETE_SUCCESSFUL_REGRESSION_PROOF_REQUIRED')
  await writeFile(proofFile,JSON.stringify({format:1,verifiedAt:new Date().toISOString(),jarSha256:hash(await readFile(jar)),inputsSha256:await inputs(repository),
    backend:{tests,failures,errors,skipped},frontend:{browser:'chrome',passed,failed},buildJava:execFileSync('java',['--version'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]},null,2)+'\n',{flag:'wx'})
}else if(mode==='verify') {
  const proof=JSON.parse(await readFile(proofFile,'utf8'))
  if(proof.format!==1||proof.jarSha256!==hash(await readFile(jar))||proof.inputsSha256!==await inputs(repository))throw new Error('BUILD_PROOF_DOES_NOT_MATCH_APPLICATION_INPUTS')
}else throw new Error('INVALID_PROOF_COMMAND')
