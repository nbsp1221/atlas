import { useRef, useState, type FormEvent, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { AdminPasswordForm } from "./admin-password-form"

async function readSession() {
  const response = await fetch("/api/auth/get-session", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  })
  if (response.status === 503)
    throw new Error(
      "Administrator sign-in is not configured. Deployment setup is pending."
    )
  if (response.status === 401) return null
  if (!response.ok) throw new Error("Unable to check your session. Try again.")
  const data: unknown = await response.json()
  if (data === null) return null
  if (typeof data !== "object" || !("session" in data) || !("user" in data))
    throw new Error("Unable to verify your session. Try again.")
  if (!data.session || !data.user) return null
  return true
}

export function ConnectionsAuthGate({ children }: { children: ReactNode }) {
  const cache = useQueryClient()
  const session = useQuery({
    queryKey: ["admin-session"],
    queryFn: readSession,
    retry: false,
    staleTime: 0,
    refetchInterval: 60_000,
  })
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function authenticate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    const signingOut = !event
    const fields = event ? new FormData(event.currentTarget) : null
    if (event)
      (
        event.currentTarget.elements.namedItem("password") as HTMLInputElement
      ).value = ""
    try {
      const response = await fetch(
        `/api/auth/${signingOut ? "sign-out" : "sign-in/email"}`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(
            signingOut
              ? {}
              : {
                  email: String(fields?.get("email")).trim(),
                  password: String(fields?.get("password")),
                }
          ),
        }
      )
      if (!response.ok)
        throw new Error(
          signingOut
            ? "Sign-out failed. Try again."
            : "Sign-in failed. Check your details and try again."
        )
      await response.json()
      await cache.cancelQueries()
      cache.removeQueries({
        predicate: (query) => query.queryKey[0] !== "admin-session",
      })
      cache.setQueryData(["admin-session"], null)
      await session.refetch()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to complete the request."
      )
    } finally {
      fields?.delete("password")
      busy.current = false
      setPending(false)
    }
  }
  if (session.isPending)
    return (
      <main className="p-8">
        <p role="status">Checking administrator session…</p>
      </main>
    )
  if (session.isError)
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
        <h1 className="text-xl font-medium">Atlas access</h1>
        <p role="alert">{session.error.message}</p>
        <Button onClick={() => void session.refetch()}>
          Retry session check
        </Button>
      </main>
    )
  if (!session.data)
    return (
      <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
        <div>
          <h1 className="text-2xl font-medium">Sign in to Atlas</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Administrator access is required. Public registration is disabled.
          </p>
        </div>
        <form
          onSubmit={(event) => void authenticate(event)}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="admin-email">Email</FieldLabel>
              <Input
                id="admin-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                disabled={pending}
              />
            </Field>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="admin-password">Password</FieldLabel>
              <Input
                id="admin-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={pending}
              />
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </main>
    )
  return (
    <>
      <div className="flex min-h-11 items-center justify-end gap-3 border-b px-4 py-1">
        <span className="text-xs text-muted-foreground">
          Administrator session
        </span>
        {error && (
          <p role="alert" className="text-xs">
            {error}
          </p>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void authenticate()}
        >
          {pending ? "Signing out…" : "Sign out"}
        </Button>
      </div>
      <AdminPasswordForm
        onChanged={async () => {
          await cache.cancelQueries()
          cache.removeQueries({
            predicate: (query) => query.queryKey[0] !== "admin-session",
          })
          await session.refetch()
        }}
      />
      {children}
    </>
  )
}
