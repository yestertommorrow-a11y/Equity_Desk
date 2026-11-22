"""Read-only equity research data via installed OpenBB provider extensions."""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import math
import re
import tempfile
import time
from collections import OrderedDict
from concurrent.futures import Future
from datetime import date, datetime, timedelta, timezone
from threading import Lock, Thread
from typing import NamedTuple


def _new_york_today():
    """Today's date in New York, which US earnings and exchange dates use (the server may be elsewhere)."""
    now = datetime.now(timezone.utc)
    try:
        from zoneinfo import ZoneInfo

        return now.astimezone(ZoneInfo("America/New_York")).date()
    except Exception:  # No time zone data on this machine: apply the US daylight-saving rule.
        year = now.year
        march = date(year, 3, 8 + (6 - date(year, 3, 8).weekday()) % 7)  # second Sunday
        november = date(year, 11, 1 + (6 - date(year, 11, 1).weekday()) % 7)  # first Sunday
        dst_start = datetime(year, march.month, march.day, 7, tzinfo=timezone.utc)  # 2 a.m. EST
        dst_end = datetime(year, november.month, november.day, 6, tzinfo=timezone.utc)  # 2 a.m. EDT
        return (now - timedelta(hours=4 if dst_start <= now < dst_end else 5)).date()


class Route(NamedTuple):
    provider: str
    module: str
    fetcher: str


