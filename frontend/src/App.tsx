import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { BidDeskPage } from "./pages/BidDeskPage";
import { CompaniesPage } from "./pages/CompaniesPage";
import { CoveragePage } from "./pages/CoveragePage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { HomePage } from "./pages/HomePage";
import { InboxPage } from "./pages/InboxPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OutreachPage } from "./pages/OutreachPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SourceMonitorPage } from "./pages/SourceMonitorPage";

function AuthenticatedRoutes() {
  const { user, loading, error } = useAuth();
  if (loading) return <main className="login-page"><div className="loading-panel">Checking your Tudelu session…</div></main>;
  if (!user) return <LoginPage error={error} />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="bid-desk" element={<BidDeskPage />} />
        <Route path="outreach" element={<OutreachPage />} />
        <Route path="coverage" element={<CoveragePage />} />
        <Route path="source-monitor" element={<SourceMonitorPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return <AuthProvider><AuthenticatedRoutes /></AuthProvider>;
}
