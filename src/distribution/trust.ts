import tls from "node:tls";

/** Called by standalone startup before any application network requests. */
export function configureSystemTrust() {
  if (process.env.NODE_USE_SYSTEM_CA === "0") return;
  // Older runtimes may lack these APIs; the bundled Node supports both.
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") return;
  tls.setDefaultCACertificates([
    ...tls.getCACertificates("default"),
    ...tls.getCACertificates("system"),
  ]);
}

export function releaseRequestError(error: unknown): Error {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
  const detail = code ?? (error instanceof Error ? error.message : String(error));
  const certificateError = code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(code);
  const hint = certificateError
    ? " Check that your company's CA certificate is trusted by your operating system, or provide its PEM file with NODE_EXTRA_CA_CERTS."
    : " Check network and proxy access to GitHub.";
  return new Error(`Could not check the latest Mason release on GitHub (${detail}).${hint}`, { cause: error });
}
