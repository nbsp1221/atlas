import { useRef, useState, type FormEvent } from "react"
import { useLocation } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  actOnConnection,
  authorizeGoogle,
  createApiKeyConnection,
  getConnectionSettings,
  saveGoogleClient,
  type ConnectionAction,
  type ManagedConnection,
} from "@/api/connections"
import { formatSeoulTime } from "@/lib/time"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"

type Panel =
  | { kind: "add" }
  | { kind: "client" }
  | { kind: "google"; reconnect?: ManagedConnection }
  | { kind: ConnectionAction; connection: ManagedConnection }
const actionLabels: Record<ConnectionAction, string> = {
  replace: "Replace key",
  test: "Test connection",
  disconnect: "Disable locally",
  resume: "Resume locally",
  forget: "Forget credential",
  archive: "Archive connection",
  revoke: "Revoke Google grant",
}
const actionDescriptions: Record<ConnectionAction, string> = {
  replace:
    "Replace the stored key. Atlas checks the replacement with the provider before saving it and preserves an already verified account identity.",
  test: "Contact the provider to verify this credential and account. This does not run an automation.",
  resume:
    "Restore local use of this connection with its stored, verified credential. Atlas automations that reference it can use it again. This does not change provider permissions.",
  disconnect:
    "Stop Atlas from using this connection. The credential stays encrypted in Atlas and remains valid at the provider.",
  forget:
    "Remove the stored credential from Atlas. History stays available. This does not revoke access at the provider.",
  archive:
    "Hide this connection from active use while keeping its history. This does not revoke provider access.",
  revoke:
    "Revoke the Google authorization grant. This can affect other connections using the same Google account and OAuth client project, including grants outside Atlas. This is different from disabling locally.",
}

