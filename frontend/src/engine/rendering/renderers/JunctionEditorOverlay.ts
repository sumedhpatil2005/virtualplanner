import { Cartesian2, Cartesian3, Color, Entity, LabelStyle, PolygonHierarchy, VerticalOrigin, type Viewer } from 'cesium';
import type { CityObject } from '../../objects/types';
import { junctionLayout } from '../../objects/junctionLayout';
import { GeometryContext } from '../geometry/GeometryContext';

/** Editor-only affordances; the actual asphalt stays in the batched mesh renderer. */
export class JunctionEditorOverlay {
  private viewer: Viewer | null = null;
  private markers: Entity[] = [];
  private ghost: Entity | null = null;
  private approaches: Entity[] = [];
  private context = new GeometryContext(new Map());
  private scene: CityObject[] = [];
  private hoveredRoads = '';

  setViewer(viewer: Viewer) { this.viewer = viewer; }

  sync(objects: CityObject[], editing: boolean, selectedId?: string) {
    if (!this.viewer) return;
    if (objects.length !== this.scene.length || objects.some((o, i) => o !== this.scene[i])) {
      this.scene = objects;
      this.context = new GeometryContext(new Map(objects.map(o => [o.id, o])));
    }
    this.markers.forEach(e => this.viewer!.entities.remove(e));
    this.markers = [];
    if (!editing) { this.clearPreview(); return; }
    for (const j of objects) {
      if (j.type !== 'junction') continue;
      const selected = j.id === selectedId;
      const cs = j.coordinates;
      this.markers.push(this.viewer.entities.add({
        id: `junction_edit_${j.id}`,
        position: Cartesian3.fromDegrees(cs[0], cs[1], (cs[2] || 0) + 1.5),
        point: { pixelSize: selected ? 14 : 10, color: Color.fromCssColorString(selected ? '#fbbf24' : '#22d3ee'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
        label: {
          text: selected ? `${j.name}\n${j.hasSignals ? 'Signalised' : 'Give way'} · ${j.connectedRoads.length} roads` : 'Junction',
          font: '12px Inter, sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -15),
          disableDepthTestDistance: Infinity,
        },
      }));
    }
  }

  preview(point: [number, number, number]) {
    if (!this.viewer) return;
    const [x, y] = point;
    const nearby = this.context.drivablesNear(x - 0.0003, y - 0.0003, x + 0.0003, y + 0.0003);
    const layout = junctionLayout(point, nearby);
    const color = Color.fromCssColorString(layout.valid ? '#22d3ee' : '#fb7185');
    const label = layout.valid ? `Place junction · ${layout.roadIds.length} road${layout.roadIds.length === 1 ? '' : 's'}\nClick to place · Esc to cancel` : 'Move onto a road connection';
    const position = Cartesian3.fromDegrees(x, y, layout.elevation + 1.5);
    const boundary = layout.boundary.map(p => Cartesian3.fromDegrees(p[0], p[1], p[2] + 0.18));
    if (!this.ghost) {
      this.ghost = this.viewer.entities.add({
        id: 'junction_placement_preview', position,
        point: { pixelSize: 17, color, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
        label: { text: label, font: '13px Inter, sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -25), disableDepthTestDistance: Infinity },
        polygon: { hierarchy: new PolygonHierarchy(boundary), perPositionHeight: true, material: color.withAlpha(0.32), show: layout.valid },
        polyline: { positions: boundary.length ? [...boundary, boundary[0]] : [], width: 3, material: color, depthFailMaterial: color, show: layout.valid },
      });
    } else {
      this.ghost.position = position as any;
      this.ghost.point!.color = color as any;
      this.ghost.label!.text = label as any;
      this.ghost.polygon!.hierarchy = new PolygonHierarchy(boundary) as any;
      this.ghost.polygon!.material = color.withAlpha(0.32) as any;
      this.ghost.polygon!.show = layout.valid as any;
      this.ghost.polyline!.positions = (boundary.length ? [...boundary, boundary[0]] : []) as any;
      this.ghost.polyline!.material = color as any;
      this.ghost.polyline!.show = layout.valid as any;
    }
    const key = layout.roadIds.join('|');
    if (key !== this.hoveredRoads) {
      this.approaches.forEach(e => this.viewer!.entities.remove(e));
      this.approaches = [];
      this.hoveredRoads = key;
      for (const road of nearby.filter(r => layout.roadIds.includes(r.id))) {
        this.approaches.push(this.viewer.entities.add({
          polyline: { positions: road.coordinates.map(p => Cartesian3.fromDegrees(p[0], p[1], p[2] + 0.2)), width: 4, material: Color.CYAN.withAlpha(0.65), depthFailMaterial: Color.CYAN.withAlpha(0.35) },
        }));
      }
    }
    this.viewer.scene.requestRender();
  }

  clearPreview() {
    if (this.ghost) this.viewer?.entities.remove(this.ghost);
    this.ghost = null;
    this.approaches.forEach(e => this.viewer?.entities.remove(e));
    this.approaches = [];
    this.hoveredRoads = '';
  }

  dispose() {
    this.clearPreview();
    this.markers.forEach(e => this.viewer?.entities.remove(e));
    this.markers = [];
    this.viewer = null;
    this.scene = [];
  }
}
