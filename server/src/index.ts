import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { spApiGet } from "./spapi.js";
import type { StoreData, ReviewStats } from "./types.js";
import { mergeReviewStats, requestReviews } from "./reviews.js";
import {
  computeAge90Plus,
  createReport,
  downloadReport,
  getReport,
  getReportDocument,
  listReports,
  parseNumber,
  parsePercent,
  parseTabDelimited
} from "./reports.js";

const app = express();

const PORT = Number(process.env.PORT ?? 4242);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const appName = process.env.APP_NAME ?? "FBAInventoryDashboard";
const lwaClientId = process.env.LWA_CLIENT_ID ?? "";
const lwaClientSecret = process.env.LWA_CLIENT_SECRET ?? "";

const REGION_CONFIG = {
  US: {
    region: "NA",
    marketplaceId: "ATVPDKIKX0DER",
    refreshToken: process.env.REFRESH_TOKEN_NA ?? ""
  },
  CA: {
    region: "NA",
    marketplaceId: "A2EUQ1WTGCTBG2",
    refreshToken: process.env.REFRESH_TOKEN_NA ?? ""
  },
  UK: {
    region: "EU",
    marketplaceId: "A1F83G8C2ARO7P",
    refreshToken: process.env.REFRESH_TOKEN_EU ?? ""
  },
  AU: {
    region: "AU",
    marketplaceId: "A39IBJ37TRP1C6",
    refreshToken: process.env.REFRESH_TOKEN_AU ?? ""
  }
} as const;

type StoreKey = keyof typeof REGION_CONFIG;

let reviewStats: ReviewStats = {
  today: 0,
  last7Days: 0,
  last30Days: 0
};

type PlanningItem = {
  sku: string;
  title: string;
  available: number;
  inbound: number;
  reserved: number;
  sales7d: number;
  sellThrough: number;
  age90plusUnits: number;
  estimatedLtsf: number;
  estimatedStorage: number;
};

type PlanningCache = {
  fetchedAt: number;
  items: Map<string, PlanningItem>;
  agingRisk: number;
};

const planningCache = new Map<StoreKey, PlanningCache>();
const REPORT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const reportCooldownUntil = new Map<StoreKey, number>();
const REPORT_COOLDOWN_MS = 15 * 60 * 1000;
let planningReportHeadersLogged = false;
const AUTO_REPORT_REFRESH = process.env.REPORT_AUTO_REFRESH !== "false";
const shipmentsCache = new Map<StoreKey, { fetchedAt: number; shipments: StoreData["shipments"] }>();
const SHIPMENTS_CACHE_TTL_MS = 5 * 60 * 1000;

function getPlanningCache(store: StoreKey) {
  const cached = planningCache.get(store);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > REPORT_CACHE_TTL_MS) return null;
  return cached;
}

function getShipmentsCache(store: StoreKey) {
  const cached = shipmentsCache.get(store);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > SHIPMENTS_CACHE_TTL_MS) return null;
  return cached;
}

function getSpApiConfig(store: StoreKey) {
  const region = REGION_CONFIG[store];
  return {
    lwaClientId,
    lwaClientSecret,
    refreshToken: region.refreshToken,
    appName,
    region: region.region
  } as const;
}

function hasCredentials(store: StoreKey) {
  const region = REGION_CONFIG[store];
  return Boolean(lwaClientId && lwaClientSecret && region.refreshToken);
}

