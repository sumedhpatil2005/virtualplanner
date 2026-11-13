import { AppShell } from './shell/AppShell';
import { ModelTrustPill } from './components/ui/badges';

/**
 * UrbanOS. The whole layout lives in shell/AppShell (docs/urbanos/SHELL_AND_DESIGN_SYSTEM.md). The top bar always shows
 * the traffic model's validation status (fails TAG M3.1, docs/ENGINEERING_VALIDATION.md).
 */
function App() {
  return <AppShell trust={<ModelTrustPill />} />;
}

export default App;
