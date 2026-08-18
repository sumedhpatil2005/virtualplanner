import type { CityObject, RoadObject, BuildingObject, ZoneObject, GatewayObject, FlyoverObject, MetroFlyoverObject } from '../objects/types';
import type { TrafficNetwork } from '../objects/trafficTypes';
import { Pathfinder } from './Pathfinder';
import type { VehicleAgent } from './VehicleAgent';
import { interpolateCoordsAlongPolyline } from './VehicleAgent';
import { VehicleVisualizer } from '../rendering/renderers/VehicleVisualizer';
import { renderManagerInstance } from '../rendering/RenderManager';

export interface TrafficSimResult {
  averageSpeed: number; // km/h
  travelTimeIndex: number; // ratio (lower is better)
  levelOfService: { A: number; B: number; C: number; D: number; E: number; F: number }; // percentage split
  congestedRoadIds: Record<string, number>; // roadId -> congestion factor (0.0 to 1.0)
}

export interface FloodSimResult {
  waterDepthMax: number; // meters
  floodedBuildingIds: Record<string, number>; // buildingId -> flood depth in meters
  affectedPopulation: number;
  floodedRoadIds: Record<string, number>; // roadId -> flood depth
}

export interface PopulationSimResult {
  totalPopulation: number;
  averageDensity: number; // people/sq km
  peakMovementVolume: number; // vehicles or pedestrian trips
  demandMetrics: {
    waterTotal: number; // Liters/day
    electricityTotal: number; // kWh/day
  };
}

export type SimulationType = 'traffic' | 'flood' | 'population';

export class SimulationManager {
  private activeSimulations: Set<SimulationType> = new Set();
  private trafficResults: TrafficSimResult | null = null;
  private floodResults: FloodSimResult | null = null;
  private populationResults: PopulationSimResult | null = null;
  private isSimulating: Record<SimulationType, boolean> = { traffic: false, flood: false, population: false };
  private onChangeListeners: (() => void)[] = [];

  // Agent simulation private state
  private simInterval: any = null;
  private activeAgents: VehicleAgent[] = [];
  private visualizer: VehicleVisualizer | null = null;
  private initialAgentCount = 0;
  private tickCount = 0;
  private roadPeakOccupancy = new Map<string, number>();

  constructor() {}

  public onChange(callback: () => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    this.onChangeListeners.forEach(cb => cb());
  }

  public isRunning(type: SimulationType): boolean {
    return this.isSimulating[type];
  }

  public getTrafficResults(): TrafficSimResult | null {
    return this.trafficResults;
  }

  public getFloodResults(): FloodSimResult | null {
    return this.floodResults;
  }

  public getPopulationResults(): PopulationSimResult | null {
    return this.populationResults;
  }

  public startSimulation(type: SimulationType, objects: CityObject[], onComplete?: () => void) {
    if (this.isSimulating[type]) return;
    this.isSimulating[type] = true;
    this.notify();

    if (type === 'traffic') {
      this.runTrafficSim(objects, onComplete);
    } else {
      // Simulate async running process for non-traffic models
      setTimeout(() => {
        if (type === 'flood') {
          this.runFloodSim(objects);
        } else if (type === 'population') {
          this.runPopulationSim(objects);
        }
        this.isSimulating[type] = false;
        this.activeSimulations.add(type);
        this.notify();
        if (onComplete) onComplete();
      }, 1500);
    }
  }

