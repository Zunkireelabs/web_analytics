# Admizz (site 8862) recommendation workflow audit — 2026-11-22

Read-only. No production writes. Generated from `server/scripts/audit-recommendation-workflow.js`; full data in `admizz-8862-recommendation-audit-2026-11-22.json`. Open recommendations: 161.
Items marked *needs-verification* were not confirmed against the live site.

## 1. By recommendation type

| Type | Can write automatically | Can resolve automatically with evidence | Requires human approval or input | Cannot safely process yet |
|---|---|---|---|---|
| canonical | 1 | 0 | 0 | 0 |
| faq | 4 | 0 | 0 | 2 |
| meta-title | 1 | 0 | 0 | 8 |
| qa-content | 0 | 12 | 7 | 0 |
| blog-outline | 0 | 0 | 44 | 0 |
| breadcrumbs | 0 | 0 | 10 | 0 |
| content-integrity-repair | 0 | 0 | 1 | 1 |
| expand-content | 0 | 0 | 4 | 11 |
| internal-links | 0 | 0 | 5 | 5 |
| refresh-content | 0 | 0 | 1 | 0 |
| schema-repair | 0 | 0 | 14 | 25 |
| sitemap | 0 | 0 | 1 | 0 |
| direct-answer | 0 | 0 | 0 | 1 |
| duplicate-id-fix | 0 | 0 | 0 | 1 |
| sitemap-removal | 0 | 0 | 0 | 1 |
| translation | 0 | 0 | 0 | 1 |

## Can write automatically
- **canonical — Mapped page file + nextjs-metadata-export adapter.**
  - IDs (1): 13718
- **faq — Writable via ts-named-export-content once its config is added (needs production approval): page-faqs.ts categoryFaqs["for-nepalese-students"].**
  - IDs (1): 13905
- **faq — Writable via ts-named-export-content once its config is added (needs production approval): page-faqs.ts destinationQuizFaqs.**
  - IDs (1): 13906
- **faq — Writable via ts-named-export-content once its config is added (needs production approval): page-faqs.ts categoryFaqs["visa-guides"].**
  - IDs (1): 13907
- **faq — Writable via ts-named-export-content once its config is added (needs production approval): page-faqs.ts blogIndexFaqs.**
  - IDs (1): 13908
- **meta-title — Mapped page file + nextjs-metadata-export adapter.**
  - IDs (1): 13159

## Can resolve automatically with evidence
- **qa-content — categoryFaqs["australia"] already exists in src/data/page-faqs.ts, so the category page already renders curated Q&A. Re-read the live page to confirm before closing.**
  - IDs (1): 13930
- **qa-content — categoryFaqs["new-zealand"] already exists in src/data/page-faqs.ts, so the category page already renders curated Q&A. Re-read the live page to confirm before closing.**
  - IDs (1): 13931
- **qa-content — categoryFaqs["pr-and-migration"] already exists in src/data/page-faqs.ts, so the category page already renders curated Q&A. Re-read the live page to confirm before closing.**
  - IDs (1): 13932
- **qa-content — categoryFaqs["scholarships"] already exists in src/data/page-faqs.ts, so the category page already renders curated Q&A. Re-read the live page to confirm before closing.**
  - IDs (1): 13933
