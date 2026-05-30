import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './hooks/use-auth';
import { LibraryProvider } from './hooks/use-libraries';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { AllLibrariesPage } from './pages/AllLibrariesPage';
import { PivotPage } from './pages/PivotPage';
import { ModelDetailPage } from './pages/ModelDetailPage';
import { CollectionsPage } from './pages/CollectionsPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { UploadPage } from './pages/UploadPage';
import { SearchPage } from './pages/SearchPage';
import { SmartCollectionComposerPage } from './pages/SmartCollectionComposerPage';
import { DesignSystemPage } from './pages/DesignSystemPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

/**
 * Authenticated shell: gates on auth then mounts LibraryProvider so every nested
 * route (the All-Libraries home and each `/lib/:id` workspace route) shares one
 * libraries query and keeps the API client's active-library header in sync.
 */
function AuthedLayout() {
  return (
    <ProtectedRoute>
      <LibraryProvider>
        <Outlet />
      </LibraryProvider>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthedLayout />}>
        {/* All-Libraries home — pick or manage a library */}
        <Route index element={<AllLibrariesPage />} />
        {/* Per-library workspace */}
        <Route path="lib/:libraryId" element={<AppShell />}>
          <Route index element={<PivotPage />} />
          <Route path="models/:id" element={<ModelDetailPage />} />
          <Route path="collections" element={<CollectionsPage />} />
          <Route path="collections/:id" element={<CollectionDetailPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="smart-collections/new" element={<SmartCollectionComposerPage />} />
          <Route path="smart-collections/:id/edit" element={<SmartCollectionComposerPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="search" element={<SearchPage />} />
        </Route>
      </Route>
      {import.meta.env.DEV && (
        <Route path="/design-system" element={<DesignSystemPage />} />
      )}
      {/* Catch-all → home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