async function fetchInventorySnapshot(store: StoreKey): Promise<StoreData> {
  const fallback: StoreData = {
    code: store,
    name: store === "US" ? "United States" : store === "UK" ? "United Kingdom" : store === "CA" ? "Canada" : "Australia",
    marketplace: `Amazon ${store}`,
    currency: store === "US" ? "USD" : store === "UK" ? "GBP" : store === "CA" ? "CAD" : "AUD",
    ipiScore: 0,
    storageUtilization: 0,
    agingRisk: 0,
    strandedUnits: 0,
    suppressedUnits: 0,
    inventory: [],
    shipments: [],
    warnings: [],
    reviewStats: reviewStats
  };

  if (!hasCredentials(store)) return fallback;

  const config = getSpApiConfig(store);

  try {
    const inventoryResponse = await spApiGet<{
      payload?: { inventorySummaries?: any[] };
    }>("/fba/inventory/v1/summaries", config, {
      marketplaceIds: REGION_CONFIG[store].marketplaceId,
      granularityType: "Marketplace",
      granularityId: REGION_CONFIG[store].marketplaceId,
      details: "true"
    });

    const inventorySummaries = inventoryResponse.payload?.inventorySummaries ?? [];
    const shipments = await fetchInboundShipments(store);
    let inventory = inventorySummaries.map((summary) => {
      const details = summary.inventoryDetails ?? {};
      const fulfillable = pickNumber(details.fulfillableQuantity);
      const totalQuantity = pickNumber(summary.totalQuantity, details.totalQuantity, summary.totalAvailableQuantity);
      const reserved = pickNumber(details.reservedQuantity?.totalReservedQuantity, summary.totalReservedQuantity);
      const inboundTotal = pickNumber(details.inboundQuantity, summary.totalInboundQuantity);
      const inboundWorking = pickNumber(details.inboundWorkingQuantity, summary.inboundWorkingQuantity, summary.totalInboundWorkingQuantity);
      const inboundShipped = pickNumber(details.inboundShippedQuantity, summary.inboundShippedQuantity, summary.totalInboundShippedQuantity);
      const inboundReceiving = pickNumber(details.inboundReceivingQuantity, summary.inboundReceivingQuantity, summary.totalInboundReceivingQuantity);
      const inbound = inboundTotal ?? inboundWorking + inboundShipped + inboundReceiving;

      const sku = summary.sellerSku ?? summary.asin ?? "UNKNOWN";
      const title =
        summary.productName ??
        summary.itemName ??
        summary.itemTitle ??
        summary.title ??
        sku;

      return {
        sku,
        title,
        onHand: fulfillable ?? totalQuantity ?? 0,
        reserved: reserved ?? 0,
        inbound,
        sales7d: 0,
        age90plus: false,
        stranded: 0,
        suppressed: 0,
        sellThrough: 0,
        margin: 0
      };
    });

    const planning = getPlanningCache(store);
    if (planning) {
      const merged = new Map<string, PlanningItem>(planning.items);

      inventory = inventory.map((item) => {
        const planningItem = merged.get(item.sku);
        if (planningItem) {
          merged.delete(item.sku);
          return {
            ...item,
            title: planningItem.title || item.title,
            onHand: item.onHand === 0 ? planningItem.available : item.onHand,
            reserved: item.reserved === 0 ? planningItem.reserved : item.reserved,
            inbound: item.inbound === 0 ? planningItem.inbound : item.inbound,
            sales7d: planningItem.sales7d,
            age90plus: planningItem.age90plusUnits > 0,
            sellThrough: planningItem.sellThrough
          };
        }
        return item;
      });

      for (const planningItem of merged.values()) {
        inventory.push({
          sku: planningItem.sku,
          title: planningItem.title || planningItem.sku,
          onHand: planningItem.available,
          reserved: planningItem.reserved,
          inbound: planningItem.inbound,
          sales7d: planningItem.sales7d,
          age90plus: planningItem.age90plusUnits > 0,
          stranded: 0,
          suppressed: 0,
          sellThrough: planningItem.sellThrough,
          margin: 0
        });
      }

      return {
        ...fallback,
        inventory,
        shipments,
        agingRisk: planning.agingRisk
      };
    }

    return {
      ...fallback,
      inventory,
      shipments
    };
  } catch (error) {
    console.error(`[SP-API] Inventory fetch failed for ${store}: ${getErrorSummary(error)}`);
  }

  return fallback;
}

async function fetchAllStores(): Promise<StoreData[]> {
  const stores: StoreKey[] = ["US", "UK", "CA", "AU"];
  return Promise.all(stores.map((store) => fetchInventorySnapshot(store)));
}

app.get("/api/stores", async (_req, res) => {
  const data = await fetchAllStores();
  res.json({ stores: data });
});

app.get("/api/reports/planning/status", (_req, res) => {
  const status = REPORT_STORES.map((store) => {
    const cached = planningCache.get(store);
    const cooldownUntil = reportCooldownUntil.get(store) ?? 0;
    return {
      store,
      cached: Boolean(cached),
      cachedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
      cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null
    };
  });
  res.json({ status });
});

app.post("/api/reports/planning/refresh", (req, res) => {
  const store = String(req.query.store ?? "US") as StoreKey;
  if (!REPORT_STORES.includes(store)) {
    res.status(400).json({ error: `Unsupported store. Allowed: ${REPORT_STORES.join(", ")}` });
    return;
  }

  runBackground("manualPlanningRefresh", refreshPlanningReport(store));
  res.json({ ok: true });
});

app.get("/api/reviews/stats", (_req, res) => {
  res.json(reviewStats);
});

