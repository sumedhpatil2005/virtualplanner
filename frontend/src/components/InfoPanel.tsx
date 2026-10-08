import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, Hammer, Crosshair, Route, Train, Building2, Shapes, AlertTriangle, CheckCircle2, ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type {
  CityObject, RoadObject, FlyoverObject, MetroFlyoverObject, BuildingObject, MetroLineObject, MetroStationObject,
  JunctionObject, UtilityObject, ZoneObject, GatewayObject,
} from '../engine/objects/types';
import { isUserBuilt, TYPE_LABELS } from '../engine/objects/builtBy';
import { filterObjectsForScenario } from '../engine/scenarios/scenarioFilter';
import { isDrivable, polylineLengthM } from '../engine/simulation/StudyAreaExplorer';
import { formatDistanceM } from '../lib/format';
import { useSelectedId } from '../hooks/useAppMode';
import { SidePanel, PanelHeader, PanelBody, Section, Facts, Button, Notice } from './ui/kit';

/**
 * View mode: what the user has built. Nothing selected lists their projects;
 * a selection shows what it is and how it connects, with a way back.
 */
export const InfoPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const selectedId = useSelectedId();
  const [version, setVersion] = useState(0);
  useEffect(() => engineInstance.objects.onChange(() => setVersion(v => v + 1)), []);
  useEffect(() => engineInstance.scenarios.onChange(() => setVersion(v => v + 1)), []);

  const obj = selectedId ? engineInstance.objects.getById(selectedId) : undefined;
  if (obj) return <ObjectDetails key={obj.id} obj={obj} version={version} />;
  return <ProjectList version={version} onClose={onClose} />;
};

// ── Projects ──────────────────────────────────────────────────────────────────

const GROUPS: { title: string; icon: LucideIcon; types: CityObject['type'][] }[] = [
  { title: 'Roads and flyovers', icon: Route, types: ['road', 'flyover', 'metro_flyover'] },
  { title: 'Metro', icon: Train, types: ['metro_line', 'metro_station'] },
  { title: 'Buildings', icon: Building2, types: ['building'] },
  { title: 'Other', icon: Shapes, types: ['junction', 'utility', 'zone', 'gateway'] },
];

const lineLength = (o: CityObject) =>
  Array.isArray(o.coordinates[0]) && o.type !== 'building' && o.type !== 'zone' ? polylineLengthM(o.coordinates as number[][]) : null;

