import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { apiProxyTarget } from "../../scripts/verification-isolation.mjs"

const apiProxy = {
  "/api": {
    target: apiProxyTarget(process.env),
    changeOrigin: false,
  },
}

export default defineConfig(({ mode }) => {
  // Server-side only: never expose private host configuration through VITE_*.
  const { ATLAS_DEV_ALLOWED_HOST: allowedHost } = loadEnv(
    mode,
    import.meta.dirname,
    "ATLAS_DEV_"
  )
  if (
    allowedHost &&
    (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(allowedHost) ||
      allowedHost.includes(".."))
  )
    throw new Error("ATLAS_DEV_ALLOWED_HOST must be one exact hostname")
  const allowedHosts = allowedHost ? [allowedHost] : []

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      allowedHosts,
      proxy: apiProxy,
    },
    preview: {
      allowedHosts,
      proxy: apiProxy,
    },
  }
})
