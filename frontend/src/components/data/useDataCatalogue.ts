import { create } from 'zustand';

export type DataView = 'datasets' | 'features';

/** Open state of the Data catalogue overlay (opened from Reports → Data catalogue). */
export const useDataCatalogue = create<{
  open: boolean;
  view: DataView;
  selected: string | null;
  show: (view?: DataView, selected?: string | null) => void;
  close: () => void;
  setView: (v: DataView) => void;
  select: (id: string | null) => void;
}>(set => ({
  open: false,
  view: 'datasets',
  selected: null,
  show: (view = 'datasets', selected = null) => set(s => ({ open: true, view, selected: selected ?? s.selected })),
  close: () => set({ open: false }),
  setView: view => set({ view }),
  select: selected => set({ selected, view: 'datasets' }),
}));
