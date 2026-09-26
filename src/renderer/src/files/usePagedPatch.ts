// A cut patch read on past its first page, each page from where the last ended, up to a ceiling.

import { useEffect, useRef, useState } from 'react'
import type { PatchMore } from '../workspace/PatchView'

/** The most of one patch that is read, first page included. */
export const FULL_PATCH_BYTES = 16 * 1024 * 1024

/** The runtime's first page; each page after is as big as everything before it. */
const FIRST_PAGE_BYTES = 1024 * 1024

export type PatchPage = { patch: string; truncated: boolean; totalLines?: number }

export type ReadPage = (offsetBytes: number, maxBytes: number) => Promise<PatchPage>

type Rest = { first: PatchPage; patch: string; truncated: boolean; loading: boolean }

const encoder = new TextEncoder()
const bytesOf = (text: string): number => encoder.encode(text).length

/** `first` with the pages read after it once `Show Full Diff` is asked for; a new `first` reads them again. */
export function usePagedPatch(
  first: PatchPage | null,
  read: ReadPage
): { patch: string | null; truncated: boolean; more: PatchMore } {
  const [wanted, setWanted] = useState(false)
  const [rest, setRest] = useState<Rest | null>(null)
  const reader = useRef(read)
  reader.current = read

  useEffect(() => {
    if (!wanted || first === null || !first.truncated) return
    let alive = true
    const load = async (): Promise<void> => {
      let patch = ''
      let loaded = bytesOf(first.patch)
      let truncated = true
      setRest({ first, patch, truncated, loading: true })
      while (truncated && loaded < FULL_PATCH_BYTES) {
        const size = Math.min(FULL_PATCH_BYTES - loaded, Math.max(FIRST_PAGE_BYTES, loaded))
        const page = await reader.current(loaded, size)
        if (!alive) return
        if (page.patch === '') break
        patch += page.patch
        loaded += bytesOf(page.patch)
        truncated = page.truncated
        setRest({ first, patch, truncated, loading: truncated && loaded < FULL_PATCH_BYTES })
      }
      setRest({ first, patch, truncated, loading: false })
    }
    load().catch(() => {
      if (alive) setRest((now) => (now === null ? now : { ...now, loading: false }))
    })
    return () => {
      alive = false
    }
  }, [first, wanted])

  const current = rest?.first === first ? rest : null
  const loading = wanted && (current?.loading ?? first?.truncated === true)
  return {
    patch: first === null ? null : first.patch + (current?.patch ?? ''),
    truncated: current?.truncated ?? first?.truncated ?? false,
    more: {
      totalLines: first?.totalLines,
      loading,
      onShowAll: wanted && !loading ? undefined : () => setWanted(true),
      onStop: () => {
        setWanted(false)
        setRest((now) => (now === null ? now : { ...now, loading: false }))
      }
    }
  }
}
