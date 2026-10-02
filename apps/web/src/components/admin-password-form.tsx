import { useRef, useState, type FormEvent } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"

export function AdminPasswordForm({
  onChanged,
}: {
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const busy = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current) return
    busy.current = true
    setPending(true)
    setMessage(null)
    const form = event.currentTarget
    const fields = new FormData(form)
    form.reset()
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: fields.get("currentPassword"),
          newPassword: fields.get("newPassword"),
        }),
      })
      if (!response.ok) {
        setMessage(
          response.status === 403
            ? "Sign out and sign in again before changing your password."
            : "Password change failed. Check your current password and try again."
        )
        return
      }
      await response.json()
      await onChanged()
      setOpen(false)
      setMessage("Password changed. Other sessions have been signed out.")
    } catch {
      setMessage("Unable to change your password. Try again.")
    } finally {
      fields.delete("currentPassword")
      fields.delete("newPassword")
      busy.current = false
      setPending(false)
    }
  }
  return (
    <section aria-label="Administrator password" className="border-b px-4 py-2">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(!open)
            setMessage(null)
          }}
        >
          {open ? "Cancel password change" : "Change password"}
        </Button>
      </div>
      {open && (
        <form
          onSubmit={(event) => void submit(event)}
          className="mx-auto flex max-w-md flex-col gap-4 py-4"
        >
          <p className="text-sm text-muted-foreground">
            Changing your password signs out every other session.
          </p>
          <FieldGroup>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="current-password">
                Current password
              </FieldLabel>
              <Input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                disabled={pending}
              />
            </Field>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                disabled={pending}
              />
            </Field>
          </FieldGroup>
          <Button type="submit" disabled={pending}>
            {pending ? "Changing password…" : "Save password"}
          </Button>
        </form>
      )}
    </section>
  )
}
