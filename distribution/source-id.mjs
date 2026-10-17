import { readFile,writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const [repository,output] = process.argv.slice(2)
const hash = value => createHash('sha256').update(value).digest('hex')
const names = [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','backend/src','backend/pom.xml','backend/.mvn','backend/mvnw','backend/mvnw.cmd','frontend/src','frontend/package.json','frontend/package-lock.json','Dockerfile','.dockerignore','compose.yaml','deploy'],{cwd:repository,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean))].sort()
const files=[]
for(const path of names)files.push({path,sha256:hash(await readFile(join(repository,path)))})
const result={format:1,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:repository,encoding:'utf8'}).trim(),contentSha256:hash(JSON.stringify(files)),files}
if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
else console.log(result.commit+'-tree-'+result.contentSha256)
