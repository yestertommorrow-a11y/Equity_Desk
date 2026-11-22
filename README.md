# Equity Desk

Equity Desk is a local research dashboard based on the public ROIC.ai quote-page workflow. It opens on AAPL and looks up stocks by ticker or company name. OpenBB supplies the data through Yahoo Finance, SEC EDGAR, Cboe, Nasdaq, and TMX, depending on the listing and dataset. http://127.0.0.1:8766/api/health lists the provider extensions that the running Python can import.

## Open the dashboard

Double-click **Start Equity Desk.cmd**, then leave its window open while using the dashboard. The dashboard uses http://127.0.0.1:8766 on this PC. Close the launcher window to stop it. If Codex already has the dashboard running on this port, use the open browser tab.

If moving this project to another folder or machine, install Python 3.12 and run these commands in PowerShell from the project folder.

    py -3.12 -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt

Then use the same launcher. No provider API keys are required for the feeds currently configured. Lookups need internet access. The watchlist and theme are stored in the current browser.

## Research workflow

- **Summary** shows the quote, price chart, optional SPY comparison, trailing returns, financial highlights, capital structure, working capital, growth rates, quarterly revenue, EPS and dividends, company profile, and news. Customize the financial highlights and export them to CSV.
- **Financials** provides income statements, balance sheets, and cash flow statements with annual, quarterly, and trailing 12-month views. Use the units, per-share, year-over-year, line-item, and CSV controls.
- **Ratios, Charts, and Statistics** cover profitability, credit, liquidity, working capital, valuation, yields, trends, ownership, and analyst estimates when the inputs are available. Derived ratios and chart series depend on the filings and price history available for the selected company.
- **Transcripts and Documents** display earnings dates and available filings. Full transcripts, slides, peer suggestions, and proprietary research feeds are not configured. Use the source links for original filings.
- **Classic View and Stock Splits** provide a compact historical overview and a split timeline when supplied by a provider.

## Reading the data

Prices can be delayed. Check timestamps, currencies, and sources before using a figure. SPY is an ETF proxy for the S&P 500. The chart uses provider price history and shows a rebased comparison when SPY is enabled. Statements retain their reporting currency. Yahoo Finance returns at most five annual or quarterly statements. When the reporting currency is unknown or differs from the quote currency, valuation ratios that mix the two are left blank. Statement per-share figures and share counts are restated to the current share basis using the provider's split history. Each period's own share count shows whether a provider already restated it. Periods that can't be checked stay as reported and are flagged in the section. The statement views require sufficient quarterly filings for TTM. Missing values remain blank, and provider failures are shown in the affected section.

Data availability varies by exchange and provider. Tested examples include **AAPL**, **MSFT**, **RY.TO**, and **7203.T**. Exchange-qualified queries such as **NASDAQ:AAPL** also work when the exchange is recognized. The local server does not place trades.
