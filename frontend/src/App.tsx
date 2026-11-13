import { AppShell } from './shell/AppShell';

/**
 * UrbanOS. The whole layout lives in shell/AppShell (docs/urbanos/SHELL_AND_DESIGN_SYSTEM.md). The model-trust pill
 * (ui/badges, design-tools work) is passed in as `trust` once it exists.
 */
function App() {
  return <AppShell />;
}

export default App;
