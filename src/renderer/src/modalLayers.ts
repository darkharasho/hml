/** Anything that can be made inert (an HTMLElement, or a fake in tests). */
export interface InertTarget {
  inert: boolean
}

/** The page the modals sit on. */
export interface ModalHost {
  /** The elements a modal covers (those marked `data-inert-under-modal`), looked up fresh. */
  covers(): Iterable<InertTarget>
  /** Calls `onChange` whenever elements are added or removed, until the returned stop runs. */
  watch(onChange: () => void): () => void
}

/**
 * Keeps track of open modals, innermost last. A native showModal() would make everything else
 * inert, the titlebar's window buttons included, so the app marks what modals cover inert itself:
 * every covered element (also ones mounted while a modal is open) and any modal under the top one.
 */
export function createModalLayers(host: ModalHost): {
  open(layer: InertTarget): void
  close(layer: InertTarget): void
  isTop(layer: InertTarget): boolean
} {
  const layers: InertTarget[] = []
  let stopWatching: (() => void) | null = null

  function sync(): void {
    const anyOpen = layers.length > 0
    for (const el of host.covers()) if (el.inert !== anyOpen) el.inert = anyOpen
    layers.forEach((layer, i) => {
      layer.inert = i !== layers.length - 1
    })
  }

  return {
    open(layer) {
      layers.push(layer)
      stopWatching ??= host.watch(sync)
      sync()
    },
    close(layer) {
      const i = layers.indexOf(layer)
      if (i >= 0) layers.splice(i, 1)
      if (layers.length === 0) {
        stopWatching?.()
        stopWatching = null
      }
      sync()
    },
    isTop: (layer) => layers[layers.length - 1] === layer
  }
}

/** The real page: covered elements by attribute, changes from a MutationObserver on <body>. */
export function domModalHost(doc: Document): ModalHost {
  return {
    covers: () => doc.querySelectorAll<HTMLElement>('[data-inert-under-modal]'),
    watch(onChange) {
      // Setting `inert` is an attribute change, so it doesn't trigger this observer again.
      const observer = new MutationObserver(onChange)
      observer.observe(doc.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }
  }
}
