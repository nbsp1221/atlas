import { Navigate, Route, Routes } from "react-router-dom"
import { ConnectionsAuthGate } from "@/components/connections-auth-gate"
import { AppShell } from "@/app/app-shell"
import { AutomationPage } from "@/pages/automation-page"
import { AutomationsPage } from "@/pages/automations-page"
import { ConnectionsPage } from "@/pages/connections-page"
import { OverviewPage } from "@/pages/overview-page"
import { RunsPage } from "@/pages/runs-page"

export function App() {
  return (
    <ConnectionsAuthGate>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="automations" element={<AutomationsPage />} />
          <Route path="automations/:id" element={<AutomationPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ConnectionsAuthGate>
  )
}

export default App
