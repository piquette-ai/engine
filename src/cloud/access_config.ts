/**
 * Cloudflare Access configuration parsing. Node-free and jose-free so the
 * config schema, the Worker and an embedding host can all share it; the JWT
 * verification itself stays in cloud/.
 */

export const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

export interface AccessBindings {
  ACCESS_TEAM_DOMAIN?: string;
  /** Comma-separated list of Access application AUD tags. */
  ACCESS_AUD?: string;
}

export type AccessConfig = { teamDomain: string; audiences: string[]; issuer: string; certsUrl: string };

export function accessConfig(b: AccessBindings): AccessConfig | { error: string } {
  const teamDomain = (b.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!TEAM_DOMAIN.test(teamDomain)) return { error: "ACCESS_TEAM_DOMAIN" };
  const audiences = (b.ACCESS_AUD ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (audiences.length === 0 || audiences.some((a) => /\s/.test(a))) return { error: "ACCESS_AUD" };
  return { teamDomain, audiences, issuer: `https://${teamDomain}`, certsUrl: `https://${teamDomain}/cdn-cgi/access/certs` };
}
