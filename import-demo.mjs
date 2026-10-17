// Gate 6 demo: isolated local roots and database, existing scanner/matcher/player, explicit import only.
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startMatchingDemo } from './matching-demo.mjs'

export async function startImportDemo({ directory, importRate = 1048576 } = {}) {
  directory = resolve(directory ?? await mkdtemp(join(tmpdir(), 'greenflix-import-demo-')))
  const managedRoot = join(directory, 'managed')
  await mkdir(managedRoot, { recursive: true })
  const demo = await startMatchingDemo({ directory, managedRoot, importRate })
  try {
    const roots = (await demo.request('/admin/library/roots')).data
    const root = roots.find(r => r.runtimeRef === 'gate6-managed') ?? (await demo.request('/admin/library/roots', 'POST', { displayName: 'Managed demonstration', classification: 'MANAGED', enabled: true, runtimeRef: 'gate6-managed' })).data
    const destinations = (await demo.request('/admin/library/imports/destinations')).data
    if (!destinations.find(d => d.id === root.id).writeEnabled) {
      const current = await demo.request('/admin/library/roots/' + root.id)
      await demo.request(`/admin/library/imports/destinations/${root.id}/permission`, 'PUT', { enabled: true }, current.etag)
    }
    return { ...demo, managedRoot, destinationId: root.id, directory }
  } catch (e) { await demo.stop(); throw e }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const demo = await startImportDemo()
  const { chromium } = await import('../frontend/node_modules/playwright/index.mjs')
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: false })
  const context = await browser.newContext(); const [name, value] = demo.sessionCookie().split('=')
  await context.addCookies([{ name, value, url: demo.origin, httpOnly: true, sameSite: 'Lax' }]); const page = await context.newPage(); await page.goto(demo.url)
  console.log(`Local import demo: ${demo.url}. Scan, approve an association, open its asset, preview and confirm Import to Managed Library. Ctrl+C stops it. Temporary fixture data is retained.`)
  const stop = async () => { await browser.close(); await demo.stop(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  browser.once('disconnected', async () => { await demo.stop(); process.exit(0) })
}
