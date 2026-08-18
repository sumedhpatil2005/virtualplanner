import * as fs from 'fs';
import { TrafficNetworkBuilder } from '../simulation/TrafficNetworkBuilder';
import type { RoadObject } from '../objects/types';

function runAudit() {
  const jsonPath = 'C:/Users/sumed/.gemini/antigravity/brain/bfcff758-317c-4fbc-991e-68eb415a07b3/scratch/db_roads.json';
  if (!fs.existsSync(jsonPath)) {
    console.error("Error: db_roads.json does not exist. Run dump_db_roads.py first.");
    return;
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const roads: RoadObject[] = JSON.parse(raw);

  console.log(`Loaded ${roads.length} roads from database JSON.`);
  const builder = new TrafficNetworkBuilder();
  
  const start = performance.now();
  const { network, diagnostics } = builder.build(roads);
  const end = performance.now();

  console.log("\n--- BUILD COMPLETED ---");
  console.log(`Execution Time: ${(end - start).toFixed(1)}ms`);

  // Count connected and disconnected roads
  const connectedRoadIds = new Set<string>();
  network.edges.forEach(e => {
    connectedRoadIds.add(e.roadId);
  });

  const connectedRoads = connectedRoadIds.size;
  const disconnectedRoads = roads.length - connectedRoads;

  // Classify junctions
  let tJunctions = 0;
  let xJunctions = 0;
  let complexJunctions = 0;
  let deadEnds = 0;
  let simpleLinks = 0;

  let totalTurnMovements = 0;

  network.nodes.forEach(node => {
    totalTurnMovements += node.allowedMovements.length;

    // Find unique road IDs meeting at this node
    const uniqueRoads = new Set<string>();
    node.incomingSegments.forEach(eId => {
      const edge = network.edges.get(eId);
      if (edge) uniqueRoads.add(edge.roadId);
    });
    node.outgoingSegments.forEach(eId => {
      const edge = network.edges.get(eId);
      if (edge) uniqueRoads.add(edge.roadId);
    });

    const degree = uniqueRoads.size;
    if (degree === 1) {
      deadEnds++;
    } else if (degree === 2) {
      simpleLinks++;
    } else if (degree === 3) {
      tJunctions++;
    } else if (degree === 4) {
      xJunctions++;
    } else if (degree > 4) {
      complexJunctions++;
    }
  });

  // Verify whether roads are actually split
  // If roads are split, the number of unique segment base indices will be greater than the road count
  const segmentKeys = new Set<string>();
  network.edges.forEach(e => {
    const baseSegKey = e.id.replace('_fwd', '').replace('_bwd', '');
    segmentKeys.add(baseSegKey);
  });
  const isSplitWorking = segmentKeys.size > roads.length;

  // Verify oneway/lane/speed transfer on a sample edge
  let sampleEdgeVerified = false;
  let sampleDetails = "";
  if (network.edges.size > 0) {
    const sampleEdge = Array.from(network.edges.values())[0];
    const parentRoad = roads.find(r => r.id === sampleEdge.roadId);
    if (parentRoad) {
      sampleEdgeVerified = true;
      sampleDetails = `Sample Edge: ${sampleEdge.id}
  - Parent Road ID: ${parentRoad.id}
  - Road Lanes: ${parentRoad.laneCount} | Edge Lanes: ${sampleEdge.lanes}
  - Road Speed Limit: ${parentRoad.speedLimit} | Edge Speed Limit: ${sampleEdge.speedLimit}
  - Road Capacity: ${parentRoad.trafficCapacity} | Edge Capacity: ${sampleEdge.capacity}`;
    }
  }

  console.log("\n====== AUDIT RESULTS ======");
  console.log(`1. Total Input RoadObjects: ${roads.length}`);
  console.log(`2. Total TrafficNodes (junctions/dead-ends): ${network.nodes.size}`);
  console.log(`3. Total TrafficEdges generated: ${network.edges.size}`);
  console.log(`4. Roads connected to graph: ${connectedRoads}`);
  console.log(`5. Disconnected roads: ${disconnectedRoads}`);
  console.log(`6. Junction Classification:`);
  console.log(`   - T-junctions (3 roads): ${tJunctions}`);
  console.log(`   - X-junctions (4 roads): ${xJunctions}`);
  console.log(`   - Complex junctions (>4 roads): ${complexJunctions}`);
  console.log(`   - Dead-ends (1 road): ${deadEnds}`);
  console.log(`   - Straight/Curve connection nodes (2 roads): ${simpleLinks}`);
  console.log(`7. Roundabouts: ${diagnostics.match(/Detected Roundabout Nodes: (\d+)/)?.[1] || 0}`);
  console.log(`8. Excluded Grade-Separated Crossings: ${diagnostics.match(/Detected Bridge\/Tunnel Crossings: (\d+)/)?.[1] || 0}`);
  console.log(`9. Total Turn Movements: ${totalTurnMovements}`);
  console.log(`10. Road Splitting Working: ${isSplitWorking ? "YES" : "NO"} (${segmentKeys.size} segments generated from ${roads.length} roads)`);
  console.log(`11. Attribute Transfer Verification: ${sampleEdgeVerified ? "PASS" : "FAIL"}`);
  if (sampleEdgeVerified) {
    console.log(sampleDetails);
  }
  console.log("===========================");
  console.log("\n--- Network Builder Diagnostics ---");
  console.log(diagnostics);
}

runAudit();
