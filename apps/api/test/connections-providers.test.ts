import test from "node:test"
import assert from "node:assert/strict"
import {
  checkOpenAI,
  checkAnthropic,
  checkTelegram,
  exchangeGoogleCode,
  refreshGoogleTokens,
  GoogleGrantError,
  ProviderError,
  newOAuthProof,
  googleAuthorizationUrl,
  GOOGLE_SCOPES,
  checkGoogle,
  type ProviderFetch,
} from "@workspace/integrations"
const fake =
  (
    work: (url: string, init: RequestInit) => Response | Promise<Response>
  ): ProviderFetch =>
  async (input, init) =>
    work(String(input), init ?? {})
test("API-key probes are fixed-endpoint read-only checks, no inference", async () => {
  for (const [check, host] of [
    [checkOpenAI, "api.openai.com"],
    [checkAnthropic, "api.anthropic.com"],
  ] as const) {
    await check(
      "synthetic-key",
      fake((url, init) => {
        assert.equal(new URL(url).hostname, host)
        assert.equal(new URL(url).pathname, "/v1/models")
        assert.equal(init.redirect, "error")
        assert.equal(init.method, undefined)
        return Response.json({ data: [] })
      })
    )
  }
  const bot = await checkTelegram(
    "123:synthetic",
    fake((url, init) => {
      assert.equal(new URL(url).pathname, "/bot123:synthetic/getMe")
      assert.equal(init.method, "POST")
      return Response.json({ ok: true, result: { id: 123, is_bot: true } })
    })
  )
  assert.equal(bot.principalId, "123")
})
test("provider exceptions never expose response, URL, headers or token", async () => {
  const canary = "synthetic-private-canary"
  await assert.rejects(
    () =>
      checkOpenAI(
        canary,
        fake(() => {
          throw new Error(canary)
        })
      ),
    (error) =>
      error instanceof ProviderError &&
      !JSON.stringify(error).includes(canary) &&
      !error.message.includes(canary)
  )
  await assert.rejects(
    () =>
      checkOpenAI(
        canary,
        fake(() => Response.json({ error: canary }, { status: 401 }))
      ),
    /provider_auth_rejected/
  )
})
test("OAuth proof unique; S256, offline code flow, fixed callback and scopes", () => {
  const proof = newOAuthProof(),
    other = newOAuthProof()
  assert.notEqual(proof.state, other.state)
  assert.notEqual(proof.verifier, other.verifier)
  const url = new URL(
    googleAuthorizationUrl(
      {
        clientId: "unit.apps.googleusercontent.com",
        clientSecret: "synthetic",
        redirectUri:
          "https://atlas.example/api/settings/connections/google/callback",
      },
      proof.state,
      proof.verifier
    )
  )
  assert.equal(url.origin, "https://accounts.google.com")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("access_type"), "offline")
  assert.equal(url.searchParams.get("response_type"), "code")
  assert.equal(url.searchParams.get("state"), proof.state)
  assert(!url.toString().includes("synthetic"))
  assert(!url.toString().includes(proof.verifier))
})
test("OAuth refresh preserves omitted refresh token, records rotated token, normalizes email scope", async () => {
  const client = {
    clientId: "unit",
    clientSecret: "synthetic",
    redirectUri: "https://atlas.example/callback",
  }
  const previous = {
    accessToken: "old-synthetic",
    refreshToken: "synthetic-refresh",
    expiresAt: 0,
    scopes: GOOGLE_SCOPES,
  }
  const tokens = await refreshGoogleTokens(
    client,
    previous,
    fake((url, init) => {
      assert.equal(url, "https://oauth2.googleapis.com/token")
      assert.equal(init.redirect, "error")
      return Response.json({
        access_token: "new-synthetic",
        expires_in: 3600,
        token_type: "Bearer",
      })
    })
  )
  assert.equal(tokens.refreshToken, previous.refreshToken)
  assert.deepEqual(tokens.scopes, GOOGLE_SCOPES)
  const exchanged = await exchangeGoogleCode(
    client,
    "unit-code",
    "unit-verifier",
    fake((_url, init) => {
      const body = init.body as URLSearchParams
      assert.equal(body.get("code_verifier"), "unit-verifier")
      return Response.json({
        access_token: "new-synthetic",
        refresh_token: "rotated-synthetic",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify",
      })
    })
  )
  assert.equal(exchanged.refreshToken, "rotated-synthetic")
  assert.deepEqual(exchanged.scopes, GOOGLE_SCOPES)
  await assert.rejects(
    () =>
      refreshGoogleTokens(
        client,
        previous,
        fake(() =>
          Response.json(
            { error: "invalid_grant", description: "must never leak" },
            { status: 400 }
          )
        )
      ),
    GoogleGrantError
  )
})
test("Google principal only comes from authenticated userinfo", async () => {
  const result = await checkGoogle(
    { accessToken: "synthetic", expiresAt: 1, scopes: GOOGLE_SCOPES },
    fake((url, init) => {
      assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo")
      assert.equal(
        (init.headers as Record<string, string>).authorization,
        "Bearer synthetic"
      )
      return Response.json({ sub: "verified-sub", email_verified: true })
    })
  )
  assert.equal(result.principalId, "verified-sub")
})