US = {
    "quote": (Route("cboe", "equity_quote", "CboeEquityQuoteFetcher"), Route("nasdaq", "equity_quote", "NasdaqEquityQuoteFetcher")),
    "profile": (Route("nasdaq", "equity_info", "NasdaqEquityInfoFetcher"),),
    "history": (Route("cboe", "equity_historical", "CboeEquityHistoricalFetcher"), Route("nasdaq", "equity_historical", "NasdaqEquityHistoricalFetcher")),
    "income": (Route("sec", "income_statement", "SecIncomeStatementFetcher"), Route("nasdaq", "income_statement", "NasdaqIncomeStatementFetcher")),
    "balance": (Route("sec", "balance_sheet", "SecBalanceSheetFetcher"), Route("nasdaq", "balance_sheet", "NasdaqBalanceSheetFetcher")),
    "cash": (Route("sec", "cash_flow", "SecCashFlowStatementFetcher"), Route("nasdaq", "cash_flow", "NasdaqCashFlowStatementFetcher")),
    # No "ratios" route: Nasdaq's CDN answers OpenBB's aiohttp client with 403 Access Denied
    # (checked 2026-11-22), so the Nasdaq ratios feed never returns data. The app computes
    # ratios from the statements instead; re-add the route if Nasdaq access returns.
    "news": (Route("nasdaq", "company_news", "NasdaqCompanyNewsFetcher"),),
    "earnings": (Route("nasdaq", "historical_eps", "NasdaqHistoricalEpsFetcher"),),
    "earnings_calendar": (Route("nasdaq", "calendar_earnings", "NasdaqCalendarEarningsFetcher"),),
    "dividends": (Route("nasdaq", "historical_dividends", "NasdaqHistoricalDividendsFetcher"),),
    "estimates": (Route("nasdaq", "price_target_consensus", "NasdaqPriceTargetConsensusFetcher"),),
    "targets": (Route("nasdaq", "price_target", "NasdaqPriceTargetFetcher"),),
    "filings": (Route("sec", "company_filings", "SecCompanyFilingsFetcher"), Route("nasdaq", "company_filings", "NasdaqCompanyFilingsFetcher")),
    "holders": (Route("nasdaq", "institutional_ownership", "NasdaqInstitutionalOwnershipFetcher"),),
    "insiders": (Route("nasdaq", "insider_trading", "NasdaqInsiderTradingFetcher"),),
    "segments": (Route("sec", "sec_segment_revenue", "SecSegmentRevenueFetcher"),),
}
CANADA = {
    "quote": (Route("tmx", "equity_quote", "TmxEquityQuoteFetcher"),),
    "profile": (Route("tmx", "equity_profile", "TmxEquityProfileFetcher"),),
    "history": (Route("tmx", "equity_historical", "TmxEquityHistoricalFetcher"),),
    "income": (Route("tmx", "income_statement", "TmxIncomeStatementFetcher"),),
    "balance": (Route("tmx", "balance_sheet", "TmxBalanceSheetFetcher"),),
    "cash": (Route("tmx", "cash_flow", "TmxCashFlowStatementFetcher"),),
    "news": (Route("tmx", "company_news", "TmxCompanyNewsFetcher"),),
    "earnings_calendar": (Route("tmx", "calendar_earnings", "TmxCalendarEarningsFetcher"),),
    "dividends": (Route("tmx", "historical_dividends", "TmxHistoricalDividendsFetcher"),),
    "splits": (Route("tmx", "historical_splits", "TmxHistoricalSplitsFetcher"),),
    "estimates": (Route("tmx", "price_target_consensus", "TmxPriceTargetConsensusFetcher"),),
    "filings": (Route("tmx", "company_filings", "TmxCompanyFilingsFetcher"),),
    "insiders": (Route("tmx", "insider_trading", "TmxInsiderTradingFetcher"),),
}
YAHOO = {
    "quote": Route("yfinance", "equity_quote", "YFinanceEquityQuoteFetcher"),
    "profile": Route("yfinance", "equity_profile", "YFinanceEquityProfileFetcher"),
    "history": Route("yfinance", "equity_historical", "YFinanceEquityHistoricalFetcher"),
    "income": Route("yfinance", "income_statement", "YFinanceIncomeStatementFetcher"),
    "balance": Route("yfinance", "balance_sheet", "YFinanceBalanceSheetFetcher"),
    "cash": Route("yfinance", "cash_flow", "YFinanceCashFlowStatementFetcher"),
    "metrics": Route("yfinance", "key_metrics", "YFinanceKeyMetricsFetcher"),
    "news": Route("yfinance", "company_news", "YFinanceCompanyNewsFetcher"),
    "earnings": Route("yfinance", "historical_eps", "YFinanceHistoricalEpsFetcher"),
    "earnings_calendar": Route("yfinance", "company_calendar", "YFinanceCompanyCalendarFetcher"),
    "dividends": Route("yfinance", "historical_dividends", "YFinanceHistoricalDividendsFetcher"),
    "splits": Route("yfinance", "historical_splits", "YFinanceHistoricalSplitsFetcher"),
    "estimates": Route("yfinance", "earnings_estimates", "YFinanceEarningsEstimatesFetcher"),
    "revenue_estimates": Route("yfinance", "revenue_estimates", "YFinanceRevenueEstimatesFetcher"),
    "targets": Route("yfinance", "price_target_consensus", "YFinancePriceTargetConsensusFetcher"),
    "recommendations": Route("yfinance", "analyst_recommendations", "YFinanceAnalystRecommendationsFetcher"),
    "filings": Route("yfinance", "company_filings", "YFinanceCompanyFilingsFetcher"),
    "holders": Route("yfinance", "institutional_holders", "YFinanceInstitutionalHoldersFetcher"),
    "insiders": Route("yfinance", "insider_trading", "YFinanceInsiderTradingFetcher"),
    "management": Route("yfinance", "key_executives", "YFinanceKeyExecutivesFetcher"),
}
SEARCH = (
    Route("nasdaq", "equity_search", "NasdaqEquitySearchFetcher"),
    Route("sec", "equity_search", "SecEquitySearchFetcher"),
    Route("tmx", "equity_search", "TmxEquitySearchFetcher"),
)
YAHOO_SEARCH = Route("yfinance", "symbol_search", "YFinanceSymbolSearchFetcher")
PROVIDER_NAMES = {"nasdaq": "Nasdaq", "sec": "SEC EDGAR", "cboe": "Cboe", "tmx": "TMX", "yfinance": "Yahoo Finance"}
SECTIONS = frozenset(US) | frozenset(CANADA) | frozenset(YAHOO) | {"peers", "transcripts", "ratios"}
STATEMENTS = {"income", "balance", "cash", "ratios"}
# Nasdaq and TMX calendars are market-wide and fetched one day per request, so the
# look-ahead is bounded; Yahoo's company calendar has no window. Shown in metadata.
EARNINGS_WINDOW_DAYS = 45
# Largest statement `limit` each provider's query model accepts (openbb-yfinance 2.1 uses le=5).
STATEMENT_LIMITS = {"yfinance": 5}
RANGES = {"1D": 1, "5D": 7, "1M": 31, "3M": 93, "6M": 186, "1Y": 366, "3Y": 1096, "5Y": 1827, "10Y": 3653, "MAX": 36525}
US_EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "NYSEARCA", "NYSEAMERICAN", "BATS", "CBOE", "OTC"}
CA_SUFFIXES = {"TSX": ".TO", "TSXV": ".V", "TSX-V": ".V", "TSE": ".TO", "XTSE": ".TO", "XTSX": ".V", "CSE": ".CN", "NEO": ".NE"}
GLOBAL_SUFFIXES = {
    "LSE": ".L", "XLON": ".L", "HKEX": ".HK", "XHKG": ".HK", "ASX": ".AX",
    "JAPAN": ".T", "JPX": ".T", "XTKS": ".T", "SGX": ".SI", "XSES": ".SI",
    "XETRA": ".DE", "XETR": ".DE", "EURONEXT-PARIS": ".PA", "XPAR": ".PA",
    "NSE": ".NS", "BSE": ".BO", "KOSPI": ".KS", "SIX": ".SW", "TWSE": ".TW",
}
EXCHANGE_NAMES = {
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NYQ": "NYSE",
    "ASE": "NYSE American", "PCX": "NYSE Arca", "TOR": "TSX", "VAN": "TSXV",
    "JPX": "Tokyo Stock Exchange", "HKG": "Hong Kong Stock Exchange", "LSE": "London Stock Exchange",
}
SYMBOL_PATTERN = re.compile(r"[A-Z0-9][A-Z0-9.\-]{0,19}")
CACHE: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
IN_FLIGHT: dict[tuple, tuple[Future, bool]] = {}  # key -> (future, started by a refresh)
CACHE_LOCK = Lock()
RUNTIME_LOCK = Lock()
_LOOP: asyncio.AbstractEventLoop | None = None
_PROVIDER_CACHE: tempfile.TemporaryDirectory | None = None


