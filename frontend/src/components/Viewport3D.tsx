import React, { useEffect, useRef } from 'react';
import { 
  Viewer, 
  Ion, 
  Cartesian3, 
  Math as CesiumMath,
  ScreenSpaceEventType
} from 'cesium';
import { engineInstance } from '../engine/TwinCityEngine';

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

    // Cleanup
    return () => {
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

  return (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 glass-panel px-4 py-2 rounded-full border border-indigo-500/30 flex items-center gap-3 text-sm z-[999] animate-bounce pointer-events-auto">
      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
      <span>
        {mode === 'draw_road' && `Drawing Road: Click to add points. Double-click to complete (${pointsCount} points)`}
        {mode === 'draw_flyover' && `Drawing Elevated Flyover: Click to add points. Double-click to complete (${pointsCount} points)`}
        {mode === 'draw_metro' && `Drawing Elevated Metro Line: Click to add points. Double-click to complete (${pointsCount} points)`}
        {mode === 'place_station' && 'Placing Metro Station: Click once on the map to place'}
        {mode === 'draw_building' && `Drawing Building Footprint: Click nodes. Double-click to extrude (${pointsCount} nodes)`}
        {mode === 'draw_junction' && 'Drawing Junction: Click once on the map to place'}
        {mode === 'draw_utility' && `Drawing Sub-surface Utility: Click to draw lines. Double-click to finalize (${pointsCount} points)`}
        {mode === 'import_osm' && 'Import OSM Roads: Click anywhere on the map to import real 3D roads in a 1km area'}
        {mode === 'draw_zone' && `Drawing Zone: Click 3+ points on the map. Double-click to complete (${pointsCount} vertices)`}
        {mode === 'draw_gateway' && 'Placing Gateway: Click once on or near a boundary road to place'}
      </span>
      <button 
        onClick={() => engineInstance.editing.setMode('select')}
        className="px-2 py-0.5 rounded bg-red-950 text-red-300 hover:bg-red-900 border border-red-500/20 text-xs transition cursor-pointer"
      >
        Cancel
      </button>
    </div>
  );
};
