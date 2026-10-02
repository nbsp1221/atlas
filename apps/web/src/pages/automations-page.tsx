import { Link } from "react-router-dom"
import { useAutomations } from "@/api/queries"
import { Badge } from "@workspace/ui/components/badge"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

export function AutomationsPage() {
  const query = useAutomations()

  if (!query.data) {
    return (
      <div className="mx-auto w-full max-w-[980px] space-y-4 p-5 sm:p-8">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-5 py-6 sm:px-8 sm:py-9">
      <div className="mb-7">
        <h1 className="text-2xl font-medium tracking-[-.035em]">Automations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Versioned automation graphs in your personal workspace.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs uppercase">Automation</TableHead>
            <TableHead className="hidden text-xs uppercase sm:table-cell">
              Version
            </TableHead>
            <TableHead className="hidden text-xs uppercase md:table-cell">
              Model
            </TableHead>
            <TableHead className="text-xs uppercase">Verification</TableHead>
            <TableHead className="hidden text-xs uppercase md:table-cell">
              24h cost
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.map((automation) => (
            <TableRow key={automation.id}>
              <TableCell>
                <Link
                  to={"/automations/" + automation.id}
                  className="block rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {automation.name}
                    <Badge variant="outline" className="font-mono">
                      {automation.status.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {automation.description}
                  </div>
                </Link>
              </TableCell>
              <TableCell className="hidden font-mono text-xs sm:table-cell">
                v{automation.version}
              </TableCell>
              <TableCell className="hidden font-mono text-xs md:table-cell">
                {automation.model}
              </TableCell>
              <TableCell className="text-xs text-amber-400">
                {automation.verifiedRate === null
                  ? "—"
                  : automation.verifiedRate + "%"}
              </TableCell>
              <TableCell className="hidden font-mono text-xs md:table-cell">
                {"$" + automation.cost24hUsd.toFixed(4)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
