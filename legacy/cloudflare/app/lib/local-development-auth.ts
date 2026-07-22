const LOCAL_DEVELOPMENT_HOSTS = [
  /^localhost(?::\d{1,5})?$/i,
  /^127\.0\.0\.1(?::\d{1,5})?$/,
  /^\[::1\](?::\d{1,5})?$/,
  /^::1$/,
];

export type LocalDevelopmentIdentityOptions = {
  development?: boolean;
  host?: string | null;
  configuredEmail?: string;
};

/**
 * Returns an explicitly configured local identity only for a development
 * request made directly to a loopback host. Hosted and network-accessible
 * requests must continue to rely on the platform authentication headers.
 */
export function localDevelopmentUserEmail(
  options: LocalDevelopmentIdentityOptions,
): string | null {
  if (options.development !== true) return null;

  const host = options.host?.trim() ?? "";
  if (!LOCAL_DEVELOPMENT_HOSTS.some((pattern) => pattern.test(host))) {
    return null;
  }

  const email = options.configuredEmail?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
