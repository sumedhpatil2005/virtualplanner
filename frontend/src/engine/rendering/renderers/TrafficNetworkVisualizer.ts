import { Viewer, CustomDataSource, Color, Cartesian3, HeightReference, PolylineArrowMaterialProperty } from 'cesium';
import type { TrafficNetwork } from '../../objects/trafficTypes';

export class TrafficNetworkVisualizer {
  private dataSource: CustomDataSource | null = null;
  private viewer: Viewer | null = null;

  constructor() {
    this.dataSource = new CustomDataSource('traffic-network-debug');
  }

  public setViewer(viewer: Viewer) {
    this.viewer = viewer;
  }

  public clear() {
    if (this.dataSource) {
      this.dataSource.entities.removeAll();
      if (this.viewer && this.viewer.dataSources.contains(this.dataSource)) {
        this.viewer.dataSources.remove(this.dataSource);
      }
    }
  }

  public render(network: TrafficNetwork) {
    this.clear();
    if (!this.viewer || !this.dataSource || !network) return;

    // Render nodes
    network.nodes.forEach(node => {
      let color = Color.YELLOW; // Default/dead-end
      
      const associatedRoads = new Set<string>();
      node.incomingSegments.forEach(eId => {
        const segIdx = eId.indexOf('_seg_');
        if (segIdx !== -1) associatedRoads.add(eId.substring(0, segIdx));
      });
      node.outgoingSegments.forEach(eId => {
        const segIdx = eId.indexOf('_seg_');
        if (segIdx !== -1) associatedRoads.add(eId.substring(0, segIdx));
      });

      const degree = associatedRoads.size;

      // Check roundabout node
      const isRoundabout = node.incomingSegments.some(eId => eId.includes('roundabout')) || 
                           node.outgoingSegments.some(eId => eId.includes('roundabout'));

      if (isRoundabout) {
        color = Color.CYAN; // Roundabout node
      } else if (degree === 1) {
        color = Color.YELLOW; // Dead-end
      } else if (degree === 2) {
        color = Color.GREEN; // Simple link
      } else if (degree === 3) {
        color = Color.ORANGE; // T-junction
      } else if (degree === 4) {
        color = Color.RED; // X-junction
      } else if (degree > 4) {
        color = Color.PURPLE; // Complex junction
      }

      this.dataSource!.entities.add({
        id: `debug_node_${node.id}`,
        name: `Node: ${node.id}`,
        position: Cartesian3.fromDegrees(node.coordinates[0], node.coordinates[1], node.coordinates[2] + 1.0),
        point: {
          pixelSize: 10,
          color: color,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          heightReference: HeightReference.RELATIVE_TO_GROUND
        }
      });
    });

    // Render edges
    network.edges.forEach(edge => {
      const positions = edge.coordinates.map(c => 
        Cartesian3.fromDegrees(c[0], c[1], c[2] + 0.5)
      );

      this.dataSource!.entities.add({
        id: `debug_edge_${edge.id}`,
        name: `Edge: ${edge.id}`,
        polyline: {
          positions: positions,
          width: 3.5,
          material: new PolylineArrowMaterialProperty(Color.WHITE.withAlpha(0.7)),
          clampToGround: false
        }
      });
    });

    this.viewer.dataSources.add(this.dataSource);
  }
}