def _has_yahoo():
    return importlib.util.find_spec("openbb_yfinance") is not None


def installed_providers():
    """Return the display names of the OpenBB provider extensions that can be imported."""
    return [name for key, name in PROVIDER_NAMES.items() if importlib.util.find_spec(f"openbb_{key}") is not None]


def _run(coroutine):
    """Share one event loop so OpenBB's async provider caches can be reused."""
    global _LOOP
    with RUNTIME_LOCK:
        if _LOOP is None:
            _LOOP = asyncio.new_event_loop()
            Thread(target=_LOOP.run_forever, name="openbb-provider-loop", daemon=True).start()
        loop = _LOOP
    return asyncio.run_coroutine_threadsafe(coroutine, loop).result()


def _envelope(data=None, source=None, error=None, warnings=None, **extra):
    return {
        "data": data if data is not None else [],
        "source": source,
        "error": error,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "warnings": warnings if warnings is not None else [],
        **extra,
    }


def _cache(key, ttl, loader, refresh=False):
    while True:
        with CACHE_LOCK:
            found = CACHE.get(key)
            if found and found[0] > time.monotonic() and not refresh:
                CACHE.move_to_end(key)
                return found[1]
            running = IN_FLIGHT.get(key)
            if running is None:
                future = Future()
                IN_FLIGHT[key] = (future, refresh)
                break
            future, running_is_refresh = running
        if not refresh or running_is_refresh:
            return future.result()
        # A refresh must not get data requested before it: let that older fetch
        # finish (so the provider is not hit twice at once), then fetch again.
        try:
            future.result()
        except Exception:
            pass
    try:
        result = loader()
        with CACHE_LOCK:
            CACHE[key] = (time.monotonic() + (30 if result["error"] else ttl), result)
            CACHE.move_to_end(key)
            while len(CACHE) > 160:
                CACHE.popitem(last=False)
        future.set_result(result)
        return result
    except BaseException as exc:
        future.set_exception(exc)
        raise
    finally:
        with CACHE_LOCK:
            IN_FLIGHT.pop(key, None)


def _json_safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_safe(item) for item in value]
    return value


async def _fetch(route: Route, params: dict, timeout=18):
    """Call the provider implementation directly, without regenerating SDK code."""
    global _PROVIDER_CACHE
    if _PROVIDER_CACHE is None:
        from openbb_core.app import utils

        # OpenBB 5's HTTP cache reads the global JSON preference directly.
        # Confine this dashboard's public-data cache to its temporary directory.
        _PROVIDER_CACHE = tempfile.TemporaryDirectory(prefix="stock-research-openbb-", ignore_cleanup_errors=True)
        cache_dir = _PROVIDER_CACHE.name
        utils.get_user_cache_directory = lambda: cache_dir
        if _has_yahoo():
            import yfinance

            yfinance.set_tz_cache_location(cache_dir)
    module = importlib.import_module(f"openbb_{route.provider}.models.{route.module}")
    fetcher = getattr(module, route.fetcher)
    result = await asyncio.wait_for(fetcher.fetch_data(params, {}), timeout=timeout)
    metadata = {}
    if hasattr(result, "metadata") and hasattr(result, "result"):
        metadata = _json_safe(result.model_dump(mode="json", include={"metadata"})["metadata"])
        result = result.result
    elif isinstance(result, tuple):
        result = result[0]
    if result is None:
        return [], metadata
    if not isinstance(result, list):
        result = [result]
    rows = [
        _json_safe(row.model_dump(mode="json") if hasattr(row, "model_dump") else row)
        for row in result
        if isinstance(row, dict) or hasattr(row, "model_dump")
    ]
    return rows, metadata


def _provider_error(exc):
    name = type(exc).__name__
    if isinstance(exc, (ModuleNotFoundError, ImportError, AttributeError)):
        return "provider extension unavailable"
    if isinstance(exc, TimeoutError):
        return "request timed out"
    if name == "EmptyDataError":
        return "no data returned"
    message = str(exc).lower()
    if "rate limit" in message or "429" in message:
        return "provider rate limit"
    if "forbidden" in message or "403" in message:
        return "provider refused the request"
    if "connection" in message or "network" in message or "getaddrinfo" in message:
        return "provider connection failed"
    return "request failed"


