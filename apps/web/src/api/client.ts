import { z } from "zod"
import {
  automationSchema,
  connectionSchema,
  overviewSchema,
  runDetailSchema,
  runListItemSchema,
} from "@workspace/domain"

async function fetchJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  return schema.parse(await response.json())
}

export const getOverview = () => fetchJson("/api/overview", overviewSchema)

export const getAutomations = () =>
  fetchJson("/api/automations", z.array(automationSchema))

export const getAutomation = (key: string) =>
  fetchJson(`/api/automations/${encodeURIComponent(key)}`, automationSchema)

export const getRuns = () => fetchJson("/api/runs", z.array(runListItemSchema))

export const getRun = (id: string) =>
  fetchJson(`/api/runs/${encodeURIComponent(id)}`, runDetailSchema)

export const getConnections = () =>
  fetchJson("/api/connections", z.array(connectionSchema))
