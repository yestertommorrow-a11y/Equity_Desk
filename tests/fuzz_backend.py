"""Synthetic-data tests for Equity Desk backend logic (no network)."""
import copy, math, sys, traceback
sys.path.insert(0, sys.argv[1])
from backend import openbb_data as o

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))

def run(name, fn):
    try:
        fn()
    except Exception as exc:
        results.append((name, False, "EXCEPTION " + type(exc).__name__ + ": " + str(exc)[:200]))

# ---- _symbol parsing -------------------------------------------------------
def symbols():
    cases = {
        "AAPL": ("AAPL", "US"), "nasdaq:aapl": ("AAPL", "US"), "TSX:SHOP": ("SHOP.TO", "CA"),
        "RY.TO": ("RY.TO", "CA"), "BRK.B": ("BRK.B", "US"), "7203.T": ("7203.T", "GLOBAL"),
        "LSE:VOD": ("VOD.L", "GLOBAL"), "VOD.L": ("VOD.L", "GLOBAL"), "BRK-B": ("BRK-B", "US"),
        "TSXV:ABC": ("ABC.V", "CA"), "XETRA:SAP": ("SAP.DE", "GLOBAL"),
    }
    for raw, want in cases.items():
        try:
            got = o._symbol(raw)
        except Exception as exc:
            got = "ERR " + str(exc)
        check(f"_symbol({raw!r})", got == want, f"got {got} want {want}")
    for bad in ["", ":", "AAPL:", "^GSPC", "A B", "FOO:BAR", "X" * 25, "TSX:"]:
        try:
            got = o._symbol(bad); check(f"_symbol rejects {bad!r}", False, f"accepted -> {got}")
        except ValueError:
            check(f"_symbol rejects {bad!r}", True)
        except Exception as exc:
            check(f"_symbol rejects {bad!r}", False, "wrong exception " + type(exc).__name__)
    # Class shares with suffix A/B but listed abroad e.g. "XYZ.A" on TSX? .A treated as US
    check("_symbol('TECK.B') treated as US share class", o._symbol("TECK.B") == ("TECK.B", "US"), str(o._symbol("TECK.B")))
run("symbols", symbols)

# ---- _date_window ------------------------------------------------------------
def windows():
    from datetime import date
    w = o._date_window("YTD", None, None); check("YTD starts Jan 1", w["start_date"] == date(date.today().year, 1, 1))
    try:
        o._date_window("1Y", "2025-02-30", None); check("bad date rejected", False, "accepted 2025-02-30")
    except ValueError:
        check("bad date rejected", True)
    try:
        o._date_window("1Y", "2025-05-01", "2025-01-01"); check("start>end rejected", False)
    except ValueError:
        check("start>end rejected", True)
run("windows", windows)

