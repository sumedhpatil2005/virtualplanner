import { apiDelete, apiGet, apiPost } from '../../lib/api';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  isBase: boolean;
  year: number;
}

export const BASE_SCENARIO_ID = 'base';

interface ScenarioRecord {
  id: string;
  name: string;
  description: string;
  year: number;
}

const BASE_SCENARIO: Scenario = {
  id: BASE_SCENARIO_ID,
  name: 'Current City (Base)',
  description: 'Existing layout of the city infrastructure.',
  isBase: true,
  year: 2026,
};

/**
 * Planning scenarios. "base" is the existing city; every other scenario is a
 * user-created proposal whose objects are layered on top of base. Scenarios are
 * persisted through the backend.
 */
export class ScenarioManager {
  private scenarios: Map<string, Scenario> = new Map([[BASE_SCENARIO_ID, { ...BASE_SCENARIO }]]);
  private activeScenarioId: string = BASE_SCENARIO_ID;
  private onChangeListeners: ((scenarios: Scenario[], activeId: string) => void)[] = [];

  public onChange(callback: (scenarios: Scenario[], activeId: string) => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    const list = this.getAll();
    this.onChangeListeners.forEach(cb => cb(list, this.activeScenarioId));
  }

  /** Base first, then proposals by year and name. */
  public getAll(): Scenario[] {
    return Array.from(this.scenarios.values()).sort((a, b) =>
      a.isBase !== b.isBase ? (a.isBase ? -1 : 1) : a.year - b.year || a.name.localeCompare(b.name)
    );
  }

  public get(id: string): Scenario | undefined {
    return this.scenarios.get(id);
  }

  public getActiveScenarioId(): string {
    return this.activeScenarioId;
  }

  public getActiveScenario(): Scenario | undefined {
    return this.scenarios.get(this.activeScenarioId);
  }

  public setActiveScenario(id: string) {
    if (this.scenarios.has(id) && id !== this.activeScenarioId) {
      this.activeScenarioId = id;
      this.notify();
    }
  }

  /** Loads scenarios from the backend. The base scenario is always present. */
  public async load(): Promise<void> {
    try {
      const records = await apiGet<ScenarioRecord[]>('/api/scenarios');
      const next = new Map<string, Scenario>([[BASE_SCENARIO_ID, { ...BASE_SCENARIO }]]);
      for (const r of records) {
        next.set(r.id, { ...r, description: r.description ?? '', isBase: r.id === BASE_SCENARIO_ID });
      }
      this.scenarios = next;
      if (!this.scenarios.has(this.activeScenarioId)) this.activeScenarioId = BASE_SCENARIO_ID;
      this.notify();
    } catch (e) {
      console.warn('[ScenarioManager] load failed:', e);
      (window as any).showToast?.('Could not load scenarios from the backend — only the base city is available.', 'error');
    }
  }

  public async createScenario(input: { name: string; description?: string; year: number }): Promise<Scenario> {
    const scenario: Scenario = {
      id: `scn_${Math.random().toString(36).slice(2, 10)}`,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      year: input.year,
      isBase: false,
    };
    this.validate(scenario);
    await apiPost('/api/scenarios', this.toRecord(scenario));
    this.scenarios.set(scenario.id, scenario);
    this.notify();
    return scenario;
  }

  public async updateScenario(id: string, patch: { name?: string; description?: string; year?: number }): Promise<void> {
    const existing = this.scenarios.get(id);
    if (!existing) throw new Error('Scenario not found.');
    const updated: Scenario = {
      ...existing,
      ...patch,
      name: (patch.name ?? existing.name).trim(),
      description: (patch.description ?? existing.description).trim(),
    };
    this.validate(updated);
    await apiPost('/api/scenarios', this.toRecord(updated));
    this.scenarios.set(id, updated);
    this.notify();
  }

  /** Deletes a proposal on the backend (which also deletes its objects). */
  public async deleteScenario(id: string): Promise<void> {
    if (id === BASE_SCENARIO_ID) throw new Error('The base city cannot be deleted.');
    if (!this.scenarios.has(id)) return;
    await apiDelete(`/api/scenarios/${encodeURIComponent(id)}`);
    this.scenarios.delete(id);
    if (this.activeScenarioId === id) this.activeScenarioId = BASE_SCENARIO_ID;
    this.notify();
  }

  private validate(s: Scenario) {
    if (!s.name) throw new Error('Scenario name cannot be empty.');
    if (s.name.length > 120) throw new Error('Scenario name must be 120 characters or fewer.');
    if (!Number.isInteger(s.year) || s.year < 1900 || s.year > 2200) throw new Error('Year must be between 1900 and 2200.');
  }

  private toRecord(s: Scenario): ScenarioRecord {
    return { id: s.id, name: s.name, description: s.description, year: s.year };
  }
}