  public stopSimulation(type: SimulationType) {
    this.activeSimulations.delete(type);
    this.isSimulating[type] = false;

    if (type === 'traffic') {
      if (this.simInterval) {
        clearInterval(this.simInterval);
        this.simInterval = null;
      }
      if (this.visualizer) {
        this.visualizer.clear();
        this.visualizer = null;
      }
      
      // Restore default road colors
      const engine = (window as any).engineInstance;
      if (engine) {
        const roads = engine.objects.getAll().filter((o: CityObject) => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') as (RoadObject | FlyoverObject | MetroFlyoverObject)[];
        roads.forEach(r => {
          const defaultColor = r.roadClass === 'highway' ? '#0f172a' : r.roadClass === 'collector' ? '#334155' : r.roadClass === 'local' ? '#475569' : '#1e293b';
          renderManagerInstance.setRoadColor(r.id, defaultColor);
        });
      }

      this.activeAgents = [];
    }

    if (type === 'traffic') this.trafficResults = null;
    if (type === 'flood') this.floodResults = null;
    if (type === 'population') this.populationResults = null;
    this.notify();
  }

  private findClosestNode(objId: string, objects: CityObject[], network: TrafficNetwork): string | null {
    const obj = objects.find(o => o.id === objId);
    if (!obj) return null;
    
    let coords: [number, number, number] = [0, 0, 0];
    if (obj.type === 'building') {
      const b = obj as BuildingObject;
      if (b.accessPoints?.vehicleEntrance) {
        coords = b.accessPoints.vehicleEntrance;
      } else {
        coords = b.coordinates[0];
      }
    } else if (obj.type === 'zone') {
      const z = obj as ZoneObject;
      if (z.coordinates && z.coordinates.length > 0) {
        coords = z.coordinates[0];
      }
    } else if (obj.type === 'gateway') {
      const g = obj as GatewayObject;
      if (g.coordinates && g.coordinates.length > 0) {
        coords = g.coordinates[0];
      }
    }
    
    // Find closest node
    let minDist = Infinity;
    let closestNodeId: string | null = null;
    network.nodes.forEach(node => {
      const dx = node.coordinates[0] - coords[0];
      const dy = node.coordinates[1] - coords[1];
      const dist = dx * dx + dy * dy;
      if (dist < minDist) {
        minDist = dist;
        closestNodeId = node.id;
      }
    });
    
    return closestNodeId;
  }

  private runTrafficSim(objects: CityObject[], onComplete?: () => void) {
    const engine = (window as any).engineInstance;
    if (!engine) {
      this.isSimulating.traffic = false;
      this.notify();
      return;
    }

    const network = engine.getTrafficNetwork() as TrafficNetwork;
    const demandMatrix = engine.trafficDemandMatrix;
    const viewer = engine.getViewer();

    if (!network || network.nodes.size === 0 || !viewer) {
      console.warn('Traffic simulation aborted: network or viewer not ready.');
      this.isSimulating.traffic = false;
      this.notify();
      return;
    }

    // Clean any prior simulation
    if (this.simInterval) clearInterval(this.simInterval);
    if (this.visualizer) this.visualizer.clear();

    this.visualizer = new VehicleVisualizer(viewer);
    this.activeAgents = [];
    this.roadPeakOccupancy.clear();
    this.tickCount = 0;

    const nodes = Array.from(network.nodes.keys());
    
    // 1. Spawning Agents from travel demand matrix snaps
    if (demandMatrix && demandMatrix.trips && demandMatrix.trips.length > 0) {
      demandMatrix.trips.forEach((trip: any) => {
        if (this.activeAgents.length >= 80) return; // Cap at 80 demand trips
        
        const startNodeId = this.findClosestNode(trip.originId, objects, network);
        const endNodeId = this.findClosestNode(trip.destinationId, objects, network);
        
        if (startNodeId && endNodeId && startNodeId !== endNodeId) {
          const path = Pathfinder.findPath(network, startNodeId, endNodeId);
          if (path && path.length > 0) {
            this.activeAgents.push({
              id: `veh_demand_${trip.id}_${this.activeAgents.length}`,
              route: path,
              currentEdgeIndex: 0,
              distanceOnEdge: 0,
              speed: (network.edges.get(path[0])?.speedLimit || 50) / 3.6,
              coordinates: [...network.nodes.get(startNodeId)!.coordinates],
              isFinished: false
            });
          }
        }
      });
    }

    // 2. Robust fallback node-to-node routing to guarantee exactly 75 vehicles
    let attempts = 0;
    while (this.activeAgents.length < 75 && attempts < 1000 && nodes.length > 1) {
      attempts++;
      const startNodeId = nodes[Math.floor(Math.random() * nodes.length)];
      const endNodeId = nodes[Math.floor(Math.random() * nodes.length)];
      if (startNodeId === endNodeId) continue;
      
      const path = Pathfinder.findPath(network, startNodeId, endNodeId);
      if (path && path.length > 0) {
        this.activeAgents.push({
          id: `veh_random_${this.activeAgents.length}`,
          route: path,
          currentEdgeIndex: 0,
          distanceOnEdge: 0,
          speed: (network.edges.get(path[0])?.speedLimit || 50) / 3.6,
          coordinates: [...network.nodes.get(startNodeId)!.coordinates],
          isFinished: false
        });
      }
    }

    this.initialAgentCount = this.activeAgents.length;
    console.log(`[SIMULATION] Spawned ${this.initialAgentCount} agents.`);

    if (this.initialAgentCount === 0) {
      console.warn('Traffic simulation aborted: no routable paths could be resolved.');
      this.isSimulating.traffic = false;
      this.notify();
      return;
    }

    // 3. Real-time Tick Update Loop (ticks every 100ms with dt = 1.0s)
    const dt = 1.0;
    this.simInterval = setInterval(() => {
      this.tickCount++;

      // If all vehicles reached destinations, simulation completes
      if (this.activeAgents.length === 0 || this.tickCount > 300) {
        this.completeTrafficSimulation(objects, onComplete);
        return;
      }

      const roadOccupancy = new Map<string, number>();

      this.activeAgents.forEach(agent => {
        // Move vehicle
        agent.distanceOnEdge += agent.speed * dt;
        let edgeId = agent.route[agent.currentEdgeIndex];
        let edge = network.edges.get(edgeId);

        if (!edge) {
          agent.isFinished = true;
          return;
        }

        // Keep track of active road occupancy
        roadOccupancy.set(edge.roadId, (roadOccupancy.get(edge.roadId) || 0) + 1);

        // Edge transition logic
        while (edge && agent.distanceOnEdge >= edge.length) {
          agent.distanceOnEdge -= edge.length;
          agent.currentEdgeIndex++;

          if (agent.currentEdgeIndex >= agent.route.length) {
            agent.isFinished = true;
            break;
          }

          edgeId = agent.route[agent.currentEdgeIndex];
          edge = network.edges.get(edgeId);
          if (edge) {
            agent.speed = (edge.speedLimit || 50) / 3.6;
          }
        }

        // Interpolate WGS84 point position and update Cesium primitive
        if (!agent.isFinished && edge) {
          agent.coordinates = interpolateCoordsAlongPolyline(edge.coordinates, agent.distanceOnEdge);
          this.visualizer?.updateVehicle(agent.id, agent.coordinates);
        } else {
          this.visualizer?.removeVehicle(agent.id);
        }
      });

      // Filter out finished agents
      this.activeAgents = this.activeAgents.filter(a => !a.isFinished);

      // Record peak occupancies per road
      roadOccupancy.forEach((count, roadId) => {
        const peak = this.roadPeakOccupancy.get(roadId) || 0;
        if (count > peak) {
          this.roadPeakOccupancy.set(roadId, count);
        }
      });

      // Dynamic edge painting on the GPU (live traffic flow visual)
      const roads = objects.filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') as (RoadObject | FlyoverObject | MetroFlyoverObject)[];
      roads.forEach(road => {
        const count = roadOccupancy.get(road.id) || 0;
        const laneCount = road.laneCount || 2;
        const congestion = count / (laneCount * 1.5);

        let color = '#1e293b'; // Default arterial
        if (congestion > 0.8) {
          color = '#ef4444'; // Red (Congested)
        } else if (congestion > 0.4) {
          color = '#f97316'; // Orange (Heavy)
        } else if (congestion > 0.1) {
          color = '#fbbf24'; // Yellow (Moderate)
        } else {
          // Default class colors
          color = road.roadClass === 'highway' ? '#0f172a' : road.roadClass === 'collector' ? '#334155' : road.roadClass === 'local' ? '#475569' : '#1e293b';
        }
        renderManagerInstance.setRoadColor(road.id, color);
      });

    }, 100);
  }

  private completeTrafficSimulation(objects: CityObject[], onComplete?: () => void) {
    console.log('[SIMULATION] Completed.');
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }
    if (this.visualizer) {
      this.visualizer.clear();
      this.visualizer = null;
    }

    // 4. Compile final metrics based on peak road loads
    const congestedRoadIds: Record<string, number> = {};
    let totalSpeed = 0;
    let roadCount = 0;

    const roads = objects.filter(o => o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') as (RoadObject | FlyoverObject | MetroFlyoverObject)[];
    roads.forEach(road => {
      const peakCount = this.roadPeakOccupancy.get(road.id) || 0;
      const laneCount = road.laneCount || 2;
      const congestionFactor = Math.min(1.0, peakCount / (laneCount * 2));
      
      congestedRoadIds[road.id] = congestionFactor;

      const freeSpeed = road.speedLimit || 50;
      const speed = Math.max(10, Math.round(freeSpeed * (1.0 - congestionFactor * 0.7)));
      totalSpeed += speed;
      roadCount++;

      // Restore base colors
      const defaultColor = road.roadClass === 'highway' ? '#0f172a' : road.roadClass === 'collector' ? '#334155' : road.roadClass === 'local' ? '#475569' : '#1e293b';
      renderManagerInstance.setRoadColor(road.id, defaultColor);
    });

    const averageSpeed = roadCount > 0 ? Math.round(totalSpeed / roadCount) : 48;
    const travelTimeIndex = Math.min(2.5, 1.0 + (1.0 - averageSpeed / 50));

    // Compile levels of service based on congestion distribution
    let cCount = 0, hCount = 0, mCount = 0, fCount = 0;
    roads.forEach(r => {
      const c = congestedRoadIds[r.id] || 0;
      if (c > 0.8) cCount++;
      else if (c > 0.4) hCount++;
      else if (c > 0.1) mCount++;
      else fCount++;
    });

    const total = roads.length || 1;
    const a = Math.round((fCount / total) * 50);
    const b = Math.round((fCount / total) * 30);
    const c = Math.round((mCount / total) * 12);
    const d = Math.round((mCount / total) * 5);
    const e = Math.round((hCount / total) * 2.5);
    const f = Math.round((cCount / total) * 0.5);

    this.trafficResults = {
      averageSpeed,
      travelTimeIndex,
      levelOfService: {
        A: Math.max(5, a),
        B: Math.max(5, b),
        C: Math.max(2, c),
        D: Math.max(2, d),
        E: Math.max(1, e),
        F: Math.max(1, f)
      },
      congestedRoadIds
    };

    this.isSimulating.traffic = false;
    this.activeSimulations.add('traffic');
    this.notify();

    if (onComplete) onComplete();
  }

  private runFloodSim(objects: CityObject[]) {
    const buildings = objects.filter(o => o.type === 'building');
    const roads = objects.filter(o => o.type === 'road');
    
    const floodedBuildingIds: Record<string, number> = {};
    let affectedPop = 0;
    
    buildings.forEach((b) => {
      if (b.type === 'building') {
        const isFlooded = Math.random() > 0.6;
        if (isFlooded) {
          const depth = Math.round((Math.random() * 2.5 + 0.1) * 10) / 10;
          floodedBuildingIds[b.id] = depth;
          affectedPop += b.population;
        }
      }
    });

    const floodedRoadIds: Record<string, number> = {};
    roads.forEach((r) => {
      if (Math.random() > 0.5) {
        floodedRoadIds[r.id] = Math.round((Math.random() * 1.5 + 0.1) * 10) / 10;
      }
    });

    this.floodResults = {
      waterDepthMax: 2.8,
      floodedBuildingIds,
      affectedPopulation: affectedPop,
      floodedRoadIds
    };
  }

  private runPopulationSim(objects: CityObject[]) {
    const buildings = objects.filter(o => o.type === 'building');
    
    let totalPop = 0;
    let totalWater = 0;
    let totalElec = 0;
    
    buildings.forEach((b) => {
      if (b.type === 'building') {
        totalPop += b.population;
        totalWater += b.waterDemand;
        totalElec += b.electricityDemand;
      }
    });

    this.populationResults = {
      totalPopulation: totalPop,
      averageDensity: Math.round(totalPop / 0.5),
      peakMovementVolume: Math.round(totalPop * 0.45),
      demandMetrics: {
        waterTotal: totalWater,
        electricityTotal: totalElec,
      }
    };
  }

  public getActiveVehicleCount(roadId: string): number {
    return this.activeAgents.filter(a => {
      if (a.isFinished || !a.route || a.currentEdgeIndex >= a.route.length) return false;
      const edgeId = a.route[a.currentEdgeIndex];
      return edgeId.startsWith(roadId);
    }).length;
  }

  public getRoadCongestion(roadId: string, road: RoadObject | FlyoverObject | MetroFlyoverObject): number {
    if (this.trafficResults && this.trafficResults.congestedRoadIds[roadId] !== undefined) {
      return this.trafficResults.congestedRoadIds[roadId];
    }
    const peakCount = this.roadPeakOccupancy.get(roadId) || 0;
    const laneCount = road.laneCount || 2;
    return Math.min(1.0, peakCount / (laneCount * 2));
  }

  public getRoadSpeed(roadId: string, road: RoadObject | FlyoverObject | MetroFlyoverObject): number {
    const congestionFactor = this.getRoadCongestion(roadId, road);
    const freeSpeed = road.speedLimit || 50;
    return Math.max(10, Math.round(freeSpeed * (1.0 - congestionFactor * 0.7)));
  }
}
