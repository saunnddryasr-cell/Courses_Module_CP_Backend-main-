# CoursePur Backend API — Local Development Guide

> **Single Source of Truth (v1)** — Production-grade, modular Node.js / Express REST API written in clean, scalable TypeScript.

---

## 1. Prerequisites

- **Node.js**: `v18.0.0` or higher (Node 20+ recommended)
- **Package Manager**: `npm` (bundled with Node), `pnpm`, or `bun`
- **Git** (for version control)

---

## 2. Quick Start (Run Locally in 60 Seconds)

### Step 1: Install Dependencies
Open your terminal in the project root directory and run:

```bash
npm install
```

### Step 2: Configure Environment Variables
A default `.env` file is already generated. If creating from scratch:

```bash
cp .env.example .env
```

Default settings in `.env`:
```env
PORT=3000
NODE_ENV=development
API_URL=http://localhost:3000
SESSION_SECRET=local_dev_session_secret_coursepur_2026
```

### Step 3: Start the Development Server
Run the local dev server with automatic file-watching and hot-reload:

```bash
npm run dev
```

You should see:
```text
======================================================
 CoursePur Backend API running on port 3000
 Health check: http://0.0.0.0:3000/health
======================================================
```

Verify in your browser or terminal:
```bash
curl http://localhost:3000/health
```

Expected JSON response:
```json
{
  "status": "ok",
  "service": "CoursePur Backend Service",
  "version": "1.0.0",
  "entities": {
    "institutes": 5,
    "courses": 4,
    "users": 2,
    "claims": 2,
    "leads": 1,
    "reviews": 3
  }
}
```

---

## 3. Available NPM Scripts

| Command | Action |
|---|---|
| `npm run dev` | Starts server in watch mode using `tsx watch server.ts` |
| `npm start` | Runs server in production mode using `tsx server.ts` |
| `npm run typecheck` | Checks full TypeScript codebase without emitting JS files |
| `npm run lint` | Validates types and syntax (`tsc --noEmit`) |

---

## 4. Directory & Module Architecture

```text
/
├── modules/
│   ├── auth/              # OTP engine, multi-persona auth (Student/Institute/Admin), session resolver & RBAC middleware
│   ├── coaching/          # Institutes directory, batch schedules, scoped institute panel (/panel/*)
│   ├── claims/            # 8-signal hybrid risk scoring engine (Part 7.1), auto-approval, spot-audit sampler
│   ├── courses/           # MOOC course catalog, provider profiles, comparisons, correction submissions
│   ├── reviews/           # Polymorphic reviews, 1-per-phone constraint, response immutability (409), sentiment check
│   ├── leads/             # Verified student inquiries & contact unlock (Part 7.5), lead quality scorecard
│   ├── taxonomy/          # Exam tags, Exam Prep Hub (/prep/:slug) composite assembler (Part 7.4), global search
│   ├── collection/        # Saved items & public bundles (/collections/:id/public)
│   ├── guides/            # Content Hub rich guides
│   ├── exam-calendar/     # National entrance & certification key dates timeline
│   ├── learning-paths/    # Curated step-by-step career & exam learning sequences
│   ├── ingestion/         # MOOC catalog sync engine (Coursera/Udemy/NPTEL) protecting manually overridden fields
│   ├── aggregator/        # Persistent API/RSS update ingestion, deduplication, review, and publishing pipeline
│   ├── notifications/     # Transactional email, SMS, and gated WhatsApp Business API adapter
│   ├── integrations/      # Third-party integration config manager with encrypted credential masks
│   ├── admin/             # Claims queue, review moderation, reports, and platform admin ops
│   └── ml-automation/     # Zero-cost TF-IDF relevance ranking, duplicate institute detection & sentiment analysis
├── shared/
│   ├── types/schema.ts    # Authoritative entity models & TypeScript interfaces matching Specification Part 2
│   ├── db/database.ts     # In-memory relational database store with pre-seeded datasets
│   ├── security/crypto.ts # Cryptographic hashing (SHA-256, Scrypt) and secure tokens
│   ├── security/masking.ts# Serialization-layer contact masking (Part 7.5)
│   └── errors/app-error.ts# Structured application error class
├── src/
│   └── app/
│       ├── middleware.ts   # Request logger and security middleware
│       ├── error-handler.ts# Global error handler
│       ├── router.ts       # Central router mounting all module routers
│       └── server.ts       # Express server initialization (Port 3000)
├── server.ts              # Root server entry point
├── package.json           # Root backend package ("courses_module_cp_backend")
├── tsconfig.json          # NodeNext TypeScript configuration
└── .env                   # Local environment variables
```

