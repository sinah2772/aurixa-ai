# AURIXA AI strategy comparison (offline only)

This tool compares the existing AURIXA AI TRADER V1 signal engine with a research-only trend/pullback candidate on the **same historical M5 candle sequence**. It does not place orders, write trading settings, or switch the production strategy.

## Input format

Prepare a JSON file with at least 100 chronological candles:

```json
{
  "symbol": "XAUUSD",
  "costs": {
    "spreadPrice": 0.25,
    "slippagePricePerSide": 0.05,
    "commissionRPerTrade": 0.02
  },
  "candles": [
    { "time": 1792000000000, "open": 4000.0, "high": 4001.0, "low": 3999.0, "close": 4000.5 }
  ]
}
```

The values above are format examples only, **not recommended broker costs**. Replace them with measured costs for the chosen symbol/account. `spreadPrice` and `slippagePricePerSide` are in that symbol's price units. `commissionRPerTrade` is the total round-trip commission converted to R units (commission divided by the monetary amount at risk). If actual commission cannot be converted reliably, report it separately and do not treat results as fully net-of-costs.

## Run

```sh
npm run compare:strategies -- ./your-m5-data.json
```

The JSON report contains both strategies' trade lists and comparable metrics: trade count, win rate, net R, expectancy, profit factor and maximum drawdown in R. Both strategies use the same supplied cost assumptions. The simulator enters no earlier than the next candle open and assumes the stop was hit first if stop and target both occur inside one candle.

## Interpretation limits

- This is a screening backtest, not a profitability guarantee.
- It assumes OHLC candles represent the same price basis and does not reconstruct tick-level bid/ask paths, partial fills, financing, swaps, market gaps within candles, or correlated multi-symbol portfolio risk.
- V1's quote freshness is synthesized for offline replay; live broker connectivity and order eligibility are not being tested.
- Use a training period to develop rules and a separate untouched out-of-sample period to evaluate them. Include multiple market regimes and symbols, and use realistic costs.
- Do not choose a strategy by win rate alone. Compare net expectancy, profit factor, drawdown, trade count and stability across out-of-sample periods.
- The report intentionally says `DO_NOT_SWITCH_FROM_THIS_REPORT_ALONE`. Strategy selection and any production change require separate review and explicit authorization.


## Render read-only API

After the API change is deployed, inspect the currently cached broker M5 history in a browser:

```text
https://aurixa-ai.onrender.com/api/research/market-candles?symbol=XAUUSD
```

Supported canonical symbols are `XAUUSD`, `EURUSD`, `NZDUSD`, `USDCHF`, `USDCAD`, `AUDUSD`, `USDJPY`, `GBPUSD`, `XAGUSD`, and `BTCUSD`. This endpoint returns only cached OHLC candles and whether at least 100 are available. It does not request or execute orders.

To run the comparison, call the read-only endpoint with explicit measured costs, for example:

```text
https://aurixa-ai.onrender.com/api/research/compare-strategies?symbol=XAUUSD&spreadPrice=YOUR_SPREAD&slippagePricePerSide=YOUR_SLIPPAGE&commissionRPerTrade=YOUR_COMMISSION_IN_R
```

Replace each `YOUR_...` value with measured broker/account values; these placeholders are not valid numeric inputs. `spreadPrice` and `slippagePricePerSide` use the instrument's price units. `commissionRPerTrade` is round-trip commission divided by the monetary risk of one trade. The service rejects missing or invalid costs rather than inventing assumptions. Historical spread is not available in OHLC candles, so a single supplied spread is only a proxy unless you have a historical spread series. Do not treat the report as a realistic net-cost backtest unless those assumptions are defensible.