app.get("/api/debug/marketplaces", async (_req, res) => {
  try {
    const stores: StoreKey[] = ["US", "UK", "CA", "AU"];
    const results = await Promise.all(
      stores.map(async (store) => {
        if (!hasCredentials(store)) {
          return { store, error: "Missing credentials" };
        }
        const config = getSpApiConfig(store);
        const response = await spApiGet<{
          payload?: Array<{
            marketplace?: { id?: string; name?: string; countryCode?: string };
            sellerId?: string;
            type?: string;
          }>;
        }>("/sellers/v1/marketplaceParticipations", config);

        return {
          store,
          marketplaces: response.payload ?? []
        };
      })
    );
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: getErrorSummary(error) });
  }
});

app.get("/api/debug/inventory", async (req, res) => {
  const store = String(req.query.store ?? "US") as StoreKey;
  if (!REGION_CONFIG[store]) {
    res.status(400).json({ error: "Invalid store. Use US, UK, CA, or AU." });
    return;
  }
  if (!hasCredentials(store)) {
    res.status(400).json({ error: "Missing credentials for this store." });
    return;
  }

  const config = getSpApiConfig(store);
  try {
    const inventoryResponse = await spApiGet<{
      payload?: { inventorySummaries?: any[] };
    }>("/fba/inventory/v1/summaries", config, {
      marketplaceIds: REGION_CONFIG[store].marketplaceId,
      granularityType: "Marketplace",
      granularityId: REGION_CONFIG[store].marketplaceId,
      details: "true"
    });

    const summaries = inventoryResponse.payload?.inventorySummaries ?? [];
    res.json({
      store,
      count: summaries.length,
      sample: summaries.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ error: getErrorSummary(error) });
  }
});

app.post("/api/reviews/request", async (_req, res) => {
  // Endpoint for manual triggering (optional for debugging)
  // Not exposed to the UI yet.
  res.json({ ok: true });
});

// Daily batch schedule (09:00 local time)
cron.schedule("0 9 * * *", async () => {
  const now = new Date();
  const stores: StoreKey[] = ["US", "UK", "CA", "AU"];

  for (const store of stores) {
    if (!hasCredentials(store)) continue;
    const config = getSpApiConfig(store);
    const marketplaceId = REGION_CONFIG[store].marketplaceId;

    // TODO: Pull eligible orders for review requests, excluding refunds/returns.
    // TODO: Use Orders API + Returns API or financial events to filter out returns/refunds.
    const eligibleOrderIds: string[] = [];

    if (eligibleOrderIds.length === 0) continue;

    const result = await requestReviews(
      { marketplaceId, orderIds: eligibleOrderIds, region: REGION_CONFIG[store].region },
      config
    );

    reviewStats = mergeReviewStats(reviewStats, result.success.length, now);
  }
});

async function refreshPlanningReport(store: StoreKey) {
  if (!hasCredentials(store)) return;
  if (getPlanningCache(store)) return;

  const config = getSpApiConfig(store);
  const marketplaceId = REGION_CONFIG[store].marketplaceId;

  try {
    const reused = await loadLatestPlanningReport(store);
    if (reused) return;

    const cooldown = reportCooldownUntil.get(store) ?? 0;
    if (Date.now() < cooldown) {
      // We're rate-limited for report creation. We'll still be able to reuse
      // an existing report once it finishes, via the next scheduled/manual run.
      return;
    }

    const reportId = await createReportOnce("GET_FBA_INVENTORY_PLANNING_DATA", [marketplaceId], config, store);
    if (!reportId) return;

    let reportDocumentId = "";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const report = await getReport(reportId, config);
      if (report?.processingStatus === "DONE" && report.reportDocumentId) {
        reportDocumentId = report.reportDocumentId;
        break;
      }
      if (report?.processingStatus === "CANCELLED" || report?.processingStatus === "FATAL") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    if (!reportDocumentId) return;

    const document = await getReportDocument(reportDocumentId, config);
    if (!document?.url) return;

    const content = await downloadReport(document.url, document.compressionAlgorithm);
    const rows = parseTabDelimited(content);

    const items = new Map<string, PlanningItem>();
    let agingRisk = 0;

    rows.forEach((row) => {
      const sku = row["sku"] || row["seller-sku"] || row["seller-sku-sku"] || "";
      if (!sku) return;

      const title = row["product-name"] || row["item-name"] || "";
      const available = parseNumber(row["available"] || row["available-quantity"]);
      const inbound =
        parseNumber(row["inbound-working-quantity"]) +
        parseNumber(row["inbound-shipped-quantity"]) +
        parseNumber(row["inbound-receiving-quantity"]) +
        parseNumber(row["inbound-quantity"]);
      const reserved = parseNumber(row["reserved-quantity"] || row["total-reserved-quantity"]);
      const sales7d =
        parseNumber(row["units-shipped-t7"]) ||
        parseNumber(row["sales-shipped-last-7-days"]);
      const sellThrough = parsePercent(row["sell-through"]);
      const age90plusUnits = computeAge90Plus(row);
      const estimatedLtsf =
        parseNumber(row["estimated-ltsf-next-charge"]) +
        parseNumber(row["projected-ltsf-11-mo"]);
      const estimatedStorage = parseNumber(row["estimated-storage-cost-next-month"]);

      agingRisk += estimatedLtsf + estimatedStorage;

      items.set(sku, {
        sku,
        title,
        available,
        inbound,
        reserved,
        sales7d,
        sellThrough,
        age90plusUnits,
        estimatedLtsf,
        estimatedStorage
      });
    });

    planningCache.set(store, {
      fetchedAt: Date.now(),
      items,
      agingRisk
    });

    console.log(`[SP-API] Planning report cached for ${store} (${items.size} rows)`);
  } catch (error) {
    console.error(`[SP-API] Planning report failed for ${store}: ${getErrorSummary(error)}`);
  }
}

