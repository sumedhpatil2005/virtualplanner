export interface Scenario {
  id: string;
  name: string;
  description: string;
  isBase: boolean;
  year: number;
}

export class ScenarioManager {
  private scenarios: Map<string, Scenario> = new Map();
  private activeScenarioId: string = 'base';
  private onChangeListeners: ((scenarios: Scenario[], activeId: string) => void)[] = [];

  constructor() {
    this.initializeDefaultScenarios();
  }

  private initializeDefaultScenarios() {
    const defaults: Scenario[] = [
      { id: 'base', name: 'Current City (Base)', description: 'Existing layout of the city infrastructure.', isBase: true, year: 2026 },
      { id: 'proposal_2028', name: '2028 Green Metro & Flyover Expansion', description: 'Proposed metro lines and arterial flyover connections.', isBase: false, year: 2028 },
      { id: 'proposal_2030', name: '2030 Smart Grid & Flood Drainage', description: 'Upgraded storm-water management and smart power utility installations.', isBase: false, year: 2030 },
      { id: 'proposal_2035', name: '2035 Net Zero Urban Corridor', description: 'Complete electrification, high-density mixed zoning, and cycle pathway integration.', isBase: false, year: 2035 },
    ];
    defaults.forEach(s => this.scenarios.set(s.id, s));
  }

  public onChange(callback: (scenarios: Scenario[], activeId: string) => void) {
    this.onChangeListeners.push(callback);
    return () => {
      this.onChangeListeners = this.onChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notify() {
    const list = Array.from(this.scenarios.values());
    this.onChangeListeners.forEach(cb => cb(list, this.activeScenarioId));
  }

  public getAll(): Scenario[] {
    return Array.from(this.scenarios.values());
  }

  public getActiveScenarioId(): string {
    return this.activeScenarioId;
  }

  public getActiveScenario(): Scenario | undefined {
    return this.scenarios.get(this.activeScenarioId);
  }

  public setActiveScenario(id: string) {
    if (this.scenarios.has(id)) {
      this.activeScenarioId = id;
      this.notify();
    }
  }

  public addScenario(scenario: Omit<Scenario, 'isBase'>) {
    this.scenarios.set(scenario.id, { ...scenario, isBase: false });
    this.notify();
  }
}