def _symbol(raw):
    exchange, separator, name = raw.strip().upper().partition(":")
    if not separator:
        name, exchange = exchange, ""
    if not SYMBOL_PATTERN.fullmatch(name) or (exchange and not SYMBOL_PATTERN.fullmatch(exchange)):
        raise ValueError("Enter a valid stock symbol, such as AAPL or TSX:SHOP.")
    if name.endswith(tuple(CA_SUFFIXES.values())):
        return name, "CA"
    if exchange in CA_SUFFIXES:
        return name + CA_SUFFIXES[exchange], "CA"
    if exchange in GLOBAL_SUFFIXES:
        suffix = GLOBAL_SUFFIXES[exchange]
        return name if name.endswith(suffix) else name + suffix, "GLOBAL"
    if exchange and exchange not in US_EXCHANGES:
        raise ValueError(f"The installed OpenBB feeds do not cover the {exchange} exchange in this app.")
    if "." in name and not name.endswith((".A", ".B")):
        return name, "GLOBAL"
    return name, "US"


def _date_window(range_name, start_date, end_date):
    today = date.today()
    end = date.fromisoformat(end_date) if end_date else today
    if start_date:
        start = date.fromisoformat(start_date)
    elif range_name == "YTD":
        start = end.replace(month=1, day=1)
    else:
        start = max(end - timedelta(days=RANGES[range_name]), date(1900, 1, 1))
    if start > end:
        raise ValueError("The start date must precede the end date.")
    return {"start_date": start, "end_date": end}


def _params(section, route, symbol, options):
    if route.provider == "tmx" and symbol.endswith(tuple(CA_SUFFIXES.values())):
        symbol = symbol.rsplit(".", 1)[0]
    if route.provider == "yfinance" and symbol.endswith((".A", ".B")):
        symbol = symbol[:-2] + "-" + symbol[-1]
    params = {"symbol": symbol}
    if section == "history":
        params.update(_date_window(options["range"], options["start_date"], options["end_date"]))
        if options["range"] == "1D" and not options["start_date"] and not options["end_date"]:
            params["start_date"] = params["end_date"] - timedelta(days=7)
            if route.provider == "yfinance":
                params["interval"] = "5m"
        if route.provider == "yfinance":
            params["end_date"] += timedelta(days=1)  # The provider's upper bound is exclusive.
    if section in STATEMENTS:
        period = options["period"]
        if route.provider == "sec":
            period = "quarterly" if period == "quarter" else period
        limit = min(options["limit"], STATEMENT_LIMITS.get(route.provider, options["limit"]))
        params.update(period=period, limit=limit)
    if section in {"news", "filings", "holders", "insiders"}:
        params["limit"] = options["limit"]
    if section == "earnings_calendar" and route.provider != "yfinance":
        today = _new_york_today()
        params = {"start_date": today, "end_date": today + timedelta(days=EARNINGS_WINDOW_DAYS)}
    return params


def _normalize(section, rows, symbol, market, options):
    if section == "history":
        rows = sorted((row for row in rows if row.get("date") and row.get("close") is not None), key=lambda row: row["date"])
        if rows and options["range"] == "1D" and not options["start_date"] and not options["end_date"]:
            session = rows[-1]["date"][:10]
            return [row for row in rows if row["date"][:10] == session]
        return rows
    if section == "earnings_calendar":
        rows = [row for row in rows if not row.get("symbol") or str(row["symbol"]).upper() in {symbol, symbol.split(".")[0]}]
        for row in rows:
            row["report_date"] = row.get("report_date") or row.get("earnings_date") or row.get("date")
            row["eps_estimated"] = row.get("eps_consensus") if row.get("eps_consensus") is not None else row.get("earnings_average")
        return sorted(rows, key=lambda row: row.get("report_date") or "")
    if section == "quote":
        for row in rows:
            if not row.get("currency") and market == "US":
                row["currency"] = "USD"
            row["exchange_name"] = EXCHANGE_NAMES.get(row.get("exchange"), row.get("exchange"))
            row["price"] = row.get("last_price")
            row["previous_close"] = row.get("prev_close")
            row["timestamp"] = row.get("last_timestamp") or row.get("sip_timestamp") or row.get("participant_timestamp")
            row["day_high"] = row.get("high")
            row["day_low"] = row.get("low")
            row["week_52_high"] = row.get("year_high")
            row["week_52_low"] = row.get("year_low")
            if row.get("average_volume") is None:
                row["average_volume"] = row.get("volume_average")
            previous = row.get("prev_close")
            price = row.get("last_price")
            if previous and price is not None:
                if row.get("change") is None:
                    row["change"] = price - previous
                if row.get("change_percent") is None:
                    row["change_percent"] = (price - previous) / previous
            raw_percent = row.get("change_percent")
            row["change_percent_points"] = raw_percent * 100 if isinstance(raw_percent, (float, int)) else None
        return [row for row in rows if row.get("price") is not None]
    if section == "profile":
        for row in rows:
            row["description"] = row.get("long_description") or row.get("short_description")
            row["exchange"] = row.get("stock_exchange") or row.get("exchange")
            row["country"] = row.get("hq_country") or row.get("country")
            row["industry"] = row.get("industry_category") or row.get("industry")
            row["website"] = row.get("company_url") or row.get("website")
    if section in STATEMENTS:
        return sorted(rows, key=lambda row: row.get("period_ending") or row.get("date") or "", reverse=True)[:options["limit"]]
    if section in {"dividends", "splits"}:
        for row in rows:
            row["date"] = row.get("date") or row.get("ex_dividend_date") or row.get("split_date")
        rows.sort(key=lambda row: row.get("date") or "", reverse=True)
    return rows[:options["limit"]]


