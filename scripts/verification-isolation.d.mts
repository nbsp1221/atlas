type Environment = Record<string, string | undefined>
export function createVerificationRunId(): string
export function verificationDatabaseName(purpose: string, runId: string): string
export function verificationDatabaseUrl(purpose: string, runId: string): string
export function verificationPostgresArgs(args: string[]): string[]
export function verificationEvidenceDirectory(
  area: string,
  runId?: string
): string
export function verificationServerConfig(env: Environment): {
  apiPort: number
  webPort: number
  apiUrl: string
  webUrl: string
  env: Record<string, string>
}
export function apiProxyTarget(env: Environment): string
export function verificationWebServers(env: Environment): {
  command: string
  url: string
  env: Record<string, string>
  reuseExistingServer: false
  ignoreHTTPSErrors?: boolean
  timeout: number
}[]
export function assertPortAvailable(portNumber: number): Promise<void>
