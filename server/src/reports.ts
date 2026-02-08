import axios from "axios";
import { spApiGet, spApiPost } from "./spapi.js";
import type { SpApiConfig } from "./spapi.js";

export type ReportDocumentPayload = {
  url: string;
  compressionAlgorithm?: string;
};

export async function createReport(reportType: string, marketplaceIds: string[], config: SpApiConfig) {
  const response = await spApiPost<{ reportId: string }>(
    "/reports/2021-06-30/reports",
    config,
    {
      reportType,
      marketplaceIds
    }
  );

  return response.reportId;
}

export async function listReports(
  reportType: string,
  marketplaceIds: string[],
  createdSince: string,
  config: SpApiConfig,
  processingStatuses = "DONE"
) {
  const response = await spApiGet<{
    payload?: {
      reports?: Array<{
        reportId?: string;
        reportDocumentId?: string;
        createdTime?: string;
        processingStatus?: string;
      }>;
    };
  }>("/reports/2021-06-30/reports", config, {
    reportTypes: reportType,
    processingStatuses,
    marketplaceIds: marketplaceIds.join(","),
    createdSince
  });

  return response.payload?.reports ?? [];
}

export async function getReport(reportId: string, config: SpApiConfig) {
  const response = await spApiGet<{
    payload?: {
      processingStatus?: string;
      reportDocumentId?: string;
    };
  }>(`/reports/2021-06-30/reports/${reportId}`, config);

  return response.payload;
}

export async function getReportDocument(reportDocumentId: string, config: SpApiConfig) {
  const response = await spApiGet<{ payload?: ReportDocumentPayload }>(
    `/reports/2021-06-30/documents/${reportDocumentId}`,
    config
  );

  return response.payload;
}

export async function downloadReport(url: string, compressionAlgorithm?: string) {
  const response = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
  let buffer = Buffer.from(response.data);

  if (compressionAlgorithm?.toUpperCase() === "GZIP") {
    const { gunzipSync } = await import("node:zlib");
    buffer = gunzipSync(buffer);
  }

  return buffer.toString("utf-8");
}

function normalizeHeader(header: string) {
  return header.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function parseTabDelimited(content: string) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = lines[0].split("\t").map(normalizeHeader);

  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = (values[idx] ?? "").trim();
    });
    return row;
  });
}

export function parseNumber(value: string | undefined) {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePercent(value: string | undefined) {
  if (!value) return 0;
  if (value.includes("%")) {
    return parseNumber(value) / 100;
  }
  const parsed = parseNumber(value);
  return parsed > 1 ? parsed / 100 : parsed;
}

export function computeAge90Plus(row: Record<string, string>) {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("inv-age-")) continue;
    if (
      key.includes("0-to-90") ||
      key.includes("0-to-30") ||
      key.includes("31-to-60") ||
      key.includes("61-to-90")
    ) {
      continue;
    }
    total += parseNumber(value);
  }
  return total;
}
