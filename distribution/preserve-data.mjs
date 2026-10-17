import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
const root = process.cwd(), files = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git','node_modules','target','dist','test-results','tools','.codex','.agents'].includes(entry.name)) continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) await walk(file)
    else if (/\.(db|sqlite)(-|\.|$)/i.test(entry.name) || entry.name === 'V1__initial_schema.sql') {
      try { files.push({ path: relative(root,file).replaceAll('\\','/'), sha256: createHash('sha256').update(await readFile(file)).digest('hex') }) }
      catch { files.push({ path: relative(root,file).replaceAll('\\','/'), status:'UNREADABLE' }) }
    }
  }
}
await walk(root)
await writeFile(process.argv[2], JSON.stringify(files,null,2)+'\n', {flag:'wx'})
console.log(JSON.stringify({files:files.length,unreadable:files.filter(f=>!f.sha256).length}))
