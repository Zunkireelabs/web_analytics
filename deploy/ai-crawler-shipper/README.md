# AI crawler log shipper

Runs on a client's **web server**, once an hour, from cron. Reads the site's nginx access log from Docker, keeps only the lines
whose user agent could be an AI crawler, and posts them to the analytics app, which turns them into daily counts and discards
the lines. Ordinary visitors' lines never leave the server.

What the app keeps: per project, per day, per bot, per URL path (no query string), per HTTP status, whether the visit was verified
against the vendor's published IP list, and a hit count. Kept 13 months. No raw lines, no visitor addresses, no user agents.

## Set up one site

1. **Create the upload token** (once per site; it is shown once). This writes to the database `DATABASE_URL` points at, so on
   production it needs the owner's OK first:
   ```
   node server/scripts/create-crawler-token.js --site-id <project id> --label "<container name>"
   ```
2. **On the web server**, as root:
   ```
   mkdir -p /opt/ai-crawler-shipper /etc/ai-crawler-shipper /var/lib/ai-crawler-shipper
   cp ship-logs.sh /opt/ai-crawler-shipper/ && chmod 755 /opt/ai-crawler-shipper/ship-logs.sh
   umask 077
   printf '%s' '<the token>' > /etc/ai-crawler-shipper/<site>.token      # mode 600; the script refuses anything looser
   cat > /etc/ai-crawler-shipper/<site>.conf <<'EOF'
   CONTAINER=<nginx container name>
   ENDPOINT=https://<analytics app host>/api/ai-crawlers/ingest
   TOKEN_FILE=/etc/ai-crawler-shipper/<site>.token
   EOF
   chmod 600 /etc/ai-crawler-shipper/<site>.conf
   ```
3. **Try it without sending anything:**
   ```
   DRY_RUN=1 /opt/ai-crawler-shipper/ship-logs.sh /etc/ai-crawler-shipper/<site>.conf
   ```
   It prints how many log lines it read and how many would be sent. Then run it once for real (the first run reads the last 24 hours).
4. **Schedule it** (`crontab -e` as root):
   ```
   7 * * * * /opt/ai-crawler-shipper/ship-logs.sh /etc/ai-crawler-shipper/<site>.conf >> /var/log/ai-crawler-shipper.log 2>&1
   ```
   Stagger the minute between sites (7, 12, 17 …) if several share a server.

## What to expect

- Each run prints one line (`shipped window … read N lines, sent K`) or an error. Errors leave the window **pending**: the next run
  retries exactly the same window, and the app ignores a repeated identical upload, so a retry can never double count.
- An hour with no AI crawler traffic still sends an empty upload, which is how the dashboard knows the script is alive.
- A token revoked in the app gives `401`; the script keeps failing loudly until it is replaced.
- The log source is `docker logs`, so the container must write its access log to stdout (the official nginx image does).
  A container that is recreated keeps no old logs: the first run after a recreate only sees what the new container has written.

## The sites

| Site | Container | Server |
|---|---|---|
| SuperRank (superrank.si) | `superrank-web-prod` | Kangchenjunga (169.58.62.143) |
| Zennly | `web-zenly-web-prod` | Kangchenjunga |
| Admizz Education | `admizz-edu-web-prod` | Sagarmatha (94.136.189.213) |
| Chayce Properties | `chayce-web-prod` (name from its deploy file) | **not found on either server: its host is not known yet** |
| Zunkireelabs (site 1) | `zunkiree-production` | Kangchenjunga |

All four log in nginx's default format ending with the real visitor address (`"$http_x_forwarded_for"`), checked 2026-11-18.
The analytics app's public address for `ENDPOINT` has not been confirmed from this repo; check it before step 2.
