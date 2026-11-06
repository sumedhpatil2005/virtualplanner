import React, { useEffect, useState } from 'react';
import { AlertTriangle, Map as MapIcon } from 'lucide-react';
import type { BindingSegment, DirectionFlow, RoadAnalysisResult } from '../engine/simulation/RoadAnalysis';
import type { LaneInsight } from '../engine/simulation/ScenarioComparison';
import { Button } from './ui/kit';
import { Card, Chip } from './ui/viz';

/**
 * Which stretch sets a direction's capacity when its lanes vary along it
 * (docs/OVERHAUL.md §16): widening only a bridge deck leaves the 2-lane
 * approaches as the limit, and the panel says so instead of implying the
 * extra lane did nothing. Engine-free: the panel passes `onShow`, which
 * highlights road ids on the map (null clears).
 */

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lanesOf = (x: readonly number[]) => (x[0] === x[1] ? `${x[0]}` : x.join('–'));
const wayList = (bs: readonly BindingSegment[]) => bs.map(b => `${b.roadId} (${fmt(b.lengthM)} m)`).join(', ');

/** Directions of a result whose lanes vary along them, with the stretch that sets their capacity. */
function varyingDirections(r: RoadAnalysisResult): (DirectionFlow & { binding: BindingSegment })[] {
  return r.directions.filter((d): d is DirectionFlow & { binding: BindingSegment } => !!d.binding && !!d.lanesRange && d.lanesRange[0] !== d.lanesRange[1]);
}

const ShowOnMap: React.FC<{ ids: string[]; shown: string | null; id: string; setShown: (id: string | null) => void; onShow: (ids: string[] | null) => void; testId?: string }> = ({ ids, shown, id, setShown, onShow, testId }) => (
  <Button size="sm" icon={MapIcon} variant={shown === id ? 'primary' : 'secondary'} data-testid={testId}
    onClick={() => { const on = shown !== id; setShown(on ? id : null); onShow(on ? ids : null); }}>
    {shown === id ? 'Hide on map' : 'Show on map'}
  </Button>
);

/** On What's wrong: one line per direction whose lanes vary, naming the stretch that sets its capacity. */
export const CapacityStretchCard: React.FC<{ r: RoadAnalysisResult; onShow: (ids: string[] | null) => void }> = ({ r, onShow }) => {
  const [shown, setShown] = useState<string | null>(null);
  const dirs = varyingDirections(r);
  useEffect(() => () => onShow(null), [r]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!dirs.length) return null;
  return (
    <Card tone="warn" testId="capacity-stretch">
      {dirs.map(d => {
        const wider = (d.segments ?? []).filter(s => s.lanes > d.binding.lanes);
        return (
          <div key={d.label} className="space-y-1.5" data-testid="capacity-stretch-row" data-direction={d.label} data-binding-road={d.binding.roadId} data-binding-lanes={d.binding.lanes} data-binding-length-m={d.binding.lengthM}>
            <p className="flex items-start gap-2 text-xs text-amber-100 leading-snug">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
              <span>
                <b>{cap(d.label)}</b>: capacity {fmt(d.midblockPcu)} PCU/h is set by its {d.binding.lanes}-lane stretch, {d.binding.name} ({wayList(d.bindingSegments ?? [d.binding])}).
                {wider.length > 0 && <> The {d.lanesRange[1]}-lane {wayList(wider)} {wider.length === 1 ? "isn't" : "aren't"} the constraint: widen the narrower stretch too to raise it.</>}
              </span>
            </p>
            <div className="flex items-center gap-2">
              <ShowOnMap id={d.label} ids={(d.bindingSegments ?? [d.binding]).map(b => b.roadId)} shown={shown} setShown={setShown} onShow={onShow} testId="capacity-stretch-show" />
              <Chip tone="neutral" title="IRC:106 mid-block capacity of the direction's narrowest stretch, from the compiled network">model output</Chip>
            </div>
          </div>
        );
      })}
    </Card>
  );
};

/** On Improve & compare: what a lane edit did to each edited direction's capacity. */
export const LaneInsightCard: React.FC<{ insights: readonly LaneInsight[]; onShow: (ids: string[] | null) => void }> = ({ insights, onShow }) => {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => () => onShow(null), [insights]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!insights.length) return null;
  const warn = insights.some(i => i.kind === 'unchanged_elsewhere' || i.newBottlenecksNearby.length > 0 || (i.binding && !i.bindingEdited));
  return (
    <Card tone={warn ? 'warn' : 'plain'} testId="lane-insight">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Lane change and capacity</p>
      {insights.map(i => (
        <div key={i.direction} className="space-y-1.5" data-testid="lane-insight-row" data-direction={i.direction} data-kind={i.kind} data-capacity-before={i.capacityBefore} data-capacity-after={i.capacityAfter} data-binding-road={i.binding?.roadId ?? ''}>
          <p className={`flex items-start gap-2 text-xs leading-snug ${i.kind === 'unchanged_elsewhere' || i.newBottlenecksNearby.length ? 'text-amber-100' : 'text-slate-200'}`}>
            {(i.kind === 'unchanged_elsewhere' || i.newBottlenecksNearby.length > 0) && <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />}
            <span>{i.text}</span>
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {i.binding && <ShowOnMap id={i.direction} ids={(i.bindingSegments.length ? i.bindingSegments : [i.binding]).map(b => b.roadId)} shown={shown} setShown={setShown} onShow={onShow} testId="lane-insight-show" />}
            <Chip tone="neutral">{fmt(i.capacityBefore)} → {fmt(i.capacityAfter)} PCU/h</Chip>
            <Chip tone="neutral" title="Lanes along the direction (fewest–most), existing city → proposal">lanes {lanesOf(i.lanesBefore)} → {lanesOf(i.lanesAfter)}</Chip>
          </div>
        </div>
      ))}
    </Card>
  );
};