async def _load_section(symbol, market, section, options):
    routes = {"US": US, "CA": CANADA, "GLOBAL": {}}[market].get(section, ())
    if section in YAHOO and _has_yahoo():
        yahoo = (YAHOO[section],)
        # Prefer SEC statement depth and filing provenance for U.S. companies.
        routes = routes + yahoo if section in STATEMENTS | {"filings"} else yahoo + routes
    if not routes:
        return _envelope(error=f"No OpenBB {section.replace('_', ' ')} feed is configured for this listing.")
    failures = []
    for route in routes:
        provider = PROVIDER_NAMES[route.provider]
        try:
            params = _params(section, route, symbol, options)
            # SEC statements are large and were timing out at 18s, which silently switched one
            # statement to Yahoo while the others stayed on SEC.
            timeout = 45 if route.provider == "sec" and section in STATEMENTS else 18
            data, metadata = await _fetch(route, params, timeout=timeout)
            rows = _normalize(section, data, symbol, market, options)
            if section == "metrics" and route.provider == "yfinance":
                # OpenBB documents dividend_yield as a fraction, but openbb-yfinance passes Yahoo's
                # percent value through (0.32 means 0.32%). The other ratio fields are fractions.
                for row in rows:
                    if isinstance(row.get("dividend_yield"), (int, float)):
                        row["dividend_yield"] = row["dividend_yield"] / 100
            if section == "earnings" and route.provider == "yfinance":
                # Yahoo's "Surprise(%)" is already in percent (5.8 means 5.8%; schema multiplier 1),
                # while Nasdaq's is a fraction. Store fractions, as the page expects.
                for row in rows:
                    if isinstance(row.get("surprise_percent"), (int, float)):
                        row["surprise_percent"] = row["surprise_percent"] / 100
            # A market-wide calendar that answered but has no row for this company is a valid
            # "nothing scheduled in the window" result, not a failure.
            bounded_calendar = section == "earnings_calendar" and route.provider != "yfinance"
            if rows or bounded_calendar:
                if bounded_calendar:
                    metadata = {**metadata, "window_days": EARNINGS_WINDOW_DAYS}
                if section == "history":
                    metadata = {**metadata, "interval": params.get("interval", "1d")}
                    if route.provider == "yfinance":
                        metadata["price_basis"] = "splits_only"
                if metadata.get("validation_warnings"):
                    failures.append(f"{provider}: statement validation warnings are available in metadata")
                return _envelope(rows, f"OpenBB · {provider}", warnings=failures, provider=route.provider, metadata=metadata)
            failures.append(f"{provider}: no matching data")
        except Exception as exc:
            failures.append(f"{provider}: {_provider_error(exc)}")
    return _envelope(error="OpenBB could not return this dataset. " + "; ".join(failures) + ".", warnings=failures)


SCREENER = Route("yfinance", "equity_screener", "YFinanceEquityScreenerFetcher")
# Yahoo screener regions for listings outside the US and Canada, by ticker suffix.
SUFFIX_COUNTRY = {".T": "jp", ".L": "gb", ".HK": "hk", ".AX": "au", ".DE": "de", ".PA": "fr", ".NS": "in", ".BO": "in",
                  ".KS": "kr", ".SW": "ch", ".TW": "tw", ".SI": "sg", ".TO": "ca", ".V": "ca", ".CN": "ca", ".NE": "ca"}
PEER_LIMIT = 10
OTC_EXCHANGES = {"PNK", "OTC", "OQB", "OQX", "OEM", "OBB", "OID", "OGM"}


def _screener_key(label, choices):
    """Map a Yahoo display name ("Banks - Diversified") to a screener key ("banks")."""
    if not label:
        return None
    slug = re.sub(r"[^a-z0-9]+", "_", str(label).lower()).strip("_")
    if slug in choices:
        return slug
    close = [choice for choice in choices if choice in slug or slug in choice]
    if close:
        return max(close, key=len)
    # "software_infrastructure" -> "software_and_services": same leading word.
    first = slug.split("_")[0]
    same_start = sorted(choice for choice in choices if choice.split("_")[0] == first)
    return same_start[0] if same_start else None


