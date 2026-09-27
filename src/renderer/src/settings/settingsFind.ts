// The find chord while Settings is open: the command bumps `asked`, and the page focuses its search.

import { create } from 'zustand'

export const useSettingsFind = create<{ asked: number; ask: () => void }>()((set) => ({
  asked: 0,
  ask: () => set((state) => ({ asked: state.asked + 1 }))
}))
