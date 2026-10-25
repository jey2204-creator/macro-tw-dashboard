"""
一次性：從 Wayback Machine 存檔的上海航交所 SCFI 官方頁面回收歷史綜合指數（每個存檔含本期＋上期）。
官方多期／指定日期查詢要登入，免費只公布最新兩期，所以只能靠存檔拼出稀疏歷史。
用法：python3 -u scfi_wayback_seed.py <起年> <迄年> <輸出.json>（GitHub Actions 依年份分批平行跑）
"""
import json, re, sys, time, urllib.parse, urllib.request, collections

UA = "macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)"
PATTERNS = [
    "en.sse.net.cn/indices/scfinew.jsp",
    "www.sse.net.cn/index/singleIndex?indexType=scfi",
    "www1.sse.net.cn/index/scfinew.jsp",
    "www.sse.net.cn/index/scfi.jsp",
    "www.sse.net.cn/index/scfinew.jsp",
    "www1.sse.net.cn/index/scfiAdvanceNew.jsp",
    "en.sse.net.cn/currentIndex?indexName=scfi",
]
DATE = r"(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})"
LABEL = re.compile(r"(Comprehensive\s*Index|综合指数|綜合指數)", re.I)


def get(url, tries=4, timeout=40):
    """archive.org 會限流（連線被拒、503、握手逾時）：指數退避 10、20、40 秒"""
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout).read()
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(10 * 2 ** i)


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
    t = re.sub(r"<[^>]+>", " ", t).replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", t)


def extract(raw, original):
    if "currentIndex" in original or raw[:1] == b"{":
        try:
            d = json.loads(raw)["data"]
            line = next(x for x in d["lineDataList"] if x["properties"].get("lineName_EN") == "Comprehensive Index")
            out = []
            if line.get("lastContent") is not None:
                out.append((d["lastDate"], float(line["lastContent"])))
            if line.get("currentContent") is not None:
                out.append((d["currentDate"], float(line["currentContent"])))
            return out
        except Exception:  # noqa: BLE001
            return []
    t = text_of(raw)
    m = LABEL.search(t)
    if not m:
        return []
    dates = ["%04d-%02d-%02d" % tuple(map(int, x)) for x in re.findall(DATE, t[: m.start()])]
    nums = [float(x) for x in re.findall(r"(?<![\d.])(\d{3,5}\.\d{1,4})(?![\d.])", t[m.end(): m.end() + 200])]
    if len(dates) < 2 or len(nums) < 2:
        return []
    d_prev, d_cur = dates[-2], dates[-1]
    a, b = nums[0], nums[1]
    if d_prev > d_cur:
        d_prev, d_cur, a, b = d_cur, d_prev, b, a
    if not (300 < a < 20000 and 300 < b < 20000):
        return []
    return [(d_prev, a), (d_cur, b)]


def main(y0, y1, out_file):
    snaps = {}
    for p in PATTERNS:
        q = urllib.parse.urlencode({"url": p, "matchType": "prefix", "output": "json", "fl": "timestamp,original", "filter": "statuscode:200", "collapse": "timestamp:8", "from": y0, "to": y1})
        try:
            rows = json.loads(get("https://web.archive.org/cdx/search/cdx?" + q, tries=3, timeout=60) or b"[]")[1:]
        except Exception as e:  # noqa: BLE001
            print("CDX ERR", p, e, flush=True)
            continue
        finally:
            time.sleep(3)
        for ts, orig in rows:
            o = orig.lower()
            if "scfi_sa" in o or "scfis" in o or ("indextype=scfi" in o and not re.search(r"indextype=scfi($|&)", o)):
                continue
            snaps[ts[:8] + "|" + orig.split("//")[-1].split("?")[0]] = (ts, orig)
        print("CDX", p, len(rows), flush=True)
    print("snapshots", len(snaps), flush=True)
    by_date = collections.defaultdict(list)
    done = 0
    saved = set()
    for ts, orig in sorted(snaps.values()):
        try:
            raw = get(f"https://web.archive.org/web/{ts}id_/{orig}")
            pts = extract(raw, orig)
            key = re.sub(r"\W+", "_", orig.split("//")[-1])[:60]
            if key not in saved:
                saved.add(key)
                open(f"{out_file}.raw-{ts}-{key}.html", "wb").write(raw)
        except Exception as e:  # noqa: BLE001
            print("ERR", ts, orig, str(e)[:80], flush=True)
            pts = []
        for d, v in pts:
            by_date[d].append([round(v, 2), f"{ts}:{orig}"])
        done += 1
        print(ts, len(pts), pts, flush=True)
        if done % 10 == 0:
            json.dump(by_date, open(out_file, "w"), ensure_ascii=False)
        time.sleep(2)
    json.dump(by_date, open(out_file, "w"), ensure_ascii=False)
    print("points", len(by_date), flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
