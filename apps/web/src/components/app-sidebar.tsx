import { useEffect, type MouseEvent } from "react"
import { Link, matchPath, useLocation } from "react-router-dom"
import { Activity, Boxes, Cable, LayoutDashboard, Workflow } from "lucide-react"
import { useOverview, useAutomations } from "@/api/queries"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"

const primary = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/automations", label: "Automations", icon: Workflow },
  { to: "/runs", label: "Runs", icon: Activity },
]

const system = [{ to: "/connections", label: "Connections", icon: Cable }]

// Keep current-page styling distinct from hover, including without color vision.
const navigationClassName =
  "relative h-9 data-active:bg-sidebar-accent data-active:font-semibold data-active:text-sidebar-accent-foreground data-active:before:absolute data-active:before:inset-y-2 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-current data-active:hover:bg-sidebar-accent data-active:active:bg-sidebar-accent focus-visible:ring-sidebar-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"

export function AppSidebar() {
  const location = useLocation()
  const { setOpenMobile } = useSidebar()

  // Browser history can change while the drawer is open, too.
  useEffect(() => {
    setOpenMobile(false)
  }, [location.key, setOpenMobile])

  const closeOnNavigate = (event: MouseEvent) => {
    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      setOpenMobile(false)
    }
  }
  const overview = useOverview()
  const automations = useAutomations()
  const needsAttention = (overview.data?.attentionCount ?? 0) > 0
  const hasRuntimeData = (overview.data?.runs24h ?? 0) > 0

  const isActive = (to: string) =>
    !!matchPath(
      { path: to, end: to === "/" || to === "/automations" },
      location.pathname
    )

  return (
    <Sidebar collapsible="icon" className="border-sidebar-border bg-sidebar">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center gap-2 px-2 text-sm font-medium">
          <span className="grid size-5 place-items-center rounded-md border border-border text-xs font-bold">
            A
          </span>
          <span className="group-data-[collapsible=icon]:hidden">
            Atlas
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primary.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    isActive={isActive(to)}
                    render={
                      <Link
                        to={to}
                        aria-current={isActive(to) ? "page" : undefined}
                        onClick={closeOnNavigate}
                      />
                    }
                    tooltip={label}
                    className={navigationClassName}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {system.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    isActive={isActive(to)}
                    render={
                      <Link
                        to={to}
                        aria-current={isActive(to) ? "page" : undefined}
                        onClick={closeOnNavigate}
                      />
                    }
                    tooltip={label}
                    className={navigationClassName}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Automation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {automations.data?.map((automation) => (
                <SidebarMenuItem key={automation.id}>
                  <SidebarMenuButton
                    isActive={isActive(
                      `/automations/${encodeURIComponent(automation.id)}`
                    )}
                    render={
                      <Link
                        to={`/automations/${encodeURIComponent(automation.id)}`}
                        aria-current={
                          isActive(
                            `/automations/${encodeURIComponent(automation.id)}`
                          )
                            ? "page"
                            : undefined
                        }
                        onClick={closeOnNavigate}
                      />
                    }
                    tooltip={automation.name}
                    className={navigationClassName}
                  >
                    <Boxes />
                    <span>{automation.name}</span>
                    <span
                      className={
                        "ml-auto size-1.5 rounded-full group-data-[collapsible=icon]:hidden " +
                        (automation.graph.nodes.some(
                          (node) => node.health === "attention"
                        )
                          ? "bg-amber-400"
                          : automation.runs24h > 0
                            ? "bg-emerald-400"
                            : "bg-muted-foreground")
                      }
                    />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center">
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
          <span className="group-data-[collapsible=icon]:hidden">
            {needsAttention
              ? "1 item needs attention"
              : hasRuntimeData
                ? "No runtime attention"
                : "No runtime data"}
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
