import {
  MousePointer2,
  Route,
  Building2,
  SquaresIntersect,
  Spline,
  Rows2,
  TrainFront,
  CircleDot,
  Cable,
  TrainFrontTunnel,
  Shapes,
  DoorOpen,
  Download,
  type LucideIcon
} from 'lucide-react';
import type { EditingMode } from '../engine/editing/EditingEngine';

/** Palette groups (docs/urbanos/UX_ARCHITECTURE.md §3), in display order. */
export type ToolCategory = 'select' | 'roads' | 'junctions' | 'grade_separation' | 'transit' | 'underground' | 'land_demand' | 'data';

export const TOOL_CATEGORIES: { id: ToolCategory; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'roads', label: 'Roads & lanes' },
  { id: 'junctions', label: 'Junctions & signals' },
  { id: 'grade_separation', label: 'Grade separation' },
  { id: 'transit', label: 'Transit' },
  { id: 'underground', label: 'Underground' },
  { id: 'land_demand', label: 'Land & demand' },
  { id: 'data', label: 'Data' },
];

export interface ToolDef {
  mode: EditingMode;
  /** Verb + noun: tooltip, aria-label and command search ("Draw road"). */
  label: string;
  /** One or two words, shown under the icon. Same as shortLabel (kept for existing callers). */
  short: string;
  shortLabel: string;
  icon: LucideIcon;
  category: ToolCategory;
  /** One sentence: what the tool really creates. */
  description: string;
  /** 'available' = a working EditingEngine mode backs it. Tools without one are not listed (no decorative controls). */
  status: 'available';
  /** Keyboard shortcut (1-9), if any. */
  hotkey?: string;
}

const t = (d: Omit<ToolDef, 'short' | 'status'>): ToolDef => ({ ...d, short: d.shortLabel, status: 'available' });

/**
 * Single source of truth for the editing tools. Array order keeps the 1-9 hotkeys of the old
 * toolbar; the palette orders them by TOOL_CATEGORIES. No icon is shared with app chrome
 * (Compass = map compass, Layers = layer tree, Hammer = Build mode, gear = settings).
 */
export const TOOLS: ToolDef[] = [
  t({ mode: 'select', label: 'Select object', shortLabel: 'Select', icon: MousePointer2, category: 'select', hotkey: '1',
    description: 'Pick an object on the map to inspect and edit it.' }),
  t({ mode: 'draw_road', label: 'Draw road', shortLabel: 'Road', icon: Route, category: 'roads', hotkey: '2',
    description: 'Draw a surface road; its class sets width, lanes, speed and capacity. Crossed roads are split into junctions.' }),
  t({ mode: 'draw_building', label: 'Draw building footprint', shortLabel: 'Building', icon: Building2, category: 'land_demand', hotkey: '3',
    description: 'Draw a building footprint; height comes from the floors you enter (hypothetical until you edit it).' }),
  t({ mode: 'draw_junction', label: 'Place junction', shortLabel: 'Junction', icon: SquaresIntersect, category: 'junctions', hotkey: '4',
    description: 'Join two or more road approaches at one level; signals on by default (90 s cycle), editable afterwards.' }),
  t({ mode: 'draw_flyover', label: 'Draw flyover', shortLabel: 'Flyover', icon: Spline, category: 'grade_separation', hotkey: '5',
    description: 'Elevated road with ramps (deck 6 m, piers every 30 m); takes ramp capacity from the roads it merges with.' }),
  t({ mode: 'draw_metro', label: 'Draw metro line (elevated)', shortLabel: 'Metro line', icon: TrainFront, category: 'transit', hotkey: '6',
    description: 'Elevated two-track metro viaduct at 12 m. Underground metro: use the Tunnel tool (Underground).' }),
  t({ mode: 'draw_metro_flyover', label: 'Draw double-deck (road + metro)', shortLabel: 'Double-deck', icon: Rows2, category: 'grade_separation', hotkey: '7',
    description: 'Double-deck corridor: road deck at 6 m with an elevated metro deck at 12 m on the same piers.' }),
  t({ mode: 'place_station', label: 'Place metro station', shortLabel: 'Station', icon: CircleDot, category: 'transit', hotkey: '8',
    description: 'Elevated station (platform 12 m) that aligns to the nearest metro track within 100 m.' }),
  t({ mode: 'draw_utility', label: 'Lay utility line', shortLabel: 'Utility', icon: Cable, category: 'underground', hotkey: '9',
    description: 'Buried utility line (water, sewage, electrical, gas, fibre) with depth, depth certainty and diameter.' }),
  t({ mode: 'draw_underground', label: 'Draw underground alignment', shortLabel: 'Tunnel', icon: TrainFrontTunnel, category: 'underground',
    description: 'Tunnel, underground metro, cut-and-cover box, utility trunk or storm drain: plan line, depth per vertex, cross-section.' }),
  t({ mode: 'draw_zone', label: 'Draw demand zone', shortLabel: 'Demand zone', icon: Shapes, category: 'land_demand',
    description: 'Traffic demand zone (residents and jobs feed the trip model). Not a land-use zoning plan.' }),
  t({ mode: 'draw_gateway', label: 'Place traffic gateway', shortLabel: 'Gateway', icon: DoorOpen, category: 'land_demand',
    description: 'Where traffic enters/leaves the study area; snaps to the nearest road node. Default flows are placeholders.' }),
  t({ mode: 'import_osm', label: 'Import area (OSM)', shortLabel: 'Import area', icon: Download, category: 'data',
    description: 'Outline or pick a study area and import OpenStreetMap roads, buildings, metro and signals inside it from the local index.' }),
];

export const toolByHotkey = (key: string): ToolDef | undefined =>
  TOOLS.find(t => t.hotkey === key);

/** Tools of one palette group, in array (hotkey) order. */
export const toolsInCategory = (c: ToolCategory): ToolDef[] => TOOLS.filter(t => t.category === c);

/** Custom DOM event used to ask the Toolbar to expand (coach marks, hotkeys). */
export const OPEN_TOOLBAR_EVENT = 'twincity:open-toolbar';
