// Explicit local verification of an already VERIFIED offline conversion. Does not switch configuration.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, pbkdf2Sync } from 'node:crypto'

const target = resolve(process.argv[2] ?? '')
const configuredDefault = process.argv[3] === '--configured-default'
const gate6 = target.endsWith('greenflix-gate6.db')
if (process.argv.length !== (configuredDefault ? 4 : 3) || (!gate6 && !target.endsWith('greenflix-v1.db'))) throw new Error('Supply the verified development database explicitly; optionally verify --configured-default.')
const directory = dirname(target)
assert.match(await readFile(join(directory, 'VERIFIED.txt'), 'utf8'), gate6 ? /^VERIFIED GATE 6 ADDITIVE DEVELOPMENT UPGRADE/ : /^VERIFIED DEVELOPMENT TRANSITION/)
const jar = fileURLToPath(new URL('../backend/target/greenflix-0.1.0-SNAPSHOT.jar', import.meta.url))
function snapshot() {
  const db = new DatabaseSync(target, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual') ORDER BY name").all().map(r => r.name).filter(n => !n.startsWith('sqlite_'))
    const records = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT ${table === 'media_fts' ? 'rowid,' : ''}* FROM "${table}"`).all()]))
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    return { records, counts: Object.fromEntries(Object.entries(records).map(([name, rows]) => [name, rows.length])), media: db.prepare('SELECT * FROM media ORDER BY id').all(),
      aliases: db.prepare('SELECT * FROM media_alias ORDER BY media_id,position').all(), locations: db.prepare('SELECT * FROM location ORDER BY id').all() }
  } finally { db.close() }
}
const before = snapshot(), password = randomBytes(32).toString('base64url'), salt = randomBytes(16)
const hash = Buffer.concat([salt, pbkdf2Sync(password, salt, 310000, 32, 'sha256')]).toString('hex')
const environment = { ...process.env, SERVER_ADDRESS: '127.0.0.1', SERVER_PORT: '0', GREENFLIX_ADMIN_PASSWORD_HASH: hash, GREENFLIX_PUBLIC_ORIGIN: '', GREENFLIX_DATABASE_URL: `jdbc:sqlite:${target}`,
  GREENFLIX_JOURNAL_MODE: 'DELETE', GREENFLIX_WAL_VERIFIED: 'false' }
if (configuredDefault) delete environment.GREENFLIX_DATABASE_URL
const verificationLabel = process.env.GREENFLIX_VERIFICATION_LABEL || ''
assert.match(verificationLabel, /^(?:[a-z0-9-]{1,40})?$/)
const suffix = (configuredDefault ? '-configured-default' : '') + (verificationLabel ? '-' + verificationLabel : '')
const server = spawn(process.env.JAVA_EXECUTABLE ?? 'java', ['--enable-native-access=ALL-UNNAMED', '-jar', jar], { cwd: configuredDefault ? fileURLToPath(new URL('../backend', import.meta.url)) : directory,
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment })
let cookie = '', token = '', requests = 0
try {
  const origin = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Verified database application startup timed out.')), 30000)
    server.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); const match = output.match(/Tomcat started on port (\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`) } })
    server.stderr.on('data', () => {})
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Verified database application startup failed.')) })
    server.once('error', () => { clearTimeout(timer); reject(new Error('Could not start Java.')) })
  })
  for (let i = 0; i < 100; i++) { if ((await fetch(origin + '/actuator/health/readiness')).ok) break; assert.ok(i < 99); await new Promise(resolve => setTimeout(resolve, 50)) }
  async function request(path, method = 'GET', body) {
    const response = await fetch(origin + '/api/v1' + path, { method, headers: { Accept: 'application/json', Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token }, body: body === undefined ? undefined : JSON.stringify(body) })
    requests++; assert.ok(response.ok, 'Application API verification failed')
    const session = response.headers.getSetCookie().find(v => v.startsWith('JSESSIONID=')); if (session) cookie = session.split(';')[0]
    return response.status === 204 ? null : response.json()
  }
  token = (await request('/csrf')).token; await request('/admin/session', 'POST', { password }); token = (await request('/csrf')).token
  const all = await request('/admin/media?size=100')
  assert.equal(all.totalElements, before.counts.media)
  const visible = await request('/media?size=100')
  assert.equal(visible.totalElements, before.media.filter(m => m.status === 'PUBLISHED').length)
  for (const media of before.media) {
    const detail = await request('/admin/media/' + media.id)
    assert.equal(detail.titleEn, media.title_en); assert.equal(detail.titleHe, media.title_he); assert.equal(detail.version, media.version)
    assert.deepEqual(detail.aliases, before.aliases.filter(a => a.media_id === media.id).map(a => a.value))
    assert.deepEqual(detail.locations.map(l => l.uncPath), before.locations.filter(l => l.media_id === media.id).sort((a, b) => a.position - b.position).map(l => l.unc_path))
    if (media.status === 'PUBLISHED') {
      const publicDetail = await request('/media/' + media.id); assert.equal(publicDetail.id, String(media.id))
      const query = media.title_en || media.title_he
      assert.ok((await request('/media?q=' + encodeURIComponent(query))).items.some(m => m.id === String(media.id)))
    }
  }
  let submissions = 0
  for (const status of ['PENDING', 'APPROVED', 'REJECTED']) submissions += (await request('/admin/submissions?status=' + status + '&size=100')).totalElements
  assert.equal(submissions, before.counts.submission)
  assert.equal((await request('/admin/library/assets?size=100')).totalElements, before.counts.media_asset)
  assert.equal((await request('/admin/library/roots')).length, before.counts.storage_root)
  assert.equal((await request('/admin/library/matching/proposals?decision=ALL&size=100')).totalElements, before.counts.media_match)
  if (gate6) {
    assert.equal((await request('/admin/library/imports?size=100')).totalElements, before.counts.media_import_job)
    assert.equal((await request('/admin/library/imports/destinations')).length, before.counts.managed_root_policy)
  }
  const backup = await fetch(origin + '/api/v1/admin/operations/backup', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-TOKEN': token } })
  assert.equal(backup.status, 200); const backupBytes = Buffer.from(await backup.arrayBuffer()); assert.ok(backupBytes.length > 0)
  const snapshotPath = join(directory, `post-transition-application-backup${suffix}.db`); await writeFile(snapshotPath, backupBytes, { flag: 'wx' })
  const restored = new DatabaseSync(snapshotPath, { readOnly: true })
  try { assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(restored.prepare('SELECT count(*) AS n FROM media').get().n, before.counts.media) } finally { restored.close() }
} finally {
  if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped }
}
assert.deepEqual(snapshot().records, before.records, 'Read-only application verification must preserve all persisted records')
await writeFile(join(directory, `APPLICATION-VERIFIED${suffix}.json`), JSON.stringify({ status: 'PASS', requests, configuredDefault, allRecordsUnchanged: true, backupRestored: true, counts: before.counts, packagedJarSha256: createHash('sha256').update(await readFile(jar)).digest('hex') }, null, 2), { flag: 'wx' })
console.log('Packaged application, exact catalog paths/aliases, search, private queues/library, persistence and backup verification PASS. No configuration switched.')