- **qa-content — /course-finder/* FAQs are generated at build time by buildCourseFaqs() (src/lib/university-kb/course-faq.ts) from the course data, and the pages are noindex. There is no per-page store to write; editing the shared template is forbidden. Resolve as not-applicable (needs human OK).**
  - IDs (8): 13934, 13935, 13936, 13937, 13938, 13939, 13940, 13941

## Requires human approval or input
- **blog-outline — New post: topic approval and a human read of the generated draft are required before anything is published; blog-outline target is mapped (see workflow audit for open gaps).**
  - IDs (44): 13013, 13014, 13016, 13729, 13730, 13734, 13892, 13893, 13894, 13895, 13896, 13897, 13898, 13899, 13900, 13901, 13902, 13903, 13904, 13909, 13910, 13911, 13912, 13913, 13914, 13915, 13916, 13917, 13918, 13919, 13920, 13921, 13922, 13923, 13924, 13925, 13926, 13942, 13943, 13944, 13945, 13946, 13947, 13948
- **breadcrumbs — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (10): 13756, 13758, 13761, 13769, 13774, 13777, 13783, 13785, 13787, 13789
- **content-integrity-repair — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (1): 13929
- **expand-content — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (4): 13170, 13171, 13173, 13485
- **internal-links — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (5): 13012, 13490, 13651, 13885, 13886
- **qa-content — Question-style headings on a page whose body is authored by hand/inline data; no safe automatic target.**
  - IDs (3): 12993, 13010, 13760
- **qa-content — categoryFaqs has no "canada" entry. A faq draft could create one through ts-named-export-content (once configured), but qa-content asks for question headings — a human should choose.**
  - IDs (1): 12995
- **qa-content — categoryFaqs has no "course-guides" entry. A faq draft could create one through ts-named-export-content (once configured), but qa-content asks for question headings — a human should choose.**
  - IDs (1): 12996
- **qa-content — categoryFaqs has no "germany" entry. A faq draft could create one through ts-named-export-content (once configured), but qa-content asks for question headings — a human should choose.**
  - IDs (1): 12997
- **qa-content — categoryFaqs has no "medical" entry. A faq draft could create one through ts-named-export-content (once configured), but qa-content asks for question headings — a human should choose.**
  - IDs (1): 12998
- **refresh-content — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (1): 13169
- **schema-repair — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (14): 13755, 13757, 13759, 13762, 13764, 13766, 13770, 13772, 13775, 13778, 13784, 13786, 13788, 13790
- **sitemap — Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.**
  - IDs (1): 13018

## Cannot safely process yet
- **content-integrity-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/step-by-step-guide-to-australia-student-visa-from-nepal.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13927
- **direct-answer — No page to attach it to (recommendation has no page URL) and newContentTargets["direct-answer"] points at src/app/blogs, which is not where Admizz serves /answers pages (src/app/answers/<slug>/page.tsx).**
  - IDs (1): 13011
- **duplicate-id-fix — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/which-country-is-best-for-nepalese-students-in-2026.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13891
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13164
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/total-cost-studying-uk-from-nepal-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13165
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/top-courses-to-study-at-kiit-university.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13166
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/how-to-get-your-noc-from-nepal-for-study-abroad/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13168
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/london-metropolitan-university-fees-courses-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13172
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/top-universities-in-the-uk.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13174
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/study-in-germany-from-nepal-costs-intakes-visa-2026/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13486
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/abertay-university-courses-fees-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13487
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/australia-student-visa-english-test-scores-ielts-pte-toefl-2026/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13488
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/university-of-east-london-courses-fees-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13489
- **expand-content — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/study-abroad-from-nepal/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13650
- **faq — No data store for this page (served by dedicated-page src/app/events/uk-education-expo-2026/page.tsx); writing it would mean editing a page file by hand.**
  - IDs (1): 12987
- **faq — Homepage FAQ is rendered by src/app/HomepageFAQ.tsx; no data-store config exists for it yet.**
  - IDs (1): 13075
- **internal-links — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13491
- **internal-links — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/fulbright-scholarship-for-nepal-complete-application-guide.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13492
- **internal-links — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/london-metropolitan-university-fees-courses-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13652
- **internal-links — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/neb-class-12-result-2083-published.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13653
- **internal-links — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/how-to-get-your-noc-from-nepal-for-study-abroad/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13887
- **meta-title — Mapped to shared src/app/[slug]/page.tsx; correct file src/app/how-to-get-your-noc-from-nepal-for-study-abroad/page.tsx — fix the mapping first (see corrections).**
  - IDs (1): 13160
- **meta-title — Mapped to shared src/app/[slug]/page.tsx; correct file src/app/chevening-scholarship-complete-guide-for-nepali-students/page.tsx — fix the mapping first (see corrections).**
  - IDs (1): 13161
- **meta-title — Mapped to shared src/app/[slug]/page.tsx; correct file src/app/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india/page.tsx — fix the mapping first (see corrections).**
  - IDs (1): 13162
- **meta-title — JSON post served by the shared [slug] template: title/description come from the post JSON, which no writer targets yet.**
  - IDs (3): 13163, 13398, 13484
- **meta-title — Mapped to shared src/app/[slug]/page.tsx; correct file src/app/study-abroad-from-nepal/page.tsx — fix the mapping first (see corrections).**
  - IDs (1): 13397
- **meta-title — Mapped to shared src/app/[slug]/page.tsx; correct file src/app/study-in-australia-from-nepal/page.tsx — fix the mapping first (see corrections).**
  - IDs (1): 13753
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/london-metropolitan-university-fees-courses-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13719
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/university-of-east-london-courses-fees-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13724
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/abertay-university-courses-fees-international-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13728
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/bpp-university-london-international-students-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13733
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/phd-in-uk-for-international-students-fees-funding-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13737
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/uk-graduate-visa-two-years-eligible-universities-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13742
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/uk-graduate-visa-18-months-january-2027-deadline.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13746
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/affordable-universities-london-international-students-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13747
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/study-in-uk-without-ielts-english-requirement-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13748
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/uk-student-visa-cost-2027/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13749
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/adult-nursing-uk-international-students-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13750
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/uk-study-gap-acceptable-international-students-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13751
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/uk-universities-with-london-campuses-international-students-2027.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13752
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/study-in-australia-from-nepal/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13754
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/5-reasons-why-uk-is-an-ideal-study-destination.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13763
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/why-study-in-india-instead-of-us-australia.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13765
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/top-ranked-mba-colleges-in-india-2021.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13767
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/chhath-puja-illuminating-cultural-diversity-in-the-admizz-education-community.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13768
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/content/blog/posts/4-major-difference-between-ielts-pte.json. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13771
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/study-abroad-rule-updates/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13773
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/uk-scholarships-for-Nepalese-students-2027/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13776
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/germany-blocked-account-2026-nepali-students/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13779
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/visa-assistance-for-study-abroad/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13780
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/uk-student-visa-from-nepal/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13781
- **schema-repair — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/scholarship-assistance-in-nepal/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13782
- **sitemap-removal — Resolves to shared template src/app/[slug]/page.tsx; the content lives in src/app/uk-student-visa-from-nepal/page.tsx. The shared-template guard (checkSharedTemplateWrite) will stop the write.**
  - IDs (1): 13019
- **translation — Admizz has no locale routes or translation content directory; newContentTargets["translation"] must NOT be invented. Needs a human decision on whether and where a Nepali version should exist.**
  - IDs (1): 13928

## Mapping corrections (proposed — each needs approval; none applied)

- **add-page** `/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india/page.tsx"}`
  - evidence: src/app/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13164, 13491, 13162
- **add-page** `/how-to-get-your-noc-from-nepal-for-study-abroad`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/how-to-get-your-noc-from-nepal-for-study-abroad/page.tsx"}`
  - evidence: src/app/how-to-get-your-noc-from-nepal-for-study-abroad/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13168, 13887, 13160
- **add-page** `/study-in-germany-from-nepal-costs-intakes-visa-2026`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/study-in-germany-from-nepal-costs-intakes-visa-2026/page.tsx"}`
  - evidence: src/app/study-in-germany-from-nepal-costs-intakes-visa-2026/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13486
- **add-page** `/australia-student-visa-english-test-scores-ielts-pte-toefl-2026`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/australia-student-visa-english-test-scores-ielts-pte-toefl-2026/page.tsx"}`
  - evidence: src/app/australia-student-visa-english-test-scores-ielts-pte-toefl-2026/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13488
- **add-page** `/study-abroad-from-nepal`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/study-abroad-from-nepal/page.tsx"}`
  - evidence: src/app/study-abroad-from-nepal/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13650, 13397
- **add-page** `/chevening-scholarship-complete-guide-for-nepali-students`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/chevening-scholarship-complete-guide-for-nepali-students/page.tsx"}`
  - evidence: src/app/chevening-scholarship-complete-guide-for-nepali-students/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13161
- **add-page** `/study-in-australia-from-nepal`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/study-in-australia-from-nepal/page.tsx"}`
  - evidence: src/app/study-in-australia-from-nepal/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13753, 13754
- **add-page** `/uk-student-visa-cost-2027`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/uk-student-visa-cost-2027/page.tsx"}`
  - evidence: src/app/uk-student-visa-cost-2027/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13749, 13928
- **add-page** `/study-abroad-rule-updates`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/study-abroad-rule-updates/page.tsx"}`
  - evidence: src/app/study-abroad-rule-updates/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13773
- **add-page** `/uk-scholarships-for-Nepalese-students-2027`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/uk-scholarships-for-Nepalese-students-2027/page.tsx"}`
  - evidence: src/app/uk-scholarships-for-Nepalese-students-2027/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13776
- **add-page** `/germany-blocked-account-2026-nepali-students`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/germany-blocked-account-2026-nepali-students/page.tsx"}`
  - evidence: src/app/germany-blocked-account-2026-nepali-students/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13779
- **add-page** `/visa-assistance-for-study-abroad`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/visa-assistance-for-study-abroad/page.tsx"}`
  - evidence: src/app/visa-assistance-for-study-abroad/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13780
- **add-page** `/uk-student-visa-from-nepal`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/uk-student-visa-from-nepal/page.tsx"}`
  - evidence: src/app/uk-student-visa-from-nepal/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13781, 13019
- **add-page** `/scholarship-assistance-in-nepal`
  - old: `"(no pages entry — resolved by pattern to src/app/[slug]/page.tsx)"`
  - new: `{"file":"src/app/scholarship-assistance-in-nepal/page.tsx"}`
  - evidence: src/app/scholarship-assistance-in-nepal/page.tsx exists on the default branch and is this URL's own route; the current mapping resolves to src/app/[slug]/page.tsx (a SHARED template used by every post).
  - recommendation IDs: 13782
- **remove-stale-page** `/study-abroad-consultancy-in-nepal`
  - old: `{"file":"src/app/study-abroad-consultancy-in-nepal/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/study-abroad-consultancy-in-nepal/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: none open
- **remove-stale-page** `/education-consultancy-in-kathmandu`
  - old: `{"file":"src/app/education-consultancy-in-kathmandu/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/education-consultancy-in-kathmandu/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: none open
- **remove-stale-page** `/top-education-consultancy-in-nepal`
  - old: `{"file":"src/app/top-education-consultancy-in-nepal/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/top-education-consultancy-in-nepal/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: 13171
- **remove-stale-page** `/best-education-consultancy-in-nepal`
  - old: `{"file":"src/app/best-education-consultancy-in-nepal/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/best-education-consultancy-in-nepal/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: none open
- **remove-stale-page** `/study-abroad-consultants-in-kathmandu`
  - old: `{"file":"src/app/study-abroad-consultants-in-kathmandu/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/study-abroad-consultants-in-kathmandu/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: none open
- **remove-stale-page** `/overseas-education-consultants-in-nepal`
  - old: `{"file":"src/app/overseas-education-consultants-in-nepal/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/overseas-education-consultants-in-nepal/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: none open
- **remove-stale-page** `/best-education-consultancy-for-study-abroad`
  - old: `{"file":"src/app/best-education-consultancy-for-study-abroad/page.tsx"}`
  - new: `"(remove entry)"`
  - evidence: src/app/best-education-consultancy-for-study-abroad/page.tsx does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.
  - recommendation IDs: none open
- **dead-pattern** `^/([a-z0-9-]+)/$`
  - old: `{"match":"^/([a-z0-9-]+)/$","file":"src/app/$1/page.tsx"}`
  - new: `"(remove pattern, or drop the required trailing slash only after confirming it cannot capture JSON posts)"`
  - evidence: Site URLs carry no trailing slash, so this never matches; and $1 files exist only for dedicated routes, not JSON posts.
  - recommendation IDs: none open

Also proposed (see `admizz-8862-proposed-url_file_map-2026-11-22.json`): faq adapter `ts-named-export-content` for `/blogs` (blogIndexFaqs), `/match-your-destination` (destinationQuizFaqs) and `^/category/([^/]+)/?$` (categoryFaqs, allowCreateKey, keyEvidence categories.json `"current": "{key}"`).

**Blog target** — old: `{dir:"src/app/blogs", filename:"page.tsx", urlPattern:"/blogs/{slug}"}`; new: `dir "src/app"`, `urlPattern "/{slug}"`, `manifestRequired ["imageUrl","categories","href"]`, `collisionChecks ["src/app/{slug}/page.tsx","src/content/blog/posts/{slug}.json"]`. Admizz's `scripts/validate-content.mjs` requires `src/app/<slug>/page.tsx`; the build outcome was not run (unverified). Whether `categoriesSource` (Sanity) should remain is unverified.

## 2. New-blog workflow findings

Target mismatch (above); no slug-collision check; manifest silently recreated when missing; page vs manifest `publishedAt` differed; failed category fetch silently produced no categories; generated posts lack quickAnswer / faqItems / Sources that Admizz's build requires; `checkBlogPostContract` not wired in (not confirmed beyond one grep). Fixed locally: collision, missing-manifest, required-field, publishedAt and category-failure guards. Not fixed: output contract (quickAnswer/faqItems/Sources), nightly audit scheduling.

## 3. Local changes (uncommitted)

`ts-named-export-content` adapter + tests; pre-draft shared-template gate and template-driven-markup gate (`action-scope.js`, `recommendation-gates.js`); blog manifest guards (`frontend.js`, `blog-outline.js`, `newpage-render.js`); rollback support for TS files. Full suite: 401 failing / 109 cancelled with and without these changes (no local DB); 35 new tests pass.

## 4. Needs a human decision

Translation on Admizz (no locale routes); closing the 8 `/course-finder/*` qa-content items as not applicable; approving every mapping correction above.
