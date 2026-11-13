import type { DrawerTab } from '../../components/ui/Drawer';
import { ProfileView, CrossSectionView } from '../../components/underground/SectionViews';
import { SubsurfaceEvidenceView } from '../../components/underground/SubsurfaceEvidence';
import { UtilityTable } from './UndergroundContext';
import { startUndergroundRuntime } from './UndergroundContext.runtime';

/** Bottom-drawer tabs of the Underground workspace (registered in AppShell's DRAWER_TABS). */
export const UNDERGROUND_DRAWER_TABS: DrawerTab[] = [
  { id: 'profile', label: 'Profile', content: <ProfileView /> },
  { id: 'section', label: 'Cross-section', content: <CrossSectionView /> },
  { id: 'utilities', label: 'Utility table', content: <UtilityTable /> },
  { id: 'evidence', label: 'Subsurface evidence', content: <SubsurfaceEvidenceView /> },
];


startUndergroundRuntime();
