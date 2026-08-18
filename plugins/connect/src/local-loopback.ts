function isConnectPairingHost(url: URL): boolean {
  if (url.protocol === "http:" && url.hostname.endsWith(".localhost")) {
    return true;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === "getbb.app" || url.hostname.endsWith(".getbb.app"))
  );
}

/**
 * Use Vite as the tunneled origin when a source-dev bb is running.
 * Packaged / `pnpm start` leave `BB_DEV_APP_PORT` unset, so the bare handle
 * keeps serving the server-hosted SPA. `pnpm dev` splits the UI onto Vite;
 * without this rewrite, https://<handle>.getbb.app hits GET / on the API
 * and shows the plain text "bb server".
 */
export function resolveLocalCloudLoopbackUrl(
  serverUrl: string | undefined,
  rawDevAppPort: string | undefined,
): string | null {
  if (!serverUrl || !rawDevAppPort) return null;
  const port = Number(rawDevAppPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (!isConnectPairingHost(url)) return null;
  return `http://127.0.0.1:${port}`;
}
