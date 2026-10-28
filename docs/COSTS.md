# Technology & Operating Cost Assessment — Honest OS

> Status: **Estimate.** Prices come from third-party summaries and Anthropic's published list prices as of 2026-10. **Verify every line on the vendor's pricing page before committing a budget.** · Phase 1 deliverable #8 · Last updated: 2026-10-28

Assumptions: 15–60 users (A-02), 1–2 developers, and a database under 8 GB in year one (≈ 50k customers, 1–2M movements, attachments in Storage).

## 1. Monthly operating cost (USD)

| Item | Choice | Basis | MVP (Phases 2–4) | Full (Phases 5–7) | Confidence |
|------|--------|-------|------------------|-------------------|------------|
| Hosting | **Vercel Pro** | ~$20 per developer seat; viewers free; usage credit included. Hobby is non-commercial, so it is not allowed for production. | $20–40 | $20–40 (+ usage if traffic grows) | Medium |
| Database + Auth + Storage + Realtime | **Supabase Pro** | $25 base incl. $10 compute credit; **Small** compute (~$15) recommended → ~$30 net. Includes 8 GB DB, 100 GB storage, 250 GB egress, 100k MAU. | $30–40 | $30–75 (Medium compute if needed) | Medium |
| Backups beyond daily | Supabase **Point-in-Time Recovery** add-on | Strongly recommended before finance go-live (RPO minutes instead of 24 h). Price varies by retention: verify. | $0 (dailies only) | ~$100 (verify) | Low |
| Staging environment | Second Supabase project (or branching) | Small/Micro compute | $10–25 | $10–25 | Medium |
| Automation | **Make.com** (Core-tier plan) | Operation-based. 7 scenarios at MVP volumes ≈ a few thousand ops/month. | ~$10–20 (verify) | ~$20–40 | Low |
| Messaging | **WhatsApp Cloud API** | Per delivered template. Utility templates for transactional messages; marketing much more expensive. Egypt rates lowered in 2025. Formula: utility msgs × Egypt utility rate + marketing msgs × Egypt marketing rate. | $0 until Phase 6 | likely < $30 at ~3k utility msgs/month (verify the Egypt rate card) | Low |
| Email | Google Workspace (assumed already in use) | Sending through the existing domain | $0 incremental | $0 | Medium |
| Monitoring | Sentry (free developer → Team tier) + free uptime monitor | Error tracking, alerts | $0–26 | ~$26 | Medium |
| AI | **Claude API**, `claude-opus-5-5` ($4 / $20 per MTok) | 3,300 questions/month estimate (see `docs/AI.md` §6) | $0 | ~$110–170 (Sonnet 5.5 ≈ half; Haiku 5.5 < $10; owner decides after eval) | Medium (volume is an assumption) |
| ETA e-invoicing | Depends on D-02 | Signing token/HSM, or a third-party ETA connector subscription, or none if accounting software handles it | unknown | unknown | — |
| Domain / DNS | Existing `honesteg.co` (subdomain `app.honesteg.co`) | — | $0 | $0 | High |
| **Total** | | | **≈ $70–150 / month** | **≈ $350–500 / month** (with PITR and AI) | |

Excluded: developer salaries, Shopify and Paymob fees (already paid by the business; Paymob takes per-transaction fees), mobile data for reps, and legal/accounting advice.

## 2. Cost levers

| Lever | Saving | Trade-off |
|-------|--------|-----------|
| Run Make.com scenarios as code in the dispatcher instead | Make plan fee | More code to maintain; lose the visual editor |
| n8n self-hosted instead of Make | Plan fee at higher volumes | You run and patch a server (~$5–10/month VPS + time) |
| Haiku 5.5 / Sonnet 5.5 for AI | 50–95% of AI cost | Possibly lower answer quality; decide after an eval on real questions |
| Defer PITR until finance modules go live | ~$100/month during Phases 2–3 | RPO 24 h during early phases (acceptable while no financial records are live) |
| Supabase branching vs a separate staging project | ~$10–25 | Branch lifecycle management |

## 3. Scaling triggers (when costs step up)

| Trigger | Action | Approx. impact |
|---------|--------|----------------|
| DB CPU > 70% sustained or p95 > 500 ms | Supabase compute Small → Medium | +$45/month (verify) |
| DB > 8 GB | Storage overage (~$0.125/GB) or archive old audit/GPS rows to Storage | Small |
| > 2 developers | Vercel seats | +$20/seat |
| WhatsApp marketing campaigns | Marketing template volume | Budget per campaign; separate approval |
