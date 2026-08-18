import { TrafficNetworkBuilder } from './TrafficNetworkBuilder';
import { DemandMatrixCompiler } from './DemandMatrixCompiler';

self.onmessage = (e: MessageEvent) => {
  const { requestId, action, data } = e.data;

  if (action === 'rebuild_network_and_demand') {
    const { roads, buildings, zones, gateways, scenarioId } = data;
    try {
      const builder = new TrafficNetworkBuilder();
      const { network, diagnostics: netDiag } = builder.build(roads);

      const compiler = new DemandMatrixCompiler();
      const { matrix, diagnostics: demandDiag } = compiler.compile(
        network,
        roads,
        buildings,
        zones,
        gateways,
        scenarioId
      );

      // Serialize network (Maps cannot be cloned directly)
      const serializedNetwork = {
        nodes: Array.from(network.nodes.entries()),
        edges: Array.from(network.edges.entries())
      };

      self.postMessage({
        requestId,
        status: 'success',
        result: {
          network: serializedNetwork,
          matrix,
          gatewaySnaps: gateways.map((g: any) => ({ id: g.id, connectedNodeId: g.connectedNodeId })),
          buildingSnaps: buildings.map((b: any) => ({ id: b.id, nearestEdgeId: b.nearestEdgeId, accessNodeId: b.accessNodeId })),
          diagnostics: `${netDiag}\n${demandDiag}`
        }
      });
    } catch (err: any) {
      self.postMessage({
        requestId,
        status: 'error',
        error: err.message || err.toString()
      });
    }
  } else if (action === 'rebuild_demand_only') {
    const { network: serializedNetwork, roads, buildings, zones, gateways, scenarioId } = data;
    try {
      // Rehydrate network maps
      const network = {
        nodes: new Map(serializedNetwork.nodes),
        edges: new Map(serializedNetwork.edges)
      } as any;

      const compiler = new DemandMatrixCompiler();
      const { matrix, diagnostics: demandDiag } = compiler.compile(
        network,
        roads,
        buildings,
        zones,
        gateways,
        scenarioId
      );

      self.postMessage({
        requestId,
        status: 'success',
        result: {
          matrix,
          gatewaySnaps: gateways.map((g: any) => ({ id: g.id, connectedNodeId: g.connectedNodeId })),
          buildingSnaps: buildings.map((b: any) => ({ id: b.id, nearestEdgeId: b.nearestEdgeId, accessNodeId: b.accessNodeId })),
          diagnostics: demandDiag
        }
      });
    } catch (err: any) {
      self.postMessage({
        requestId,
        status: 'error',
        error: err.message || err.toString()
      });
    }
  }
};
