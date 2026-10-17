// Isolated Gate 4 fixture preparation. No source-media changes, share access or application import operation.
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { startPlaybackDemo, fixtureHash } from './playback-demo.mjs'

export async function startDiscoveryDemo({ directory, ffprobePath } = {}) {
  const project = fileURLToPath(new URL('..', import.meta.url))
  directory = resolve(directory ?? join(project, 'deploy/test-results/gate4-demo'))
  const fixture = join(project, 'deploy/test-results/gate3-media/known-h264-aac.mp4')
  if (createHash('sha256').update(await readFile(fixture)).digest('hex') !== fixtureHash) throw new Error('Fetch the documented playback fixture first.')
  const discoveryRoot = join(directory, 'library')
  for (const relative of ['Movies/English sample.mp4', 'Movies/סרט לדוגמה.mp4', 'Episodes/Season 1/English sample.mp4']) {
    const destination = join(discoveryRoot, relative)
    await mkdir(resolve(destination, '..'), { recursive: true })
    try { await access(destination) } catch { await copyFile(fixture, destination) }
  }
  await mkdir(join(discoveryRoot, 'empty'), { recursive: true })
  try { await access(join(discoveryRoot, 'corrupt.mp4')) } catch { await writeFile(join(discoveryRoot, 'corrupt.mp4'), 'Invalid MP4 fixture') }
  ffprobePath = resolve(ffprobePath ?? process.env.GREENFLIX_TEST_FFPROBE ?? join(project, 'deploy/tools/ffprobe/ffprobe.exe'))
  const demo = await startPlaybackDemo({ directory, fixture, discoveryRoot, ffprobePath })
  return { ...demo, discoveryRoot }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const demo = await startDiscoveryDemo()
  // The visible local browser receives the existing shared-admin session in memory; credentials are never printed.
  const { chromium } = await import('../frontend/node_modules/playwright/index.mjs')
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: false })
  const context = await browser.newContext()
  const cookie = demo.sessionCookie().split('=')
  await context.addCookies([{ name: cookie[0], value: cookie[1], url: demo.origin, httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage(); await page.goto(demo.url)
  console.log(`Local demo: ${demo.url}. Click Scan, inspect a file, associate Discovery sample, then open its public page. Ctrl+C stops the demo.`)
  const stop = async () => { await browser.close(); await demo.stop(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  browser.once('disconnected', async () => { await demo.stop(); process.exit(0) })
}
