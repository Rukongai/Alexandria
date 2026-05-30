import { Outlet } from 'react-router-dom';
import { PivotRail } from '../pivot/PivotRail';
import { CommandPaletteProvider } from '../../hooks/use-command-palette';
import { CommandPalette } from '../command/CommandPalette';

export function AppShell() {
  return (
    <CommandPaletteProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <PivotRail />
        <main className="flex-1 min-w-0 overflow-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </CommandPaletteProvider>
  );
}
