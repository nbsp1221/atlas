import { useRef, useState, type FormEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"

const bindingSchema = z.object({
  version: z.number().int().positive(),
  mailboxConnectionId: z.string().nullable(),
  modelConnectionId: z.string().nullable(),
  model: z.string(),
  connections: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      label: z.string(),
      providerKey: z.string(),
      status: z.enum(["active", "disabled", "archived"]),
      authState: z.enum([
        "missing",
        "unchecked",
        "ready",
        "reauth_required",
        "error",
      ]),
    })
  ),
})
type Bindings = z.infer<typeof bindingSchema>
const endpoint = "/api/settings/automations/email-triage/connections"
const queryKey = ["automation-connections", "email-triage"]
async function readBindings() {
  const response = await fetch(endpoint, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  })
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Your session expired. Sign in again."
        : "Unable to load connection bindings. Try again."
    )
  const parsed = bindingSchema.safeParse(await response.json())
  if (!parsed.success)
    throw new Error("The server returned unexpected bindings. Try again.")
  return parsed.data
}
const selectClass =
  "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
function BindingForm({
  data,
  onPending,
  onSaved,
  onCancel,
  onReload,
}: {
  data: Bindings
  onPending: (pending: boolean) => void
  onSaved: (version: number) => Promise<void>
  onCancel: () => void
  onReload: () => void
}) {
  const [mailbox, setMailbox] = useState(data.mailboxConnectionId ?? "")
  const [modelConnection, setModelConnection] = useState(
    data.modelConnectionId ?? ""
  )
  const [model, setModel] = useState(data.modelConnectionId ? data.model : "")
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const mailboxes = data.connections.filter(
    (item) => item.providerKey === "google" && item.status !== "archived"
  )
  const models = data.connections.filter(
    (item) =>
      ["openai", "anthropic"].includes(item.providerKey) &&
      item.status !== "archived"
  )
  const mailboxValid = mailboxes.some((item) => item.id === mailbox)
  const modelValid =
    !modelConnection || models.some((item) => item.id === modelConnection)
  const selected = data.connections.filter(
    (item) => item.id === mailbox || item.id === modelConnection
  )
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      busy.current ||
      !mailboxValid ||
      !modelValid ||
      (modelConnection && !model.trim())
    )
      return
    busy.current = true
    setPending(true)
    onPending(true)
    setError(null)
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          expectedVersion: data.version,
          mailboxConnectionId: mailbox,
          modelConnectionId: modelConnection || null,
          model: modelConnection ? model.trim() : data.model || "fake-model",
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(
          response.status === 401
            ? "Your session expired. Sign in again."
            : payload?.error === "reauthentication_required"
              ? "Sign in again before saving bindings."
              : response.status === 409
                ? "The automation or connections changed. Reload bindings and review your selection."
                : "Bindings could not be saved. Review your selection and try again."
        )
      }
      const result = z
        .object({ version: z.number().int().positive() })
        .safeParse(await response.json())
      if (!result.success)
        throw new Error(
          "The save response could not be verified. Reload bindings before trying again."
        )
      await onSaved(result.data.version)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Bindings could not be saved."
      )
    } finally {
      busy.current = false
      setPending(false)
      onPending(false)
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-5 px-4 pb-6"
    >
      <p className="text-xs text-muted-foreground">
        Current immutable version: v{data.version}
      </p>
      <label className="block space-y-2 text-sm">
        <span>Google mailbox connection</span>
        <select
          className={selectClass}
          value={mailbox}
          onChange={(event) => setMailbox(event.target.value)}
          disabled={pending}
          required
        >
          <option value="">Select a Google connection</option>
          {mailbox && !mailboxValid && (
            <option value={mailbox} disabled>
              Current connection unavailable
            </option>
          )}
          {mailboxes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} · {item.status} / {item.authState}
            </option>
          ))}
        </select>
      </label>
      {!mailboxes.length && (
        <p className="text-sm text-muted-foreground">
          Add a Google connection in Settings → Connections first.
        </p>
      )}
      <label className="block space-y-2 text-sm">
        <span>Model connection</span>
        <select
          className={selectClass}
          value={modelConnection}
          onChange={(event) => setModelConnection(event.target.value)}
          disabled={pending}
        >
          <option value="">Fake model (no credentials)</option>
          {modelConnection && !modelValid && (
            <option value={modelConnection} disabled>
              Current model connection unavailable
            </option>
          )}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} · {item.providerKey} · {item.status} /{" "}
              {item.authState}
            </option>
          ))}
        </select>
      </label>
      {modelConnection && (
        <label className="block space-y-2 text-sm">
          <span>Model name</span>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            required
            maxLength={200}
            disabled={pending}
            placeholder="Exact provider model identifier"
          />
        </label>
      )}
      {selected.some(
        (item) => item.status !== "active" || item.authState !== "ready"
      ) && (
        <p className="rounded-md border p-3 text-sm">
          A selected connection is disabled or not verified. Saving a binding
          does not enable or verify credentials.
        </p>
      )}
      <p className="rounded-md border p-3 text-sm">
        Saving creates a new immutable automation version. Existing simulation
        stays fake and makes no provider calls. Saving does not execute the
        automation.
      </p>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onReload}
          >
            Reload bindings
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            pending ||
            !mailboxValid ||
            !modelValid ||
            (!!modelConnection && !model.trim())
          }
        >
          {pending ? "Saving version…" : "Save as new version"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function AutomationConnections() {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [notice, setNotice] = useState<string | null>(null)
  const query = useQuery({
    queryKey,
    queryFn: readBindings,
    enabled: open,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  async function saved(version: number) {
    setNotice(
      `Saved connection bindings as v${version}. Simulation remains fake.`
    )
    setOpen(false)
    await Promise.all([
      cache.invalidateQueries({ queryKey }),
      cache.invalidateQueries({ queryKey: ["automation", "email-triage"] }),
      cache.invalidateQueries({ queryKey: ["automations"] }),
    ])
  }
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        onClick={() => {
          setNotice(null)
          setOpen(true)
        }}
      >
        Connection bindings
      </Button>
      {notice && (
        <p role="status" className="max-w-sm text-xs">
          {notice}
        </p>
      )}
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!busy.current) setOpen(next)
        }}
      >
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-lg"
          showCloseButton={!pending}
        >
          <SheetHeader>
            <SheetTitle>Email Triage connections</SheetTitle>
            <SheetDescription>
              Reuse credentials managed in Settings → Connections. Choose a
              Google mailbox and an optional model provider.
            </SheetDescription>
          </SheetHeader>
          {open && query.isPending && (
            <p role="status" className="px-4">
              Loading bindings…
            </p>
          )}
          {open && query.isError && (
            <div className="space-y-3 px-4">
              <p role="alert">{query.error.message}</p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                Retry loading bindings
              </Button>
            </div>
          )}
          {open && query.data && !query.isError && (
            <BindingForm
              key={query.dataUpdatedAt}
              data={query.data}
              onPending={(value) => {
                busy.current = value
                setPending(value)
              }}
              onSaved={saved}
              onCancel={() => setOpen(false)}
              onReload={() => void query.refetch()}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
