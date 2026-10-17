import { describe, expect, it } from 'vitest'
import { contrast, pickAccent } from '../../../src/main/art/accent'

type Rgba = [number, number, number, number]

/** An image of `parts`: each colour repeated for its share of `size` pixels. */
function image(parts: [Rgba, number][], size = 1000): Uint8Array {
  const out: number[] = []
  for (const [px, share] of parts) {
    for (let i = 0; i < Math.round(size * share); i++) out.push(...px)
  }
  return new Uint8Array(out)
}

const rgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
]
const INK: [number, number, number] = [0x0f, 0x19, 0x1d]

describe('pickAccent', () => {
  it('takes the dominant vivid colour and keeps it readable on ink', () => {
    const accent = pickAccent(
      image([
        [[180, 20, 20, 255], 0.5],
        [[10, 10, 10, 255], 0.5]
      ])
    )
    expect(accent).toMatch(/^#[0-9a-f]{6}$/)
    const [r, g, b] = rgb(accent!)
    expect(r).toBeGreaterThan(g * 1.5)
    expect(r).toBeGreaterThan(b * 1.5)
    expect(contrast([r, g, b], INK)).toBeGreaterThanOrEqual(5)
  })

  it('brightens a dark colour until it reads on ink', () => {
    const accent = pickAccent(image([[[20, 40, 120, 255], 1]]))!
    const [r, g, b] = rgb(accent)
    expect(b).toBeGreaterThan(r)
    expect(contrast([r, g, b], INK)).toBeGreaterThanOrEqual(5)
  })

  it('picks the colour covering more of the art', () => {
    const [r, g, b] = rgb(
      pickAccent(
        image([
          [[30, 90, 220, 255], 0.6],
          [[240, 200, 30, 255], 0.4]
        ])
      )!
    )
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('returns null for grey, near-black and mostly colourless art', () => {
    expect(pickAccent(image([[[128, 128, 128, 255], 1]]))).toBeNull()
    expect(pickAccent(image([[[30, 5, 5, 255], 1]]))).toBeNull()
    expect(
      pickAccent(
        image([
          [[200, 30, 30, 255], 0.02],
          [[240, 240, 240, 255], 0.98]
        ])
      )
    ).toBeNull()
  })

  it('ignores transparent pixels and handles empty input', () => {
    expect(pickAccent(image([[[200, 30, 30, 0], 1]]))).toBeNull()
    expect(pickAccent(new Uint8Array())).toBeNull()
  })
})
