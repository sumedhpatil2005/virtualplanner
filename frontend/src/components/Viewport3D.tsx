import React, { useEffect, useRef } from 'react';
import {
  Viewer,
  Ion,
  Cartesian3,
  Math as CesiumMath,
  ScreenSpaceEventType
} from 'cesium';
import { engineInstance } from '../engine/TwinCityEngine';
import type { EditingMode } from '../engine/editing/EditingEngine';

export const Viewport3D: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Set Cesium Ion default token if available in env, otherwise blank
    const ionToken = (import.meta.env.VITE_CESIUM_ION_TOKEN || '').trim();
    if (ionToken && ionToken !== 'YOUR_CESIUM_ION_TOKEN_HERE') {
      Ion.defaultAccessToken = ionToken;
    }

    // Initialize Cesium Viewer with clean, clutter-free options
    const viewer = new Viewer(containerRef.current, {
      animation: false, // Custom scenario timelines
      timeline: false,  // Custom simulation slider
      geocoder: false,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: false,
      infoBox: false, // Custom context properties panel
      selectionIndicator: false,
      baseLayerPicker: true, // Allow user to toggle between satellite and street base maps
      fullscreenButton: true,
      terrainProvider: undefined // Default ellipsoid or generic terrain
    });

    // Disable default double-click camera tracking/zoom
    viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // Configure lighting and camera
    viewer.scene.globe.enableLighting = true;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;

    // Set initial camera view centered on Pune (73.8567, 18.5204) at 1500m altitude
    const initialPosition = Cartesian3.fromDegrees(73.8567, 18.5204, 1500);
    viewer.camera.setView({
      destination: initialPosition,
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-45),
        roll: 0.0
      }
    });

    // Register Cesium viewer inside our master TwinCityEngine
    engineInstance.setViewer(viewer);

    // Cleanup: release engine resources bound to this viewer before destroying it
    return () => {
      engineInstance.dispose();
      viewer.destroy();
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      {/* Target element for Cesium container */}
      <div ref={containerRef} className="w-full h-full absolute inset-0" />

      {/* Overlay to show current drawing tool tips */}
      <DrawingHUD />
    </div>
  );
};

const HUD_TEXT: Record<Exclude<EditingMode, 'select'>, (n: number) => string> = {
  draw_road: n => `Drawing Road: click to add points, double-click or Enter to finish (${n} points)`,
  draw_flyover: n => `Drawing Elevated Flyover: click to add points, double-click or Enter to finish (${n} points)`,
  draw_metro: n => `Drawing Elevated Metro Line: click to add points, double-click or Enter to finish (${n} points)`,
  draw_metro_flyover: n => `Drawing Metro + Flyover: click to add points, double-click or Enter to finish (${n} points)`,
  draw_building: n => `Drawing Building Footprint: click 3+ corners, double-click or Enter to extrude (${n} corners)`,
  draw_utility: n => `Laying Utility Conduit: click to add points, double-click or Enter to finish (${n} points)`,
  draw_zone: n => `Drawing Demand Zone: click 3+ corners, double-click or Enter to finish (${n} corners)`,
  draw_junction: () => 'Placing Junction: click on the map to place one',
  place_station: () => 'Placing Metro Station: click on the map to place one',
  draw_gateway: () => 'Placing Gateway: click on or near a boundary road to place one',
  import_osm: n => n > 0
    ? `Study area: ${n} boundary points placed. Add more, then choose "Create and import" in the tool panel`
    : 'Study area: click 3+ points to outline an area, then choose Create and import',
};

const DrawingHUD: React.FC = () => {
  const [mode, setMode] = React.useState(engineInstance.editing.getMode());
  const [pointsCount, setPointsCount] = React.useState(0);

  useEffect(() => {
    const unsub = engineInstance.editing.onChange(() => {
      setMode(engineInstance.editing.getMode());
      setPointsCount(engineInstance.editing.getDrawingPoints().length);
    });
    return unsub;
  }, []);

  if (mode === 'select') return null;

  const multiPoint = !engineInstance.editing.isSingleClickMode(mode);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-2xl bg-slate-950/90 backdrop-blur-xl border border-indigo-400/30 shadow-2xl flex items-center gap-3 text-sm z-999 animate-fade-in pointer-events-auto max-w-[min(42rem,calc(100vw-48rem))]">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
      <div className="flex flex-col">
        <span className="text-slate-100">{HUD_TEXT[mode](pointsCount)}</span>
        <span className="text-xs text-slate-400">
          {multiPoint && pointsCount > 0 ? 'Right-click a point to remove it · ' : ''}Tool stays active · Esc to exit
        </span>
      </div>
      <button
        onClick={() => engineInstance.editing.cancelDrawing()}
        className="px-3 py-1 rounded-lg bg-white/[0.07] text-slate-100 hover:bg-white/[0.12] border border-white/10 text-sm font-semibold transition cursor-pointer shrink-0"
      >
        Done
      </button>
    </div>
  );
};
