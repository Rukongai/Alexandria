import { Outlet } from 'react-router-dom';
import { PivotRail } from '../pivot/PivotRail';

export function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <PivotRail />
      <main className="flex-1 min-w-0 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