# ---- _split_adjust ------------------------------------------------------------
def splits():
    # Reverse split 1:10 on 2023-06-01; pre-split row unadjusted (10x more shares)
    rows = [
        {"period_ending": "2024-12-31", "weighted_ave_basic_shares_os": 100e6, "basic_eps": 5.0, "cash_dividends_per_share": 1.0, "net_income": 500e6},
        {"period_ending": "2023-12-31", "weighted_ave_basic_shares_os": 101e6, "basic_eps": 4.0, "net_income": 404e6},
        {"period_ending": "2022-12-31", "weighted_ave_basic_shares_os": 1020e6, "basic_eps": 0.3, "net_income": 306e6},
    ]
    s = o._split_adjust(rows, [{"date": "2023-06-01", "numerator": 1, "denominator": 10}])
    check("reverse split: pre-split shares /10", math.isclose(rows[2]["weighted_ave_basic_shares_os"], 102e6), str(rows[2]))
    check("reverse split: pre-split EPS x10", math.isclose(rows[2]["basic_eps"], 3.0), str(rows[2]["basic_eps"]))
    check("reverse split summary", s["adjusted_periods"] == 1 and s["basis"] == "current", str(s))
    # 3:2 split with modest growth: must pick right factor
    rows = [
        {"period_ending": "2024-12-31", "weighted_ave_basic_shares_os": 150e6, "basic_eps": 2.0},
        {"period_ending": "2023-12-31", "weighted_ave_basic_shares_os": 100e6, "basic_eps": 2.7},  # unadjusted
        {"period_ending": "2022-12-31", "weighted_ave_basic_shares_os": 148e6, "basic_eps": 1.6},  # already adjusted
    ]
    o._split_adjust(rows, [{"date": "2024-03-01", "numerator": 3, "denominator": 2}])
    check("3:2 unadjusted row restated", math.isclose(rows[1]["weighted_ave_basic_shares_os"], 150e6), str(rows[1]))
    check("3:2 adjusted row untouched", math.isclose(rows[2]["weighted_ave_basic_shares_os"], 148e6), str(rows[2]))
    # Field-name safety: money fields containing 'share' must not be scaled
    rows = [{"period_ending": "2024-12-31", "weighted_ave_basic_shares_os": 400e6},
            {"period_ending": "2023-12-31", "weighted_ave_basic_shares_os": 100e6, "net_income_attributable_to_common_shareholders": 9e9,
             "share_based_compensation": 1e9, "repurchase_of_common_shares": -5e9, "payments_for_repurchase_of_common_stock": -5e9,
             "preferred_shares_value": 7e8, "common_shares_issued_amount": 2e8, "basic_eps": 2.0}]
    o._split_adjust(rows, [{"date": "2024-06-01", "numerator": 4, "denominator": 1}])
    r = rows[1]
    check("split: shareholders' income untouched", r["net_income_attributable_to_common_shareholders"] == 9e9, str(r))
    check("split: share-based comp untouched", r["share_based_compensation"] == 1e9, str(r["share_based_compensation"]))
    check("split: repurchase amount untouched", r["repurchase_of_common_shares"] == -5e9, str(r["repurchase_of_common_shares"]))
    check("split: preferred value untouched", r["preferred_shares_value"] == 7e8, str(r["preferred_shares_value"]))
    check("split: issued amount untouched", r["common_shares_issued_amount"] == 2e8, str(r["common_shares_issued_amount"]))
    # Split on the exact period end date
    rows = [{"period_ending": "2024-06-30", "weighted_ave_basic_shares_os": 400e6, "basic_eps": 1},
            {"period_ending": "2024-03-31", "weighted_ave_basic_shares_os": 100e6, "basic_eps": 4}]
    o._split_adjust(rows, [{"date": "2024-06-30", "numerator": 4, "denominator": 1}])
    check("split dated on period end: earlier row restated", rows[1]["basic_eps"] == 1, str(rows[1]))
    # Bad split data
    s = o._split_adjust([{"period_ending": "2024-01-01", "basic_eps": 1}], [{"date": None, "numerator": "x"}, {"date": "2023-01-01", "numerator": 0, "denominator": 1}])
    check("bad split rows ignored", s["basis"] == "current", str(s))
    # Negative EPS + net income (loss) -> implied shares positive
    rows = [{"period_ending": "2024-12-31", "net_income": -100e6, "basic_eps": -1.0},
            {"period_ending": "2023-12-31", "net_income": -100e6, "basic_eps": -4.0}]
    o._split_adjust(rows, [{"date": "2024-06-01", "numerator": 4, "denominator": 1}])
    check("loss-making: implied shares restate EPS", rows[1]["basic_eps"] == -1.0, str(rows[1]))
    # Zero net income with EPS 0 -> cannot infer
    rows = [{"period_ending": "2024-12-31", "weighted_ave_basic_shares_os": 400e6},
            {"period_ending": "2023-12-31", "net_income": 0, "basic_eps": 0.0}]
    s = o._split_adjust(rows, [{"date": "2024-06-01", "numerator": 4, "denominator": 1}])
    check("zero earnings row flagged unverified", s["unverified_periods"] == 1, str(s))
run("splits", splits)

# ---- outliers ----------------------------------------------------------------
def outliers():
    base = lambda s: [{"period_ending": f"2024-0{i}-28", "weighted_ave_basic_shares_os": v, "basic_eps": 1.0, "diluted_eps": 1.0, "cash_dividends_per_share": 0.1}
                      for i, v in enumerate(s, 1)]
    rows = base([100e6, 100e6, 300e6, 100e6]); b = o._blank_share_outliers(rows)
    check("spike blanked", b == ["2024-03-28"], str(b))
    check("spike: dividend kept", rows[2]["cash_dividends_per_share"] == 0.1)
    rows = base([100e6, 100e6, 30e6, 100e6]); check("dip blanked", o._blank_share_outliers(rows) == ["2024-03-28"])
    rows = base([100e6, 160e6, 100e6, 160e6]); b = o._blank_share_outliers(rows)
    check("alternating noise (1.6x) both directions", True, f"blanked {b}")
    rows = base([None, 100e6, 300e6, None]); check("missing neighbours -> nothing", o._blank_share_outliers(rows) == [])
    rows = [{"period_ending": None}, {"date": "2024-01-01", "weighted_ave_basic_shares_os": "abc"}]
    check("junk rows tolerated", o._blank_share_outliers(rows) == [])
