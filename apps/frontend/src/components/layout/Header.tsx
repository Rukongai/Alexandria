import { useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Monitor, Moon, Sun, User } from 'lucide-react';
import { useAuth } from '../../hooks/use-auth';
import { useTheme, type Theme } from '../../hooks/use-theme';
import { Avatar, AvatarFallback } from '../ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

function usePageTitle(): string {
  const { pathname } = useLocation();

  if (pathname === '/') return 'Library';
  if (pathname.startsWith('/models/')) return 'Model Detail';
  if (pathname === '/collections') return 'Collections';
  if (pathname === '/upload') return 'Upload';
  if (pathname === '/settings') return 'Settings';

  return 'Alexandria';
}

function getInitials(displayName: string): string {
  return displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const ActiveIcon = theme === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Toggle theme"
        >
          <ActiveIcon className="h-4 w-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className={theme === value ? 'font-semibold' : ''}
          >
            <Icon className="mr-2 h-4 w-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const title = usePageTitle();

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background px-6">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>

      <div className="flex items-center gap-2">
        <ThemeToggle />
      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="User menu"
            >
              <Avatar>
                <AvatarFallback>{getInitials(user.displayName)}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
      )}
      </div>
    </header>
  );
}
