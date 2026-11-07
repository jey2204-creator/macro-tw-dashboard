/** 漲跌停家數監測的兩個市場：上市（加權）／上櫃（櫃買） */
export const BREADTH_MARKET = {
  twse: { name: '上市', index: '加權', historySince: '2011-01-01' },
  tpex: { name: '上櫃', index: '櫃買', historySince: '2009-01-01' },
} as const;
export type BreadthMarket = keyof typeof BREADTH_MARKET;