---

## 5. End-to-End API Testing Guide (cURL Examples)

### 5.1 Request & Verify OTP
The OTP system generates a cryptographically secure 6-digit code with a 5-minute expiry and max 3 attempts. In local development, the code is returned in `dev_preview_code` for convenience.

**1. Request OTP:**
```bash
curl -X POST http://localhost:3000/api/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "purpose": "login"}'
```
*Response:*
```json
{
  "success": true,
  "message": "OTP sent to +91 9876543210. Valid for 5 minutes.",
  "dev_preview_code": "591593"
}
```

**2. Verify OTP (Obtain Single-Use Verification Token):**
```bash
curl -X POST http://localhost:3000/api/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "code": "591593", "purpose": "login"}'
```
*Response:*
```json
{
  "success": true,
  "verification_token": "vtok_4901b0f19e48c...",
  "expires_at": "2026-10-07T17:45:00.000Z"
}
```

---

### 5.2 Multi-Persona Authentication (Part 3)

#### A. Student Login (with optional Referral Attribution, Part 7.6):
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "persona": "student",
    "phone": "9876543210",
    "name": "Rahul Sharma",
    "primary_goal_exam_tag_id": "tag_upsc"
  }'
```
*Response returns Bearer token:*
```json
{
  "token": "cp_sess_4981ad...",
  "persona": "student",
  "user": { "id": "usr_student_01", "name": "Rahul Sharma", "phone": "9876543210" }
}
```

#### B. Platform Admin Login (Email + Password):
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "persona": "admin_user",
    "email": "admin@coursepur.com",
    "password": "Admin@123"
  }'
```

Pre-seeded admin accounts:
- **Platform Admin**: `admin@coursepur.com` / `Admin@123`
- **Moderator**: `moderator@coursepur.com` / `Moderator@123`
- **Content Ops**: `content@coursepur.com` / `Content@123`

---

### 5.3 Contact Masking Verification (Part 7.5)

**Public Institute Profile:**
```bash
curl http://localhost:3000/api/institutes/vision-ias
```
Notice that `phone` and `email` are **never present** in the public payload:
```json
{
  "id": "inst_vision_ias",
  "name": "Vision IAS",
  "city": "Delhi",
  "locality": "Karol Bagh",
  "phone_masked": true,
  "email_masked": true
}
```

---

### 5.4 Lead Capture & Contact Unlock (Part 7.5)
When a student submits an inquiry lead via a verified OTP token, the lead is stored for attribution and the unmasked contact details are returned to the student:

```bash
# 1. Request lead-purpose OTP:
CODE=$(curl -s -X POST http://localhost:3000/api/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone": "9877112233", "purpose": "lead"}' | grep -o '"dev_preview_code":"[^"]*' | cut -d'"' -f4)

# 2. Verify OTP:
TOKEN=$(curl -s -X POST http://localhost:3000/api/otp/verify \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"9877112233\", \"code\": \"$CODE\", \"purpose\": \"lead\"}" | grep -o '"verification_token":"[^"]*' | cut -d'"' -f4)

# 3. Submit Lead:
curl -X POST http://localhost:3000/api/leads \
  -H "Content-Type: application/json" \
  -d "{
    \"verification_token\": \"$TOKEN\",
    \"institute_id\": \"inst_vision_ias\",
    \"student_name\": \"Pooja Verma\",
    \"message\": \"Inquiring about 2027 Prelims batch fee structure\"
  }"
```
*Response reveals contact details:*
```json
{
  "success": true,
  "lead": { "id": "lead_...", "student_name": "Pooja Verma" },
  "institute_contact": {
    "phone": "918448449550",
    "email": "info@visionias.in",
    "address": "B-19, Pusa Road, Karol Bagh, New Delhi 110005"
  },
  "quality_score": 85
}
```