const ProjectList: React.FC<{ version: number; onClose: () => void }> = ({ version, onClose }) => {
  const built = useMemo(
    () => filterObjectsForScenario(engineInstance.objects.getAll(), engineInstance.scenarios.getActiveScenarioId()).filter(isUserBuilt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const open = (id: string) => {
    engineInstance.selection.selectSingle(id);
    engineInstance.flyToObject(id);
  };

  return (
    <SidePanel label="Your projects">
      <PanelHeader
        title="Your projects"
        subtitle={built.length === 0 ? 'Nothing built yet' : `${built.length} thing${built.length === 1 ? '' : 's'} you have built`}
        onClose={onClose}
        closeLabel="Hide panel"
      />
      <PanelBody>
        {built.length === 0 ? (
          <div className="text-sm text-slate-300 space-y-3">
            <p>Roads, flyovers, metro lines and buildings you add show up here. Click one on the map to see its details.</p>
            <Button variant="primary" icon={Hammer} onClick={() => engineInstance.setAppMode('build')}>Start building</Button>
          </div>
        ) : (
          GROUPS.map(g => {
            const items = built.filter(o => g.types.includes(o.type));
            if (items.length === 0) return null;
            const Icon = g.icon;
            return (
              <Section key={g.title} title={g.title} aside={String(items.length)}>
                <ul className="rounded-xl bg-white/[0.04] border border-white/5 divide-y divide-white/5 overflow-hidden">
                  {items.map(o => {
                    const len = lineLength(o);
                    return (
                      <li key={o.id}>
                        <button
                          onClick={() => open(o.id)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 cursor-pointer transition"
                        >
                          <Icon size={16} className="text-slate-400 shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm text-slate-100 truncate">{o.name || TYPE_LABELS[o.type]}</span>
                            <span className="block text-xs text-slate-500">
                              {TYPE_LABELS[o.type]}{len !== null ? ` · ${formatDistanceM(len)}` : ''}
                            </span>
                          </span>
                          <ChevronRight size={16} className="text-slate-600 shrink-0" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            );
          })
        )}
        <p className="text-xs text-slate-500 leading-relaxed">
          Imported OpenStreetMap roads and buildings are the base map, so clicking them does nothing here. Use Simulate to study traffic on any road.
        </p>
      </PanelBody>
    </SidePanel>
  );
};

// ── Details ───────────────────────────────────────────────────────────────────

const nameOf = (id: string) => engineInstance.objects.getById(id)?.name || 'Unnamed road';

/** "Baner Road, Service Road and 3 more", one mention per name. */
function listNames(ids: string[], max = 3): string {
  const names = [...new Set(ids.map(nameOf))];
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

function lanesText(o: RoadObject | FlyoverObject | MetroFlyoverObject): string {
  const sec = o.type === 'road' ? o.sections?.[0] : undefined;
  const fwd = sec ? sec.carriagewayA.lanes : o.isOneWay ? o.laneCount : Math.ceil(o.laneCount / 2);
  const bwd = sec ? sec.carriagewayB?.lanes ?? 0 : o.isOneWay ? 0 : Math.floor(o.laneCount / 2);
  if (bwd === 0) return `${fwd}, one-way`;
  return fwd === bwd ? `${fwd} each way` : `${fwd} + ${bwd}`;
}

const CLASS_LABELS: Record<string, string> = { highway: 'Highway', arterial: 'Main road', collector: 'Collector', local: 'Local street' };

const ObjectDetails: React.FC<{ obj: CityObject; version: number }> = ({ obj, version }) => {
  const back = () => engineInstance.selection.clearSelection();
  const editInBuild = () => {
    engineInstance.setAppMode('build');
    engineInstance.selection.selectSingle(obj.id);
  };
  const drivable = isDrivable(obj);
  const len = lineLength(obj);

  return (
    <SidePanel label={`${obj.name} details`}>
      <PanelHeader
        title={obj.name || TYPE_LABELS[obj.type]}
        subtitle={`${TYPE_LABELS[obj.type]}${obj.scenarioId !== 'base' ? ' · in this proposal' : ''}`}
        onBack={back}
        backLabel="All projects"
      />
      <PanelBody>
        <div className="space-y-2">
          {drivable && <Button variant="primary" icon={Activity} className="w-full" onClick={() => engineInstance.simulateRoad(obj.id)}>Simulate traffic here</Button>}
          <div className="grid grid-cols-2 gap-2">
            <Button icon={Crosshair} onClick={() => engineInstance.flyToObject(obj.id)}>Show on map</Button>
            <Button icon={Hammer} onClick={editInBuild}>Edit in Build</Button>
          </div>
        </div>

        {drivable && <RoadDetails road={obj} length={len} version={version} />}
        {obj.type === 'building' && <BuildingDetails b={obj} />}
        {obj.type === 'metro_line' && <MetroLineDetails m={obj} length={len} />}
        {obj.type === 'metro_station' && <StationDetails s={obj} />}
        {obj.type === 'junction' && <JunctionDetails j={obj} />}
        {obj.type === 'utility' && <UtilityDetails u={obj} length={len} />}
        {obj.type === 'zone' && <ZoneDetails z={obj} />}
        {obj.type === 'gateway' && <GatewayDetails g={obj} />}
      </PanelBody>
    </SidePanel>
  );
};

const RoadDetails: React.FC<{ road: RoadObject | FlyoverObject | MetroFlyoverObject; length: number | null; version: number }> = ({ road, length, version }) => {
  const conn = useMemo(
    () => engineInstance.getRoadConnections(road.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [road.id, version]
  );

  const facts: [string, React.ReactNode][] = [];
  if (length !== null) facts.push(['Length', formatDistanceM(length)]);
  facts.push(['Lanes', lanesText(road)]);
  facts.push(['Speed limit', `${road.speedLimit} km/h`]);
  facts.push(['Type', CLASS_LABELS[road.roadClass] ?? road.roadClass]);
  if (road.type === 'flyover') facts.push(['Deck height', `${road.elevation} m`]);
  if (road.type === 'metro_flyover') {
    facts.push(['Road deck', `${road.elevation} m up`]);
    facts.push(['Metro deck', `${road.metroElevation} m up`]);
  }

  return (
    <>
      <Section title="Facts"><Facts rows={facts} /></Section>
      {conn && (
        <Section title="Connections">
          <div className="space-y-2">
            <EndRow label="Start" ids={conn.start} />
            <EndRow label="End" ids={conn.end} />
            {conn.along.length > 0 && <p className="text-sm text-slate-300">Also meets {listNames(conn.along)} along the way.</p>}
            {conn.over.length > 0 && <p className="text-sm text-slate-300">Passes over {listNames(conn.over)} without joining.</p>}
            {conn.under.length > 0 && <p className="text-sm text-slate-300">Passes under {listNames(conn.under)}.</p>}
          </div>
        </Section>
      )}
    </>
  );
};

const EndRow: React.FC<{ label: string; ids: string[] }> = ({ label, ids }) =>
  ids.length > 0 ? (
    <Notice tone="good" icon={CheckCircle2}>
      <span className="font-semibold">{label}</span> joins {listNames(ids)}
    </Notice>
  ) : (
    <Notice tone="warn" icon={AlertTriangle}>
      <span className="font-semibold">{label}</span> is not connected to any road, so traffic cannot get on or off here.
    </Notice>
  );

const n = (v: number | undefined | null, unit = '') => (v === undefined || v === null ? '—' : `${v.toLocaleString()}${unit}`);

const BuildingDetails: React.FC<{ b: BuildingObject }> = ({ b }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Use', (b.category ?? b.usageType).replace(/_/g, ' ')],
      ['Floors', n(b.floors)],
      ['Height', n(b.height, ' m')],
      ['Residents', n(b.residents ?? (b.usageType === 'residential' ? b.population : 0))],
      ['Jobs', n(b.employees ?? 0)],
      ['Parking', n(b.parkingCapacity ?? b.parkingSpaces, ' spaces')],
    ]} />
  </Section>
);

const MetroLineDetails: React.FC<{ m: MetroLineObject; length: number | null }> = ({ m, length }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Length', length === null ? '—' : formatDistanceM(length)],
      ['Tracks', n(m.trackCount)],
      ['Deck height', n(m.elevation, ' m')],
      ['Status', m.status === 'under_construction' ? 'Under construction' : 'Operational'],
    ]} />
  </Section>
);

const StationDetails: React.FC<{ s: MetroStationObject }> = ({ s }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Station', s.stationName || s.name],
      ['Platform length', n(s.length, ' m')],
      ['Platform height', n(s.elevation, ' m up')],
      ['Capacity', n(s.capacity, ' passengers')],
    ]} />
  </Section>
);

const JunctionDetails: React.FC<{ j: JunctionObject }> = ({ j }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Signals', j.hasSignals ? `Yes, ${j.signalTiming} s cycle` : 'No'],
      ['Pedestrian crossing', j.hasPedestrianCrossing ? 'Yes' : 'No'],
      ['Roads', n(j.connectedRoads.length)],
    ]} />
  </Section>
);

const UtilityDetails: React.FC<{ u: UtilityObject; length: number | null }> = ({ u, length }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Carries', u.utilityType],
      ['Length', length === null ? '—' : formatDistanceM(length)],
      ['Depth', n(u.depth, ' m')],
      ['Capacity', n(u.capacity)],
    ]} />
  </Section>
);

const ZoneDetails: React.FC<{ z: ZoneObject }> = ({ z }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Population', n(z.totalPopulation)],
      ['Jobs', n(z.totalEmployment)],
      ['Land use', `${z.landUseMix.residential}% homes · ${z.landUseMix.commercial}% business`],
    ]} />
  </Section>
);

const GatewayDetails: React.FC<{ g: GatewayObject }> = ({ g }) => (
  <Section title="Facts">
    <Facts rows={[
      ['Morning peak in', n(g.inboundFlows?.AM_Peak, ' veh/h')],
      ['Morning peak out', n(g.outboundFlows?.AM_Peak, ' veh/h')],
      ['Evening peak in', n(g.inboundFlows?.PM_Peak, ' veh/h')],
      ['Evening peak out', n(g.outboundFlows?.PM_Peak, ' veh/h')],
    ]} />
  </Section>
);

