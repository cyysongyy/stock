# 風險預警收集器 真實網路驗證報告

驗證對象：commit `9144305`（`.github/scripts/risk-monitor.mjs`、`.github/scripts/lib/market-data.mjs`、`config/risk-alerts.json`）
驗證時間：2026-11-08 11:41–11:45 UTC（週日；美股最新收盤日 2026-11-06）
環境：Node v22.23.4，只放行 query1.finance.yahoo.com、stooq.com、quote.cnbc.com

## 結論

**收集器在真實網路下可以用：17 個代號涵蓋率 100%，全部由 Yahoo 取得，日期都是 2026-11-06。**
但有兩個問題要修：

1. **Stooq 在此環境全面回 403 "Access denied"**（17 個代號、換 UA 都一樣），Stooq 這一層等於不存在。
2. **`TWD=X` 的 Yahoo 日線末根是過時的盤中值**，算出 `+0.88%`（台幣急貶，+10 分）。但實際當日是台幣升值，約 -0.9%。這是**誤報**。本次分數 55（警戒）有 10 分來自這項，扣掉後是 45（注意），等級會從「警戒」降到「注意」。

CNBC 備援對有設定的 12 個代號全部可用（解析 OK）。`DX-Y.NYB`、`TWD=X`、`CL=F`、`ES=F`、`NQ=F` 目前沒有 CNBC 代號。

## 各來源結果（每個代號）

說明：日期皆為最後一根資料的日期；「OK」代表資料可解析。

| 代號 | Yahoo | Stooq（config 代號） | CNBC（config 代號） |
|---|---|---|---|
| ^DJI | OK 11-06 | 失敗 403（`^dji`） | OK 11-06（`.DJI`），-0.46% |
| ^IXIC | OK 11-06 | 失敗 403（`^ndq`） | OK 11-06（`.IXIC`），+1.09% |
| ^GSPC | OK 11-06 | 失敗 403（`^spx`） | OK 11-06（`.SPX`），+0.31% |
| ^SOX | OK 11-06 | 失敗 403（`^sox`） | OK 11-06（`.SOX`），+4.21% |
| NVDA | OK 11-06 | 失敗 403（`nvda.us`） | OK 11-06（`NVDA`），+2.78% |
| TSM | OK 11-06 | 失敗 403（`tsm.us`） | OK 11-06（`TSM`），+6.33% |
| ^VIX | OK 11-06，25.64 | 失敗 403（`^vix`） | OK 11-06（`.VIX`），-9.01% |
| ^TNX | OK 11-06，**4.859（量級為 4.x）** | 失敗 403（`10usy.b`） | OK（`US10Y`），`last`=`"4.859%"`，`last_time` 帶時間 |
| DX-Y.NYB | OK 11-06，有 null 列（見下） | 未設定 | 未設定 |
| TWD=X | **OK 但末根值錯**，11-06 33.109，meta 32.765 | 失敗 403（`usdtwd`） | 未設定 |
| CL=F | OK 11-06，90.83 | 失敗 403（`cl.f`） | 未設定 |
| ES=F | OK 11-06 | 失敗 403（`es.f`） | 未設定 |
| NQ=F | OK 11-06 | 失敗 403（`nq.f`） | 未設定 |
| ^N225 | OK 11-06 | 失敗 403（`^nkx`） | OK 11-06（`.N225`），-5.96% |
| ^KS11 | OK 11-06 | 失敗 403（`^kospi`） | OK 11-06（`.KS11`），-6.02% |
| ^HSI | OK 11-06 | 失敗 403（`^hsi`） | OK 11-06（`.HSI`），-1.27% |
| ^TWII | OK 11-06，有 1 列 null | 失敗 403（`^twse`） | OK 11-06（`.TWII`），-4.51% |

Stooq 的代號是否正確**無法驗證**，因為所有請求在到達資料前就被擋掉。

## 執行結果（`--dry-run --print`）

- 風險分數 **55/100（警戒）**，涵蓋率 100%，狀態 ok，`skipped` 為空，通知欄顯示 `alert`（dry-run 未實際發送）。
- 觸發 5 項：
  - VIX 25.64（+15）
  - 台幣 +0.88%（+10，**誤報**，見下）
  - 日經 -5.96%（+10）
  - 韓國綜合 -6.02%（+10）
  - 台灣加權指數 -4.51%（+10）