const REPORT_STORES: StoreKey[] = ["US"];

let planningRefreshInProgress = false;
async function refreshAllPlanningReports() {
  if (planningRefreshInProgress) return;
  planningRefreshInProgress = true;
  try {
    for (const store of REPORT_STORES) {
      await refreshPlanningReport(store);
      await sleep(15000);
    }
  } finally {
    planningRefreshInProgress = false;
  }
}

function runBackground(label: string, task: Promise<void>) {
  void task.catch((error) => {
    console.error(`[SP-API] Background task failed (${label}): ${getErrorSummary(error)}`);
  });
}

if (AUTO_REPORT_REFRESH) {
  setTimeout(() => {
    runBackground("initialPlanningRefresh", refreshAllPlanningReports());
  }, 5000);

  // Try periodically, but refreshPlanningReport() will no-op if cached or cooling down.
  cron.schedule("*/15 * * * *", () => {
    runBackground("scheduledPlanningRefresh", refreshAllPlanningReports());
  });
}

function getErrorSummary(error: unknown) {
  const err = error as any;
  const status = err?.response?.status;
  const code = err?.code;
  const message =
    err?.response?.data?.errors?.[0]?.message ||
    err?.response?.data?.message ||
    err?.message ||
    "Unknown error";
  return [status, code, message].filter(Boolean).join(" | ");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatEta(dateString?: string) {
  if (!dateString) return "TBD";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "TBD";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function fetchInboundShipments(store: StoreKey): Promise<StoreData["shipments"]> {
  const cached = getShipmentsCache(store);
  if (cached) return cached.shipments;
  if (!hasCredentials(store)) return [];

  const config = getSpApiConfig(store);
  const lastUpdatedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const response = await spApiGet<{
      payload?: {
        ShipmentData?: Array<Record<string, any>>;
        shipmentData?: Array<Record<string, any>>;
      };
    }>("/fba/inbound/v0/shipments", config, {
      MarketplaceId: REGION_CONFIG[store].marketplaceId,
      QueryType: "DATE_RANGE",
      LastUpdatedAfter: lastUpdatedAfter,
      ShipmentStatusList: "WORKING,SHIPPED,IN_TRANSIT,DELIVERED,RECEIVING,CHECKED_IN"
    });

    const data = response.payload?.ShipmentData ?? response.payload?.shipmentData ?? [];
    const shipments = data.map((shipment) => {
      const id = shipment.ShipmentId ?? shipment.shipmentId ?? "UNKNOWN";
      const status = shipment.ShipmentStatus ?? shipment.shipmentStatus ?? "Unknown";
      const etaRaw =
        shipment.EstimatedArrivalDate ??
        shipment.estimatedArrivalDate ??
        shipment.ExpectedArrivalDate ??
        shipment.expectedArrivalDate;
      const units =
        pickNumber(
          shipment.TotalUnits,
          shipment.totalUnits,
          shipment.TotalQuantity,
          shipment.totalQuantity,
          shipment.BoxCount,
          shipment.boxCount
        ) ?? 0;

      return {
        id,
        status,
        eta: formatEta(etaRaw),
        units
      };
    });

    shipmentsCache.set(store, { fetchedAt: Date.now(), shipments });
    return shipments;
  } catch (error) {
    console.error(`[SP-API] Inbound shipments fetch failed for ${store}: ${getErrorSummary(error)}`);
    return [];
  }
}

async function createReportOnce(
  reportType: string,
  marketplaceIds: string[],
  config: ReturnType<typeof getSpApiConfig>,
  store: StoreKey
) {
  try {
    return await createReport(reportType, marketplaceIds, config);
  } catch (error) {
    const status = (error as any)?.response?.status;
    if (status === 429) {
      const retryAfter = Number((error as any)?.response?.headers?.["retry-after"] ?? 0);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : REPORT_COOLDOWN_MS;
      reportCooldownUntil.set(store, Date.now() + backoff);
      console.warn(`[SP-API] Rate limited creating report. Cooling down for ${Math.round(backoff / 1000)}s.`);
      return "";
    }
    throw error;
  }
}

async function loadLatestPlanningReport(store: StoreKey) {
  const config = getSpApiConfig(store);
  const marketplaceId = REGION_CONFIG[store].marketplaceId;
  const createdSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const reports = await listReports(
    "GET_FBA_INVENTORY_PLANNING_DATA",
    [marketplaceId],
    createdSince,
    config,
    "IN_QUEUE,IN_PROGRESS,DONE"
  );
  if (!reports.length) return false;

  const latest = reports
    .filter((report) => report.createdTime)
    .sort((a, b) => (b.createdTime ?? "").localeCompare(a.createdTime ?? ""))[0];

  if (!latest) return false;

  if (latest.processingStatus && latest.processingStatus !== "DONE") {
    if (latest.reportId) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const report = await getReport(latest.reportId, config);
        if (report?.processingStatus === "DONE" && report.reportDocumentId) {
          const document = await getReportDocument(report.reportDocumentId, config);
          if (!document?.url) return true;
          const content = await downloadReport(document.url, document.compressionAlgorithm);
          cachePlanningReport(store, content);
          console.log(`[SP-API] Planning report finished while polling for ${store}`);
          return true;
        }
        if (report?.processingStatus === "CANCELLED" || report?.processingStatus === "FATAL") {
          return false;
        }
        await sleep(10000);
      }
    }

    console.log(`[SP-API] Planning report already processing for ${store} (${latest.processingStatus}).`);
    return true;
  }

  if (!latest.reportDocumentId) return false;

  const document = await getReportDocument(latest.reportDocumentId, config);
  if (!document?.url) return false;

  const content = await downloadReport(document.url, document.compressionAlgorithm);
  cachePlanningReport(store, content);
  console.log(`[SP-API] Planning report reused for ${store}`);
  return true;
}

