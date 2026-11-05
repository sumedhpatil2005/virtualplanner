import React from 'react';
import { HeadingPitchRange, BoundingSphere, Cartesian2 } from 'cesium';
import { engineInstance } from '../engine/TwinCityEngine';
import { useCameraHeading } from '../hooks/useCameraHeading';
import { compassShort, normaliseDeg } from '../engine/simulation/directions';

/** Turns the camera back to north-up about the point at the centre of the screen, keeping its tilt and distance. */
function resetNorthUp() {
  const viewer = engineInstance.getViewer();
  if (!viewer) return;
  const scene = viewer.scene, camera = viewer.camera;
  const canvas = scene.canvas as HTMLCanvasElement;
  const ray = camera.getPickRay(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  const centre = ray ? scene.globe.pick(ray, scene) : undefined;
  if (!centre) { camera.flyTo({ destination: camera.positionWC.clone(), orientation: { heading: 0, pitch: camera.pitch, roll: 0 }, duration: 0.6 }); return; }
  const range = Math.max(10, Math.hypot(camera.positionWC.x - centre.x, camera.positionWC.y - centre.y, camera.positionWC.z - centre.z));
  camera.flyToBoundingSphere(new BoundingSphere(centre, 0), { offset: new HeadingPitchRange(0, camera.pitch, range), duration: 0.6 });
}

/**
 * Compass on the map: the needle points to north on screen, turning as the
 * map is rotated, with the direction the camera looks written under it.
 * Click to turn the map back to north-up.
 */
export const MapCompass: React.FC = () => {
  const heading = useCameraHeading();
  const deg = normaliseDeg((heading * 180) / Math.PI);
  const northUp = Math.min(deg, 360 - deg) < 1;
  return (
    <button
      type="button"
      onClick={resetNorthUp}
      data-testid="map-compass"
      data-heading={Math.round(deg)}
      title={northUp ? 'North is up' : `Looking ${compassShort(deg)} (${Math.round(deg)}°). Click to turn north up`}
      aria-label={`Compass: looking ${compassShort(deg)}, ${Math.round(deg)} degrees. Click to turn north up`}
      className="h-16 w-16 rounded-full bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-xl shadow-black/40 flex flex-col items-center justify-center gap-0.5 cursor-pointer hover:border-white/25 transition pointer-events-auto"
    >
      <svg viewBox="-22 -22 44 44" className="h-10 w-10" style={{ transform: `rotate(${-deg}deg)` }} aria-hidden>
        <circle r="20.5" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1.5" />
        {[0, 90, 180, 270].map(t => <line key={t} x1="0" y1="-20.5" x2="0" y2="-17" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" transform={`rotate(${t})`} />)}
        <path d="M0 -11 L4 0 L-4 0 Z" fill="#f43f5e" />
        <path d="M0 11 L4 0 L-4 0 Z" fill="#94a3b8" />
        <circle r="1.6" fill="#0f172a" />
        <text y="-12.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#fecdd3" fontFamily="Inter, sans-serif">N</text>
      </svg>
      <span className="text-[9px] leading-none text-slate-400 tabular-nums">{compassShort(deg)} {Math.round(deg)}°</span>
    </button>
  );
};
