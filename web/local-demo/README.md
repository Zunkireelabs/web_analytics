# Local check of the draft preview and click-to-edit

Example drafts (one or two per client) with the real preview and edit code. Nothing here touches a real client repo or the production database.

    # 1. the local test database must be running (docker start sr-local-pg)
    # 2. from the repo root, in two terminals:
    DATABASE_URL=postgres://postgres:<local password>@localhost:55432/analytics DB_SSL=off FIXTURES=<path to fixtures.json> node web/local-demo/server.mjs
    npx vite --config web/local-demo/vite.config.js
    # open http://localhost:5199

Add DEMO_AI=claude to the first command to let "Change it" rewrite with this machine's Claude Code login.
The previews load each client's real site over the internet (their own pages, fonts and styles).
