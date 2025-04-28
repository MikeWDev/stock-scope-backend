export interface FinnhubQuoteResponse {
  c: number;
  h: number;
  l: number;
  pc: number;
}
export interface FinnhubProfileResponse {
  name: string;
  ticker: string;
}
export type AlertData = {
  id: string;
  userId: string;
  symbol: string;
  targetPrice: number;
  triggered: boolean;
  direction: "above" | "below";
};
