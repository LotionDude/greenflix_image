export function validateOrigin(origin, allowLoopback = false) {
  const url = new URL(origin)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_ORIGIN')
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')) throw new Error('HTTPS_REQUIRED')
  return url.origin
}
export class Client {
  constructor(origin, allowLoopback = false) { this.origin = validateOrigin(origin, allowLoopback); this.cookie = ''; this.csrf = '' }
  async raw(path, options = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('INVALID_ROUTE')
    const response = await fetch(this.origin + path, { ...options, redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(15000), headers: { Cookie: this.cookie, ...options.headers } })
    const cookie = response.headers.getSetCookie().find(v => v.startsWith('JSESSIONID='))
    if (cookie) this.cookie = cookie.split(';')[0]
    return response
  }
  async call(path, method = 'GET', body, etag, expected = 200) {
    const response = await this.raw('/api/v1' + path, { method, headers: { Accept: 'application/json',
      ...(method !== 'GET' ? { 'X-CSRF-TOKEN': this.csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(etag ? { 'If-Match': etag } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (response.status !== expected) { await response.body?.cancel(); throw new Error('HTTP_' + response.status) }
    const data = response.status === 204 ? null : await response.json()
    if (path === '/csrf') this.csrf = data.token
    return { data, etag: response.headers.get('ETag') }
  }
  async login(password) { await this.call('/csrf'); await this.call('/admin/session', 'POST', { password }); await this.call('/csrf') }
}
export async function input() {
  let data = ''; for await (const chunk of process.stdin) { data += chunk; if (data.length > 131072) throw new Error('INPUT_TOO_LARGE') }
  const value = JSON.parse(data)
  if (!value.config || !value.password) throw new Error('CONFIG_AND_PASSWORD_REQUIRED_ON_STDIN')
  return value
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function waitFor(get, predicate, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await get(); if (predicate(value)) return value; await delay(250) }
  throw new Error('STATE_TIMEOUT')
}
export const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)] : null
