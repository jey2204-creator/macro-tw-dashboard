"""
一次性：從 Wayback Machine 存檔的上海航交所 SCFI 頁面，回收歷史綜合指數，產生 data/scfi-seed.json 的候選值。

為什麼：上海航交所官方「多期查詢」與「指定日期查詢」都要登入，免費只公布最新兩期（本期＋上期）。
Wayback 存了各時期的官方頁面（每個存檔含本期＋上期），可以拼出稀疏的歷史（每年數次到數十次）。
用法（GitHub Actions 或可連 web.archive.org 的機器）：python3 scfi_wayback_seed.py out.json
輸出：{"points": [[date, value, source_url], ...], "conflicts": [...]}；同一日期多個存檔數值不一致時列入 conflicts。
"""
import json, re, sys, time, urllib.parse, urllib.request, collections

UA = "macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)"
PATTERNS = [
    "en.sse.net.cn/indices/scfinew.jsp*",
    "www.sse.net.cn/index/singleIndex?indexType=scfi",
    "www1.sse.net.cn/index/scfinew.jsp*",
    "www.sse.net.cn/index/scfi.jsp*",
    "www.sse.net.cn/index/scfinew.jsp*",
    "www1.sse.net.cn/index/scfiAdvanceNew.jsp*",
    "en.sse.net.cn/currentIndex?indexName=scfi",
]
DATE = r"(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})"
LABEL = re.compile(r"(Comprehensive\s*Index|综合指数|綜合指數)", re.I)


def get(url, tries=3):
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def norm_date(m):
    y, mo, d = m
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def text_of(raw):
    for enc in ("utf-8", "gb18030"):
        try:
            t = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        t = raw.decode("utf-8", "replace")
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", t)


def extract(raw, original):
    """回傳 [(date, value)]：本期與上期"""
    if original.startswith("https://en.sse.net.cn/currentIndex") or raw[:1] == b"{":
        try:
            j = json.loads(raw)
            d = j["data"]
            line = next(x for x in d["lineDataList"] if x["properties"].get("lineName_EN") == "Comprehensive Index")
            out = []
            if line.get("currentContent") is not None:
                out.append((d["currentDate"], float(line["currentContent"])))
            if line.get("lastContent") is not None:
                out.append((d["lastDate"], float(line["lastContent"])))
            return out
        except Exception:  # noqa: BLE001
            return []
    t = text_of(raw)
    m = LABEL.search(t)
    if not m:
        return []
    head = t[: m.start()]
    dates = [norm_date(x) for x in re.findall(DATE, head)]
    after = t[m.end(): m.end() + 200]
    nums = [float(x) for x in re.findall(r"(?<![\d.])(\d{3,5}\.\d{1,4})(?![\d.])", after)]
    if len(dates) < 2 or len(nums) < 2:
        return []
    # 表頭順序：上期、本期（最後兩個日期）；數值順序同表頭
    d_prev, d_cur = dates[-2], dates[-1]
    if d_prev > d_cur:
        d_prev, d_cur = d_cur, d_prev
        nums[0], nums[1] = nums[1], nums[0]
    if not (300 < nums[0] < 20000 and 300 < nums[1] < 20000):
        return []
    return [(d_prev, nums[0]), (d_cur, nums[1])]


def main(out_file):
    snaps = {}
    for p in PATTERNS:
        q = urllib.parse.urlencode({"url": p, "output": "json", "fl": "timestamp,original", "filter": "statuscode:200", "collapse": "timestamp:8"})
        try:
            rows = json.loads(get("https://web.archive.org/cdx/search/cdx?" + q) or b"[]")[1:]
        except Exception as e:  # noqa: BLE001
            print("CDX ERR", p, e)
            continue
        for ts, orig in rows:
            if "scfi_sa" in orig or "scfis" in orig.lower():
                continue
            snaps[ts[:8] + "|" + orig.split("?")[0].split("//")[-1]] = (ts, orig)
        print("CDX", p, len(rows))
        time.sleep(1)
    print("snapshots", len(snaps))
    by_date = collections.defaultdict(list)
    ok = fail = 0
    for ts, orig in sorted(snaps.values()):
        url = f"https://web.archive.org/web/{ts}id_/{orig}"
        try:
            raw = get(url)
            pts = extract(raw, orig)
        except Exception as e:  # noqa: BLE001
            print("ERR", ts, orig, e)
            pts = []
        if pts:
            ok += 1
            for d, v in pts:
                by_date[d].append((round(v, 2), f"{ts}:{orig}"))
        else:
            fail += 1
        time.sleep(0.8)
    points, conflicts = [], []
    for d in sorted(by_date):
        vals = collections.Counter(v for v, _ in by_date[d])
        if len(vals) > 1:
            conflicts.append([d, [[v, c] for v, c in vals.items()]])
        v, _ = vals.most_common(1)[0]
        points.append([d, v, by_date[d][0][1]])
    json.dump({"points": points, "conflicts": conflicts}, open(out_file, "w"), ensure_ascii=False, indent=0)
    years = collections.Counter(p[0][:4] for p in points)
    print("parsed ok", ok, "fail", fail, "points", len(points), "conflicts", len(conflicts))
    print("per-year", sorted(years.items()))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "scfi-wayback.json")
