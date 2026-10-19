#!/usr/bin/env bash
# 台灣景氣資料源探測 第三輪（暫時性，合併前移除）：主計總處預告統計發布時間表、外銷訂單新聞稿內頁
# stat.gov.tw 未附中繼憑證：從伺服器憑證的 AIA 取得中繼憑證，加進信任清單後正常驗證（不關閉 TLS 驗證）
set +e
OUT=${1:-/tmp/out}
mkdir -p "$OUT/raw"
LOG="$OUT/log.txt"
CH="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

# 1) 補中繼憑證
HOST=www.stat.gov.tw
echo | openssl s_client -connect $HOST:443 -servername $HOST 2>/dev/null | openssl x509 > /tmp/leaf.pem
AIA=$(openssl x509 -in /tmp/leaf.pem -noout -text | grep -A2 "Authority Information Access" | grep -o 'CA Issuers - URI:[^ ]*' | sed 's/CA Issuers - URI://')
echo "AIA $AIA" | tee -a "$LOG"
curl -sS -m 30 -o /tmp/inter.der "$AIA"
openssl x509 -inform DER -in /tmp/inter.der -out /tmp/inter.pem 2>/dev/null || cp /tmp/inter.der /tmp/inter.pem
cat /etc/ssl/certs/ca-certificates.crt /tmp/inter.pem > /tmp/bundle.pem
openssl x509 -in /tmp/inter.pem -noout -subject -issuer | tee -a "$LOG"

get() { # name url
  local n=$1 u=$2
  local r
  r=$(curl -sS -L --cacert /tmp/bundle.pem -o "$OUT/raw/$n" -w "code=%{http_code} size=%{size_download} t=%{time_total}s" -m 40 -A "$CH" "$u" 2>&1)
  echo "GET $n | ec=$? $r | $u" | tee -a "$LOG"
}

# 2) 預告統計資料發布時間表：各機關全部項目（PageSize=200）
for d in A13000000G A07000000D 602000000A A41000000G A45000000D A17000000J; do
  get "cal-$d.html" "https://www.stat.gov.tw/News_NoticeCalendar.aspx?n=3717&IsControl=0&_Hide=1&Dept=$d&page=1&PageSize=200"
done
echo "完成" | tee -a "$LOG"