---

### 5.5 Hybrid Risk-Based Claims Approval (Part 7.1)
The claim approval engine computes a risk score (0-100) using 8 weighted fraud signals:

| Signal | Condition | Weight |
|---|---|---|
| `phone_matches_listing` | Phone matches listing directory record | -30 |
| `duplicate_active_claim` | Active claim already exists for institute | +40 |
| `high_velocity_phone` | 3+ claims filed by phone in 24 hours | +50 |
| `high_velocity_device` | Device fingerprint seen across multiple claims | +50 |
| `first_time_phone` | Phone has no prior platform history | +10 |
| `institute_has_prior_rejected_claim` | Prior rejected claim on this institute | +25 |
| `new_institute_self_entry` | Net-new "List your institute" submission | +15 *(Always manual review)* |
| `name_mismatch` | Claimant name has no match to faculty records | +15 |

**Test Legitimate Claim Submission:**
```bash
# 1. Request claim OTP:
CODE=$(curl -s -X POST http://localhost:3000/api/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone": "911141007400", "purpose": "claim"}' | grep -o '"dev_preview_code":"[^"]*' | cut -d'"' -f4)

# 2. Verify claim OTP:
TOKEN=$(curl -s -X POST http://localhost:3000/api/otp/verify \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"911141007400\", \"code\": \"$CODE\", \"purpose\": \"claim\"}" | grep -o '"verification_token":"[^"]*' | cut -d'"' -f4)

# 3. Submit Claim for Vajiram & Ravi (phone matches directory -> score 0 -> auto-approved!):
curl -X POST http://localhost:3000/api/claims \
  -H "Content-Type: application/json" \
  -d "{
    \"verification_token\": \"$TOKEN\",
    \"institute_id\": \"inst_vajiram\",
    \"claimant_name\": \"P. Ravindran\"
  }"
```
*Result:*
```json
{
  "success": true,
  "claim": {
    "status": "auto_approved",
    "review_mode": "auto",
    "risk_score": 0,
    "risk_signals": ["phone_matches_listing", "first_time_phone"]
  }
}
```

---

### 5.6 Exam Prep Hub Assembly (Part 7.4)
Fetches aggregated courses, masked institutes, learning paths, and upcoming exam dates in a single query:
```bash
curl http://localhost:3000/api/prep/upsc
```

---

### 5.7 Trigger MOOC Catalog Ingestion (Part 5)
Requires Content Ops or Platform Admin Bearer token:
```bash
curl -X POST http://localhost:3000/api/admin/ingestion/jobs/prov_coursera/run \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

---

## 6. Pre-Seeded Datasets
The in-memory database (`shared/db/database.ts`) is pre-seeded on startup with:
- **Admin Users**: Super Admin, Trust Moderator, Content Ops Specialist
- **Students**: Rahul Sharma, Ananya Sen
- **Institutes**: Vision IAS (Delhi), Allen Career Institute (Kota), Vajiram & Ravi (Delhi), British Council (Delhi)
- **Courses**: Machine Learning (Coursera), Python for Everybody (Coursera), Complete Web Dev (Udemy), Constitutional Law (NPTEL)
- **Taxonomy**: UPSC, JEE, NEET, IELTS, CFA, Full Stack Web Development
- **Integration Configs**: MSG91 SMS, Resend Email, WhatsApp Business API (disabled by default)

To reset to a clean state anytime during testing:
```bash
curl -X POST http://localhost:3000/api/admin/system/reset-db
```

---

## 7. Update Aggregator

The update aggregator runs alongside the CoursePur API. Its tables are initialized from `modules/aggregator/schema.sql`.

- For local development, leave `DATABASE_URL` empty. The app uses a persistent embedded PostgreSQL-compatible database at `.data/aggregator`.
- For deployment, set `DATABASE_URL` to a PostgreSQL connection string. Production startup fails if it is missing or the database cannot be initialized.
- Source credentials are encrypted with AES-256-GCM. Set `INTEGRATION_ENCRYPTION_KEY` to a private random secret of at least 32 characters before saving API credentials.
- Telegram publishing uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID`. Source failure alerts additionally require `TELEGRAM_ADMIN_CHAT_ID`. Without these values, publishing/alert requests report a configuration error.
- The scheduler polls enabled API/RSS sources each minute when their configured cadence is due and checks source health hourly. Manual sources are ingested through the run endpoint.
- Connector runs, including fetched/inserted counts and failures, are retained in `source_runs` and listed by `GET /runs`.
- Formatting uses a literal, no-LLM fallback template. Category-specific copy from the referenced Post Templates document was not included in this repository.

