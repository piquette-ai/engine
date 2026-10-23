/**
 * A minimal Cloudflare REST client for provisioning (#214). Node (it is
 * handed a fetch). The token is sent as a Bearer header and is never echoed:
 * results carry an HTTP status and Cloudflare's `errors[].message` only, and
 * a missing credential is reported by the env var's NAME.
 */

const API = "https://api.cloudflare.com/client/v4";

export interface CfResult<T = unknown> {
  ok: boolean;
  status: number;
  errors: string[];
  result?: T;
}

export interface CfApi {
  get<T = unknown>(path: string): Promise<CfResult<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<CfResult<T>>;
}

export interface CfCredentials {
  token: string;
  /** The env var name the token came from, used in messages only. */
  tokenEnv: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function cfApi(credentials: CfCredentials, fetchImpl: FetchLike = fetch): CfApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<CfResult<T>> {
    if (!credentials.token) return { ok: false, status: 0, errors: [`${credentials.tokenEnv} is not set`] };
    let res: Response;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${credentials.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return { ok: false, status: 0, errors: [`network error calling ${method} ${path}`] };
    }
    const json = (await res.json().catch(() => ({}))) as { result?: T; errors?: { message?: string }[] };
    const errors = (json.errors ?? []).map((e) => e.message).filter((m): m is string => typeof m === "string" && m.length > 0);
    return { ok: res.ok, status: res.status, errors, ...(json.result !== undefined ? { result: json.result } : {}) };
  }
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body ?? {}) };
}
