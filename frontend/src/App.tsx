import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { BidDeskPage } from "./pages/BidDeskPage";
import { CompaniesPage } from "./pages/CompaniesPage";
import { CoveragePage } from "./pages/CoveragePage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { HomePage } from "./pages/HomePage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SourceMonitorPage } from "./pages/SourceMonitorPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="bid-desk" element={<BidDeskPage />} />
        <Route path="coverage" element={<CoveragePage />} />
        <Route path="source-monitor" element={<SourceMonitorPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
