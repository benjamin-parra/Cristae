// Descarga clasificada: network con status, cors por origen y aborto propagado.
// Corre con: node --test test/remote-fetch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchBytes, RemoteError } from '../src/data/remote-fetch.js'

const ok = bytes => async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => bytes.buffer })

const conPagina = (origin, fn) => async () => {
  const antes = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: { origin, href: `${origin}/` }, configurable: true })
  try { await fn() } finally {
    if (antes) Object.defineProperty(globalThis, 'location', antes); else delete globalThis.location
  }
}

test('devuelve los bytes y las cabeceras', async () => {
  const r = await fetchBytes('/x', { fetch: ok(new Uint8Array([1, 2, 3])) })
  assert.deepEqual([...r.bytes], [1, 2, 3])
  assert.ok(r.headers)
})

test('un 404 da network con status', async () => {
  const fetch = async () => ({ ok: false, status: 404 })
  await assert.rejects(fetchBytes('/x', { fetch }), e => e instanceof RemoteError && e.code === 'network' && e.status === 404 && e.url === '/x')
})

test('rechazo sin DOM da network', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchBytes('https://otro.test/x', { fetch }), e => e.code === 'network')
})

test('rechazo de mismo origen da network', conPagina('https://app.test', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchBytes('https://app.test/x', { fetch }), e => e.code === 'network')
  await assert.rejects(fetchBytes('/x', { fetch }), e => e.code === 'network')
}))

test('rechazo de otro origen da cors', conPagina('https://app.test', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchBytes('https://otro.test/x', { fetch }), e => e.code === 'cors' && e.url === 'https://otro.test/x')
}))

test('el aborto se propaga tal cual', async () => {
  const ctl = new AbortController()
  const fetch = async (_u, { signal }) => { ctl.abort(); signal.throwIfAborted(); return {} }
  await assert.rejects(fetchBytes('/x', { fetch, signal: ctl.signal }), e => e.name === 'AbortError' && !(e instanceof RemoteError))
})
