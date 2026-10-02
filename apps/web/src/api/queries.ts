import { useQuery } from "@tanstack/react-query"
import {
  getAutomation,
  getAutomations,
  getConnections,
  getOverview,
  getRun,
  getRuns,
} from "@/api/client"

export const useOverview = () =>
  useQuery({
    queryKey: ["overview"],
    queryFn: getOverview,
    refetchInterval: 10_000,
  })

export const useAutomations = () =>
  useQuery({ queryKey: ["automations"], queryFn: getAutomations })

export const useAutomation = (id: string) =>
  useQuery({
    queryKey: ["automation", id],
    queryFn: () => getAutomation(id),
  })

export const useRuns = () =>
  useQuery({
    queryKey: ["runs"],
    queryFn: getRuns,
    refetchInterval: 10_000,
  })

export const useRun = (id: string | null) =>
  useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id!),
    enabled: Boolean(id),
  })

export const useConnections = () =>
  useQuery({ queryKey: ["connections"], queryFn: getConnections })
