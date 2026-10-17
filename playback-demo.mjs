// Isolated local demonstration. Never reads .env or the developer catalog; no remote/share access.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, dirname, basename, join } from 'node:path'
import { randomBytes, pbkdf2Sync, createHash } from 'node:crypto'

export const fixtureHash = '3bb938fb70049e3e45f533b37ccae995ae96516e04c2f35b0c1142e47b2a39c1'
export async function startPlaybackDemo({ directory, fixture, port = 0, discoveryRoot, ffprobePath, managedRoot, importRate = 1048576, startupLog } = {}) {
  const project = fileURLToPath(new URL('..', import.meta.url))
  directory = resolve(directory ?? join(project, 'deploy/test-results/gate3-demo'))
  fixture = resolve(fixture ?? join(project, 'deploy/test-results/gate3-media/known-h264-aac.mp4'))
  const bytes = await readFile(fixture)
  if (createHash('sha256').update(bytes).digest('hex') !== fixtureHash) throw new Error('Use the documented, checksum-pinned local demonstration fixture.')
  await mkdir(directory, { recursive: true })
  const stateDirectory = join(directory, 'application')
  await mkdir(stateDirectory, { recursive: true })
  const launcher = process.env.GREENFLIX_TEST_LAUNCHER
  const configuration = join(stateDirectory, launcher ? 'application.yml' : 'application-demo.yml')
  const reference = discoveryRoot ? 'gate4-demo' : 'gate3-demo'
  const scanner = discoveryRoot ? `    scanner:\n      stability-seconds: 0\n      failure-backoff-seconds: 0\n${ffprobePath ? `      ffprobe-path: ${JSON.stringify(ffprobePath)}\n` : ''}` : ''
  const managed = managedRoot ? `      - reference: gate6-managed\n        path: ${JSON.stringify(managedRoot)}\n        revision: 1\n        comparison-mode: ${process.platform === 'win32' ? 'WINDOWS_INSENSITIVE' : 'SENSITIVE'}\n    imports:\n      write-approved-references: [gate6-managed]\n      bytes-per-second: ${importRate}\n      reserve-bytes: 1048576\n` : `    imports:\n      write-approved-references: []\n`
  await writeFile(configuration, `greenflix:\n  state-directory: ${JSON.stringify(stateDirectory)}\n  library:\n${scanner}    approved-roots:\n      - reference: ${reference}\n        path: ${JSON.stringify(discoveryRoot ?? dirname(fixture))}\n        revision: 1\n        comparison-mode: ${process.platform === 'win32' ? 'WINDOWS_INSENSITIVE' : 'SENSITIVE'}\n${managed}`)
  const password = randomBytes(32).toString('base64url'), salt = randomBytes(16)
  const hash = Buffer.concat([salt, pbkdf2Sync(password, salt, 310000, 32, 'sha256')]).toString('hex')
  const server = spawn(launcher ?? process.env.JAVA_EXECUTABLE ?? 'java', launcher ? [`--config-dir=${stateDirectory}`] : ['--enable-native-access=ALL-UNNAMED', '-jar', process.env.GREENFLIX_TEST_JAR ?? join(project, 'backend/target/greenflix-0.1.0-SNAPSHOT.jar'), `--spring.config.additional-location=${pathToFileURL(configuration).href}`], {
    cwd: stateDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SERVER_PORT: String(port), SERVER_ADDRESS: '127.0.0.1', GREENFLIX_PUBLIC_ORIGIN: '', GREENFLIX_ADMIN_PASSWORD_HASH: hash, GREENFLIX_DATABASE_URL: `jdbc:sqlite:${join(stateDirectory, 'demo.db')}` },
  })
  const stop = async () => {
    if (server.exitCode !== null) return
    const exited = new Promise(resolve => server.once('exit', resolve))
    if (launcher) {
      const stopper = spawn(launcher, [`--config-dir=${stateDirectory}`, '--stop'], { cwd:stateDirectory, windowsHide:true, stdio:'ignore', env:server.spawnargs ? { ...process.env, GREENFLIX_ADMIN_PASSWORD_HASH:hash } : process.env })
      await new Promise(resolve => stopper.once('exit', resolve))
      await Promise.race([exited, new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Portable graceful stop timed out')),45000);timer.unref()})])
    } else { server.kill(); await exited }
  }
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Demo startup timed out.')), 25000)
      server.stdout.on('data', chunk => {
        startupLog?.(chunk.toString())
        output = (output + chunk.toString()).slice(-12000)
        const match = output.match(/Tomcat started on port (\d+)/)
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`) }
      })
      server.stderr.on('data', chunk => { startupLog?.(chunk.toString()) })
      server.once('error', () => { clearTimeout(timer); reject(new Error('Java could not be launched.')) })
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Demo stopped before startup.')) })
    })
    let cookie = '', token = ''
    async function request(path, method = 'GET', body, etag) {
      const headers = { Accept: 'application/json', Cookie: cookie }
      if (method !== 'GET') headers['X-CSRF-TOKEN'] = token
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (etag) headers['If-Match'] = etag
      const response = await fetch(origin + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      const session = response.headers.getSetCookie().find(value => value.startsWith('JSESSIONID='))
      if (session) cookie = session.split(';')[0]
      if (!response.ok) throw new Error(`Demo API request failed (${response.status}).`)
      return { data: response.status === 204 ? null : await response.json(), etag: response.headers.get('ETag') }
    }
    token = (await request('/csrf')).data.token
    await request('/admin/session', 'POST', { password })
    token = (await request('/csrf')).data.token
    const roots = (await request('/admin/library/roots')).data
    const root = roots.find(item => item.runtimeRef === reference) ?? (await request('/admin/library/roots', 'POST', { displayName: discoveryRoot ? 'Local discovery demonstration' : 'Local playback demonstration', classification: 'LEGACY', enabled: true, runtimeRef: reference })).data
    if (discoveryRoot) {
      const movies = (await request('/admin/media?type=MOVIE&q=Discovery%20sample')).data.items
      let movie = movies[0] ?? (await request('/admin/media', 'POST', { type: 'MOVIE', titleEn: 'Discovery sample', synopsisEn: 'Local discovery fixture. © 2008 Blender Foundation / www.bigbuckbunny.org. CC BY 3.0. Unchanged W3Schools sample excerpt.' })).data
      const current = await request('/admin/media/' + movie.id)
      if (current.data.status !== 'PUBLISHED') await request(`/admin/media/${movie.id}/publish`, 'POST', undefined, current.etag)
      return { origin, rootId: root.id, movieId: movie.id, stateDirectory, url: `${origin}/admin/library`, request, stop, server, sessionCookie: () => cookie }
    }
    const rootTag = (await request('/admin/library/roots/' + root.id)).etag
    const assets = (await request('/admin/library/assets?storageRootId=' + root.id)).data.items
    let asset = assets.find(item => item.relativePath === basename(fixture))
    if (!asset) asset = (await request('/admin/library/assets', 'POST', { storageRootId: root.id, relativePath: basename(fixture) }, rootTag)).data.asset
    const detail = await request('/admin/library/assets/' + asset.id)
    await request(`/admin/library/assets/${asset.id}/direct-mp4-approval`, 'POST', { generation: detail.data.asset.contentGeneration, confirmKnownH264Aac: true }, detail.etag)
    const movies = (await request('/admin/media?type=MOVIE&q=Big%20Buck%20Bunny%20playback%20sample')).data.items
    let movie = movies[0]
    if (!movie) movie = (await request('/admin/media', 'POST', { type: 'MOVIE', titleEn: 'Big Buck Bunny playback sample', synopsisEn: 'Local 10-second browser playback fixture. © 2008 Blender Foundation / www.bigbuckbunny.org. CC BY 3.0. Sample excerpt supplied by W3Schools.' })).data
    let current = await request('/admin/media/' + movie.id)
    const bindings = (await request(`/admin/library/targets/MOVIE/${movie.id}/assets`)).data
    if (!bindings.some(item => item.binding.assetId === asset.id)) {
      await request('/admin/library/bindings', 'POST', { assetId: asset.id, targetType: 'MOVIE', targetId: movie.id, versionLabel: 'Browser test MP4', preferenceOrder: 0 }, current.etag)
      current = await request('/admin/media/' + movie.id)
    }
    if (current.data.status !== 'PUBLISHED') await request(`/admin/media/${movie.id}/publish`, 'POST', undefined, current.etag)
    return { origin, movieId: movie.id, assetId: asset.id, url: `${origin}/media/${movie.id}`, request, stop, server }
  } catch (error) { await stop(); throw error }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const demo = await startPlaybackDemo()
  console.log(`Open ${demo.url} and press Play. This is an isolated local sample catalog. Press Ctrl+C to stop.`)
  process.once('SIGINT', async () => { await demo.stop(); process.exit(0) })
  process.once('SIGTERM', async () => { await demo.stop(); process.exit(0) })
}
