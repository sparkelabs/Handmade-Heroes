export type MarketplaceCode = "US" | "UK" | "CA" | "AU";

export type StoreInventoryItem = {
  sku: string;
  title: string;
  onHand: number;
  reserved: number;
  inbound: number;
  sales7d: number;
  age90plus: boolean;
  stranded: number;
  suppressed: number;
  sellThrough: number;
  margin: number;
};

export type StoreShipment = {
  id: string;
  status: string;
  eta: string;
  units: number;
};

export type StoreData = {
  code: MarketplaceCode;
  name: string;
  marketplace: string;
  currency: string;
  ipiScore: number;
  storageUtilization: number;
  agingRisk: number;
  strandedUnits: number;
  suppressedUnits: number;
  inventory: StoreInventoryItem[];
  shipments: StoreShipment[];
  warnings: string[];
  reviewStats?: ReviewStats;
};

export type ReviewStats = {
  today: number;
  last7Days: number;
  last30Days: number;
  lastRunAt?: string;
};