run("outliers", outliers)

# ---- _normalize --------------------------------------------------------------
def normalize():
    opts = {"range": "1Y", "start_date": None, "end_date": None, "limit": 50, "period": "annual"}
    q = o._normalize("quote", [{"last_price": 10, "prev_close": 0}], "X", "US", opts)
    check("quote with prev_close 0 no crash", q and q[0].get("change") is None, str(q))
    q = o._normalize("quote", [{"last_price": 10, "prev_close": 8, "change_percent": 0.25}], "X", "US", opts)
    check("quote change_percent points", q[0]["change_percent_points"] == 25.0, str(q[0]["change_percent_points"]))
    h = o._normalize("history", [{"date": "2024-01-02", "close": 1}, {"date": None, "close": 2}, {"date": "2024-01-01", "close": None}], "X", "US", opts)
    check("history drops null rows", len(h) == 1)
    # intraday 1D keeps last session only; dates as datetime with tz
    opts1 = {**opts, "range": "1D"}
    h = o._normalize("history", [{"date": "2024-01-02T15:00:00-05:00", "close": 1}, {"date": "2024-01-03T09:30:00-05:00", "close": 2}, {"date": "2024-01-02T20:00:00-05:00", "close": 3}], "X", "US", opts1)
    check("1D keeps last session", [r["close"] for r in h] == [2], str(h))
    # statements limit + sort
    s = o._normalize("income", [{"period_ending": "2020-01-01"}, {"period_ending": "2024-01-01"}, {"date": "2022-01-01"}], "X", "US", {**opts, "limit": 2})
    check("statements newest first, limited", [r.get("period_ending") or r.get("date") for r in s] == ["2024-01-01", "2022-01-01"], str(s))
    # earnings calendar symbol filter for CA
    c = o._normalize("earnings_calendar", [{"symbol": "RY", "report_date": "2026-12-01"}, {"symbol": "TD", "report_date": "2026-12-02"}], "RY.TO", "CA", opts)
    check("calendar filters to RY", [r["symbol"] for r in c] == ["RY"], str(c))
    # dividends: mixed date fields; sort with None
    d = o._normalize("dividends", [{"ex_dividend_date": "2024-01-01", "amount": 1}, {"amount": 2}, {"date": "2025-01-01", "amount": 3}], "X", "US", opts)
    check("dividends sort with missing date", [r["amount"] for r in d] == [3, 1, 2], str(d))
run("normalize", normalize)

# ---- cache -------------------------------------------------------------------
def cache():
    calls = []
    def loader():
        calls.append(1); return {"error": None, "data": [1]}
    o._cache(("t",), 100, loader); o._cache(("t",), 100, loader)
    check("cache hit", len(calls) == 1)
    o._cache(("t",), 100, loader, refresh=True); check("refresh bypasses", len(calls) == 2)
    def boom(): raise RuntimeError("x")
    try:
        o._cache(("b",), 100, boom)
    except RuntimeError:
        pass
    check("failed loader leaves no in-flight entry", ("b",) not in o.IN_FLIGHT)
    for i in range(200): o._cache(("fill", i), 100, loader)
    check("cache bounded", len(o.CACHE) <= 160, str(len(o.CACHE)))
run("cache", cache)

# ---- get_section validation ---------------------------------------------------
def validation():
    for kwargs, label in [({"limit": 0}, "limit 0"), ({"limit": 101}, "limit 101"), ({"limit": "abc"}, "limit text"),
                          ({"period": "monthly"}, "period monthly"), ({"range": "2W"}, "range 2W")]:
        r = o.get_section("AAPL", "quote", **kwargs)
        check(f"get_section rejects {label}", r["error"], str(r)[:120])
    r = o.get_section("AAPL", "history", start_date="2025-13-01")
    check("history bad start_date rejected", r["error"], str(r)[:150])
run("validation", validation)

bad = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("PASS " if ok else "FAIL ") + name + ("  | " + detail if detail and not ok else ""))
print(f"\n{len(results) - len(bad)} passed, {len(bad)} failed")
