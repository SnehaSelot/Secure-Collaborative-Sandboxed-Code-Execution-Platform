import { Routes, Route, Navigate } from 'react-router-dom';
import { MainLayout } from '../layouts/MainLayout';
import { EditorPage } from '../pages/EditorPage';
import { RiskAnalysisPage } from '../pages/RiskAnalysisPage';
import { SessionsPage } from '../pages/SessionsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ProfilePage } from '../pages/ProfilePage';
import { CollaborationPage } from '../pages/CollaborationPage';

/** Central route table for the application pages. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Navigate to="/editor" replace />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route
          path="/collaboration/:roomId?"
          element={<CollaborationPage />}
        />
        <Route path="/risk" element={<RiskAnalysisPage />} />
        <Route path="*" element={<Navigate to="/editor" replace />} />
      </Route>
    </Routes>
  );
}
