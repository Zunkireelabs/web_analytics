-- Rollback support for data-file adapters (locations-faq/compare-faq/
-- glossary-faq — see server/implementers/adapters/): a snapshot of the
-- exact pre-merge file content, captured at merge time (before the merge
-- commit lands), so a later rollback has something real to restore even
-- after the live file has since changed further. Nullable/purely additive
-- — every existing row and every draft type without a rollback()
-- implementation simply never populates it.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS rollback_snapshot JSONB;
