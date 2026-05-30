import { LogOut, MoreHorizontal, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/use-auth';
import { Avatar, AvatarFallback } from '../ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ThemeToggle } from '../layout/ThemeToggle';

function getInitials(displayName: string): string {
  return displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Rail-footer account control. Same behavior as Header's user menu (theme
 * toggle, identity, Settings nav, Log out) but styled for the dark rail.
 * Pinned at the bottom of PivotRail.
 */
export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div
      className="flex-shrink-0"
      style={{
        borderTop: '1px solid var(--ax-rail-border)',
        background: 'var(--ax-rail)',
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* Theme toggle — styled for dark rail */}
        <div className="flex-shrink-0">
          <ThemeToggle />
        </div>

        {user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ax-rail-active)] hover:bg-[var(--ax-rail-hover)]"
                aria-label="User menu"
              >
                <Avatar className="h-7 w-7 flex-shrink-0">
                  <AvatarFallback
                    style={{
                      background: 'linear-gradient(135deg, var(--ax-amber) 0%, var(--ax-amber-deep) 100%)',
                      color: 'var(--ax-amber-fg)',
                      fontSize: '11px',
                      fontWeight: 700,
                    }}
                  >
                    {getInitials(user.displayName)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div
                    className="truncate font-semibold"
                    style={{ fontSize: '12.5px', color: 'var(--ax-rail-fg)' }}
                  >
                    {user.displayName}
                  </div>
                  <div
                    className="ax-mono truncate"
                    style={{ fontSize: '10.5px', color: 'var(--ax-rail-fg-muted)' }}
                  >
                    {user.email}
                  </div>
                </div>
                <MoreHorizontal
                  className="flex-shrink-0 h-3.5 w-3.5"
                  style={{ color: 'var(--ax-rail-fg-muted)' }}
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{user.displayName}</span>
                  <span className="text-xs text-muted-foreground">{user.email}</span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/settings')}>
                <User className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={logout}
                className="text-destructive hover:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