def _load_peers(symbol, name, market):
    """Largest companies in the same Yahoo industry (else sector) on the same market, by market cap."""
    if not _has_yahoo():
        return _envelope(error="A peer group needs the Yahoo Finance extension.")
    import json

    from openbb_yfinance.models.equity_screener import INDUSTRY_MAP, PEER_GROUPS, SECTOR_MAP

    profile = get_section(symbol, "profile")
    row = (profile.get("data") or [{}])[0]
    industry_label = row.get("industry_category") or row.get("industry")
    sector_label = row.get("sector")
    country = "us" if market == "US" else next((code for suffix, code in SUFFIX_COUNTRY.items() if name.endswith(suffix)), None)
    # Yahoo filters on its own values: broad "peer_group" names (Banks, Semiconductors) or industries.
    attempts = []
    sector = _screener_key(sector_label, set(INDUSTRY_MAP))
    industry = _screener_key(industry_label, set(INDUSTRY_MAP.get(sector) or {}) or {k for keys in INDUSTRY_MAP.values() for k in keys})
    if industry:
        home = sector if industry in (INDUSTRY_MAP.get(sector) or {}) else next(s for s, keys in INDUSTRY_MAP.items() if industry in keys)
        value = INDUSTRY_MAP[home][industry]
        attempts.append(("industry", value, {"field": "peer_group" if value in PEER_GROUPS else "industry", "value": value}))
    if sector and sector in SECTOR_MAP:
        attempts.append(("sector", SECTOR_MAP[sector], {"field": "sector", "value": SECTOR_MAP[sector]}))
    if not attempts:
        return _envelope(error="The company profile has no industry or sector to build a peer group from.")
    own = {name, name.replace(".", "-"), name.split(".")[0]} if market == "US" else {name}
    failures = []
    for basis, label, condition in attempts:
        filters = [{**condition, "operator": "eq"}] + ([{"field": "region", "operator": "eq", "value": country}] if country else [])
        config = {"type": "equity", "limit": 40, "sort_field": "intradaymarketcap", "sort_type": "DESC", "filters": filters}
        try:
            rows, _metadata = _run(_fetch(SCREENER, {"config": json.dumps(config)}, timeout=25))
        except Exception as exc:
            failures.append(f"Yahoo Finance screener: {_provider_error(exc)}")
            continue
        # Largest first; one listing per company (Sony trades as SONY and SNEJF), and no over-the-counter
        # foreign lines (XIACF, ASMLF) unless the company itself trades over the counter.
        own_otc = any(str(r.get("symbol") or "").upper() in own and r.get("exchange") in OTC_EXCHANGES for r in rows)
        names, peers = set(), []
        for r in sorted(rows, key=lambda r: -(r.get("market_cap") or 0)):
            ticker = str(r.get("symbol") or "").upper()
            company = re.sub(r"[^a-z0-9]", "", str(r.get("name") or r.get("longName") or ticker).lower())[:24]
            if not ticker or ticker in own or not r.get("market_cap") or company in names or not SYMBOL_PATTERN.fullmatch(ticker):
                continue
            if r.get("exchange") in OTC_EXCHANGES and not own_otc:
                continue
            names.add(company)
            peers.append(r)
        peers = peers[:PEER_LIMIT]
        if len(peers) >= 2:
            data = [{"symbol": str(r["symbol"]).upper(), "name": r.get("name") or r.get("longName"), "market_cap": r.get("market_cap"),
                     "currency": r.get("currency"), "exchange": r.get("exchange")} for r in peers]
            return _envelope(data, "OpenBB · Yahoo Finance", warnings=failures, provider="yfinance",
                             metadata={"basis": basis, "group": label, "country": country})
        failures.append(f"Yahoo Finance screener: too few companies in the {label} {basis}")
    return _envelope(error="No peer group could be built. " + "; ".join(failures) + ".", warnings=failures)