- 沒有 Telegram／Sheet 金鑰，未測發送與寫入。
- 17 個代號的 `src` 全是 Yahoo。下列備援路徑已驗證。把 Yahoo 指到不通的位址（`YAHOO_BASE=http://127.0.0.1:9`）重跑後：
  - 12 個有 CNBC 代號的代號都落到 CNBC，日期和漲跌幅與 Yahoo 一致。
  - 診斷訊息顯示 `Stooq → HTTP 403`。
  - 其餘 5 個（`DX-Y.NYB`、`TWD=X`、`CL=F`、`ES=F`、`NQ=F`）整體失敗，原因是沒有備援代號。

## 與真實行情對照（用本次真實回應核對）

Yahoo 與 CNBC 的收盤價、漲跌幅互相吻合（例如 ^SOX 9390.25、+4.21%；^TWII 39701.64、-4.51%）。程式計算的 `chg1d` 與 CNBC 的 `change_pct` 在 17 個代號中 16 個一致，唯一不符的是 `TWD=X`。

- **近 5 日大跌是真實資料，不是解析錯誤**：^SOX 5 日 -12.1%、^TWII -12.2%、^N225 -11.2%、^KS11 -11.7%。11-06 當日美股反彈（SOX +4.2%、TSM +6.3%），亞股當日大跌。
- 分數 55 的觸發項目和行情相符，**除了台幣那一項**。
- 我無法獨立確認這些行情是否「正確」，只能確認 Yahoo 與 CNBC 兩個獨立來源互相吻合。

### TWD=X 誤報的證據

- 日線（`interval=1d`）：10-29 至 11-06 的末根 `close` 為 33.109，前一根為 32.821，算出 +0.88%。
- 小時線（`interval=1h&range=5d`）：11-05 收在 33.090，11-06 最高 33.045、最後 32.765。`meta.regularMarketPrice` = 32.765。
- CNBC `TWD=` 回 `last`=32.766、`change_pct`=**-0.9186%**。
- 所以外匯日線末根沒有反映當日最終價，與 `meta.regularMarketPrice`（32.765）差 1%。方向相反，會把台幣升值誤判成急貶。

## 需要修正

1. **`config/risk-alerts.json` → `symbols["TWD=X"]` 加上 `"cnbc": "TWD="`，並讓 `lib/market-data.mjs` 對這類外匯代號優先用 CNBC 或 `meta.regularMarketPrice`。**
   依據：上方 TWD=X 證據。目前 Yahoo 末根日線 33.109 與 meta 32.765 相差 1%，且方向相反。
   建議做法：在 `fromYahoo` 對 `meta.instrumentType === 'CURRENCY'`（`TWD=X` 實測為此值）改用 `meta.regularMarketPrice` 當最後價，並以前一根 close 算漲跌。
   注意：前一根日線 close 也可能有同樣的偏移（日線整體比實際晚一天），實作時要用小時線或 CNBC 驗證。
2. **`fromYahoo` 的 null 補值邏輯在真實資料沒有被觸發。**
   - `DX-Y.NYB` 末根日期是 2026-11-08（週日），`close` 為 null，前一根是 11-06。
   - 補值條件是 `regularMarketTime` 的日期 `>` 最後有效 bar 的日期，這裡兩者都是 11-06，所以不會補，結果正確（102.30）。
   - 這個分支（剛收盤、最後一根 null、meta 日期較新）**沒有用真實資料驗證過**。
3. **`symbols["DX-Y.NYB"]` 補 `"cnbc": ".DXY"`。**
   依據：CNBC `.DXY` 回 `last`=102.279、`change_pct`=+0.72%、`last_time`=2026-11-06，數字和 Yahoo 的 meta 價（102.279）一致。
4. **`symbols["CL=F"]` 可補 `"cnbc": "@CL.1"`，但有格式風險。**
   - `@CL.1` 回 WTI Dec'26、90.34、-0.20%。
   - `last_time` 是 `2026-11-07`（週六），不是交易日，日期語意要再確認。
   - 與 Yahoo 90.83 有 0.5% 差距（不同合約或結算時間）。建議補了之後再觀察。
