import axios from "axios";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

type CachedToken = {
  token: string;
  expiresAt: number;
};

const tokenCache = new Map<string, CachedToken>();

type Region = "NA" | "EU" | "AU";

const REGION_ENDPOINTS: Record<Region, string> = {
  NA: "https://sellingpartnerapi-na.amazon.com",
  EU: "https://sellingpartnerapi-eu.amazon.com",
  AU: "https://sellingpartnerapi-fe.amazon.com"
};

export type SpApiConfig = {
  lwaClientId: string;
  lwaClientSecret: string;
  refreshToken: string;
  appName: string;
  region: Region;
};

export async function getAccessToken(config: SpApiConfig): Promise<string> {
  const cacheKey = `${config.lwaClientId}:${config.refreshToken}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: config.lwaClientId,
    client_secret: config.lwaClientSecret
  });

  const response = await axios.post(LWA_TOKEN_URL, payload.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    }
  });

  const accessToken = response.data.access_token as string;
  const expiresIn = Number(response.data.expires_in ?? 3600);
  tokenCache.set(cacheKey, {
    token: accessToken,
    expiresAt: now + expiresIn * 1000
  });

  return accessToken;
}

export function getRegionEndpoint(region: Region): string {
  return REGION_ENDPOINTS[region];
}

function getAmzDate() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
}

function getUserAgent(appName: string) {
  return `${appName}/1.0 (Language=JavaScript; Platform=Node.js/${process.version})`;
}

export async function spApiGet<T>(path: string, config: SpApiConfig, params?: Record<string, string>) {
  const token = await getAccessToken(config);
  const endpoint = getRegionEndpoint(config.region);
  const url = `${endpoint}${path}`;

  const response = await axios.get<T>(url, {
    params,
    headers: {
      "x-amz-access-token": token,
      "x-amz-date": getAmzDate(),
      "User-Agent": getUserAgent(config.appName)
    }
  });

  return response.data;
}

export async function spApiPost<T>(path: string, config: SpApiConfig, data?: unknown) {
  const token = await getAccessToken(config);
  const endpoint = getRegionEndpoint(config.region);
  const url = `${endpoint}${path}`;

  const response = await axios.post<T>(url, data ?? {}, {
    headers: {
      "x-amz-access-token": token,
      "x-amz-date": getAmzDate(),
      "User-Agent": getUserAgent(config.appName),
      "Content-Type": "application/json"
    }
  });

  return response.data;
}
