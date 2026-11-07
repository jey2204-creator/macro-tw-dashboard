/** 面板文案：上市（加權）／上櫃（櫃買） */
export const BREADTH_MARKET = {
  twse: {
    id: 'sec-br',
    title: '漲跌停家數監測（上市股票，參考）',
    aria: '漲跌停家數監測',
    index: '加權',
    capitulate: '投降：連續 2 日恐慌或恐慌日融資維持率 < 140%',
    extra: '',
    usage: '用法：恐慌本身不是進場訊號（恐慌常持續 2–5 天）；背離、止跌再搭配上方「融資斷頭監測」的清洗完成與總經判斷，才考慮分批。僅供參考，不計分。',
  },
  tpex: {
    id: 'sec-bro',
    title: '上櫃漲跌停家數監測（上櫃股票，參考）',
    aria: '上櫃漲跌停家數監測',
    index: '櫃買',
    capitulate: '投降：連續 2 日恐慌（上櫃沒有融資維持率可用）',
    extra: '家數由櫃買中心每日收盤行情逐檔推算（只算普通股，不含 ETF、權證），歷史自 2008 年起。',
    usage: '用法：上櫃以中小型股為主，恐慌通常比上市更早、更深；和上方「漲跌停家數監測」對照——上櫃先止跌、上市還在跌，常是資金回流中小型股的開端。僅供參考，不計分。',
  },
} as const;
export type BreadthMarket = keyof typeof BREADTH_MARKET;

