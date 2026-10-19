#!/usr/bin/env bash
# 台灣景氣資料源探測 第五輪（暫時性，合併前移除）：央行預告發布時間表；經濟部外銷訂單新聞稿用誠實 UA 是否可抓
set +e
OUT=${1:-/tmp/out}
mkdir -p "$OUT/raw"
LOG="$OUT/log.txt"
CH="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
ME="macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)"
HOST=www.stat.gov.tw
echo | openssl s_client -connect $HOST:443 -servername $HOST 2>/dev/null | openssl x509 > /tmp/leaf.pem
AIA=$(openssl x509 -in /tmp/leaf.pem -noout -text | grep -A2 "Authority Information Access" | grep -o 'CA Issuers - URI:[^ ]*' | sed 's/CA Issuers - URI://')
curl -sS -m 30 -o /tmp/inter.der "$AIA"
openssl x509 -inform DER -in /tmp/inter.der -out /tmp/inter.pem 2>/dev/null || cp /tmp/inter.der /tmp/inter.pem
cp /tmp/inter.pem "$OUT/raw/twca-inter.pem"
cat /etc/ssl/certs/ca-certificates.crt /tmp/inter.pem > /tmp/bundle.pem
get() { # name ua url
  local n=$1 ua=$2 u=$3 r
  r=$(curl -sS -L --cacert /tmp/bundle.pem -o "$OUT/raw/$n" -w "code=%{http_code} size=%{size_download} t=%{time_total}s" -m 40 -A "$ua" "$u" 2>&1)
  echo "GET $n | ec=$? $r | $u" | tee -a "$LOG"
}
get cal-A59000000N.html "$CH" 'https://www.stat.gov.tw/News_NoticeCalendar.aspx?n=3717&IsControl=0&_Hide=1&Dept=A59000000N&page=1&PageSize=200'
get moea-list-me.html "$ME" 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724'
sleep 2
get moea-16911-me.html "$ME" 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724&bull_id=16911'
sleep 2
get moea-list-ch.html "$CH" 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724'
# Node fetch（與正式程式相同）
node -e '
const ME="macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)";
(async()=>{for(const u of ["https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724","https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724&bull_id=16911"]){const t0=Date.now();try{const r=await fetch(u,{headers:{"User-Agent":ME,Accept:"*/*"},signal:AbortSignal.timeout(30000)});const b=await r.text();console.log("NODE",r.status,b.length,(Date.now()-t0)+"ms",u, /億美元/.test(b))}catch(e){console.log("NODE ERR",String(e.cause??e),u)}}})();' | tee -a "$LOG"
echo "完成" | tee -a "$LOG"
