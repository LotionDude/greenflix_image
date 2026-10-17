import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const sha256 = data => createHash('sha256').update(data).digest('hex')
export async function members(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Release links are refused')
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await members(path))
    else files.push(path)
  }
  return files.sort()
}
const [directory, repository, version, epoch] = process.argv.slice(2)
if (directory) {
  if (!/^[0-9][A-Za-z0-9_.-]{0,63}$/.test(version) || !/^\d+$/.test(epoch)) throw new Error('Invalid release metadata')
  const files = []
  for (const file of await members(directory)) {
    const path = relative(directory, file).replaceAll('\\', '/')
    if (path === 'release-manifest.json') continue
    files.push({ path, bytes: (await stat(file)).size, sha256: sha256(await readFile(file)) })
  }
  const manifest = { format: 1, version, builtAt: new Date(Number(epoch) * 1000).toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim(),
    schemaVersion: '1', schemaSha256: sha256(await readFile(join(repository, 'backend/src/main/resources/db/migration/V1__initial_schema.sql'))),
    productionV1Frozen: false, toolchain: JSON.parse(await readFile(join(directory, 'deploy/windows/toolchain.lock.json'), 'utf8')),
    files }
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: 'PASS', version, files: files.length, jarSha256: files.find(f => f.path === 'greenflix.jar').sha256 }))
}
