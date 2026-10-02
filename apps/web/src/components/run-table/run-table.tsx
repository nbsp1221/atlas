import * as React from "react"
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"
import type { RunListItem } from "@workspace/domain"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { formatSeoulTime } from "@/lib/time"

const outcomeClass: Record<RunListItem["verification"], string> = {
  verified: "text-emerald-400",
  completed: "text-emerald-400",
  unverified: "text-amber-400",
  failed: "text-red-400",
  pending: "text-amber-400",
}

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, RunListItem>()

const columns = helper.columns([
  helper.accessor("occurredAt", {
    header: "Time",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground/80">
        {formatSeoulTime(row.original.occurredAt)}
      </span>
    ),
  }),
  helper.accessor("subject", {
    header: "Input",
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="max-w-[32rem] truncate text-sm font-medium">
          {row.original.subject}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {row.original.automationName} · {row.original.sender}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs sm:hidden">
          <span className="font-mono text-foreground/75">
            {row.original.route}
          </span>
          <span className={outcomeClass[row.original.verification]}>
            {row.original.verification[0].toUpperCase() +
              row.original.verification.slice(1)}
          </span>
        </div>
      </div>
    ),
  }),
  helper.accessor("mode", {
    header: "Mode",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground uppercase">
        {row.original.mode.toUpperCase()}
      </span>
    ),
  }),
  helper.accessor("route", {
    header: "Route",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground/75">
        {row.original.route}
      </span>
    ),
  }),
  helper.accessor("model", {
    header: "Model",
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.model}</span>
    ),
  }),
  helper.accessor("verification", {
    header: "Outcome",
    cell: ({ row }) => (
      <span className={"text-xs " + outcomeClass[row.original.verification]}>
        {row.original.verification[0].toUpperCase() +
          row.original.verification.slice(1)}
      </span>
    ),
  }),
  helper.accessor("latencyMs", {
    header: "Latency",
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.latencyMs}ms</span>
    ),
  }),
])

function responsiveColumnClass(columnId: string) {
  if (
    columnId === "mode" ||
    columnId === "route" ||
    columnId === "verification"
  )
    return "hidden sm:table-cell"
  if (columnId === "model") return "hidden md:table-cell"
  if (columnId === "latencyMs") return "hidden lg:table-cell"
  return ""
}

export function RunTable({
  runs,
  onSelect,
}: {
  runs: RunListItem[]
  onSelect: (run: RunListItem) => void
}) {
  const [routeFilter, setRouteFilter] = React.useState("all")
  const data = React.useMemo(
    () =>
      routeFilter === "all"
        ? runs
        : runs.filter((run) => run.route === routeFilter),
    [runs, routeFilter]
  )
  const table = useTable({ features, columns, data })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Select
          value={routeFilter}
          onValueChange={(value) => setRouteFilter(value ?? "all")}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue>
              {routeFilter === "all" ? "All routes" : routeFilter}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All routes</SelectItem>
            <SelectItem value="archive">archive</SelectItem>
            <SelectItem value="notify">notify</SelectItem>
            <SelectItem value="spam">spam</SelectItem>
            <SelectItem value="no_action">no_action</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {data.length} runs
        </span>
      </div>

      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={
                    "text-xs tracking-wide text-muted-foreground uppercase " +
                    responsiveColumnClass(header.column.id)
                  }
                >
                  {header.isPlaceholder ? null : (
                    <table.FlexRender header={header} />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="py-10 text-center text-sm text-muted-foreground"
              >
                No runs yet.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                tabIndex={0}
                role="button"
                onClick={() => onSelect(row.original)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onSelect(row.original)
                  }
                }}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={"py-3 " + responsiveColumnClass(cell.column.id)}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
