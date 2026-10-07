# 美國總經 → 台股投資儀表板

以透明、可審閱的規則，把美國總經與全球市場指標彙整成「對台股 偏多／中性／偏空」的判斷。
手機高密度優先、桌面寬版雙欄、繁體中文。

## 架構

```
GitHub Actions（排程）
  └─ scripts/fetch-data      抓取 → 驗證 → 與快取合併 → 寫出 JSON
        public/data/summary.json        首頁用（每指標尾段收盤，約 120 KB）
        public/data/series/<id>.json    圖表用（完整歷史 OHLC，點開才載入）
  └─ vite build → GitHub Pages（純靜態網站，無後端）

src/shared/   前後端共用：指標註冊表、時間序列、訊號規則、綜合判斷（皆有單元測試）
src/          React UI（lightweight-charts 繪製 K 線）
```

- **為什麼是靜態網站 + 排程抓取**：FRED、Yahoo、證交所等皆不允許瀏覽器跨網域直接呼叫（CORS），
  且免費來源有頻率限制。由排程統一抓取再發布 JSON，前端只讀靜態檔，最穩定也最省維護。
- **新增指標**：在 `src/shared/indicators.ts` 加一筆設定（來源、單位、規則、權重），其他程式自動適用。

## 資料來源

| 指標 | 主要來源 | 備援 |
|---|---|---|
| 美債 2Y / 10Y、10Y−2Y | FRED `DGS2` `DGS10` `T10Y2Y` | — |
| Fed 目標區間 | FRED `DFEDTARU` `DFEDTARL` | — |
| CPI / 核心 CPI（年增率） | FRED `CPIAUCSL` `CPILFESL`（前端計算 YoY） | — |
| 失業率 / 非農 | FRED `UNRATE` `PAYEMS`（前端計算月增） | — |
| 實質 GDP / GDPNow | FRED `A191RL1Q225SBEA` `GDPNOW` | — |
| DXY | Yahoo `DX-Y.NYB` | — |
| USD/TWD | Yahoo `TWD=X` | FRED `DEXTAUS` |
| WTI / Brent | Yahoo `CL=F` `BZ=F`（近月期貨） | FRED `DCOILWTICO` `DCOILBRENTEU`（現貨） |
| S&P 500 / NASDAQ / 費半 | Yahoo `^GSPC` `^IXIC` `^SOX` | FRED `SP500` `NASDAQCOM`（費半無） |
| 加權指數 | Yahoo `^TWII` | 證交所 `MI_5MINS_HIST`（官方） |
| 櫃買指數 | 櫃買中心 `indexInfo/inx`（官方，自 2000 年起） | — |

FRED 與證交所、櫃買中心為官方公開資料；Yahoo Finance 為非官方介面（可能變動，已設計備援與快取）。

## 容錯設計

| 狀況 | 處理 |
|---|---|
| 主要來源失敗、快取仍新鮮 | 保留快取（狀態「快取」），**不混用不同來源數值** |
| 主要來源失敗、快取過時/不存在 | 改用備援來源（狀態「備援」） |
| 全部失敗 | 沿用快取或標示「失敗」；其他指標照常 |
| 資料過時（超過 `maxAgeDays`） | 標示「過時」，**不納入綜合判斷** |
| Yahoo 最新日 K 收盤為 null | 以同日 `regularMarketPrice` 補上（已與證交所官方收盤比對一致） |
| 盤中資料 | 標示「盤中」 |
| 時區 | 依交易所 IANA 時區換算當地日期（含夏令時間）；顯示時間一律台北時間 |
| 休市 | 以日曆天容忍（台股 5 天、匯率/油價 10 天）；長假可能短暫顯示「過時」 |
| 寫檔中斷 | 先寫暫存檔再 rename，不會產生半個 JSON |

## 綜合判斷方法

每個指標依固定規則判為 偏多(+1)／中性(0)／偏空(−1)，乘上權重加權平均得 −1～+1 分數；
≥ +0.2 偏多、≤ −0.2 偏空。可計分權重 < 60% 時標示「僅供參考」。
所有規則與門檻在 `src/shared/indicators.ts`，UI 的「查看判斷依據」逐項列出依據與貢獻。

### 權重（2026-10 依回測審查後調整）

| 類別 | 指標與權重 | 依據 |
|---|---|---|
| 利率／政策 | 2Y 1、10Y 1、Fed 1 | 2010–17、2018–26 兩段皆有鑑別力 |
| 通膨 | 核心 CPI 1、CPI 0.5 | 兩段皆有鑑別力 |
| 美元／匯率 | DXY 0.5、USD/TWD 0.5 | 兩段方向相反，降權 |
| 景氣 | 失業率 0.5、非農 0.5（只判中性／偏空）、GDP 0.5、GDPNow 0.5 | 落後指標 |
| 股價趨勢 | 費半 0.5、加權 0.5、S&P 0.25、NASDAQ 0.25、櫃買 0.25（三項一致才判多空） | 對未來 60 日幾乎無預測力 |
| 僅供參考 | 10Y−2Y、WTI、Brent（權重 0） | 觸發樣本太少 |

## 回測

`npm run backtest`（`data:fetch` 結束時也會自動執行）以**目前規則**逐日重算 2010 年至今的訊號，
統計各狀態之後 20／60 個交易日的加權指數報酬，輸出 `public/data/backtest.json`，網站在「判斷依據」與各指標圖表下方顯示。

- 防止前視偏誤：月資料 +45 天、季資料 +120 天後才視為可用
- 以 2018-01-01 分前後段，檢查結果是否穩定
- 限制：FRED 為修正後數值（非當時初值）；60 日觀察期重疊，獨立樣本有限；屬樣本內結果

## 開發

```bash
npm ci
npm run data:fetch          # 抓取資料到 public/data（首次約 2–3 分鐘，含櫃買歷史回補）
npm run dev                 # http://localhost:5173
npm run backtest            # 以目前規則重算回測
npm run check               # lint + typecheck + test + build
```

> 公司網路需透過 proxy 時，Node 內建 fetch 需設定 `NODE_USE_ENV_PROXY=1`（Node 22.21+/24）。

`scripts/replay-capture.ts` 可用事先擷取的 API 回應離線重播整個管線（開發除錯用）。

## 部署（GitHub Pages）

1. Repo → Settings → Pages → Source 選「GitHub Actions」。
2. 推送到 `main` 或手動執行 workflow「更新資料並部署」。
3. 排程：週一至週五台北時間 05:40、13:40、15:10 自動更新。

## 免責聲明

本專案僅供研究參考，不構成投資建議。
