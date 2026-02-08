import { spApiPost } from "./spapi.js";
import type { ReviewStats } from "./types.js";

export type ReviewRequestConfig = {
  marketplaceId: string;
  orderIds: string[];
  region: "NA" | "EU" | "AU";
};

export type ReviewRequestResult = {
  success: string[];
  failed: { orderId: string; reason: string }[];
};

export async function requestReviews(config: ReviewRequestConfig, spApiConfig: Parameters<typeof spApiPost>[1]) {
  const results: ReviewRequestResult = { success: [], failed: [] };

  for (const orderId of config.orderIds) {
    try {
      await spApiPost(
        `/solicitations/v1/orders/${orderId}/solicitations/productReviewAndSellerFeedback`,
        { ...spApiConfig, region: config.region },
        { marketplaceIds: [config.marketplaceId] }
      );
      results.success.push(orderId);
    } catch (error) {
      results.failed.push({ orderId, reason: "Request failed" });
    }
  }

  return results;
}

export function mergeReviewStats(current: ReviewStats, increment: number, when: Date) {
  const todayKey = when.toISOString().slice(0, 10);
  return {
    today: current.lastRunAt?.startsWith(todayKey) ? current.today + increment : increment,
    last7Days: current.last7Days + increment,
    last30Days: current.last30Days + increment,
    lastRunAt: when.toISOString()
  };
}
