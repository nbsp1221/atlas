import type React from "react"
import { Outlet, useLocation } from "react-router-dom"
import { useOverview, useAutomations } from "@/api/queries"
import { AppSidebar } from "@/components/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { Separator } from "@workspace/ui/components/separator"

function labelFor(pathname: string, automationName?: string) {
  if (pathname === "/") return "Overview"
  if (pathname === "/automations") return "Automations"
  if (pathname.startsWith("/automations/"))
    return `Automations / ${automationName ?? "Automation"}`
  if (pathname.startsWith("/runs")) return "Runs"
  if (pathname === "/connections") return "Connections"
  return ""
}

export function AppShell() {
  const location = useLocation()
  const overview = useOverview()
  const automations = useAutomations()
  const automation = automations.data?.find(
    (item) =>
      location.pathname === `/automations/${encodeURIComponent(item.id)}`
  )
  const needsAttention = (overview.data?.attentionCount ?? 0) > 0
  const hasRuntimeData = (overview.data?.runs24h ?? 0) > 0

  return (
    <SidebarProvider
      defaultOpen
      style={
        {
          "--sidebar-width": "13.5rem",
          "--sidebar-width-icon": "3.25rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-5">
          <SidebarTrigger className="md:hidden" />
          <Separator orientation="vertical" className="h-4 md:hidden" />
          <div className="min-w-0 truncate text-xs text-muted-foreground">
            Atlas /{" "}
            <span className="text-foreground/75">
              {labelFor(location.pathname, automation?.name)}
            </span>
          </div>
          <div className="ml-auto hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span
              className={
                "size-1.5 rounded-full " +
                (needsAttention
                  ? "bg-amber-400"
                  : hasRuntimeData
                    ? "bg-emerald-400"
                    : "bg-muted-foreground")
              }
            />
            {needsAttention
              ? "1 item needs attention"
              : hasRuntimeData
                ? "No runtime attention"
                : "No runtime data"}
          </div>
        </header>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
