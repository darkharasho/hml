import { describe, expect, test } from 'vitest'
import { createModalLayers, type ModalHost } from '../../src/renderer/src/modalLayers'

/** A fake page: `covered` is what carries data-inert-under-modal; `mutate` mimics a DOM change. */
function fakeHost(): ModalHost & {
  covered: { inert: boolean }[]
  watching: boolean
  mutate(): void
} {
  let onChange: (() => void) | null = null
  const host = {
    covered: [{ inert: false }],
    watching: false,
    covers: () => host.covered,
    watch(cb: () => void) {
      onChange = cb
      host.watching = true
      return () => {
        onChange = null
        host.watching = false
      }
    },
    mutate: () => onChange?.()
  }
  return host
}

describe('createModalLayers', () => {
  test('a modal makes covered elements inert until it closes', () => {
    const host = fakeHost()
    const layers = createModalLayers(host)
    const modal = { inert: false }
    layers.open(modal)
    expect(host.covered[0].inert).toBe(true)
    expect(modal.inert).toBe(false)
    layers.close(modal)
    expect(host.covered[0].inert).toBe(false)
  })

  test('an element mounted while a modal is open is made inert too', () => {
    const host = fakeHost()
    const layers = createModalLayers(host)
    const modal = { inert: false }
    layers.open(modal)
    const later = { inert: false }
    host.covered.push(later)
    host.mutate()
    expect(later.inert).toBe(true)
    layers.close(modal)
    expect(later.inert).toBe(false)
  })

  test('watches the page only while a modal is open', () => {
    const host = fakeHost()
    const layers = createModalLayers(host)
    const a = { inert: false }
    const b = { inert: false }
    layers.open(a)
    layers.open(b)
    expect(host.watching).toBe(true)
    layers.close(b)
    expect(host.watching).toBe(true)
    layers.close(a)
    expect(host.watching).toBe(false)
  })

  test('only the top modal stays live; closing it brings back the one under it', () => {
    const host = fakeHost()
    const layers = createModalLayers(host)
    const outer = { inert: false }
    const inner = { inert: false }
    layers.open(outer)
    layers.open(inner)
    expect(outer.inert).toBe(true)
    expect(inner.inert).toBe(false)
    expect(layers.isTop(inner)).toBe(true)
    expect(layers.isTop(outer)).toBe(false)
    layers.close(inner)
    expect(outer.inert).toBe(false)
    expect(layers.isTop(outer)).toBe(true)
  })
})
