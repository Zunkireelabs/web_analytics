#!/bin/sh
# Starts the REAL SuperRank system on this machine, against the LOCAL test database only, with every outside key and every scheduled job switched off:
# nothing here can push to a GitHub repo, send an email, call a paid AI service or touch the production database.
#
#   sh web/local-demo/start-local.sh
#   open http://localhost:3002      login: demo@local.test   password: localdemo123
#
# (docker must be running: docker start sr-local-pg)
set -e
cd "$(dirname "$0")/../.."
PW=$(docker inspect sr-local-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
[ -n "$PW" ] || { echo "The local database container sr-local-pg is not available. Run: docker start sr-local-pg"; exit 1; }
exec env \
  DATABASE_URL="postgres://postgres:$PW@localhost:55432/analytics" DB_SSL=off \
  DISABLE_CRON=true DISABLE_CATCHUP=true API_PORT=3002 LLM_WORKER_MODE= \
  GITHUB_PAT= GH_PAT= GITHUB_APP_PRIVATE_KEY_B64= GITHUB_APP_PRIVATE_KEY_B64_CHAYCE= GITHUB_WEBHOOK_SECRET= \
  SMTP_HOST= SMTP_USER= SMTP_PASS= REPORT_EMAIL_TO= REPORT_EMAIL_FROM= \
  OPENAI_API_KEY= ANTHROPIC_API_KEY= GOOGLE_OAUTH_REFRESH_TOKEN= SANITY_TOKEN_ADMIZZ= DATAFORSEO_PASSWORD= SERPAPI_KEY= TAVILY_API_KEY= PEXELS_API_KEY= GOOGLE_CSE_API_KEY= PAGESPEED_API_KEY= \
  DATA_ANALYST_AGENT_INTERNAL_URL= DATA_ANALYST_AGENT_ADMIN_KEY= \
  node server/index.js