function cachePlanningReport(store: StoreKey, content: string) {
  const rows = parseTabDelimited(content);
  if (!planningReportHeadersLogged && rows.length > 0) {
    planningReportHeadersLogged = true;
    console.log(`[SP-API] Planning report headers sample: ${Object.keys(rows[0]).slice(0, 50).join(", ")}`);
  }

  const items = new Map<string, PlanningItem>();
  let agingRisk = 0;

  rows.forEach((row) => {
    const sku = row["sku"] || row["seller-sku"] || row["seller-sku-sku"] || "";
    if (!sku) return;

    const title = row["product-name"] || row["item-name"] || "";
    const available = parseNumber(row["available"] || row["available-quantity"]);
    const inbound =
      parseNumber(row["inbound-working-quantity"]) +
      parseNumber(row["inbound-shipped-quantity"]) +
      parseNumber(row["inbound-receiving-quantity"]) +
      parseNumber(row["inbound-quantity"]);
    const reserved = parseNumber(row["reserved-quantity"] || row["total-reserved-quantity"]);
    const sales7d =
      parseNumber(row["units-shipped-t7"]) ||
      parseNumber(row["sales-shipped-last-7-days"]);
    const sellThrough = parsePercent(row["sell-through"]);
    const age90plusUnits = computeAge90Plus(row);
    const estimatedLtsf =
      parseNumber(row["estimated-ltsf-next-charge"]) +
      parseNumber(row["projected-ltsf-11-mo"]);
    const estimatedStorage = parseNumber(row["estimated-storage-cost-next-month"]);

    agingRisk += estimatedLtsf + estimatedStorage;

    items.set(sku, {
      sku,
      title,
      available,
      inbound,
      reserved,
      sales7d,
      sellThrough,
      age90plusUnits,
      estimatedLtsf,
      estimatedStorage
    });
  });

  planningCache.set(store, {
    fetchedAt: Date.now(),
    items,
    agingRisk
  });

  console.log(`[SP-API] Planning report cached for ${store} (${items.size} rows)`);
}

app.listen(PORT, () => {
  console.log(`SP-API server running on http://localhost:${PORT}`);
});