def get_section(symbol: str, section: str, **kwargs) -> dict:
    """Return one JSON-compatible section with OpenBB provenance."""
    if section not in SECTIONS:
        return _envelope(error="Unknown dataset.")
    if section == "peers":
        try:
            name, market = _symbol(symbol)
        except ValueError as exc:
            return _envelope(error=str(exc))
        return _cache((name, market, "peers"), 1800, lambda: _load_peers(symbol, name, market), bool(kwargs.get("refresh")))
    try:
        name, market = _symbol(symbol)
        period = str(kwargs.get("period") or "annual").lower()
        if period == "quarterly":
            period = "quarter"
        if period not in {"annual", "quarter", "ttm"}:
            raise ValueError("Choose annual, quarter, or TTM periods.")
        range_name = str(kwargs.get("range") or "1Y").upper()
        if range_name not in RANGES and range_name != "YTD":
            raise ValueError("Choose a supported price history range.")
        limit = int(kwargs.get("limit") or (20 if section in STATEMENTS else 50))
        if not 1 <= limit <= 100:
            raise ValueError("Choose a limit from 1 to 100.")
        options = {
            "period": period,
            "range": range_name,
            "limit": limit,
            "start_date": kwargs.get("start_date"),
            "end_date": kwargs.get("end_date"),
        }
        if section == "history":
            _date_window(range_name, options["start_date"], options["end_date"])
    except (ValueError, TypeError) as exc:
        return _envelope(error=str(exc))
    key = (name, market, section, *options.values())
    ttl = 90 if section == "quote" else (300 if section == "history" else 1800)
    loader = lambda: _run(_load_section(name, market, section, options))
    refresh = bool(kwargs.get("refresh"))
    if section in SPLIT_SECTIONS:
        return _cache(key, ttl, lambda: _with_splits(symbol, loader()), refresh)
    return _cache(key, ttl, loader, refresh)


SPLIT_SECTIONS = {"income", "balance", "cash"}
PER_SHARE_FIELD = re.compile(r"(^|_)eps(_|$)|per_share")
SHARE_COUNT_FIELD = re.compile(r"shares|share_issued")
NOT_SHARE_COUNT = re.compile(r"repurchase|issuance|payment|proceeds|value|equity|holders|based|compensation|amount")
SHARE_KEYS = ("weighted_ave_basic_shares_os", "weighted_average_basic_shares_outstanding", "basic_average_shares",
              "weighted_average_shares_outstanding", "weighted_average_shares", "ordinary_shares_number", "share_issued",
              "shares_outstanding")


