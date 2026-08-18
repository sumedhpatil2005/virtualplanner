import React, { useEffect, useState } from 'react';
import { 
  Settings, 
  Trash2, 
  Users, 
  Droplet, 
  Zap, 
  Compass,
  X
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { CityObject, RoadObject, BuildingObject, JunctionObject, UtilityObject, FlyoverObject, MetroLineObject, MetroStationObject, BuildingCategory, BuildingState, ZoneObject, GatewayObject } from '../engine/objects/types';
import { getFlyoverConnectionStatus } from '../engine/objects/flyoverHelper';

interface PropertiesPanelProps {
  onClose?: () => void;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({ onClose }) => {
  const [selectedObj, setSelectedObj] = useState<CityObject | null>(null);
  const [isEditingBuilding, setIsEditingBuilding] = useState(false);
  const [draftBuilding, setDraftBuilding] = useState<BuildingObject | null>(null);

  const [cityStats, setCityStats] = useState({
    buildingsCount: 0,
    roadsCount: 0,
    junctionsCount: 0,
    totalPopulation: 0,
    totalWater: 0,
    totalElectricity: 0
  });

  // Track state changes in selection & objects
  useEffect(() => {
    const updateSelection = (selectedIds: string[]) => {
      setIsEditingBuilding(false);
      setDraftBuilding(null);
      if (selectedIds.length > 0) {
        const id = selectedIds[0];
        if (id.startsWith('debug_node_') || id.startsWith('debug_edge_')) {
          const net = engineInstance.getTrafficNetwork();
          if (id.startsWith('debug_node_')) {
            const nodeId = id.replace('debug_node_', '');
            const node = net?.nodes.get(nodeId);
            if (node) {
              setSelectedObj({
                id,
                type: 'debug_node' as any,
                name: `Traffic Node: ${nodeId}`,
                layerId: 'simulations',
                scenarioId: 'base',
                coordinates: [node.coordinates],
                properties: node
              } as any);
              return;
            }
          } else {
            const edgeId = id.replace('debug_edge_', '');
            const edge = net?.edges.get(edgeId);
            if (edge) {
              setSelectedObj({
                id,
                type: 'debug_edge' as any,
                name: `Traffic Edge: ${edgeId}`,
                layerId: 'simulations',
                scenarioId: 'base',
                coordinates: edge.coordinates,
                properties: edge
              } as any);
              return;
            }
          }
        }

        const obj = engineInstance.objects.getById(id);
        setSelectedObj(obj ? { ...obj } : null);
      } else {
        setSelectedObj(null);
      }
    };

    const updateStats = () => {
      const all = engineInstance.objects.getAll();
      console.log('DEBUG: All objects in database:', all.map(o => ({ id: o.id, type: o.type, scenarioId: o.scenarioId })));
      const activeScenarioId = engineInstance.scenarios.getActiveScenarioId();
      
      // Filter objects for the active scenario, deduping overrides
      const scenarioObjects = all.filter(obj => {
        const isBaseObj = obj.scenarioId === 'base';
        const isScenarioObj = obj.scenarioId === activeScenarioId;
        if (!isBaseObj && !isScenarioObj) return false;
        
        if (isBaseObj && activeScenarioId !== 'base') {
          const overrideExists = all.some(o => o.id === obj.id && o.scenarioId === activeScenarioId);
          if (overrideExists) return false;
        }
        return true;
      });

      const buildings = scenarioObjects.filter(o => o.type === 'building') as BuildingObject[];
      const roads = scenarioObjects.filter(o => o.type === 'road') as RoadObject[];
      const junctions = scenarioObjects.filter(o => o.type === 'junction') as JunctionObject[];

      setCityStats({
        buildingsCount: buildings.length,
        roadsCount: roads.length,
        junctionsCount: junctions.length,
        totalPopulation: buildings.reduce((acc, b) => acc + b.population, 0),
        totalWater: buildings.reduce((acc, b) => acc + b.waterDemand, 0),
        totalElectricity: buildings.reduce((acc, b) => acc + b.electricityDemand, 0)
      });

      // Also refresh the selected object details if it was updated
      const activeSelection = engineInstance.selection.getSelection();
      if (activeSelection.length > 0) {
        const current = engineInstance.objects.getById(activeSelection[0]);
        if (current) setSelectedObj({ ...current });
      }
    };

    const unsubSelection = engineInstance.selection.onChange(updateSelection);
    const unsubObjects = engineInstance.objects.onChange(updateStats);

    // Initial update
    updateStats();

    return () => {
      unsubSelection();
      unsubObjects();
    };
  }, []);

  const handleUpdateField = (field: string, value: any) => {
    if (!selectedObj) return;

    // Build the updates object
    const updates: Partial<CityObject> = {};
    if (selectedObj.type === 'building') {
      const b = selectedObj as BuildingObject;
      const bUpdates = updates as Partial<BuildingObject>;
      if (field === 'height') {
        bUpdates.height = Number(value);
        bUpdates.floors = Math.max(1, Math.round(Number(value) / 3));
      } else if (field === 'floors') {
        bUpdates.floors = Math.max(1, Number(value));
        bUpdates.height = Number(value) * 3;
      } else if (field === 'population') {
        const f = Number(value);
        bUpdates.floors = f;
        bUpdates.height = f * 3;
      }

      // Re-estimate population and demands based on zoning & floor sizes
      const floors = bUpdates.floors !== undefined ? bUpdates.floors : b.floors;
      const usage = bUpdates.usageType !== undefined ? bUpdates.usageType : b.usageType;
      
      let popFactor = 10;
      let waterFactor = 150;
      let elecFactor = 6;

      if (usage === 'commercial') {
        popFactor = 25;
        waterFactor = 60;
        elecFactor = 15;
      } else if (usage === 'industrial') {
        popFactor = 15;
        waterFactor = 300;
        elecFactor = 40;
      } else if (usage === 'educational') {
        popFactor = 20;
        waterFactor = 45;
        elecFactor = 8;
      }

      bUpdates.population = floors * popFactor;
      bUpdates.waterDemand = bUpdates.population * waterFactor;
      bUpdates.electricityDemand = bUpdates.population * elecFactor;
      bUpdates.parkingSpaces = Math.max(1, Math.round(floors * (usage === 'commercial' ? 8 : 2)));
    } else if (selectedObj.type === 'road') {
      const r = selectedObj as RoadObject;
      const rUpdates = updates as Partial<RoadObject>;
      
      let sections = r.sections ? JSON.parse(JSON.stringify(r.sections)) : engineInstance.objects.synthesizeDefaultSections(r);
      if (!sections || sections.length === 0) {
        sections = engineInstance.objects.synthesizeDefaultSections(r);
      }
      
      const firstSection = sections[0];
      let carriagewayA = firstSection.carriagewayA;
      let carriagewayB = firstSection.carriagewayB;

      let isOneWay = r.isOneWay;
      let laneWidth = r.laneWidth || 3.5;
      let hasDivider = r.hasDivider;
      let dividerWidth = r.dividerWidth || 2.0;
      let hasFootpath = r.hasFootpath;
      let footpathWidth = r.footpathWidth || 1.5;

      if (field === 'isOneWay') {
        isOneWay = Boolean(value);
        rUpdates.isOneWay = isOneWay;
      } else if (field === 'hasDivider') {
        hasDivider = Boolean(value);
        rUpdates.hasDivider = hasDivider;
      } else if (field === 'dividerWidth') {
        dividerWidth = Number(value);
        rUpdates.dividerWidth = dividerWidth;
      } else if (field === 'hasFootpath') {
        hasFootpath = Boolean(value);
        rUpdates.hasFootpath = hasFootpath;
      } else if (field === 'footpathWidth') {
        footpathWidth = Number(value);
        rUpdates.footpathWidth = footpathWidth;
      } else if (field === 'laneWidth') {
        laneWidth = Number(value);
        rUpdates.laneWidth = laneWidth;
      }

      if (field === 'isOneWay') {
        if (isOneWay) {
          carriagewayA.direction = 'forward';
          firstSection.carriagewayB = undefined;
          carriagewayB = undefined;
        } else {
          carriagewayA.direction = 'both';
          const defaultBwdLanes = 1;
          firstSection.carriagewayB = {
            direction: 'backward',
            lanes: defaultBwdLanes,
            laneWidth,
            leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
            rightRoadside: { footpathWidth: hasFootpath ? footpathWidth : 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
          };
          carriagewayB = firstSection.carriagewayB;
        }
      } else if (field === 'lanesForward') {
        carriagewayA.lanes = Math.max(1, Number(value));
      } else if (field === 'lanesBackward') {
        if (isOneWay) {
          firstSection.carriagewayB = undefined;
          carriagewayB = undefined;
        } else {
          if (!carriagewayB) {
            firstSection.carriagewayB = {
              direction: 'backward',
              lanes: Math.max(1, Number(value)),
              laneWidth,
              leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
              rightRoadside: { footpathWidth: hasFootpath ? footpathWidth : 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
            };
            carriagewayB = firstSection.carriagewayB;
          } else {
            carriagewayB.lanes = Math.max(1, Number(value));
          }
        }
      }

      carriagewayA.laneWidth = laneWidth;
      if (carriagewayB) carriagewayB.laneWidth = laneWidth;

      firstSection.hasMedian = hasDivider && !isOneWay;
      firstSection.medianWidth = firstSection.hasMedian ? dividerWidth : 0;

      carriagewayA.leftRoadside.footpathWidth = hasFootpath ? footpathWidth : 0;
      if (carriagewayB) {
        carriagewayB.rightRoadside.footpathWidth = hasFootpath ? footpathWidth : 0;
        carriagewayA.rightRoadside.footpathWidth = 0;
      } else {
        carriagewayA.rightRoadside.footpathWidth = hasFootpath ? footpathWidth : 0;
      }

      const laneCount = carriagewayA.lanes + (carriagewayB?.lanes || 0);
      rUpdates.laneCount = laneCount;
      rUpdates.sections = sections;

      const totalLanesWidth = (carriagewayA.lanes * laneWidth) + (carriagewayB ? carriagewayB.lanes * laneWidth : 0);
      const medianWidth = firstSection.hasMedian ? dividerWidth : 0;
      const leftFootpath = carriagewayA.leftRoadside.footpathWidth || 0;
      const rightFootpath = carriagewayB ? (carriagewayB.rightRoadside.footpathWidth || 0) : (carriagewayA.rightRoadside.footpathWidth || 0);
      rUpdates.width = totalLanesWidth + medianWidth + leftFootpath + rightFootpath;
      rUpdates.trafficCapacity = laneCount * 1000;

      rUpdates.laneWidth = laneWidth;
      rUpdates.hasDivider = hasDivider && !isOneWay;
      rUpdates.dividerWidth = rUpdates.hasDivider ? dividerWidth : 0;
      rUpdates.hasFootpath = hasFootpath;
      rUpdates.footpathWidth = footpathWidth;

      if (field === 'speedLimit' || field === 'trafficCapacity') {
        (rUpdates as any)[field] = Number(value);
      } else if (field === 'roadClass' || field === 'name') {
        (rUpdates as any)[field] = value;
      }
    } else if (selectedObj.type === 'flyover' || selectedObj.type === 'metro_flyover') {
      const f = selectedObj as any;
      const fUpdates = updates as any;
      
      let laneCount = f.laneCount;
      let laneWidth = f.laneWidth || 3.5;
      let hasDivider = f.hasDivider;
      let dividerWidth = f.dividerWidth || 2.0;
      let hasFootpath = f.hasFootpath;
      let footpathWidth = f.footpathWidth || 1.5;

      if (field === 'laneCount') laneCount = Number(value);
      else if (field === 'laneWidth') laneWidth = Number(value);
      else if (field === 'hasDivider') hasDivider = Boolean(value);
      else if (field === 'dividerWidth') dividerWidth = Number(value);
      else if (field === 'hasFootpath') hasFootpath = Boolean(value);
      else if (field === 'footpathWidth') footpathWidth = Number(value);
      else if (field === 'elevation' || field === 'pierSpacing') {
        (fUpdates as any)[field] = Number(value);
      }

      fUpdates.laneCount = laneCount;
      fUpdates.laneWidth = laneWidth;
      fUpdates.hasDivider = hasDivider;
      fUpdates.dividerWidth = dividerWidth;
      fUpdates.hasFootpath = hasFootpath;
      fUpdates.footpathWidth = footpathWidth;

      const asphaltWidth = (laneCount * laneWidth) + (hasDivider ? dividerWidth : 0);
      fUpdates.width = asphaltWidth + (hasFootpath ? footpathWidth * 2 : 0);

      if (field === 'speedLimit') {
        fUpdates.speedLimit = Number(value);
      } else if (field === 'isOneWay') {
        fUpdates.isOneWay = Boolean(value);
      } else if (field === 'roadClass' || field === 'name') {
        (fUpdates as any)[field] = value;
      }
    } else if (selectedObj.type === 'metro_line') {
      const mUpdates = updates as Partial<MetroLineObject>;
      if (field === 'trackCount' || field === 'trackGauge' || field === 'deckWidth' || field === 'elevation' || field === 'pierSpacing') {
        (mUpdates as any)[field] = Number(value);
      } else if (field === 'name') {
        mUpdates.name = value;
      }
    } else if (selectedObj.type === 'metro_station') {
      const sUpdates = updates as Partial<MetroStationObject>;
      if (field === 'length' || field === 'width' || field === 'height' || field === 'elevation' || field === 'capacity') {
        (sUpdates as any)[field] = Number(value);
      } else if (field === 'name' || field === 'stationName') {
        (sUpdates as any)[field] = value;
      }
    } else if (selectedObj.type === 'junction') {
      const jUpdates = updates as Partial<JunctionObject>;
      if (field === 'signalTiming') {
        jUpdates.signalTiming = Number(value);
      } else if (field === 'hasSignals') {
        jUpdates.hasSignals = Boolean(value);
      } else if (field === 'hasPedestrianCrossing') {
        jUpdates.hasPedestrianCrossing = Boolean(value);
      } else if (field === 'name') {
        jUpdates.name = value;
      }
    } else if (selectedObj.type === 'utility') {
      const uUpdates = updates as Partial<UtilityObject>;
      if (field === 'depth' || field === 'capacity') {
        (uUpdates as any)[field] = Number(value);
      } else if (field === 'name') {
        uUpdates.name = value;
      }
    } else if (selectedObj.type === 'zone') {
      const zUpdates = updates as Partial<ZoneObject>;
      if (field === 'name') {
        zUpdates.name = value;
      } else if (field === 'totalPopulation' || field === 'totalEmployment') {
        (zUpdates as any)[field] = Number(value);
      } else if (field === 'landUseMix') {
        zUpdates.landUseMix = value;
      }
    } else if (selectedObj.type === 'gateway') {
      const gwUpdates = updates as Partial<GatewayObject>;
      if (field === 'name' || field === 'connectedNodeId') {
        (gwUpdates as any)[field] = value;
      } else if (field === 'inboundFlows' || field === 'outboundFlows' || field === 'modeSplit') {
        (gwUpdates as any)[field] = value;
      }
    }

    // Apply & trigger updates
    const merged = { ...selectedObj, ...updates } as CityObject;
    setSelectedObj(merged);
    engineInstance.objects.update(selectedObj.id, updates);
  };

  const handleDelete = () => {
    if (!selectedObj) return;
    engineInstance.objects.delete(selectedObj.id);
    engineInstance.selection.clearSelection();
  };

  return (
    <div className="w-80 glass-panel rounded-2xl flex flex-col h-full pointer-events-auto shadow-2xl border border-white/5 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-white/5 bg-slate-900/40 flex items-center justify-between">
        <h3 className="font-semibold text-slate-200 flex items-center gap-2 text-sm tracking-wide uppercase">
          <Settings size={15} className="text-indigo-400" />
          {selectedObj ? 'Object Properties' : 'City Analytics'}
        </h3>
        <div className="flex items-center gap-1.5">
          {selectedObj && (
            <button 
              onClick={handleDelete}
              title="Delete Object"
              className="p-1 rounded bg-red-950/40 text-red-400 hover:bg-red-900/60 border border-red-500/10 cursor-pointer transition mr-1"
            >
              <Trash2 size={14} />
            </button>
          )}
          {onClose && (
            <button 
              onClick={onClose}
              title="Collapse Panel"
              className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800/40 cursor-pointer transition"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {selectedObj ? (
          <div className="space-y-4">
            {/* Identity Group */}
            <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-2">
              <div className="flex justify-between items-center text-[10px] text-indigo-400 uppercase font-mono">
                <span>{selectedObj.type} ID: {selectedObj.id.slice(0, 8)}</span>
                <span className="bg-indigo-950/80 px-2 py-0.5 rounded text-[9px] border border-indigo-500/20">
                  {selectedObj.scenarioId === 'base' ? 'BASE STATE' : 'PROPOSED STATE'}
                </span>
              </div>
              <input 
                type="text" 
                value={isEditingBuilding && draftBuilding ? draftBuilding.name : selectedObj.name}
                disabled={selectedObj.type === 'building' && !isEditingBuilding}
                onChange={(e) => {
                  if (selectedObj.type === 'building') {
                    if (draftBuilding) setDraftBuilding({ ...draftBuilding, name: e.target.value });
                  } else {
                    handleUpdateField('name', e.target.value);
                  }
                }}
                className="w-full bg-slate-900/80 border border-slate-700/50 rounded-lg p-2 text-sm text-slate-100 font-medium focus:outline-none focus:border-indigo-500 disabled:opacity-80"
              />
            </div>

            {/* Building Specifics */}
            {selectedObj.type === 'building' && (
              isEditingBuilding && draftBuilding ? (
                <BuildingEditorDraft 
                  draft={draftBuilding}
                  onUpdateDraft={(updated) => setDraftBuilding({ ...draftBuilding, ...updated })}
                  onSave={() => {
                    const finalObject = {
                      ...draftBuilding,
                      isManuallyEdited: true,
                      source: draftBuilding.source === 'OSM' ? 'OSM' : draftBuilding.source || 'manual',
                      updatedAt: new Date().toISOString()
                    } as BuildingObject;
                    
                    engineInstance.objects.update(selectedObj.id, finalObject);
                    setSelectedObj(finalObject);
                    setIsEditingBuilding(false);
                    setDraftBuilding(null);
                  }}
                  onCancel={() => {
                    setIsEditingBuilding(false);
                    setDraftBuilding(null);
                  }}
                />
              ) : (
                <BuildingInspector 
                  b={selectedObj as BuildingObject}
                  onEdit={() => {
                    setDraftBuilding(JSON.parse(JSON.stringify(selectedObj)));
                    setIsEditingBuilding(true);
                  }}
                />
              )
            )}

            {(selectedObj.type === 'road' || selectedObj.type === 'flyover' || selectedObj.type === 'metro_flyover') && (
              <RoadEditor r={selectedObj as any} onUpdate={handleUpdateField} isFlyover={selectedObj.type === 'flyover' || selectedObj.type === 'metro_flyover'} />
            )}

            {/* Metro Line Specifics */}
            {selectedObj.type === 'metro_line' && (
              <MetroLineEditor m={selectedObj as MetroLineObject} onUpdate={handleUpdateField} />
            )}

            {/* Metro Station Specifics */}
            {selectedObj.type === 'metro_station' && (
              <MetroStationEditor s={selectedObj as MetroStationObject} onUpdate={handleUpdateField} />
            )}

            {/* Junction Specifics */}
            {selectedObj.type === 'junction' && (
              <JunctionEditor j={selectedObj as JunctionObject} onUpdate={handleUpdateField} />
            )}

            {/* Utility Specifics */}
            {selectedObj.type === 'utility' && (
              <UtilityEditor u={selectedObj as UtilityObject} onUpdate={handleUpdateField} />
            )}

            {/* Zone Specifics */}
            {selectedObj.type === 'zone' && (
              <ZoneEditor z={selectedObj as ZoneObject} onUpdate={handleUpdateField} />
            )}

            {/* Gateway Specifics */}
            {selectedObj.type === 'gateway' && (
              <GatewayEditor g={selectedObj as GatewayObject} onUpdate={handleUpdateField} />
            )}

            {/* Traffic Node Debug Specifics */}
            {selectedObj.type === ('debug_node' as any) && (
              <div className="space-y-4">
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">
                  Traffic Node Details
                </div>
                <div className="bg-slate-900/30 border border-white/5 rounded-xl p-3 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Node ID:</span>
                    <span className="text-slate-100 font-mono select-all">{(selectedObj as any).properties.id}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Coordinates:</span>
                    <span className="text-slate-100 font-mono">
                      {(selectedObj as any).properties.coordinates[0].toFixed(5)}, {(selectedObj as any).properties.coordinates[1].toFixed(5)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">
                    Incoming Segments ({ (selectedObj as any).properties.incomingSegments.length })
                  </div>
                  <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                    {(selectedObj as any).properties.incomingSegments.map((id: string) => (
                      <div key={id} className="bg-slate-900/25 border border-white/5 rounded-lg px-2.5 py-1.5 text-[10px] text-indigo-300 font-mono">
                        {id}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">
                    Outgoing Segments ({ (selectedObj as any).properties.outgoingSegments.length })
                  </div>
                  <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                    {(selectedObj as any).properties.outgoingSegments.map((id: string) => (
                      <div key={id} className="bg-slate-900/25 border border-white/5 rounded-lg px-2.5 py-1.5 text-[10px] text-emerald-300 font-mono">
                        {id}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">
                    Allowed Turn Movements ({ (selectedObj as any).properties.allowedMovements.length })
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                    {(selectedObj as any).properties.allowedMovements.map((move: any, idx: number) => (
                      <div key={idx} className="bg-slate-900/40 border border-white/5 rounded-xl p-2.5 flex flex-col gap-1 text-[10px]">
                        <div className="flex justify-between">
                          <span className="text-slate-400 font-mono">{move.fromSegmentId.split('_seg_')[1] || move.fromSegmentId} &rarr; {move.toSegmentId.split('_seg_')[1] || move.toSegmentId}</span>
                          <span className="font-semibold text-slate-200 capitalize font-mono text-indigo-400">{move.direction}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Traffic Edge Debug Specifics */}
            {selectedObj.type === ('debug_edge' as any) && (
              <div className="space-y-4">
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">
                  Traffic Edge Details
                </div>
                <div className="bg-slate-900/30 border border-white/5 rounded-xl p-3.5 space-y-2.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Edge Segment ID:</span>
                    <span className="text-slate-100 font-mono select-all">{(selectedObj as any).properties.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Parent Road ID:</span>
                    <span className="text-slate-100 font-mono">{(selectedObj as any).properties.roadId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Origin Node:</span>
                    <span className="text-slate-300 font-mono">{(selectedObj as any).properties.fromNodeId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Destination Node:</span>
                    <span className="text-slate-300 font-mono">{(selectedObj as any).properties.toNodeId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Length:</span>
                    <span className="text-slate-100">{(selectedObj as any).properties.length.toFixed(1)} meters</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Lanes:</span>
                    <span className="text-slate-100 font-mono">{(selectedObj as any).properties.lanes}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Direction:</span>
                    <span className="text-slate-100 capitalize">{(selectedObj as any).properties.direction}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Speed Limit:</span>
                    <span className="text-slate-100">{(selectedObj as any).properties.speedLimit} km/h</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Hourly Capacity:</span>
                    <span className="text-slate-100">{(selectedObj as any).properties.capacity} vehicles/hr</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* General Analytics / Stats */
          <div className="space-y-5">
            {/* City Overview */}
            <div className="space-y-3">
              <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest font-mono">
                Asset Registry
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-900/30 border border-white/5 rounded-xl p-3 flex flex-col justify-between">
                  <span className="text-slate-400 text-[10px] font-medium">Buildings</span>
                  <span className="text-slate-100 font-bold text-lg">{cityStats.buildingsCount}</span>
                </div>
                <div className="bg-slate-900/30 border border-white/5 rounded-xl p-3 flex flex-col justify-between">
                  <span className="text-slate-400 text-[10px] font-medium">Roads</span>
                  <span className="text-slate-100 font-bold text-lg">{cityStats.roadsCount}</span>
                </div>
              </div>
            </div>

            {/* Demand Metrics */}
            <div className="space-y-3">
              <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest font-mono">
                Resource Demands
              </div>
              <div className="bg-slate-900/30 border border-white/5 rounded-xl p-4 space-y-3">
                {/* Population */}
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2 text-slate-400 text-xs">
                    <Users size={14} className="text-emerald-400" />
                    <span>Total Population</span>
                  </div>
                  <span className="text-slate-200 font-semibold text-sm">{cityStats.totalPopulation.toLocaleString()}</span>
                </div>
                {/* Water */}
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2 text-slate-400 text-xs">
                    <Droplet size={14} className="text-sky-400" />
                    <span>Water Demand</span>
                  </div>
                  <span className="text-slate-200 font-semibold text-sm">{(cityStats.totalWater / 1000).toFixed(1)} m³/day</span>
                </div>
                {/* Electricity */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-400 text-xs">
                    <Zap size={14} className="text-yellow-400" />
                    <span>Electricity Grid</span>
                  </div>
                  <span className="text-slate-200 font-semibold text-sm">{(cityStats.totalElectricity / 1000).toFixed(1)} MWh/day</span>
                </div>
              </div>
            </div>

            {/* Instruction Callout */}
            <div className="bg-indigo-950/20 border border-indigo-500/20 rounded-xl p-3.5 space-y-1">
              <span className="font-semibold text-indigo-300 text-xs flex items-center gap-1.5">
                <Compass size={13} /> Selection Guide
              </span>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Click on any 3D model, building block, road path, or junction node on the globe map to examine engineering metrics and edit coordinates.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* --- Component Editor panels for building, road, junction, utility --- */

const getBuildingCenter = (coords: [number, number, number][]): [number, number, number] => {
  if (!coords || coords.length === 0) return [73.8567, 18.5204, 0];
  let sumLon = 0;
  let sumLat = 0;
  let sumAlt = 0;
  coords.forEach(c => {
    sumLon += c[0];
    sumLat += c[1];
    sumAlt += c[2] || 0;
  });
  return [sumLon / coords.length, sumLat / coords.length, sumAlt / coords.length];
};

const BuildingInspector: React.FC<{ 
  b: BuildingObject; 
  onEdit: () => void;
}> = ({ b, onEdit }) => {
  const [showTags, setShowTags] = useState(false);
  const originalTags = b.originalOsmTags || {};
  const tagsCount = Object.keys(originalTags).length;

  return (
    <div className="space-y-4">
      {/* Action Header */}
      <div className="flex justify-between items-center bg-slate-950/20 p-2 rounded-lg border border-white/5">
        <span className="text-[10px] text-indigo-400 font-semibold uppercase tracking-wider">Building Info Panel</span>
        <button 
          onClick={onEdit}
          className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold rounded cursor-pointer transition flex items-center gap-1 shadow-md shadow-indigo-950/40"
        >
          Edit Building
        </button>
      </div>

      {/* Basic Metrics Grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-slate-900/40 p-2.5 rounded-lg border border-white/5 flex flex-col">
          <span className="text-[10px] text-slate-400 font-medium uppercase">Category</span>
          <span className="text-slate-100 font-bold capitalize mt-0.5">{b.category || b.usageType || 'Other'}</span>
        </div>
        <div className="bg-slate-900/40 p-2.5 rounded-lg border border-white/5 flex flex-col">
          <span className="text-[10px] text-slate-400 font-medium uppercase">State</span>
          <span className="text-slate-100 font-bold capitalize mt-0.5">{b.state || 'Existing'}</span>
        </div>
        <div className="bg-slate-900/40 p-2.5 rounded-lg border border-white/5 flex flex-col">
          <span className="text-[10px] text-slate-400 font-medium uppercase">Floors / Height</span>
          <span className="text-slate-100 font-bold mt-0.5">{b.floors} floors ({b.height}m)</span>
        </div>
        <div className="bg-slate-900/40 p-2.5 rounded-lg border border-white/5 flex flex-col">
          <span className="text-[10px] text-slate-400 font-medium uppercase">Parking Capacity</span>
          <span className="text-slate-100 font-bold mt-0.5">{b.parkingCapacity ?? b.parkingSpaces ?? 0} cars</span>
        </div>
      </div>

      {/* Capacities */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-2">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Planning Capacities</span>
        <div className="text-xs space-y-1.5">
          {(b.category === 'residential' || !b.category) && (
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-slate-400">Residents:</span>
              <span className="text-slate-200 font-bold">{b.residents ?? b.population}</span>
            </div>
          )}
          {(b.category !== 'residential') && (
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-slate-400">Employees:</span>
              <span className="text-slate-200 font-bold">{b.employees ?? 0}</span>
            </div>
          )}
          {(b.category === 'school' || b.category === 'college') && (
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-slate-400">Students:</span>
              <span className="text-slate-200 font-bold">{b.students ?? 0}</span>
            </div>
          )}
          {(b.category === 'hospital') && (
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-slate-400">Patients:</span>
              <span className="text-slate-200 font-bold">{b.patients ?? 0}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-slate-400">Visitors/Day:</span>
            <span className="text-slate-200 font-bold">{b.visitorsPerDay ?? 10}</span>
          </div>
          {b.nearestEdgeId && (
            <div className="flex justify-between border-t border-white/5 pt-1.5 mt-1.5">
              <span className="text-slate-400 font-semibold">Snapped Edge:</span>
              <span className="text-indigo-400 font-mono font-bold select-all">{b.nearestEdgeId}</span>
            </div>
          )}
          {b.accessNodeId && (
            <div className="flex justify-between">
              <span className="text-slate-400 font-semibold">Access Node:</span>
              <span className="text-indigo-400 font-mono font-bold select-all">{b.accessNodeId}</span>
            </div>
          )}
        </div>
      </div>

      {/* Entrances */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-2">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Building Access Points</span>
        <div className="text-[11px] space-y-1.5 font-mono text-right">
          <div className="flex justify-between items-center">
            <span className="text-slate-400 font-sans text-xs">Main:</span>
            <span className="text-slate-200">
              {b.accessPoints?.mainEntrance ? `[${b.accessPoints.mainEntrance[0].toFixed(5)}, ${b.accessPoints.mainEntrance[1].toFixed(5)}]` : 'Not Set'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-400 font-sans text-xs">Vehicle:</span>
            <span className="text-slate-200">
              {b.accessPoints?.vehicleEntrance ? `[${b.accessPoints.vehicleEntrance[0].toFixed(5)}, ${b.accessPoints.vehicleEntrance[1].toFixed(5)}]` : 'Not Set'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-400 font-sans text-xs">Service:</span>
            <span className="text-slate-200">
              {b.accessPoints?.serviceEntrance ? `[${b.accessPoints.serviceEntrance[0].toFixed(5)}, ${b.accessPoints.serviceEntrance[1].toFixed(5)}]` : 'Not Set'}
            </span>
          </div>
        </div>
      </div>

      {/* Activity Profile */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-2">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Traffic Activity Profile</span>
        {b.activityProfile ? (
          <div className="text-xs space-y-2.5">
            <div className="grid grid-cols-2 gap-2 border-b border-white/5 pb-1.5">
              <div>
                <span className="text-slate-400 block text-[9px] uppercase font-semibold">Peak Arrival</span>
                <span className="text-slate-200 font-semibold">{b.activityProfile.peakArrivalStart || 'N/A'} - {b.activityProfile.peakArrivalEnd || 'N/A'}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[9px] uppercase font-semibold">Peak Departure</span>
                <span className="text-slate-200 font-semibold">{b.activityProfile.peakDepartureStart || 'N/A'} - {b.activityProfile.peakDepartureEnd || 'N/A'}</span>
              </div>
            </div>
            {b.activityProfile.modeSplit && (
              <div>
                <span className="text-slate-400 block text-[9px] uppercase font-semibold mb-1">Mode Split (%)</span>
                <div className="grid grid-cols-3 gap-1 text-[10px]">
                  <div className="bg-slate-950/40 p-1 rounded text-center">
                    <span className="text-slate-400 block text-[8px]">Car</span>
                    <span className="text-indigo-400 font-bold">{b.activityProfile.modeSplit.car || 0}%</span>
                  </div>
                  <div className="bg-slate-950/40 p-1 rounded text-center">
                    <span className="text-slate-400 block text-[8px]">2-W</span>
                    <span className="text-indigo-400 font-bold">{b.activityProfile.modeSplit.twoWheeler || 0}%</span>
                  </div>
                  <div className="bg-slate-950/40 p-1 rounded text-center">
                    <span className="text-slate-400 block text-[8px]">Bus</span>
                    <span className="text-indigo-400 font-bold">{b.activityProfile.modeSplit.bus || 0}%</span>
                  </div>
                  <div className="bg-slate-950/40 p-1 rounded text-center">
                    <span className="text-slate-400 block text-[8px]">Metro</span>
                    <span className="text-indigo-400 font-bold">{b.activityProfile.modeSplit.metro || 0}%</span>
                  </div>
                  <div className="bg-slate-950/40 p-1 rounded text-center">
                    <span className="text-slate-400 block text-[8px]">Walk</span>
                    <span className="text-indigo-400 font-bold">{b.activityProfile.modeSplit.walk || 0}%</span>
                  </div>
                  <div className="bg-slate-950/40 p-1 rounded text-center">
                    <span className="text-slate-400 block text-[8px]">Other</span>
                    <span className="text-indigo-400 font-bold">{b.activityProfile.modeSplit.other || 0}%</span>
                  </div>
                </div>
              </div>
            )}
            
            {/* Generated Peak Trips */}
            <div className="border-t border-white/5 pt-2 space-y-1">
              <span className="text-slate-400 block text-[9px] uppercase font-semibold mb-1">Estimated Peak Trip Generation</span>
              <div className="grid grid-cols-2 gap-1 text-[10px] font-mono">
                <div className="bg-slate-950/20 px-2 py-1 rounded flex justify-between">
                  <span className="text-slate-400">AM Peak:</span>
                  <span className="text-indigo-300 font-bold">
                    {(() => {
                      const isRes = b.category === 'residential' || b.usageType === 'residential';
                      const pop = isRes ? (b.residents ?? b.population ?? 0) : 0;
                      const emp = isRes ? 0 : (b.employees ?? 0);
                      const daily = isRes ? pop * 2.2 : emp * 1.5;
                      return Math.round(daily * 0.35);
                    })()} trips
                  </span>
                </div>
                <div className="bg-slate-950/20 px-2 py-1 rounded flex justify-between">
                  <span className="text-slate-400">PM Peak:</span>
                  <span className="text-indigo-300 font-bold">
                    {(() => {
                      const isRes = b.category === 'residential' || b.usageType === 'residential';
                      const pop = isRes ? (b.residents ?? b.population ?? 0) : 0;
                      const emp = isRes ? 0 : (b.employees ?? 0);
                      const daily = isRes ? pop * 2.2 : emp * 1.5;
                      return Math.round(daily * 0.30);
                    })()} trips
                  </span>
                </div>
                <div className="bg-slate-950/20 px-2 py-1 rounded flex justify-between">
                  <span className="text-slate-400">Midday:</span>
                  <span className="text-indigo-300 font-bold">
                    {(() => {
                      const isRes = b.category === 'residential' || b.usageType === 'residential';
                      const pop = isRes ? (b.residents ?? b.population ?? 0) : 0;
                      const emp = isRes ? 0 : (b.employees ?? 0);
                      const daily = isRes ? pop * 2.2 : emp * 1.5;
                      return Math.round(daily * 0.15);
                    })()} trips
                  </span>
                </div>
                <div className="bg-slate-950/20 px-2 py-1 rounded flex justify-between">
                  <span className="text-slate-400">Night:</span>
                  <span className="text-indigo-300 font-bold">
                    {(() => {
                      const isRes = b.category === 'residential' || b.usageType === 'residential';
                      const pop = isRes ? (b.residents ?? b.population ?? 0) : 0;
                      const emp = isRes ? 0 : (b.employees ?? 0);
                      const daily = isRes ? pop * 2.2 : emp * 1.5;
                      return Math.round(daily * 0.05);
                    })()} trips
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <span className="text-xs text-slate-500 italic block">No custom activity profile set.</span>
        )}
      </div>

      {/* Notes */}
      {b.notes && (
        <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5">
          <span className="text-[10px] text-indigo-400 uppercase font-mono block mb-0.5">Notes</span>
          <p className="text-xs text-slate-300 whitespace-pre-wrap">{b.notes}</p>
        </div>
      )}

      {/* Provenance Metadata */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-[10px] text-indigo-400 uppercase font-mono">Provenance Data</span>
          <span className="text-[9px] bg-slate-800 px-2 py-0.5 rounded text-slate-300 font-semibold border border-white/5 uppercase">
            {b.isManuallyEdited ? 'Manually Edited' : 'Original Data'}
          </span>
        </div>
        <div className="text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-400">Data Source:</span>
            <span className="text-slate-200 capitalize font-medium">{b.source || 'OSM'}</span>
          </div>
          {b.osmId && (
            <div className="flex justify-between">
              <span className="text-slate-400">OSM ID:</span>
              <a 
                href={`https://www.openstreetmap.org/way/${b.osmId}`}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:underline font-mono"
              >
                {b.osmId}
              </a>
            </div>
          )}
        </div>
        
        {/* Expandable Tags */}
        {tagsCount > 0 && (
          <div className="mt-2 pt-2 border-t border-white/5">
            <button 
              onClick={() => setShowTags(!showTags)}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold uppercase flex items-center gap-1 cursor-pointer"
            >
              {showTags ? 'Hide Original Tags' : `Show Original Tags (${tagsCount})`}
            </button>
            {showTags && (
              <div className="mt-2 bg-slate-950/60 p-2 rounded border border-white/5 font-mono text-[9px] text-slate-300 overflow-x-auto max-h-40 overflow-y-auto space-y-1">
                {Object.entries(originalTags).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-indigo-400">{k}:</span>
                    <span className="text-slate-200">"{v}"</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const BuildingEditorDraft: React.FC<{ 
  draft: BuildingObject;
  onUpdateDraft: (updated: Partial<BuildingObject>) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ draft, onUpdateDraft, onSave, onCancel }) => {

  const handleCoordinateChange = (
    type: 'mainEntrance' | 'vehicleEntrance' | 'serviceEntrance', 
    coordIndex: number, 
    val: string
  ) => {
    const num = parseFloat(val);
    const currentPoints = draft.accessPoints || {};
    const currentCoord = currentPoints[type] || [0, 0, 0];
    const newCoord = [...currentCoord] as [number, number, number];
    newCoord[coordIndex] = isNaN(num) ? 0 : num;
    
    onUpdateDraft({
      accessPoints: {
        ...currentPoints,
        [type]: newCoord
      }
    });
  };

  const handleSetToCenter = (type: 'mainEntrance' | 'vehicleEntrance' | 'serviceEntrance') => {
    const center = getBuildingCenter(draft.coordinates);
    onUpdateDraft({
      accessPoints: {
        ...(draft.accessPoints || {}),
        [type]: center
      }
    });
  };

  const handleClearEntrance = (type: 'mainEntrance' | 'vehicleEntrance' | 'serviceEntrance') => {
    const currentPoints = { ...(draft.accessPoints || {}) };
    delete currentPoints[type];
    onUpdateDraft({ accessPoints: currentPoints });
  };

  const handleModeSplitChange = (mode: 'car' | 'twoWheeler' | 'bus' | 'metro' | 'walk' | 'other', val: string) => {
    const num = parseInt(val) || 0;
    const currentProfile = draft.activityProfile || {};
    const currentSplit = currentProfile.modeSplit || {};
    onUpdateDraft({
      activityProfile: {
        ...currentProfile,
        modeSplit: {
          ...currentSplit,
          [mode]: num
        }
      }
    });
  };

  const handleTripGenChange = (field: string, val: string) => {
    const num = parseInt(val) || 0;
    const currentProfile = draft.activityProfile || {};
    const currentGen = currentProfile.tripGeneration || {};
    onUpdateDraft({
      activityProfile: {
        ...currentProfile,
        tripGeneration: {
          ...currentGen,
          [field]: num
        }
      }
    });
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 bg-slate-950/20 p-2 rounded-lg">
        <span className="text-[10px] text-indigo-400 font-bold uppercase">Editing Mode</span>
        <div className="flex gap-1.5">
          <button 
            onClick={onCancel}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold rounded cursor-pointer transition text-[10px]"
          >
            Cancel
          </button>
          <button 
            onClick={onSave}
            className="px-2.5 py-1 bg-green-600 hover:bg-green-500 text-white font-semibold rounded cursor-pointer transition text-[10px]"
          >
            Save
          </button>
        </div>
      </div>

      {/* Category & State */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Category</label>
          <select 
            value={draft.category || 'other'} 
            onChange={(e) => onUpdateDraft({ category: e.target.value as BuildingCategory })}
            className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
          >
            <option value="residential">Residential</option>
            <option value="office">Office</option>
            <option value="IT">IT Block</option>
            <option value="commercial">Commercial</option>
            <option value="retail">Retail</option>
            <option value="industrial">Industrial</option>
            <option value="hospital">Hospital</option>
            <option value="school">School</option>
            <option value="college">College / Univ</option>
            <option value="hotel">Hotel</option>
            <option value="government">Government</option>
            <option value="mixed_use">Mixed Use</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">State</label>
          <select 
            value={draft.state || 'existing'} 
            onChange={(e) => onUpdateDraft({ state: e.target.value as BuildingState })}
            className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
          >
            <option value="existing">Existing</option>
            <option value="under_construction">Under Construction</option>
            <option value="proposed">Proposed</option>
          </select>
        </div>
      </div>

      {/* Height / Floors */}
      <div className="grid grid-cols-2 gap-2 bg-slate-950/40 p-2.5 rounded-lg border border-white/5">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Floors</label>
          <input 
            type="number"
            value={draft.floors}
            onChange={(e) => {
              const f = Math.max(1, parseInt(e.target.value) || 1);
              onUpdateDraft({ floors: f, height: f * 3 });
            }}
            className="bg-slate-900 border border-slate-700/50 rounded-lg p-1.5 text-slate-200 focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Height (m)</label>
          <input 
            type="number"
            value={draft.height}
            onChange={(e) => {
              const h = Math.max(1.0, parseFloat(e.target.value) || 3.0);
              onUpdateDraft({ height: h, floors: Math.max(1, Math.round(h / 3.0)) });
            }}
            className="bg-slate-900 border border-slate-700/50 rounded-lg p-1.5 text-slate-200 focus:outline-none"
          />
        </div>
      </div>

      {/* Specific Capacities */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-3.5">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Capacity Settings</span>
        
        {draft.category === 'residential' && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Residents</label>
            <input 
              type="number"
              value={draft.residents ?? draft.population}
              onChange={(e) => onUpdateDraft({ residents: parseInt(e.target.value) || 0 })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
            />
          </div>
        )}

        {draft.category !== 'residential' && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Employees</label>
            <input 
              type="number"
              value={draft.employees ?? 0}
              onChange={(e) => onUpdateDraft({ employees: parseInt(e.target.value) || 0 })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
            />
          </div>
        )}

        {(draft.category === 'school' || draft.category === 'college') && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Students</label>
            <input 
              type="number"
              value={draft.students ?? 0}
              onChange={(e) => onUpdateDraft({ students: parseInt(e.target.value) || 0 })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
            />
          </div>
        )}

        {draft.category === 'hospital' && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Patients</label>
            <input 
              type="number"
              value={draft.patients ?? 0}
              onChange={(e) => onUpdateDraft({ patients: parseInt(e.target.value) || 0 })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Visitors / Day</label>
            <input 
              type="number"
              value={draft.visitorsPerDay ?? 10}
              onChange={(e) => onUpdateDraft({ visitorsPerDay: parseInt(e.target.value) || 0 })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Parking Cap (cars)</label>
            <input 
              type="number"
              value={draft.parkingCapacity ?? draft.parkingSpaces}
              onChange={(e) => onUpdateDraft({ parkingCapacity: parseInt(e.target.value) || 0 })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Connection / Entrances */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-3">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block font-semibold">Access Coordinates (Lng/Lat)</span>
        
        {(['mainEntrance', 'vehicleEntrance', 'serviceEntrance'] as const).map(type => {
          const coord = draft.accessPoints?.[type] || [0, 0, 0];
          const hasCoord = !!draft.accessPoints?.[type];
          return (
            <div key={type} className="space-y-1 border-b border-white/5 pb-2 last:border-b-0 last:pb-0">
              <div className="flex justify-between items-center text-[10px] text-slate-400 font-semibold uppercase">
                <span>{type.replace('Entrance', ' Entrance')}</span>
                <div className="flex gap-1.5 text-[9px]">
                  <button 
                    onClick={() => handleSetToCenter(type)}
                    className="text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
                  >
                    Use Center
                  </button>
                  {hasCoord && (
                    <button 
                      onClick={() => handleClearEntrance(type)}
                      className="text-red-400 hover:text-red-300 font-medium cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 font-mono">
                <input 
                  type="number"
                  step="0.00001"
                  placeholder="Longitude"
                  value={hasCoord ? coord[0] : ''}
                  onChange={(e) => handleCoordinateChange(type, 0, e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded p-1 text-[11px] text-slate-200 focus:outline-none"
                />
                <input 
                  type="number"
                  step="0.00001"
                  placeholder="Latitude"
                  value={hasCoord ? coord[1] : ''}
                  onChange={(e) => handleCoordinateChange(type, 1, e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded p-1 text-[11px] text-slate-200 focus:outline-none"
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Activity Profile */}
      <div className="bg-slate-900/30 rounded-xl p-3 border border-white/5 space-y-3">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Peak Traffic Hours (HH:MM)</span>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-0.5">
            <label className="text-[9px] text-slate-400 uppercase">Arrival Start</label>
            <input 
              type="text"
              placeholder="e.g. 08:30"
              value={draft.activityProfile?.peakArrivalStart || ''}
              onChange={(e) => onUpdateDraft({
                activityProfile: {
                  ...(draft.activityProfile || {}),
                  peakArrivalStart: e.target.value
                }
              })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-1.5 text-slate-200 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[9px] text-slate-400 uppercase">Arrival End</label>
            <input 
              type="text"
              placeholder="e.g. 09:30"
              value={draft.activityProfile?.peakArrivalEnd || ''}
              onChange={(e) => onUpdateDraft({
                activityProfile: {
                  ...(draft.activityProfile || {}),
                  peakArrivalEnd: e.target.value
                }
              })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-1.5 text-slate-200 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[9px] text-slate-400 uppercase">Departure Start</label>
            <input 
              type="text"
              placeholder="e.g. 17:30"
              value={draft.activityProfile?.peakDepartureStart || ''}
              onChange={(e) => onUpdateDraft({
                activityProfile: {
                  ...(draft.activityProfile || {}),
                  peakDepartureStart: e.target.value
                }
              })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-1.5 text-slate-200 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[9px] text-slate-400 uppercase">Departure End</label>
            <input 
              type="text"
              placeholder="e.g. 18:30"
              value={draft.activityProfile?.peakDepartureEnd || ''}
              onChange={(e) => onUpdateDraft({
                activityProfile: {
                  ...(draft.activityProfile || {}),
                  peakDepartureEnd: e.target.value
                }
              })}
              className="bg-slate-900 border border-slate-700/50 rounded-lg p-1.5 text-slate-200 focus:outline-none"
            />
          </div>
        </div>

        {/* Mode Split */}
        <div className="space-y-1.5">
          <label className="text-[9px] text-slate-400 uppercase font-semibold">Mode Split (%)</label>
          <div className="grid grid-cols-3 gap-1.5">
            {(['car', 'twoWheeler', 'bus', 'metro', 'walk', 'other'] as const).map(mode => (
              <div key={mode} className="flex items-center gap-1.5 bg-slate-950/40 p-1 rounded">
                <span className="text-[9px] text-slate-400 capitalize w-7">{mode === 'twoWheeler' ? '2W' : mode}</span>
                <input 
                  type="number"
                  min="0"
                  max="100"
                  value={draft.activityProfile?.modeSplit?.[mode] ?? 0}
                  onChange={(e) => handleModeSplitChange(mode, e.target.value)}
                  className="bg-transparent text-right font-mono text-[10px] text-indigo-400 w-8 focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Trip Generation */}
        <div className="space-y-1.5 border-t border-white/5 pt-2.5">
          <label className="text-[9px] text-slate-400 uppercase font-semibold">Trip Generation Rates</label>
          <div className="grid grid-cols-3 gap-1.5">
            <div className="flex flex-col bg-slate-950/40 p-1.5 rounded">
              <span className="text-[9px] text-slate-400 block text-center">Daily</span>
              <input 
                type="number"
                value={draft.activityProfile?.tripGeneration?.dailyTrips ?? 0}
                onChange={(e) => handleTripGenChange('dailyTrips', e.target.value)}
                className="bg-transparent text-center font-mono text-[10px] text-slate-200 focus:outline-none w-full mt-0.5"
              />
            </div>
            <div className="flex flex-col bg-slate-950/40 p-1.5 rounded">
              <span className="text-[9px] text-slate-400 block text-center">AM Peak</span>
              <input 
                type="number"
                value={draft.activityProfile?.tripGeneration?.amPeakTrips ?? 0}
                onChange={(e) => handleTripGenChange('amPeakTrips', e.target.value)}
                className="bg-transparent text-center font-mono text-[10px] text-slate-200 focus:outline-none w-full mt-0.5"
              />
            </div>
            <div className="flex flex-col bg-slate-950/40 p-1.5 rounded">
              <span className="text-[9px] text-slate-400 block text-center">PM Peak</span>
              <input 
                type="number"
                value={draft.activityProfile?.tripGeneration?.pmPeakTrips ?? 0}
                onChange={(e) => handleTripGenChange('pmPeakTrips', e.target.value)}
                className="bg-transparent text-center font-mono text-[10px] text-slate-200 focus:outline-none w-full mt-0.5"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Planner Notes</label>
        <textarea 
          value={draft.notes || ''}
          onChange={(e) => onUpdateDraft({ notes: e.target.value })}
          rows={3}
          placeholder="Enter notes about building plans..."
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-slate-200 focus:outline-none resize-none"
        />
      </div>
    </div>
  );
};



const RoadEditor: React.FC<{ r: RoadObject | FlyoverObject; onUpdate: (field: string, val: any) => void; isFlyover?: boolean }> = ({ r, onUpdate, isFlyover }) => {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // If the traffic simulation is actively running, update stats every 500ms
    if (!engineInstance.simulations.isRunning('traffic')) return;
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 500);
    return () => clearInterval(interval);
  }, [tick]);

  const firstSection = r.type === 'road' ? (r as RoadObject).sections && (r as RoadObject).sections![0] : undefined;
  const fwdLanes = firstSection ? firstSection.carriagewayA.lanes : Math.ceil(r.laneCount / (r.isOneWay ? 1 : 2));
  const bwdLanes = firstSection && firstSection.carriagewayB ? firstSection.carriagewayB.lanes : (r.isOneWay ? 0 : Math.floor(r.laneCount / 2));

  const network = engineInstance.getTrafficNetwork();
  const conn = getFlyoverConnectionStatus(r, network);

  const capacity = (r as any).trafficCapacity || (r.laneCount * 1000);
  const activeVehicles = engineInstance.simulations.getActiveVehicleCount(r.id);
  const vcRatio = engineInstance.simulations.getRoadCongestion(r.id, r as any);
  const currentSpeed = engineInstance.simulations.getRoadSpeed(r.id, r as any);

  let congestionState = 'Free Flow';
  if (vcRatio > 0.8) congestionState = 'Severe';
  else if (vcRatio > 0.4) congestionState = 'Heavy';
  else if (vcRatio > 0.1) congestionState = 'Moderate';

  return (
    <div className="space-y-3.5">
      {/* Category Dropdown */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Road Classification</label>
        <select 
          value={r.roadClass} 
          onChange={(e) => onUpdate('roadClass', e.target.value)}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          <option value="highway">Highway</option>
          <option value="arterial">Arterial</option>
          <option value="collector">Collector</option>
          <option value="local">Local</option>
        </select>
      </div>

      {/* Total Lanes Indicator */}
      <div className="flex justify-between items-center bg-slate-950/20 p-2 rounded border border-white/5">
        <span className="text-[11px] text-slate-400 uppercase font-semibold">Total Lanes</span>
        <span className="text-xs font-mono font-bold text-slate-200 bg-indigo-500/20 px-2 py-0.5 rounded border border-indigo-500/30">{r.laneCount}</span>
      </div>

      {/* Forward Lanes */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">
          {r.isOneWay ? "Lanes" : "Lanes (Forward)"}
        </label>
        <select 
          value={fwdLanes} 
          onChange={(e) => onUpdate('lanesForward', Number(e.target.value))}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
        >
          <option value={1}>1 Lane</option>
          <option value={2}>2 Lanes</option>
          <option value={3}>3 Lanes</option>
          <option value={4}>4 Lanes</option>
          <option value={5}>5 Lanes</option>
          <option value={6}>6 Lanes</option>
          <option value={8}>8 Lanes</option>
        </select>
      </div>

      {/* Backward Lanes */}
      {!r.isOneWay && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Lanes (Backward)</label>
          <select 
            value={bwdLanes} 
            onChange={(e) => onUpdate('lanesBackward', Number(e.target.value))}
            className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
          >
            <option value={1}>1 Lane</option>
            <option value={2}>2 Lanes</option>
            <option value={3}>3 Lanes</option>
            <option value={4}>4 Lanes</option>
            <option value={5}>5 Lanes</option>
            <option value={6}>6 Lanes</option>
            <option value={8}>8 Lanes</option>
          </select>
        </div>
      )}

      {/* Lane Width */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Lane Width (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{r.laneWidth || 3.5}m</span>
        </div>
        <input 
          type="range" 
          min={2.5} 
          max={4.5} 
          step={0.1}
          value={r.laneWidth || 3.5}
          onChange={(e) => onUpdate('laneWidth', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Divider Width */}
      {r.hasDivider && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Divider Width (m)</label>
            <span className="text-[10px] text-indigo-400 font-mono">{r.dividerWidth || 2.0}m</span>
          </div>
          <input 
            type="range" 
            min={0.5} 
            max={5.0} 
            step={0.1}
            value={r.dividerWidth || 2.0}
            onChange={(e) => onUpdate('dividerWidth', Number(e.target.value))}
            className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
          />
        </div>
      )}

      {/* Footpath Width */}
      {r.hasFootpath && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center">
            <label className="text-[10px] text-slate-400 uppercase font-semibold">Footpath Width (m)</label>
            <span className="text-[10px] text-indigo-400 font-mono">{r.footpathWidth || 1.5}m</span>
          </div>
          <input 
            type="range" 
            min={0.5} 
            max={3.0} 
            step={0.1}
            value={r.footpathWidth || 1.5}
            onChange={(e) => onUpdate('footpathWidth', Number(e.target.value))}
            className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
          />
        </div>
      )}

      {/* Flyover Specific Controls */}
      {isFlyover && (
        <>
          {/* Deck Elevation */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center">
              <label className="text-[10px] text-slate-400 uppercase font-semibold">Deck Elevation (m)</label>
              <span className="text-[10px] text-indigo-400 font-mono">{(r as any).elevation || 6}m</span>
            </div>
            <input 
              type="range" 
              min={3.0} 
              max={18.0} 
              step={0.5}
              value={(r as any).elevation || 6}
              onChange={(e) => onUpdate('elevation', Number(e.target.value))}
              className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Pier Spacing */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center">
              <label className="text-[10px] text-slate-400 uppercase font-semibold">Column Spacing (m)</label>
              <span className="text-[10px] text-indigo-400 font-mono">{(r as any).pierSpacing || 30}m</span>
            </div>
            <input 
              type="range" 
              min={15.0} 
              max={60.0} 
              step={5.0}
              value={(r as any).pierSpacing || 30}
              onChange={(e) => onUpdate('pierSpacing', Number(e.target.value))}
              className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Metro Elevation for Double Decker */}
          {(r as any).type === 'metro_flyover' && (
            <div className="flex flex-col gap-1 mt-2">
              <div className="flex justify-between items-center">
                <label className="text-[10px] text-slate-400 uppercase font-semibold">Metro Elevation (m)</label>
                <span className="text-[10px] text-indigo-400 font-mono">{(r as any).metroElevation || 12}m</span>
              </div>
              <input 
                type="range" 
                min={8.0} 
                max={25.0} 
                step={0.5}
                value={(r as any).metroElevation || 12}
                onChange={(e) => onUpdate('metroElevation', Number(e.target.value))}
                className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          )}
        </>
      )}

      {/* Speed limit */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Speed Limit (km/h)</label>
        <input 
          type="number" 
          value={r.speedLimit}
          onChange={(e) => onUpdate('speedLimit', Number(e.target.value))}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
        />
      </div>

      {/* Toggle options */}
      <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">One Way Road</span>
          <input 
            type="checkbox" 
            checked={r.isOneWay} 
            onChange={(e) => onUpdate('isOneWay', e.target.checked)}
            className="rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">Central Divider</span>
          <input 
            type="checkbox" 
            checked={r.hasDivider} 
            onChange={(e) => onUpdate('hasDivider', e.target.checked)}
            className="rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">Pedestrian Footpath</span>
          <input 
            type="checkbox" 
            checked={r.hasFootpath} 
            onChange={(e) => onUpdate('hasFootpath', e.target.checked)}
            className="rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
          />
        </div>
      </div>

      {/* Diagnostics Dashboard for Flyovers */}
      {isFlyover && (
        <div className="bg-slate-950/50 p-3 rounded-lg border border-white/5 space-y-2.5 mt-3">
          <div className="text-[11px] text-slate-400 uppercase font-semibold border-b border-white/5 pb-1.5 flex justify-between items-center">
            <span>Diagnostics & Simulation</span>
            <span className="text-[9px] text-indigo-400 font-mono">Real-time</span>
          </div>

          {/* Connection Status */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-400 uppercase font-semibold">Connectivity</span>
            {conn.connected ? (
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                ● Traffic connection: Connected
              </span>
            ) : (
              <span className="text-xs text-rose-400 font-medium flex flex-col gap-0.5">
                <span>▲ Flyover is disconnected from the traffic network.</span>
                <span className="text-[9px] text-slate-500">
                  {!conn.startConnected && !conn.endConnected
                    ? "Both ends are disconnected. Draw ramps snapping to existing roads."
                    : !conn.startConnected
                    ? "Start ramp is disconnected."
                    : "End ramp is disconnected."}
                </span>
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <span className="text-slate-500">Deck Elevation:</span>
              <span className="text-slate-200 font-semibold block mt-0.5">{(r as any).elevation || 6}m</span>
            </div>
            <div>
              <span className="text-slate-500">Column Spacing:</span>
              <span className="text-slate-200 font-semibold block mt-0.5">{(r as any).pierSpacing || 30}m</span>
            </div>
            <div>
              <span className="text-slate-500">Lanes (Fwd / Bwd):</span>
              <span className="text-slate-200 font-semibold block mt-0.5">{fwdLanes} / {bwdLanes}</span>
            </div>
            <div>
              <span className="text-slate-500">Speed Limit:</span>
              <span className="text-slate-200 font-semibold block mt-0.5">{r.speedLimit} km/h</span>
            </div>
            <div>
              <span className="text-slate-500">Capacity:</span>
              <span className="text-slate-200 font-semibold block mt-0.5">{capacity} veh/h</span>
            </div>
            <div>
              <span className="text-slate-500">Active Vehicles:</span>
              <span className="text-indigo-400 font-bold block mt-0.5 font-mono">{activeVehicles}</span>
            </div>
            <div>
              <span className="text-slate-500">V/C Ratio:</span>
              <span className={`${vcRatio > 0.8 ? 'text-red-400' : vcRatio > 0.4 ? 'text-orange-400' : vcRatio > 0.1 ? 'text-yellow-400' : 'text-emerald-400'} font-semibold block mt-0.5 font-mono`}>
                {vcRatio.toFixed(2)}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Avg Speed:</span>
              <span className="text-slate-200 font-semibold block mt-0.5">{currentSpeed} km/h</span>
            </div>
          </div>

          <div className="flex flex-col gap-1 border-t border-white/5 pt-2">
            <span className="text-[10px] text-slate-400 uppercase font-semibold">Congestion State</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-md border w-fit ${
              congestionState === 'Severe'
                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                : congestionState === 'Heavy'
                ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
                : congestionState === 'Moderate'
                ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            }`}>
              {congestionState}
            </span>
          </div>

          <div className="text-[9px] text-slate-500 space-y-1 font-mono border-t border-white/5 pt-2">
            <div className="truncate">Start Node: {conn.startNodeId || "None"}</div>
            <div className="truncate">End Node: {conn.endNodeId || "None"}</div>
          </div>
        </div>
      )}
    </div>
  );
};

const MetroLineEditor: React.FC<{ m: MetroLineObject; onUpdate: (field: string, val: any) => void }> = ({ m, onUpdate }) => {
  return (
    <div className="space-y-4">
      {/* Tracks count */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Track Count</label>
        <select 
          value={m.trackCount} 
          onChange={(e) => onUpdate('trackCount', Number(e.target.value))}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
        >
          <option value={1}>Single Track</option>
          <option value={2}>Double Track</option>
        </select>
      </div>

      {/* Deck Width */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Deck Width (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{m.deckWidth}m</span>
        </div>
        <input 
          type="range" 
          min={4.0} 
          max={12.0} 
          step={0.5}
          value={m.deckWidth}
          onChange={(e) => onUpdate('deckWidth', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Elevation */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Track Elevation (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{m.elevation}m</span>
        </div>
        <input 
          type="range" 
          min={6.0} 
          max={24.0} 
          step={1.0}
          value={m.elevation}
          onChange={(e) => onUpdate('elevation', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Pier Spacing */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Column Spacing (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{m.pierSpacing}m</span>
        </div>
        <input 
          type="range" 
          min={15.0} 
          max={60.0} 
          step={5.0}
          value={m.pierSpacing}
          onChange={(e) => onUpdate('pierSpacing', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>
    </div>
  );
};

const MetroStationEditor: React.FC<{ s: MetroStationObject; onUpdate: (field: string, val: any) => void }> = ({ s, onUpdate }) => {
  return (
    <div className="space-y-4">
      {/* Length */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Station Length (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{s.length}m</span>
        </div>
        <input 
          type="range" 
          min={80} 
          max={200} 
          step={10}
          value={s.length}
          onChange={(e) => onUpdate('length', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Width */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Station Width (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{s.width}m</span>
        </div>
        <input 
          type="range" 
          min={12} 
          max={30} 
          step={2}
          value={s.width}
          onChange={(e) => onUpdate('width', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Elevation */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Platform Elevation (m)</label>
          <span className="text-[10px] text-indigo-400 font-mono">{s.elevation}m</span>
        </div>
        <input 
          type="range" 
          min={6.0} 
          max={24.0} 
          step={1.0}
          value={s.elevation}
          onChange={(e) => onUpdate('elevation', Number(e.target.value))}
          className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Capacity */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Passenger Capacity (Peak)</label>
        <input 
          type="number" 
          value={s.capacity}
          onChange={(e) => onUpdate('capacity', Number(e.target.value))}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
        />
      </div>
    </div>
  );
};

const JunctionEditor: React.FC<{ j: JunctionObject; onUpdate: (field: string, val: any) => void }> = ({ j, onUpdate }) => {
  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between text-[11px] text-slate-400 bg-slate-950/40 p-3 rounded-lg border border-white/5">
        <span>Coordinate center:</span>
        <span className="font-mono text-indigo-300">[{j.coordinates[0].toFixed(4)}, {j.coordinates[1].toFixed(4)}]</span>
      </div>

      <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">Traffic Signal Lights</span>
          <input 
            type="checkbox" 
            checked={j.hasSignals} 
            onChange={(e) => onUpdate('hasSignals', e.target.checked)}
            className="rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">Crosswalks</span>
          <input 
            type="checkbox" 
            checked={j.hasPedestrianCrossing} 
            onChange={(e) => onUpdate('hasPedestrianCrossing', e.target.checked)}
            className="rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
          />
        </div>
      </div>

      {j.hasSignals && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase font-semibold">Signal Phase Timing (secs)</label>
          <input 
            type="number" 
            value={j.signalTiming}
            onChange={(e) => onUpdate('signalTiming', Number(e.target.value))}
            className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
};

const UtilityEditor: React.FC<{ u: UtilityObject; onUpdate: (field: string, val: any) => void }> = ({ u, onUpdate }) => {
  return (
    <div className="space-y-3.5">
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Lay Depth (meters)</label>
        <input 
          type="number" 
          step="0.1"
          value={u.depth}
          onChange={(e) => onUpdate('depth', Number(e.target.value))}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-slate-400 uppercase font-semibold">Service Capacity</label>
        <input 
          type="number" 
          value={u.capacity}
          onChange={(e) => onUpdate('capacity', Number(e.target.value))}
          className="bg-slate-900 border border-slate-700/50 rounded-lg p-2 text-xs text-slate-200 focus:outline-none"
        />
      </div>
    </div>
  );
};

const ZoneEditor: React.FC<{ z: ZoneObject; onUpdate: (field: string, val: any) => void }> = ({ z, onUpdate }) => {
  const allObjects = engineInstance.objects.getAll();
  const buildings = allObjects.filter(o => o.type === 'building') as BuildingObject[];

  const isPtInPoly = (pt: [number, number], poly: [number, number, number][]) => {
    const x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi || 1) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  const zoneBuildings = buildings.filter(b => {
    if (!z.coordinates || z.coordinates.length === 0) return false;
    const bPt = b.coordinates[0];
    return isPtInPoly([bPt[0], bPt[1]], z.coordinates);
  });

  const network = engineInstance.getTrafficNetwork();
  let zoneNodesCount = 0;
  let zoneRoadsCount = 0;
  
  if (network && z.coordinates && z.coordinates.length > 0) {
    if (network.nodes) {
      network.nodes.forEach((node: any) => {
        if (isPtInPoly([node.coordinates[0], node.coordinates[1]], z.coordinates)) {
          zoneNodesCount++;
        }
      });
    }
    
    const roads = allObjects.filter(o => o.type === 'road') as RoadObject[];
    roads.forEach(r => {
      const hasCoordInside = r.coordinates.some(pt => isPtInPoly([pt[0], pt[1]], z.coordinates));
      if (hasCoordInside) {
        zoneRoadsCount++;
      }
    });
  }

  const gateways = allObjects.filter(o => o.type === 'gateway') as GatewayObject[];
  const zoneGatewaysCount = gateways.filter(g => {
    if (!z.coordinates || z.coordinates.length === 0) return false;
    const pt = g.coordinates && g.coordinates[0];
    if (!pt) return false;
    return isPtInPoly([pt[0], pt[1]], z.coordinates);
  }).length;

  const sumPop = zoneBuildings.reduce((sum, b) => sum + (b.residents ?? b.population ?? 0), 0);
  const sumEmp = zoneBuildings.reduce((sum, b) => sum + (b.employees ?? 0), 0);

  const residualPop = Math.max(0, (z.totalPopulation || 0) - sumPop);
  const residualEmp = Math.max(0, (z.totalEmployment || 0) - sumEmp);

  return (
    <div className="space-y-4">
      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">
        Demand Zone Planning
      </div>
      
      {/* Snapped Object Statistics */}
      <div className="space-y-2 bg-slate-900/30 border border-white/5 rounded-xl p-3 text-xs">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Boundary Snapped Objects</span>
        <div className="space-y-1.5 pt-1 font-mono text-[11px]">
          <div className="flex justify-between border-b border-white/5 pb-1">
            <span className="text-slate-400">Road Access:</span>
            <span className="text-slate-200 font-bold">{zoneRoadsCount} roads</span>
          </div>
          <div className="flex justify-between border-b border-white/5 pb-1">
            <span className="text-slate-400">Traffic Nodes:</span>
            <span className="text-slate-200 font-bold">{zoneNodesCount} nodes</span>
          </div>
          <div className="flex justify-between border-b border-white/5 pb-1">
            <span className="text-slate-400">Buildings:</span>
            <span className="text-slate-200 font-bold">{zoneBuildings.length} buildings</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Gateways:</span>
            <span className="text-slate-200 font-bold">{zoneGatewaysCount} gateways</span>
          </div>
        </div>
      </div>
      <div className="space-y-3 bg-slate-900/30 border border-white/5 rounded-xl p-3">
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Zone Name</label>
          <input 
            type="text" 
            value={z.name} 
            onChange={(e) => onUpdate('name', e.target.value)} 
            className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-medium"
          />
        </div>
        
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Total Residents</label>
            <input 
              type="number" 
              value={z.totalPopulation || 0} 
              onChange={(e) => onUpdate('totalPopulation', Number(e.target.value))} 
              className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Total Employees</label>
            <input 
              type="number" 
              value={z.totalEmployment || 0} 
              onChange={(e) => onUpdate('totalEmployment', Number(e.target.value))} 
              className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>
        </div>
      </div>

      <div className="space-y-2 bg-slate-900/30 border border-white/5 rounded-xl p-3 text-xs">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Residual Planning Math</span>
        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between border-b border-white/5 pb-1">
            <span className="text-slate-400">Explicit Population:</span>
            <span className="text-slate-200 font-bold">{sumPop.toLocaleString()}</span>
          </div>
          <div className="flex justify-between border-b border-white/5 pb-1">
            <span className="text-slate-400">Residual Population:</span>
            <span className="text-emerald-400 font-bold">{residualPop.toLocaleString()}</span>
          </div>
          <div className="flex justify-between border-b border-white/5 pb-1">
            <span className="text-slate-400">Explicit Employment:</span>
            <span className="text-slate-200 font-bold">{sumEmp.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Residual Employment:</span>
            <span className="text-emerald-400 font-bold">{residualEmp.toLocaleString()}</span>
          </div>
        </div>
      </div>
      
      <div className="space-y-2 bg-slate-900/30 border border-white/5 rounded-xl p-3">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">Land-Use Mix (%)</label>
        <div className="space-y-2.5 pt-1.5">
          {['residential', 'commercial', 'industrial', 'educational'].map((use) => {
            const mix = z.landUseMix || { residential: 50, commercial: 30, industrial: 10, educational: 10 };
            const val = (mix as any)[use] || 0;
            return (
              <div key={use} className="space-y-1">
                <div className="flex justify-between text-[10px] capitalize text-slate-400 font-medium">
                  <span>{use}</span>
                  <span>{val}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="100" 
                  value={val} 
                  onChange={(e) => {
                    const newMix = { ...mix, [use]: Number(e.target.value) };
                    onUpdate('landUseMix', newMix);
                  }}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2 bg-slate-900/30 border border-white/5 rounded-xl p-3 text-xs">
        <span className="text-[10px] text-indigo-400 uppercase font-mono block">Associated Gateways</span>
        <div className="flex flex-wrap gap-1 pt-1">
          {z.gateways && z.gateways.length > 0 ? (
            z.gateways.map((gId) => (
              <span key={gId} className="bg-slate-950 border border-white/10 px-2 py-0.5 rounded text-[10px] text-indigo-300 font-mono">
                {gId}
              </span>
            ))
          ) : (
            <span className="text-slate-500 italic text-[11px]">No gateways associated.</span>
          )}
        </div>
      </div>
    </div>
  );
};

const GatewayEditor: React.FC<{ g: GatewayObject; onUpdate: (field: string, val: any) => void }> = ({ g, onUpdate }) => {
  const periods = ['AM_Peak', 'PM_Peak', 'Midday', 'Night'];
  
  const allObjects = engineInstance.objects.getAll();
  const network = engineInstance.getTrafficNetwork();
  
  let connectedRoadName = 'None';
  if (g.connectedNodeId && network) {
    if (network.edges) {
      const connectedEdges = Array.from(network.edges.values() as any).filter(
        (e: any) => e.fromNodeId === g.connectedNodeId || e.toNodeId === g.connectedNodeId
      ) as any[];
      if (connectedEdges.length > 0) {
        const roadObj = allObjects.find(o => o.id === connectedEdges[0].roadId);
        if (roadObj) {
          connectedRoadName = roadObj.name || connectedEdges[0].roadId;
        } else {
          connectedRoadName = connectedEdges[0].roadId;
        }
      }
    }
  }

  const direction = (g as any).direction || 'bidirectional';

  return (
    <div className="space-y-4">
      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">
        External Gateway Settings
      </div>
      <div className="space-y-3 bg-slate-900/30 border border-white/5 rounded-xl p-3">
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Gateway Name</label>
          <input 
            type="text" 
            value={g.name} 
            onChange={(e) => onUpdate('name', e.target.value)} 
            className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-medium"
          />
        </div>

        {/* Connected Road Display */}
        <div className="flex justify-between text-xs border-b border-white/5 pb-2 pt-1 font-mono">
          <span className="text-slate-400">Connected Road:</span>
          <span className="text-indigo-300 font-bold select-all">{connectedRoadName}</span>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Connected Traffic Node</label>
          <input 
            type="text" 
            value={g.connectedNodeId || ''} 
            className="w-full bg-slate-950/60 border border-white/5 rounded-lg px-2.5 py-1.5 text-xs text-slate-500 font-mono focus:outline-none cursor-not-allowed"
            placeholder="node_lng_lat"
            disabled
          />
        </div>

        {/* Direction Selector */}
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Directional Flow</label>
          <select 
            value={direction} 
            onChange={(e) => onUpdate('direction', e.target.value)}
            className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="bidirectional">Bidirectional (In/Out)</option>
            <option value="incoming">Incoming Only (O-D Source)</option>
            <option value="outgoing">Outgoing Only (O-D Sink)</option>
          </select>
        </div>
      </div>

      <div className="space-y-3 bg-slate-900/30 border border-white/5 rounded-xl p-3">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">Flow Rate (Vehicles/hr)</label>
        <div className="space-y-2 pt-1.5">
          {periods.map(p => {
            const inf = g.inboundFlows?.[p] || 0;
            const outf = g.outboundFlows?.[p] || 0;
            return (
              <div key={p} className="grid grid-cols-3 gap-2 items-center text-xs">
                <span className="text-[10px] capitalize text-slate-400 font-mono">{p.replace('_', ' ')}</span>
                <input 
                  type="number" 
                  value={inf} 
                  onChange={(e) => {
                    const newFlows = { ...(g.inboundFlows || {}), [p]: Number(e.target.value) };
                    onUpdate('inboundFlows', newFlows);
                  }}
                  className="bg-slate-950 border border-white/10 rounded-lg p-1.5 text-[10px] text-slate-200 text-center font-mono focus:outline-none focus:border-indigo-500"
                  placeholder="In"
                />
                <input 
                  type="number" 
                  value={outf} 
                  onChange={(e) => {
                    const newFlows = { ...(g.outboundFlows || {}), [p]: Number(e.target.value) };
                    onUpdate('outboundFlows', newFlows);
                  }}
                  className="bg-slate-950 border border-white/10 rounded-lg p-1.5 text-[10px] text-slate-200 text-center font-mono focus:outline-none focus:border-indigo-500"
                  placeholder="Out"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2 bg-slate-900/30 border border-white/5 rounded-xl p-3">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono">Gateway Mode Split (%)</label>
        <div className="space-y-2.5 pt-1.5">
          {['car', 'twoWheeler', 'bus', 'metro', 'walking', 'other'].map((mode) => {
            const split = g.modeSplit || { car: 0.25, twoWheeler: 0.35, bus: 0.2, metro: 0.1, walking: 0.08, other: 0.02 };
            const val = Math.round(((split as any)[mode] || 0) * 100);
            return (
              <div key={mode} className="space-y-1">
                <div className="flex justify-between text-[10px] capitalize text-slate-400 font-medium">
                  <span>{mode.replace('W', ' W')}</span>
                  <span>{val}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="100" 
                  value={val} 
                  onChange={(e) => {
                    const newSplit = { ...split, [mode]: Number(e.target.value) / 100 };
                    onUpdate('modeSplit', newSplit);
                  }}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