export function ConnectionsPage() {
  const cache = useQueryClient()
  const location = useLocation()
  const oauthOutcome = new URLSearchParams(location.search).get("oauth")
  const query = useQuery({
    queryKey: ["connection-settings"],
    queryFn: getConnectionSettings,
    retry: false,
  })
  const [panel, setPanel] = useState<Panel | null>(null)
  const [provider, setProvider] = useState<"openai" | "anthropic" | "telegram">(
    "openai"
  )
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const data = query.data
  const client = data?.oauthClients.find(
    (item) => item.providerKey === "google"
  )
  function open(next: Panel) {
    setError(null)
    setNotice(null)
    setPanel(next)
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!panel || busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    const form = event.currentTarget
    const fields = new FormData(form)
    // Secrets never enter React state, a query/mutation cache, or browser storage.
    const secretInput = form.elements.namedItem(
      "secret"
    ) as HTMLInputElement | null
    if (secretInput) secretInput.value = ""
    try {
      let resultNotice =
        "Saved. Connection status reflects the latest server check."
      if (panel.kind === "add")
        await createApiKeyConnection({
          providerKey: provider,
          label: String(fields.get("label")).trim(),
          secret: String(fields.get("secret")),
        })
      else if (panel.kind === "client")
        await saveGoogleClient({
          clientId: String(fields.get("clientId")).trim(),
          clientSecret: String(fields.get("secret")),
          ...(client ? { revision: client.revision } : {}),
        })
      else if (panel.kind === "google") {
        const url = await authorizeGoogle({
          ...(panel.reconnect
            ? {
                connectionId: panel.reconnect.id,
                revision: panel.reconnect.revision,
              }
            : { label: String(fields.get("label")).trim() }),
        })
        window.location.assign(url)
        return
      } else {
        const result = await actOnConnection(
          panel.connection,
          panel.kind,
          panel.kind === "replace" ? String(fields.get("secret")) : undefined
        )
        if (result.connection.lastErrorCode === "revocation_failed")
          resultNotice =
            "Disabled locally, but Google revocation could not be confirmed. The credential is retained so you can retry revocation."
        else if (
          panel.kind === "test" &&
          result.connection.authState !== "ready"
        )
          resultNotice =
            "The connection check did not pass. Review its health below before using it."
      }
      setPanel(null)
      setNotice(resultNotice)
      await cache.invalidateQueries({ queryKey: ["connection-settings"] })
      await cache.invalidateQueries({ queryKey: ["connections"] })
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The request could not be completed."
      )
    } finally {
      fields.delete("secret")
      busy.current = false
      setPending(false)
    }
  }
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-6 px-5 py-6 sm:px-8 sm:py-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Settings</p>
          <h1 className="text-2xl font-medium tracking-[-.035em]">
            Connections
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Reusable provider credentials and verified accounts. Labels are
            names you choose, not proof of account identity.
          </p>
        </div>
        <Button
          disabled={!data?.credentialStorageAvailable || pending}
          onClick={() => open({ kind: "add" })}
        >
          Add API key
        </Button>
      </header>
      {oauthOutcome === "failed" && (
        <p role="alert" className="rounded-lg border p-4 text-sm">
          Google authorization did not complete. Try connecting again and review
          the permissions at Google.
        </p>
      )}
      {oauthOutcome === "complete" && (
        <p role="status" className="text-sm">
          Google authorization returned successfully. Review the verified
          account and granted scopes below.
        </p>
      )}
      {query.isPending && <p role="status">Loading connections…</p>}
      {query.isError && (
        <div role="alert" className="space-y-2 text-sm">
          <p>{query.error.message}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry loading
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {data && (
        <>
          {!data.credentialStorageAvailable && (
            <p role="alert" className="rounded-lg border p-4 text-sm">
              Credential storage is unavailable. Configure the server encryption
              key before adding or changing credentials.
            </p>
          )}
          <section
            aria-labelledby="google-title"
            className="space-y-3 rounded-lg border p-4"
          >
            <h2 id="google-title" className="font-medium">
              Google OAuth
            </h2>
            <p className="text-sm text-muted-foreground">
              Configure the OAuth application once, then connect each Google
              account separately. Consent requests Gmail modify access and basic
              account identity.
            </p>
            <p className="text-xs break-all">
              Callback URL:{" "}
              <span className="font-mono">
                {data.callbackUrl ??
                  "Unavailable until the public server URL is configured"}
              </span>
            </p>
            <p className="text-xs break-all text-muted-foreground">
              {client
                ? `Client ID: ${client.clientId} · ${client.hasSecret ? "Client secret stored" : "Client secret missing"}`
                : "No Google OAuth client configured"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!data.credentialStorageAvailable || pending}
                onClick={() => open({ kind: "client" })}
              >
                {client ? "Replace Google client" : "Configure Google client"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  !data.credentialStorageAvailable ||
                  !client?.hasSecret ||
                  !data.callbackUrl ||
                  pending
                }
                onClick={() => open({ kind: "google" })}
              >
                Connect Google account
              </Button>
            </div>
          </section>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived connections
          </label>
          <div className="space-y-3">
            {data.connections
              .filter(
                (connection) => showArchived || connection.status !== "archived"
              )
              .map((connection) => (
                <article
                  key={connection.id}
                  aria-label={connection.label}
                  className="min-w-0 space-y-4 rounded-lg border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="font-medium break-words">
                        {connection.label}
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {connection.providerKey}
                      </p>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <span className="rounded border px-2 py-1">
                        {connection.status}
                      </span>
                      <span className="rounded border px-2 py-1">
                        {connection.authState === "unchecked"
                          ? "Not yet verified"
                          : connection.authState}
                      </span>
                    </div>
                  </div>
                  <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">
                        Verified account
                      </dt>
                      <dd className="mt-1 break-all">
                        {connection.principalId
                          ? `${connection.principalType ?? "account"} · ${connection.principalId}`
                          : "Not verified"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Granted scopes</dt>
                      <dd className="mt-1 break-all">
                        {connection.grantedScopes.length
                          ? connection.grantedScopes.join(", ")
                          : "None recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Last check</dt>
                      <dd className="mt-1">
                        {connection.lastCheckedAt
                          ? formatSeoulTime(connection.lastCheckedAt, true)
                          : "Never checked"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Usage</dt>
                      <dd className="mt-1">
                        {connection.usageCount} references ·{" "}
                        {connection.hasSecret
                          ? "Credential stored"
                          : "No credential"}
                      </dd>
                    </div>
                  </dl>
                  {connection.lastErrorCode === "revocation_failed" && (
                    <p role="alert" className="text-xs text-red-500">
                      Google revocation was not confirmed. This connection is
                      disabled locally, but provider access may remain. Retry
                      revocation or remove the grant at Google.
                    </p>
                  )}
                  {connection.authState === "reauth_required" && (
                    <p className="text-xs">
                      Authorization needs renewal. Connect the account again.
                    </p>
                  )}
                  {connection.status !== "archived" && (
                    <div className="flex flex-wrap gap-2">
                      {connection.providerKey === "google" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            pending ||
                            !data.credentialStorageAvailable ||
                            !client?.hasSecret ||
                            !data.callbackUrl
                          }
                          onClick={() =>
                            open({ kind: "google", reconnect: connection })
                          }
                        >
                          Reconnect account
                        </Button>
                      )}
                      {(
                        [
                          "test",
                          ...(connection.providerKey !== "google"
                            ? ["replace"]
                            : []),
                          ...(connection.status === "disabled" &&
                          connection.hasSecret &&
                          connection.authState === "ready"
                            ? ["resume"]
                            : []),
                          "disconnect",
                          "forget",
                          ...(connection.providerKey === "google"
                            ? ["revoke"]
                            : []),
                          "archive",
                        ] as ConnectionAction[]
                      ).map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant="outline"
                          disabled={
                            pending ||
                            (action !== "archive" &&
                              !data.credentialStorageAvailable) ||
                            (["test", "forget", "revoke"].includes(action) &&
                              !connection.hasSecret) ||
                            (action === "disconnect" &&
                              connection.status === "disabled")
                          }
                          onClick={() => open({ kind: action, connection })}
                        >
                          {actionLabels[action]}
                        </Button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            {!data.connections.some(
              (connection) => showArchived || connection.status !== "archived"
            ) && (
              <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                No connections yet. Add an API key or connect a Google account
                to get started.
              </p>
            )}
          </div>
        </>
      )}
      <Sheet
        open={panel !== null}
        onOpenChange={(next) => {
          if (!next && !busy.current) {
            setPanel(null)
            setError(null)
          }
        }}
      >
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-lg"
          showCloseButton={!pending}
        >
          {panel && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {panel.kind === "add"
                    ? "Add API key"
                    : panel.kind === "client"
                      ? "Google OAuth client"
                      : panel.kind === "google"
                        ? "Connect Google account"
                        : actionLabels[panel.kind]}
                </SheetTitle>
                <SheetDescription>
                  {panel.kind === "add"
                    ? "Keys are write-only. Atlas never sends stored secrets back to this page."
                    : panel.kind === "client"
                      ? "Application credentials are separate from each connected Google account. Replacing the client can require existing accounts to reconnect."
                      : panel.kind === "google"
                        ? "Continue to Google to choose an account and review the requested permissions. No account is connected until consent and verification complete."
                        : actionDescriptions[panel.kind]}
                </SheetDescription>
              </SheetHeader>
              <form
                key={panel.kind}
                onSubmit={(event) => void submit(event)}
                autoComplete="off"
                className="space-y-5 px-4 pb-6"
              >
                {"connection" in panel && (
                  <p className="text-sm font-medium break-all">
                    {panel.connection.label}
                  </p>
                )}
                {panel.kind === "add" && (
                  <label className="block space-y-2 text-sm">
                    <span>Provider</span>
                    <select
                      aria-label="Provider"
                      value={provider}
                      disabled={pending}
                      onChange={(event) => {
                        setProvider(event.target.value as typeof provider)
                        const input = event.target.form?.elements.namedItem(
                          "secret"
                        ) as HTMLInputElement | null
                        if (input) input.value = ""
                      }}
                      className="h-9 w-full rounded-md border bg-background px-3"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="telegram">Telegram</option>
                    </select>
                  </label>
                )}
                {(panel.kind === "add" ||
                  (panel.kind === "google" && !panel.reconnect)) && (
                  <label className="block space-y-2 text-sm">
                    <span>Connection label</span>
                    <Input
                      name="label"
                      required
                      maxLength={100}
                      disabled={pending}
                      placeholder="A name for this connection"
                    />
                  </label>
                )}
                {panel.kind === "client" && (
                  <label className="block space-y-2 text-sm">
                    <span>Google client ID</span>
                    <Input
                      name="clientId"
                      required
                      maxLength={300}
                      defaultValue={client?.clientId}
                      disabled={pending}
                      autoComplete="off"
                    />
                  </label>
                )}
                {(panel.kind === "add" ||
                  panel.kind === "replace" ||
                  panel.kind === "client") && (
                  <label className="block space-y-2 text-sm">
                    <span id="connection-secret-label">
                      {panel.kind === "client"
                        ? "Google client secret"
                        : panel.kind === "add" && provider === "telegram"
                          ? "Telegram bot token"
                          : "API key"}
                    </span>
                    <Input
                      name="secret"
                      aria-labelledby="connection-secret-label"
                      type="password"
                      required
                      maxLength={16384}
                      disabled={pending}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <span className="block text-xs text-muted-foreground">
                      Stored encrypted on the server. Cleared from this form
                      after submission, including on failure.
                    </span>
                  </label>
                )}
                {error && (
                  <p role="alert" className="text-sm text-red-500">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>
                    {pending
                      ? "Working…"
                      : panel.kind === "google"
                        ? "Continue to Google"
                        : panel.kind === "add"
                          ? "Save API key"
                          : panel.kind === "client"
                            ? "Save OAuth client"
                            : `Confirm ${actionLabels[panel.kind].toLowerCase()}`}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setPanel(null)
                      setError(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
