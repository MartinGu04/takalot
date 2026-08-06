import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import {
  AuthErrorScreen,
  AuthLoadingScreen,
  ConfigErrorScreen,
  UnauthorizedScreen,
} from './components/AuthScreens';
import { getAppMode } from './data/appMode';
import { hasCapability, type Capability } from './domain/permissions';
import LoginPage from './pages/LoginPage';
import { OfflineBanner } from './pwa/OfflineBanner';
import { UpdatePrompt } from './pwa/UpdatePrompt';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const IncidentsPage = lazy(() => import('./pages/IncidentsPage'));
const IncidentCreatePage = lazy(() => import('./pages/IncidentCreatePage'));
const IncidentDetailPage = lazy(() => import('./pages/IncidentDetailPage'));
const ArchivePage = lazy(() => import('./pages/ArchivePage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const PersonnelPage = lazy(() => import('./pages/PersonnelPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const AuditLogPage = lazy(() => import('./pages/AuditLogPage'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

function Forbidden() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-bold">אין הרשאה</h1>
      <p className="mt-2 text-sm text-muted">אין לך הרשאה לצפות בעמוד זה.</p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-bold">העמוד לא נמצא</h1>
      <p className="mt-2 text-sm text-muted">ייתכן שהקישור שגוי או שהפריט הוסר.</p>
    </div>
  );
}

function RequireAuth({ children, cap }: { children: React.ReactNode; cap?: Capability }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="בודק התחברות…" />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (cap && !hasCapability(user.role, cap)) return <Forbidden />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, status, identityEmail, logout, retryAuthorization } = useAuth();

  // Gate ALL routing on the auth lifecycle so the login page never flashes
  // while a persisted session is being restored, and an authenticated but
  // unprovisioned identity is stopped before any application route.
  if (status === 'loading') return <AuthLoadingScreen />;
  if (status === 'unauthorized') return <UnauthorizedScreen email={identityEmail} onLogout={logout} />;
  if (status === 'error') return <AuthErrorScreen onRetry={retryAuthorization} onLogout={logout} />;

  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
          <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
          <Route path="/incidents" element={<RequireAuth><IncidentsPage /></RequireAuth>} />
          <Route
            path="/incidents/new"
            element={<RequireAuth cap="create_incident"><IncidentCreatePage /></RequireAuth>}
          />
          <Route path="/incidents/:id" element={<RequireAuth><IncidentDetailPage /></RequireAuth>} />
          <Route path="/archive" element={<RequireAuth><ArchivePage /></RequireAuth>} />
          <Route path="/personnel" element={<RequireAuth cap="manage_personnel"><PersonnelPage /></RequireAuth>} />
          <Route path="/admin" element={<RequireAuth cap="manage_users"><AdminPage /></RequireAuth>} />
          <Route path="/audit-log" element={<RequireAuth cap="view_audit_log"><AuditLogPage /></RequireAuth>} />
          <Route path="/reports" element={<RequireAuth><ReportsPage /></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  // RTL/Hebrew is also set statically in index.html; setting it here too keeps
  // the app correctly RTL even when mounted without that shell (e.g. tests).
  useEffect(() => {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'he');
  }, []);

  // A misconfigured build (e.g. production without Supabase credentials, or
  // a server secret in a client variable) halts here -- it must never fall
  // back to demo data silently.
  const mode = getAppMode();
  if (mode.kind === 'misconfigured') {
    return <ConfigErrorScreen reason={mode.reason} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <OfflineBanner />
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
          <UpdatePrompt />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