def _positive(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0 else None


def _row_shares(row):
    """Share count on the row's own basis, falling back to net income / basic EPS."""
    for key in SHARE_KEYS:
        if _positive(row.get(key)):
            return row[key]
    income = next((row[k] for k in ("net_income", "net_income_common_stockholders") if isinstance(row.get(k), (int, float))), None)
    eps = next((row[k] for k in ("basic_eps", "basic_earnings_per_share", "diluted_eps") if isinstance(row.get(k), (int, float)) and row[k]), None)
    return _positive(income / eps) if income is not None and eps else None


def _split_adjust(rows, splits):
    """Restate per-share fields and share counts to the current share basis.

    Providers mix bases: SEC rows carry the basis of the latest filing covering each period, so a
    year can be partly restated. For each row, pick the not-yet-applied split factor whose result
    lands closest to the share count of the first period after the latest split.
    """
    events = []
    for split in splits:
        day = str(split.get("date") or "")[:10]
        numerator, denominator = _positive(split.get("numerator")), _positive(split.get("denominator"))
        if day and numerator and denominator and numerator != denominator:
            events.append((day, numerator / denominator))
    events.sort()
    summary = {"adjusted_periods": 0, "unverified_periods": 0, "basis": "as_reported"}
    if not events or not rows:
        summary["basis"] = "current"
        return summary
    stamp = lambda row: str(row.get("period_ending") or row.get("date") or "")[:10]
    after = sorted((row for row in rows if stamp(row) >= events[-1][0] and _row_shares(row)), key=stamp)
    pending = [row for row in rows if stamp(row) and any(day > stamp(row) for day, _ in events)]
    if not after:
        summary["unverified_periods"] = len(pending)
        return summary
    reference = _row_shares(after[0])
    for row in pending:
        later = [factor for day, factor in events if day > stamp(row)]
        shares = _row_shares(row)
        if shares is None:
            summary["unverified_periods"] += 1
            continue
        total, applied, options = math.prod(later), 1.0, []
        options.append(total)
        for factor in later:
            applied *= factor
            options.append(total / applied)
        remaining = min(options, key=lambda option: abs(math.log(shares * option / reference)))
        if abs(remaining - 1) < 1e-9:
            continue
        for key, value in list(row.items()):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            if PER_SHARE_FIELD.search(key):
                row[key] = value / remaining
            elif SHARE_COUNT_FIELD.search(key) and not NOT_SHARE_COUNT.search(key):
                row[key] = value * remaining
        summary["adjusted_periods"] += 1
    summary["basis"] = "current" if not summary["unverified_periods"] else "partial"
    return summary


def _blank_share_outliers(rows):
    """Blank share counts (and the EPS derived from them) that disagree with both neighbours.

    SEC fourth quarters are derived as full year minus nine months, which breaks for
    weighted-average share counts (NVDA's quarter to 2024-01-28 shows 46.9B shares between
    two quarters of about 24.6B, and its EPS is computed from that). A genuine change, such
    as a merger, persists into the next period, so it matches at least one neighbour.
    """
    stamp = lambda row: str(row.get("period_ending") or row.get("date") or "")[:10]
    ordered = sorted((row for row in rows if stamp(row)), key=stamp)
    shares = [next((row[key] for key in SHARE_KEYS[:5] if _positive(row.get(key))), None) for row in ordered]
    blanked = []
    for index, row in enumerate(ordered):
        if shares[index] is None:
            continue
        before = next((value for value in reversed(shares[:index]) if value), None)
        after = next((value for value in shares[index + 1:] if value), None)
        if not before or not after:
            continue
        ratios = (shares[index] / before, shares[index] / after)
        if all(ratio > 1.5 for ratio in ratios) or all(ratio < 1 / 1.5 for ratio in ratios):
            for key in list(row):
                # Dividends per share are declared amounts, not derived from the share count.
                earnings_per_share = PER_SHARE_FIELD.search(key) and "dividend" not in key
                weighted_shares = "weighted" in key or "average_shares" in key
                if earnings_per_share or weighted_shares:
                    row[key] = None
            blanked.append(stamp(row))
    return blanked


def _with_splits(symbol, result):
    if result.get("error") or not result.get("data"):
        return result
    splits = get_section(symbol, "splits")
    if splits.get("error"):
        result["warnings"] = [*result.get("warnings", []), "Split history unavailable; per-share figures are as reported"]
        result.setdefault("metadata", {})["split_adjustment"] = {"basis": "as_reported"}
        _flag_outliers(result)
        return result
    summary = _split_adjust(result["data"], splits.get("data") or [])
    result.setdefault("metadata", {})["split_adjustment"] = summary
    if summary["unverified_periods"]:
        result["warnings"] = [*result.get("warnings", []),
                              f"{summary['unverified_periods']} pre-split periods could not be checked and are as reported"]
    _flag_outliers(result)
    return result


def _flag_outliers(result):
    # Run after split restatement so neighbouring periods share one basis.
    blanked = _blank_share_outliers(result["data"])
    if blanked:
        result.setdefault("metadata", {})["blanked_share_counts"] = blanked
        result["warnings"] = [*result.get("warnings", []),
                              "Inconsistent share count blanked for " + ", ".join(blanked) + " (EPS from that count removed)"]


def _search_row(row, route):
    symbol = str(row.get("symbol") or "").upper()
    exchange = row.get("exchange") or row.get("exchange_code") or ""
    if route.provider == "nasdaq":
        exchange = {"Q": "NASDAQ", "N": "NYSE", "A": "NYSE American", "P": "NYSE Arca", "Z": "Cboe"}.get(row.get("Listing Exchange"), exchange)
    country = row.get("country") or row.get("country_code")
    if route.provider == "yfinance":
        return {**row, "symbol": symbol, "name": row.get("name") or symbol, "exchange": EXCHANGE_NAMES.get(exchange, exchange)}
    if country == "CA" or exchange.upper() in CA_SUFFIXES:
        suffix = CA_SUFFIXES.get(exchange.upper(), ".TO")
        if not symbol.endswith(tuple(CA_SUFFIXES.values())):
            symbol += suffix
    elif route.provider == "tmx" and country not in {None, "US"}:
        return None  # Search only listings supported by the detail routes.
    return {**row, "symbol": symbol, "name": row.get("name") or row.get("company_name") or symbol, "exchange": exchange}


async def _load_search(query):
    routes = (YAHOO_SEARCH, *SEARCH) if _has_yahoo() else SEARCH
    results = await asyncio.gather(*(_fetch(route, {"query": query, "limit": 30, **({"asset_type": "equity"} if route == YAHOO_SEARCH else {})}, timeout=5) for route in routes), return_exceptions=True)
    found = {}
    failures = []
    providers = []
    for route, response in zip(routes, results):
        provider = PROVIDER_NAMES[route.provider]
        if isinstance(response, BaseException):
            failures.append(f"{provider}: {_provider_error(response)}")
            continue
        rows, _metadata = response
        if rows:
            providers.append(provider)
        for row in rows:
            item = _search_row(row, route)
            if item and item["symbol"]:
                found.setdefault(item["symbol"], item)
    needle = query.upper()
    rows = sorted(found.values(), key=lambda row: (row["symbol"] != needle, not row["symbol"].startswith(needle)))[:15]
    error = None
    if not rows and len(failures) == len(routes):
        error = "OpenBB symbol search is unavailable. You can enter a ticker directly."
    source = "OpenBB · " + ", ".join(providers) if providers else None
    return _envelope(rows, source, error, failures, results=rows)


def search(query: str) -> dict:
    """Search installed OpenBB symbol catalogues by company name or ticker."""
    query = query.strip()
    if not query or len(query) > 80:
        return _envelope(results=[])
    return _cache(("search", query.casefold()), 1800, lambda: _run(_load_search(query)))
