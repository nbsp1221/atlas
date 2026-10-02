import type { JsonValue } from "@workspace/domain"
export function JsonEvidence({
  title,
  value,
}: {
  title: string
  value: JsonValue
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold">{title}</h4>
      <pre className="max-h-96 overflow-auto rounded border bg-muted/20 p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}
export function CodeIdentity({ value }: { value: JsonValue }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return (
    <section className="space-y-3" data-testid="code-identity">
      <h3 className="text-sm font-semibold">Registered code · read only</h3>
      <p className="text-xs break-all">
        {String(value.id)} @ {String(value.version)}
        <br />
        Implementation SHA-256: {String(value.implementationHash)}
        <br />
        Source SHA-256: {String(value.sourceHash)}
      </p>
      <p className="text-xs text-muted-foreground">
        {String(value.sourceScope)}. Trusted in-process execution.
      </p>
      <details>
        <summary className="cursor-pointer text-xs">Callable source</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded border p-3 text-xs break-all whitespace-pre-wrap">
          {String(value.source)}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-xs">
          Schemas and artifact metadata
        </summary>
        <JsonEvidence title="Immutable implementation metadata" value={value} />
      </details>
    </section>
  )
}
