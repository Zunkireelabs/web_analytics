# Platform self-repair and release workflow

Human approval is required **only** to merge into `main` and release to production. Everything before and after that is
autonomous. This is what is built, how each step works, and what has to be configured.

```
diagnosed shared-code fault (design repair)            agents/lib/code-self-repair.js   ENABLE_CODE_SELF_REPAIR
  -> investigate + fix + tests + security checks, in a scrubbed-env sandbox
  -> PR into STAGE (never main; no stage branch = no PR, a person is told)
  -> checks green -> the staging agent merges into STAGE   agents/lib/platform-staging-merge.js   ENABLE_PLATFORM_STAGING_AUTOMERGE
  -> push to stage -> .github/workflows/deploy-staging.yml deploys it (existing workflow, unchanged)
  -> VERIFY STAGING   the deploy run succeeded for the merge AND the live app passes /api/health + serves the dashboard
                      -> label `staging-verified` (or `staging-failed`, never promoted)       agents/lib/platform-release.js
  -> PROMOTE          fresh branch from the LATEST main with ONLY the staging-verified PRs replayed onto it
                      -> PR into main. NEVER merged by an agent.                              lib/promotion-branch.js
  -> a person reviews and merges the promotion PR
  -> push to main -> .github/workflows/deploy.yml deploys production (existing workflow, unchanged)
  -> VERIFY PRODUCTION  the production deploy run succeeded AND the live app passes the same checks
                      -> label `production-verified`, or `production-failed` with the rollback workflow to run (not run by the agent)
```

State lives in labels on the pull requests (`staging-verified`, `promoted`, `production-verified`, ...), so it is visible on
GitHub and needs no database.

## What can never happen
- An agent merges into `main`, or triggers a deploy or a rollback. The deploys are the repo's own workflows, run by GitHub, on
  merges a person approved. (`platform-branch-policy.js` refuses `main` as a target; GitHub branch protection is the real backstop.)
- An unverified change reaches a promotion PR. Anything still deploying, unreachable, unreadable, or missing its URL stays unverified.
- Stage's unrelated contents reach production. The promotion branch replays only the verified PRs onto `main`; a PR whose files
  `main` has since changed is held back with the reason, never forced.

## Client sites
`lib/stage-promotion.js` follows the same rule for client repositories: after a client's batch is merged on their stage branch,
the promotion PR is a fresh branch from the latest `main` containing only the merged batches (not `stage` itself). A client with no
stage branch gets a PR to `main` and the reminder, merged by a person, as before.

## Configuration required (nothing is guessed; each is off or fail-closed when unset)
| Setting | Where | Purpose |
|---|---|---|
| `stage` branch | GitHub | does not exist yet; without it self-repair opens nothing |
| branch protection on `main` | GitHub | require a person's review; no bypass for the agent's token |
| `ENABLE_CODE_SELF_REPAIR` | staging server env | turns on the repair agent (leave unset in production) |
| `ENABLE_PLATFORM_STAGING_AUTOMERGE` | staging server env | lets the staging agent merge green PRs into stage |
| `ENABLE_PLATFORM_RELEASE_AGENT` | server env | verification, promotion PR, production verification |
| `PLATFORM_STAGING_URL`, `PLATFORM_PRODUCTION_URL` | server env | `https://` + the `STAGING_DOMAIN` / `PROD_DOMAIN` repo variables |
| `PLATFORM_STAGING_MCP_URL`, `PLATFORM_PRODUCTION_MCP_URL` | server env (optional) | also checked when set |
| `OPENAI_API_KEY` | server env | the repair agent uses OpenAI when this is set |
| GitHub token for the platform repo | server env | contents, pull requests, issues (labels, comments) and actions (read) |
| `PLATFORM_REPO_BASE_BRANCH` / `PLATFORM_PRODUCTION_BRANCH` | optional | default `stage` / `main` |
