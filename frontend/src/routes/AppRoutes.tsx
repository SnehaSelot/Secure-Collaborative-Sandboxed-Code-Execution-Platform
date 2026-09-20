import { Routes, Route, Navigate } from 'react-router-dom';
import { MainLayout } from '../layouts/MainLayout';
import { EditorPage } from '../pages/EditorPage';
import { ComingSoonPage } from '../pages/ComingSoonPage';
import { RiskAnalysisPage } from '../pages/RiskAnalysisPage';

/**
 * Central route table. Every route unavailable-by-backend renders
 * ComingSoonPage instead of a real feature — no fake API calls happen
 * on these routes.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Navigate to="/editor" replace />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route
          path="/sessions"
          element={
            <ComingSoonPage
              title="Sessions"
              description="Session creation, joining, and history will appear here once the workspace service exists."
              badge="Coming Soon"
            />
          }
        />
        <Route
          path="/collaboration"
          element={
            <ComingSoonPage
              title="Collaboration"
              description="Live multi-cursor editing will appear here once the collab-gateway (Yjs) backend is running."
              badge="Coming Soon"
            />
          }
        />
        <Route path="/risk" element={<RiskAnalysisPage />} />
        <Route
          path="/admin"
          element={
            <ComingSoonPage
              title="Admin Dashboard"
              description="Execution stats, audit logs, and user management require the admin and audit backend services."
              badge="Backend Required"
            />
          }
        />
        <Route path="*" element={<Navigate to="/editor" replace />} />
      </Route>
    </Routes>
  );
}