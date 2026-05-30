import { PivotMain } from '../components/pivot/PivotMain';

/**
 * Index route page for the pivot workspace.
 * Thin shell that renders PivotMain, which owns the top bar,
 * context header, view switch, and results region.
 */
export function PivotPage() {
  return <PivotMain />;
}