5. **`ES=F`、`NQ=F`：**
   - `@ES.1`、`@NQ.1` 在 CNBC 回 `code:1`（無資料），不能用。
   - `@ND.1`（NASDAQ 100 Fut Dec'26，27,107.50、+1.33%）有資料，可當 `NQ=F` 備援，數值和 Yahoo 27085.25 接近。`ES=F` 的 CNBC 代號這次沒找到。
6. **`stooq` 欄位：**
   - 目前環境下整層無效。保留不會造成錯誤，因為被擋時只多一行診斷（`Stooq → HTTP 403`）。
   - 缺點是每個代號多一次請求。若 GitHub Actions 上同樣被擋，建議跳過或快取「Stooq 被擋」的狀態，避免每個代號都白跑一次。
7. **`fromCnbc` 的解析沒有問題，但實測格式要記錄：**
   - 一般代號：`last` 例如 `"51,285.73"`（含千分位），`change_pct` 例如 `"-0.46%"`，`last_time` 例如 `"2026-11-06"`。
   - `US10Y`、`TWD=`：`last` 為 `"4.859%"`（帶百分號），`change_pct` 為 `"+0.4548%"`，`last_time` 為 `"2026-11-06T17:05:00.000-0500"`，前 10 碼仍是日期。
   - 現有 `parseFloat` 與 `slice(0, 10)` 全部能解析。
   - 注意 `last_time` 前 10 碼是來源當地日期，不是 UTC 日期。
8. **`^TNX` 量級沒有問題：** Yahoo 回 4.859，不是 48.59；CNBC 也是 4.859%，不需要除以 10。`tnx` 規則是相對變動 %，Yahoo 與 CNBC 都是 +0.45%，一致。

## Stooq 被擋的方式

- 所有請求（資料網址、首頁 `https://stooq.com/`）都回 **HTTP 403**，`content-type: text/html`，`server: openresty`，內容 226 bytes 的簡短頁面：`Access denied`。
- 沒有 `cf-*`、`set-cookie`、`retry-after` 這類驗證挑戰或限流標頭，也沒有驗證碼頁面。看起來是**依來源 IP 直接拒絕**（本環境出口是資料中心代理）。
- 換標頭測試：腳本 UA、瀏覽器 UA（Chrome 124）、`curl/8.5.0` 三種，加上 `Accept: text/csv`、`Accept-Language`，結果一樣 403。**換 UA 不可行。**
- 沒有嘗試繞過驗證碼、登入或更換 IP。
- GitHub Actions 的 IP 是否同樣被擋，**本次無法驗證**。

## 驗證範圍

**已用真實網路驗證：**
- `risk-monitor.mjs --dry-run --print` 完整執行，包含分數、涵蓋率、觸發項目。
- 17 個代號的 Yahoo 回應：有無資料、末根日期、close 是否 null、meta 價格與時間。
- Stooq 的 17 個請求，HTTP 狀態、回應內容、標頭、三種 UA。
- CNBC 12 個代號的 `last`、`change_pct`、`last_time` 格式與 `fromCnbc` 解析。
- 備援路徑（Yahoo 失敗 → Stooq 403 → CNBC）。
- `TWD=X` 日線與小時線對照，以及 CNBC 候選代號 `.DXY`、`TWD=`、`@CL.1`、`@ES.1`、`@NQ.1`、`@ND.1`。

**未驗證：**
- Stooq 的代號正確性與 CSV 格式（全被擋）。
- Yahoo 最後一根 close 為 null 時的補值分支（本次真實資料沒有觸發）。
- Telegram 通知、Google Sheet 寫入、冷卻與靜音時段邏輯（沒有金鑰，dry-run 不執行）。
- GitHub Actions 環境下三個來源是否被擋。
- 美股休市日、盤中時段、Yahoo 429 限流下的行為。
- 這些行情數字相對於交易所官方資料是否正確（只做了 Yahoo 與 CNBC 交叉比對）。
