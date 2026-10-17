// Isolated Gate 5 fixture preparation; uses Gate 4 scanner/probe and Gate 3 playback unchanged.
import { mkdir, mkdtemp, copyFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startPlaybackDemo, fixtureHash } from './playback-demo.mjs'
import { createHash } from 'node:crypto'

export async function startMatchingDemo({ directory, managedRoot, importRate } = {}) {
  const project = fileURLToPath(new URL('..', import.meta.url))
  directory = resolve(directory ?? await mkdtemp(join(tmpdir(), 'greenflix-local-library-')))
  const fixture = join(project, 'deploy/test-results/gate3-media/known-h264-aac.mp4')
  if (createHash('sha256').update(await readFile(fixture)).digest('hex') !== fixtureHash) throw new Error('Fetch the documented playback fixture first.')
  const discoveryRoot = join(directory, 'library')
  const files = ['Interstellar.2014.1080p.mp4', 'Interstellar.2014.Extended.720p.mp4', 'Example Show/Season 01/Example.Show.S01E03.mp4', 'Example Show/Season 01/Example.Show.1x03.720p.mp4', 'Dune.mp4', 'video_final.mp4', 'Other Movie (2023)/Interstellar.2014.mp4', 'סרט לדוגמה.2020.mp4']
  for (const relative of files) {
    const destination = join(discoveryRoot, relative)
    await mkdir(resolve(destination, '..'), { recursive: true })
    try { await access(destination) } catch { await copyFile(fixture, destination) }
  }
  const demo = await startPlaybackDemo({ directory, fixture, discoveryRoot, ffprobePath: join(project, 'deploy/tools/ffprobe/ffprobe.exe'), managedRoot, importRate })
  try {
    const create = async (titleEn, releaseYear, titleHe, type = 'MOVIE') => {
      const found = (await demo.request('/admin/media?type=' + type + '&q=' + encodeURIComponent(titleEn))).data.items
      let item = found.find(m => m.titleEn === titleEn && m.releaseYear === releaseYear)
      if (!item) item = (await demo.request('/admin/media', 'POST', { type, titleEn, titleHe, releaseYear, synopsisEn: 'Local matching and playback test fixture. © 2008 Blender Foundation / www.bigbuckbunny.org. CC BY 3.0. Unchanged sample excerpt; filenames are synthetic.' })).data
      return item.id
    }
    const movieId = await create('Interstellar', 2014, 'בין כוכבים')
    await create('Dune', 1984); await create('Dune', 2021); await create('Other Movie', 2023)
    const hebrewId = await create('Hebrew Fixture', 2020, 'סרט לדוגמה')
    const seriesId = await create('Example Show', 2020, 'סדרה לדוגמה', 'SERIES')
    let seasons = (await demo.request(`/admin/media/${seriesId}/seasons`)).data.items
    let season = seasons.find(s => s.number === 1)
    if (!season) {
      const current = await demo.request('/admin/media/' + seriesId)
      season = (await demo.request(`/admin/media/${seriesId}/seasons`, 'POST', { number: 1 }, current.etag)).data
    }
    const seasonPath = `/admin/media/${seriesId}/seasons/${season.id}`
    let episodes = (await demo.request(`${seasonPath}/episodes`)).data.items
    let episode = episodes.find(e => e.number === 3)
    if (!episode) {
      const current = await demo.request('/admin/media/' + seriesId)
      episode = (await demo.request(`${seasonPath}/episodes`, 'POST', { number: 3 }, current.etag)).data
    }
    const publish = async (path, root) => {
      const current = await demo.request('/admin/media/' + root)
      await demo.request(path + '/publish', 'POST', undefined, current.etag)
    }
    for (const id of [movieId, hebrewId, seriesId]) {
      const current = await demo.request('/admin/media/' + id)
      if (current.data.status !== 'PUBLISHED') await publish('/admin/media/' + id, id)
    }
    if (season.status !== 'PUBLISHED') await publish(seasonPath, seriesId)
    if (episode.status !== 'PUBLISHED') await publish(`${seasonPath}/episodes/${episode.id}`, seriesId)
    return { ...demo, discoveryRoot, files, movieId, seriesId, episodeId: episode.id, hebrewId }
  } catch (error) { await demo.stop(); throw error }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const demo = await startMatchingDemo()
  const { chromium } = await import('../frontend/node_modules/playwright/index.mjs')
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: false })
  const context = await browser.newContext()
  const cookie = demo.sessionCookie().split('=')
  await context.addCookies([{ name: cookie[0], value: cookie[1], url: demo.origin, httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage(); await page.goto(demo.url)
  console.log(`Local matching demo: ${demo.url}. Scan, generate proposals, review and approve selected files. Ctrl+C stops it.`)
  const stop = async () => { await browser.close(); await demo.stop(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  browser.once('disconnected', async () => { await demo.stop(); process.exit(0) })
}
