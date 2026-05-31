export function normalizeAtlassianBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Confluence baseUrl is required.");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.includes(".")) return `https://${trimmed}`;
  // Bare subdomain — assume Atlassian Cloud
  return `https://${trimmed}.atlassian.net`;
}