The Document 8 contract endpoints are exposed under `/api` and the existing `/api/admin/aggregator` routes remain available as compatibility/admin endpoints. Contract routes use the existing Bearer sessions: source/settings management requires an admin role, while post review, manual entries, and publish-log reads accept any authenticated persona. User management is restricted to Platform Admin.

### Create and preview an API source

`field_mapping` maps normalized names to JSON paths. For API responses, `records` optionally identifies the array containing items. A mapping value may also be `{ "path": "...", "transform": "strip_html|date|split_csv", "value_map": {} }`.

```json
{
  "source_key": "example-jobs",
  "category": "jobs",
  "type": "api",
  "base_url": "https://api.example.org/jobs",
  "field_mapping": {
    "records": "results",
    "title": "title",
    "org": "company.name",
    "deadline": { "path": "apply_by", "transform": "date" },
    "link": "url",
    "description": { "path": "description", "transform": "strip_html" }
  },
  "poll_frequency_minutes": 240,
  "enabled": false
}
```

Create the source with `POST /api/sources`, then call `POST /api/sources/:id/preview` to inspect its real raw and mapped sample. The legacy `POST /api/admin/aggregator/sources/preview` still supports preview-before-save. Preview accepts `auth_config` transiently; saved credentials are encrypted and never returned by source APIs. API and RSS fetches require HTTPS and reject local/private-network destinations.

### Ingest, review, and publish

- `POST /sources/:id/run` polls an API/RSS source; for a manual source, include `{ "records": [...] }`.
- `GET /api/admin/aggregator/records` lists normalized records. Deduplication is enforced by `(source_id, content_hash)`.
- `GET /api/admin/aggregator/runs` lists connector execution history.
- `GET /api/admin/aggregator/posts?status=pending` lists formatted drafts. `PATCH /api/admin/aggregator/posts/:id` with `{ "status": "approved" }` or `{ "status": "rejected" }` records a review.
- Document 8 exposes `GET /api/posts`, `PUT /api/posts/:id`, `POST /api/posts/:id/approve`, `POST /api/posts/:id/reject`, and `POST /api/posts/bulk-approve`.
- `POST /api/manual-entries` inserts a normalized record into the same formatting and review pipeline.
- `POST /api/admin/aggregator/posts/:id/publish` publishes Telegram posts through the configured Bot API. For WhatsApp and community posts it records the operator's manual copy/publish confirmation; no WhatsApp automation is performed.
- `GET /api/admin/aggregator/publish-log` lists successful publishing actions.
- `PUT /api/admin/aggregator/publish-settings/:category` with `{ "publish_mode": "manual_approval" }` (default) or `"auto_publish"` controls automatic Telegram publication for that category.
- `GET /api/admin/aggregator/health` reports source failures and staleness.
- Source/category settings use `/api/sources`, `/api/categories`, and `/api/sources/health`; all contract list endpoints accept `limit` and `offset` (defaults 50 and 0) and return `total`.
- `/api/auth/login` accepts the contract's `{ "email", "password" }` form for admin users, and `/api/auth/me` returns the authenticated user. `/api/users` supports Platform Admin user management.

Scrape sources can be registered but cannot be enabled: the document's site-specific Playwright connectors and Terms of Service checks have not been completed. Do not enable scraping until the target site's terms and robots policy are verified and a reviewed connector is added.

Aggregator review actor IDs are stored as text rather than user foreign keys because the existing CoursePur authentication store is in-memory and uses string IDs.
