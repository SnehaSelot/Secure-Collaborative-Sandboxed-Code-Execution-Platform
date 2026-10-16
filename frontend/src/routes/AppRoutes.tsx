import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { MainLayout } from '../layouts/MainLayout';
import { AdminLayout } from '../layouts/AdminLayout';
import { EditorPage } from '../pages/EditorPage';
import { RiskAnalysisPage } from '../pages/RiskAnalysisPage';
import { SessionsPage } from '../pages/SessionsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ProfilePage } from '../pages/ProfilePage';
import { CollaborationPage } from '../pages/CollaborationPage';
import { LandingPage } from '../pages/LandingPage';
import { LoginPage } from '../pages/LoginPage';
import { RegisterPage } from '../pages/RegisterPage';
import { PublicLayout } from '../components/layout/PublicLayout';
import { AdminPage } from '../pages/AdminPage';
import { RequireAuth } from './RequireAuth';
import { RequireAdmin } from './RequireAdmin';

/** Central route table for the application pages. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout><Outlet /></PublicLayout>}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin/login" element={<LoginPage adminMode />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth><MainLayout /></RequireAuth>}>
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route
          path="/collaboration/:roomId?"
          element={<CollaborationPage />}
        />
        <Route path="/risk" element={<RiskAnalysisPage />} />
        <Route path="/risk-analysis" element={<RiskAnalysisPage />} />
      </Route>
      <Route element={<RequireAuth><RequireAdmin><AdminLayout /></RequireAdmin></RequireAuth>}>
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/:section" element={<AdminPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

