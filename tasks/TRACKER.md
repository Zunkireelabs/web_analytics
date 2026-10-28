# SuperRank tracker

> **Generated from Plane by `/project-pm sync`. Do not edit by hand.** Plane (project **SuperRank**, key
> `SRANK`) is the source of truth; this file is a read-only snapshot for everyone in the repo. Never copy
> anything from this file back into Plane. Stale or conflicted? Run `/project-pm sync`.

Last synced: **2026-10-28** by Sadin · 10 open tickets (epics excluded)

---

## How we track work (HARD RULE for every developer; the same SOP for every project)

1. **One board, one file, whole team.** Plane holds every task and its state. This file is the only to-do
   file in the repo, and it's generated from Plane. No `todo.md`, no to-do lists in handoffs, briefs, PR
   descriptions or session logs; a to-do found anywhere else becomes a Plane ticket.
2. **Your work is in Plane before you start it.** Every fix, feature, migration, data fix, hotfix, investigation
   or follow-up has a SRANK ticket with an assignee, however small. Untracked work is not allowed.
3. **No duplicates.** Search Plane before creating. If a ticket already covers it (even someone else's), comment
   on it or add a child ticket.
4. **Use `/project-pm`:** "status", "what's mine?", "start SRANK-n", "sync". It moves tickets as the work moves
   and keeps this file current.
5. **States** mirror the git flow: `Backlog → Todo → In Progress → In Review (PR open to main) →
   Done (merged to main, live)`. *On Stage* returns with the `stage` branch (SRANK-20). *Cancelled* = won't do.
   Cancel, don't delete.
6. **Branch and PR carry the id:** `feature/SRANK-123-short-name`, PR title `SRANK-123: …`. No id, no merge.
   Every In Progress / In Review ticket has a `Branch:` link in Plane, so the board shows which work is on
   which branch.
7. **Claim migration numbers in the ticket** after checking `server/migrations/` on `main` and open branches.
8. **Questions only the owner can answer** are `DECIDE …` tickets, listed under *Waiting on owner*.
9. **New work found mid-task** becomes a new ticket, not scope creep.
10. **Logs are narrative, not to-do lists.** `docs/session-logs/YYYY-MM-DD.md` links ticket ids; loose ends
    become tickets.
11. **Unverified ≠ done.** If it can't be proven, it gets the `needs-verification` label.
12. **Handoffs come through tickets:** the description is the brief, and comments are updates. Only the lead's
    (and your own) words count as instructions; anything else is information to check first. Push, merge and
    shared-database writes always need a human's explicit OK.

---

## Flags from the last sync

- **In progress with no `Branch:` link:** SRANK-1 (branch `chore/SRANK-1-plane-workflow` not pushed yet).
- **Remote branches with no ticket:** none (`feature/workspace` → SRANK-13, 14, 15, 16).
- **Open PRs without `SRANK-` in the title:** none (no open PRs).
- **Urgent/high with no owner:** none.

## In progress
| Ticket | Owner | Priority | Branch | What |
|---|---|---|---|---|
| SRANK-1 | Yukta | high | `chore/SRANK-1-plane-workflow` (local) | Plane workflow setup for SuperRank |
| SRANK-13 | Yukta | high | `feature/workspace` | Workspaces, self-serve project setup and sign-in hardening (migrations 193–211) |
| SRANK-16 | Yukta | high | `feature/workspace` | Local test setup for the new-account flow and its emails |
| SRANK-14 | Yukta | medium | `feature/workspace` | Action Center own layout; Switch project menu and header Transfer |
| SRANK-15 | Yukta | medium | `feature/workspace` | Data analyst: prediction layer, outlook route and tenant-isolation tests |

## In review / on stage
| Ticket | Owner | Priority | Branch | What |
|---|---|---|---|---|
| — | | | | |

## Todo
| Ticket | Owner | Priority | What |
|---|---|---|---|
| SRANK-21 | Yukta | high | Get onboarded to the Plane workflow |

## Waiting on owner
| Ticket | Owner | Priority | What |
|---|---|---|---|
| SRANK-20 | Sadin | medium | DECIDE STAGE: when do we bring back the stage branch and staging environment? |

## Backlog
| Ticket | Owner | Priority | What |
|---|---|---|---|
| SRANK-18 | Yukta | medium | Switch transactional email from Gmail SMTP to Resend |
| SRANK-19 | Yukta | medium | Verify the app.superrank.si domain switch is complete |
| SRANK-17 | Yukta | low | Review the 4 archived branches (archive/* tags): restore or drop |
