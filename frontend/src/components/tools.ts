import {
  MousePointer,
  Route,
  Building,
  Compass,
  Settings,
  Layers,
  Train,
  MapPin,
  Globe,
  Square,
  DoorOpen,
  Hammer,
  type LucideIcon
} from 'lucide-react';
import type { EditingMode } from '../engine/editing/EditingEngine';

export interface ToolDef {
  mode: EditingMode;
  label: string;
  /** One or two words, shown under the icon. */
  short: string;
  icon: LucideIcon;
  /** Keyboard shortcut (1-9), if any. */
  hotkey?: string;
}

/**
 * Single source of truth for the editing tools. Order is the toolbar order;
 * the most common tools come first so they get the 1-9 hotkeys.
 */
export const TOOLS: ToolDef[] = [
  { mode: 'select', label: 'Select Object', short: 'Select', icon: MousePointer, hotkey: '1' },
  { mode: 'draw_road', label: 'Draw Road Path', short: 'Road', icon: Route, hotkey: '2' },
  { mode: 'draw_building', label: 'Draw Building Footprint', short: 'Building', icon: Building, hotkey: '3' },
  { mode: 'draw_junction', label: 'Create Road Junction', short: 'Junction', icon: Compass, hotkey: '4' },
  { mode: 'draw_flyover', label: 'Draw Elevated Flyover', short: 'Flyover', icon: Layers, hotkey: '5' },
  { mode: 'draw_metro', label: 'Draw Elevated Metro Line', short: 'Metro', icon: Train, hotkey: '6' },
  { mode: 'draw_metro_flyover', label: 'Draw Metro + Flyover', short: 'Metro+road', icon: Hammer, hotkey: '7' },
  { mode: 'place_station', label: 'Place Metro Station', short: 'Station', icon: MapPin, hotkey: '8' },
  { mode: 'draw_utility', label: 'Lay Utility Conduit', short: 'Utility', icon: Settings, hotkey: '9' },
  { mode: 'draw_zone', label: 'Create Demand Zone (Polygon)', short: 'Zone', icon: Square },
  { mode: 'draw_gateway', label: 'Create Traffic Gateway', short: 'Gateway', icon: DoorOpen },
  { mode: 'import_osm', label: 'Create Study Area and Import Infrastructure', short: 'Study area', icon: Globe },
];

export const toolByHotkey = (key: string): ToolDef | undefined =>
  TOOLS.find(t => t.hotkey === key);

/** Custom DOM event used to ask the Toolbar to expand (coach marks, hotkeys). */
export const OPEN_TOOLBAR_EVENT = 'twincity:open-toolbar';
