import { spawnSync } from 'node:child_process'
import { randomBytes, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import assert from 'node:assert/strict'

const image = process.env.GREENFLIX_TEST_IMAGE || 'greenflix:deployment-test'
const prefix = 'greenflix-check-' + randomBytes(6).toString('hex')
const directory = await mkdtemp(join(tmpdir(), prefix))
const containers = new Set(), volumes = new Set()
const password = randomBytes(32).toString('base64url'), salt = randomBytes(16)
const hash = Buffer.concat([salt, pbkdf2Sync(password, salt, 310000, 32, 'sha256')]).toString('hex')
const envFile = join(directory, 'credential.env')
await writeFile(envFile, `GREENFLIX_ADMIN_PASSWORD_HASH=${hash}\n`, { mode: 0o600 })
function docker(args, input) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, windowsHide: true, timeout: 90000 })
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${(result.stderr || result.error?.message || '').slice(-1500)}`)
  return result.stdout.trim()
}
async function ready(name) {
  const port = docker(['port', name, '8080/tcp']).split(':').at(-1)
  const origin = 'http://127.0.0.1:' + port
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch(origin + '/actuator/health/readiness')).ok) return origin } catch {}
    if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') throw new Error('Application exited: ' + docker(['logs', name]).slice(-1200))
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Application readiness timed out')
}
function start(name, volume, extra = []) {
  containers.add(name)
  docker(['run', '-d', '--name', name, '--user', '100123:0', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g', '--tmpfs', '/tmp:rw,exec,nosuid,size=256m', '-p', '127.0.0.1::8080', '-v', volume + ':/data', '--env-file', envFile, ...extra, image])
}
async function browser(origin) {
  let cookie = '', token = ''
  async function call(path, method = 'GET', body, etag) {
    const headers = { Accept: 'application/json', Cookie: cookie }
    if (method !== 'GET') headers['X-CSRF-TOKEN'] = token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (etag) headers['If-Match'] = etag
    const response = await fetch(origin + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const session = response.headers.getSetCookie().find(value => value.startsWith('JSESSIONID='))
    if (session) cookie = session.split(';')[0]
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return { data: response.status === 204 ? null : await response.json(), etag: response.headers.get('ETag') }
  }
  token = (await call('/csrf')).data.token
  await call('/admin/session', 'POST', { password })
  token = (await call('/csrf')).data.token
  return { call, cookie: () => cookie, token: () => token }
}
try {
  const volume = prefix + '-data', restored = prefix + '-restore'
  for (const name of [volume, restored]) { docker(['volume', 'create', name]); volumes.add(name) }
  // Image has no build tools or Node runtime; filesystem starts read-only.
  assert.equal(docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', 'command -v node || true']), '')
  const missing = prefix + '-missing'; containers.add(missing)
  docker(['run', '-d', '--name', missing, '--env-file', envFile, image])
  assert.notEqual(docker(['wait', missing]), '0', 'Missing /data mount must fail')
  const unverified = prefix + '-unverified'; start(unverified, volume, ['-e', 'GREENFLIX_JOURNAL_MODE=WAL'])
  assert.notEqual(docker(['wait', unverified]), '0', 'Unverified WAL must fail before opening storage')
  assert.match(docker(['logs', unverified]), /journal mode not approved/)
  const readOnly = prefix + '-readonly'; containers.add(readOnly)
  docker(['run', '-d', '--name', readOnly, '-v', volume + ':/data:ro', '--env-file', envFile, image])
  assert.notEqual(docker(['wait', readOnly]), '0', 'Read-only storage must fail visibly')
  const app = prefix + '-app'; start(app, volume)
  let origin = await ready(app), client = await browser(origin)
  const created = await client.call('/admin/media', 'POST', { type: 'MOVIE', titleEn: 'Persistent backup fixture', titleHe: 'שלום', aliases: ['Durability alias'] })
  const id = created.data.id, exact = '\\\\fixture\\share\\סרטים\\Exact  Name.mkv'
  await client.call(`/admin/media/${id}/locations`, 'POST', { kind: 'FILE', uncPath: exact }, created.etag)
  const current = await client.call(`/admin/media/${id}`)
  await client.call(`/admin/media/${id}/publish`, 'POST', undefined, current.etag)
  for (const path of ['/catalog', '/admin/media/' + id]) {
    const response = await fetch(origin + path, { headers: { Accept: 'text/html' } }); assert.equal(response.status, 200); assert.match(await response.text(), /id="root"/)
  }
  for (const path of ['/api/v1/missing', '/actuator/missing', '/assets/missing.js']) assert.equal((await fetch(origin + path, { headers: { Accept: 'text/html' } })).status, 404)
  assert.equal((await fetch(origin + '/api/v1/admin/operations/backup', { method: 'POST' })).status, 401)
  assert.equal((await fetch(origin + '/api/v1/admin/operations/backup', { method: 'POST', headers: { Cookie: client.cookie() } })).status, 403)
  const backup = await fetch(origin + '/api/v1/admin/operations/backup', { method: 'POST', headers: { Cookie: client.cookie(), 'X-CSRF-TOKEN': client.token() } })
  assert.equal(backup.status, 200); assert.equal(backup.headers.get('cache-control'), 'no-store')
  const snapshot = Buffer.from(await backup.arrayBuffer()); assert.equal(snapshot.subarray(0,16).toString(), 'SQLite format 3\0')
  // A second application cannot migrate or serve against the live owner.
  const competing = prefix + '-competing'; start(competing, volume)
  assert.notEqual(docker(['wait', competing]), '0')
  assert.match(docker(['logs', competing]), /already owned/)
  const oldCookie = client.cookie()
  docker(['stop', '--time', '45', app]); docker(['rm', app]); containers.delete(app)
  start(app, volume); origin = await ready(app)
  assert.equal((await fetch(origin + '/api/v1/admin/media', { headers: { Cookie: oldCookie } })).status, 401)
  let persisted = await fetch(origin + `/api/v1/media/${id}`)
  assert.equal((await persisted.json()).locations[0].uncPath, exact)
  docker(['stop', '--time', '45', app])
  // Restore only into the separate empty volume, with no app writer mounted there.
  docker(['run', '--rm', '-i', '-v', restored + ':/data', '--entrypoint', 'sh', image, '-c', 'umask 0007; cat > /data/greenflix.db'], snapshot)
  const recovery = prefix + '-recovery'; start(recovery, restored)
  const restoredOrigin = await ready(recovery)
  const detail = await (await fetch(restoredOrigin + `/api/v1/media/${id}`)).json()
  assert.equal(detail.titleHe, 'שלום'); assert.equal(detail.locations[0].uncPath, exact)
  assert.equal((await (await fetch(restoredOrigin + '/api/v1/media?q=durability')).json()).totalElements, 1)
  // Exercise approved WAL only on Docker's local Linux filesystem, not a target PVC claim.
  docker(['rm', app]); containers.delete(app)
  start(app, volume, ['-e', 'GREENFLIX_JOURNAL_MODE=WAL', '-e', 'GREENFLIX_WAL_VERIFIED=true'])
  await ready(app)
  assert.match(docker(['exec', app, 'sh', '-c', 'ls /data/greenflix.db-wal /data/greenflix.db-shm']), /greenflix.db-wal/)
  console.log('Linux arbitrary UID, no Node, mounted storage, migrations, probes, routing, CSRF backup, writer fencing, replacement persistence, session invalidation, isolated restore, FTS and local WAL pass.')
} finally {
  for (const name of containers) { spawnSync('docker', ['rm', '-f', name], { windowsHide: true, stdio: 'ignore' }) }
  for (const name of volumes) { spawnSync('docker', ['volume', 'rm', name], { windowsHide: true, stdio: 'ignore' }) }
  const resolvedDirectory = await realpath(directory)
  assert.equal(dirname(resolvedDirectory), await realpath(tmpdir()))
  assert.equal(basename(resolvedDirectory), basename(directory))
  assert.ok(basename(resolvedDirectory).startsWith(prefix))
  await rm(resolvedDirectory, { recursive: true, force: true })
}
