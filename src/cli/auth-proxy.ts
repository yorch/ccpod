import { networkInterfaces } from 'node:os';
import chalk from 'chalk';
import { AuthProxy, generateSentinelApiKey } from '../auth/proxy.ts';
import type { ProxyInjection } from '../container/builder.ts';
import { dockerExec } from '../runtime/docker.ts';
import type { ResolvedConfig } from '../types/index.ts';

// On native Linux the container reaches the host via `host-gateway`, which is
// the default bridge's gateway IP — not loopback. Bind the proxy to exactly
// that address so it isn't exposed on every host interface (LAN). Returns
// undefined on macOS (loopback is enough) or when it can't be determined, in
// which case AuthProxy falls back to 0.0.0.0 (still gated by the sentinel key).
async function bridgeGatewayIp(): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    return undefined;
  }
  try {
    const { exitCode, stdout } = await dockerExec([
      'network',
      'inspect',
      'bridge',
      '--format',
      '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
    ]);
    if (exitCode !== 0) {
      return undefined;
    }
    const local = new Set(
      Object.values(networkInterfaces())
        .flat()
        .map((i) => i?.address),
    );
    // Only usable if it is an address of *this* host: under VM-backed
    // runtimes (Colima, Docker Desktop for Linux, rootless) the bridge
    // gateway lives inside the VM and binding it would fail.
    return stdout
      .trim()
      .split(/\s+/)
      .find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && local.has(ip));
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` with a local auth proxy when the profile uses `auth.type: proxy`
 * (and `needed` is true); otherwise call `fn(null)`. The proxy is always
 * stopped afterwards. `fn` receives the base URL + sentinel key to pass to
 * `buildContainerSpec` so the container talks to the proxy instead of holding
 * OAuth credentials.
 */
export async function withAuthProxy<T>(
  config: ResolvedConfig,
  needed: boolean,
  fn: (proxy: ProxyInjection | null) => Promise<T>,
): Promise<T> {
  if (config.auth.type !== 'proxy' || !needed) {
    return fn(null);
  }
  console.log(chalk.dim('Starting auth proxy...'));
  const sentinelKey = generateSentinelApiKey();
  const hostname = await bridgeGatewayIp();
  const authProxy = new AuthProxy({
    sentinelKey,
    ...(hostname ? { hostname } : {}),
  });
  await authProxy.start();
  console.log(chalk.dim(`  Auth proxy listening on ${authProxy.address}`));
  try {
    // host.docker.internal (not the proxy's bind address) so the container
    // reaches the host whether the proxy is bound to 127.0.0.1 (macOS) or
    // 0.0.0.0 (Linux).
    return await fn({
      baseUrl: `http://host.docker.internal:${authProxy.resolvedPort}`,
      sentinelKey,
    });
  } finally {
    await authProxy.stop();
  }
}
