import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { eq } from "drizzle-orm"
import {
  authAccount,
  authSession,
  authUser,
  authVerification,
  type createDatabase,
} from "@workspace/db"
import { createAdminBoundary } from "./boundary"
import {
  ATLAS_OWNER_ID,
  FRESH_SECONDS,
  SESSION_SECONDS,
  readAdminAuthConfig,
} from "./config"

type Database = ReturnType<typeof createDatabase>["db"]
type AuthDatabase =
  Database | Parameters<Parameters<Database["transaction"]>[0]>[0]

export function createAdminAuth(
  db: Database,
  env: Record<string, string | undefined> = process.env
) {
  const config = readAdminAuthConfig(env)

  if (!config) {
    return createAdminBoundary(null, null)
  }

  const buildAuth = (database: AuthDatabase) =>
    betterAuth({
      appName: "Atlas",
      baseURL: config.origin,
      basePath: "/api/auth",
      secret: config.secret,
      trustedOrigins: [config.origin],
      // Better Call otherwise prints raw driver errors even with logger.disabled.
      // Let the Atlas boundary sanitize unexpected errors and roll back writes.
      onAPIError: { throw: true },

      database: drizzleAdapter(database, {
        provider: "pg",
        transaction: true,
        schema: {
          user: authUser,
          session: authSession,
          account: authAccount,
          verification: authVerification,
        },
      }),

      emailAndPassword: {
        enabled: true,
        disableSignUp: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        revokeSessionsOnPasswordReset: true,
      },

      account: {
        accountLinking: {
          enabled: false,
        },
      },

      session: {
        expiresIn: SESSION_SECONDS,
        disableSessionRefresh: true,
        freshAge: FRESH_SECONDS,
        cookieCache: {
          enabled: false,
        },
      },

      databaseHooks: {
        session: {
          create: {
            before: async (session) => {
              // Defense in depth if another account somehow exists.
              if (session.userId !== ATLAS_OWNER_ID) {
                return false
              }
            },
          },
        },
      },

      advanced: {
        useSecureCookies: true,
        trustedProxyHeaders: false,

        // Do not trust client-supplied IP headers. With tracking left
        // enabled, the library uses a shared fallback rate-limit bucket
        // when it cannot determine a trusted client IP.
        ipAddress: {
          ipAddressHeaders: [],
        },

        defaultCookieAttributes: {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
        },
      },

      rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: {
          "/sign-in/email": {
            window: 60,
            max: 10,
          },
          "/change-password": {
            window: 60,
            max: 5,
          },
        },
      },

      // Production should record separate, redacted security events.
      // Do not emit library errors containing request/session details.
      logger: {
        disabled: true,
      },
    })

  const auth = buildAuth(db)
  return createAdminBoundary(config, {
    handler: async (request) => {
      // Password update, old-session deletion and replacement-session creation
      // must commit together. Per-operation adapter transactions are insufficient.
      let failedResponse: Response | undefined
      try {
        return await db.transaction(async (tx) => {
          // Serialize sign-in with password changes so an old-password login
          // cannot mint a session after the revocation transaction commits.
          await tx
            .select({ id: authUser.id })
            .from(authUser)
            .where(eq(authUser.id, ATLAS_OWNER_ID))
            .for("update")
          const response = await buildAuth(tx).handler(request)
          if (!response.ok) {
            failedResponse = response
            throw new Error("auth_mutation_failed")
          }
          return response
        })
      } catch {
        // A rollback must never publish a cookie for an uncommitted session.
        if (failedResponse) {
          await failedResponse.body?.cancel().catch(() => undefined)
          return new Response(null, { status: failedResponse.status })
        }
        throw new Error("auth_mutation_failed")
      }
    },

    getSession: async (headers) => {
      const result = await auth.api.getSession({ headers })
      if (!result) return null

      // Deliberate allowlist: no bearer token, IP address,
      // user-agent string, provider credentials or arbitrary fields.
      return {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
        },
        session: {
          id: result.session.id,
          userId: result.session.userId,
          createdAt: result.session.createdAt,
          expiresAt: result.session.expiresAt,
        },
      }
    },
  })
}

export { ATLAS_OWNER_ID } from "./config"
