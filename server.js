// UtiliSave Issue Review System — backend API
// Stores intake form submissions + review versions in Postgres.
//   GET    /?action=history&submissionId=...  -> one submission + its version history + attached files
//   GET    /?action=list                      -> every submission at a glance (repository.html)
//   POST   /                { action: 'saveVersion', ... } -> create a submission or add a new version
//                             (accepts analysisNotes and skillSuggestion too — see below)
//   POST   /files             (multipart/form-data: submissionId, files[]) -> attach documents to a submission
//   GET    /files/:id         -> download one attached file
//   DELETE /files/:id         -> remove one attached file from the case (soft delete: kept in its document history)
//   GET    /submissions/:id/documents -> every document ever attached to a case + its history (admin)
//   POST   /users/:id/resend-invite   { subject?, message? } -> fresh temporary password, invite sent again (admin)
//   GET/PUT /admin/invite-template    -> the saved invite message (admin)
//   POST   /admin/invite-preview      -> the invite exactly as it will be sent, password masked (admin)
//   GET    /admin/email-log           -> every email send attempt and the mail server's answer (admin)
//   GET    /options           -> custom "Other" values added so far, grouped by field (utilityName, issueType)
//   POST   /options           { field, value } -> persist a new custom option for everyone going forward
//   GET    /suggestions       -> every submitted skill-framework suggestion (admin.html)
//   PATCH  /suggestions/:id   { status, adminNotes } -> edit admin notes only (status changes go through accept/reject below)
//   POST   /suggestions/:id/accept -> moves a suggestion to Accepted AND asks Claude to draft the framework wording
//   POST   /suggestions/:id/reject -> moves a suggestion to Rejected, no further action
//   POST   /suggestions/:id/generate-skill -> writes a complete SKILL.md from the (possibly edited) drafted wording
//   POST   /submissions/:id/outcome { status, outcomeReason } -> record the current round's real-world outcome
//   POST   /submissions/:id/extract-outcome-reason (text or attached rejection letter) -> AI-suggested outcome reason
//   GET    /export/:submissionId/zip -> the whole case history (every round + every file) as one downloadable ZIP
//   POST   /analyze/score-gap                    { submissionId } -> AI explanation of why the case isn't at 80+ yet
//   POST   /analyze/research-checklist            { submissionId } -> AI + live web search: tariff/PSC/relief suggestions
//   POST   /analyze/redline-letter                { submissionId, incorporatedItems } -> AI-drafted redlined letter
//   GET    /analyze/redline-letter/:submissionId/docx -> the redlined letter as a downloadable Word file
//
// "Reopening" a case for an appeal after a rejection doesn't create a separate
// linked case — it's just another submission_versions row (a "round") under
// the SAME submission id, the same mechanism already used for pre-submission
// edits. What changes in this round of work: outcome_reason lives on the
// version it describes, and letter_feedback/skill_suggestions/submission_files
// are now tagged with the round (version_number) they belong to, so reopening
// a case no longer overwrites the previous round's actual letter, critique,
// suggestion, or attached files. See "Reopen a case" support below.
// Two free-text boxes on the form feed this: "analysisNotes" is case-specific
// context saved onto that one submission. "skillSuggestion" is a proposal to
// change the general Auditor Skills Framework — it lands in skill_suggestions
// as a queue for Michael (the administrator) to review in admin.html. Accepting
// one there doesn't automatically rewrite the framework itself (that still
// lives in project instructions/skills, which can't be edited from this API) —
// it drafts the wording via Claude so Michael can paste it in himself.
// Uploaded files are stored as bytea blobs directly in Postgres (submission_files
// table) rather than in a separate object-storage bucket. For this app's scale —
// a handful of auditors attaching PDFs/docx/xlsx per case — that keeps the whole
// system to one Postgres + one API service, with no extra credentials or bucket
// to manage. If attachment volume/size ever grows substantially, migrating to a
// Railway storage bucket (S3-compatible) would be the next step.
//
// The /analyze/* endpoints call the Claude API directly (with Claude's built-in
// web_search tool for the research checklist) so this backend can generate
// genuinely case-specific analysis instead of the old keyword-matching heuristic.
// They require ANTHROPIC_API_KEY as a Railway variable on THIS service — see
// README.md "AI features setup." Without it, those endpoints return a clear 503
// and everything else in the app keeps working normally.

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
app.use(cors());
// Parse the body as JSON no matter what Content-Type header the caller sends
// (the front end has historically sent text/plain to dodge CORS preflight).
// Multipart file-upload requests (Content-Type: multipart/form-data) are left
// alone here and handled separately by multer on the /files route.
app.use(express.json({
    type: (req) => {
        const ct = req.headers['content-type'] || '';
        return !ct.startsWith('multipart/form-data');
    }
}));

// Files are buffered in memory just long enough to write them into Postgres —
// no temp files on disk. 15MB/file keeps worst-case request memory reasonable;
// 20 files matches the front end's cap.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 20 }
});

// Railway's internal service-to-service networking (the ${{Postgres.DATABASE_URL}}
// reference) does not use SSL. Railway's public/external Postgres proxy does.
// Set PGSSL=true only when connecting over the public proxy (e.g. testing locally).
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
});

function newSubmissionId() {
    return 'SUB-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 1000);
}

// The "round" a case is currently on — the highest version_number saved for
// it so far. Used to stamp letter_feedback/skill_suggestions/submission_files
// rows written outside of saveVersion (which already knows its own version
// number) so they land in the right round instead of always defaulting to 1.
async function getLatestVersionNumber(submissionId) {
    const result = await pool.query(
        'SELECT COALESCE(MAX(version_number), 1) AS max_v FROM submission_versions WHERE submission_id = $1',
        [submissionId]
    );
    return Number(result.rows[0].max_v);
}

// Self-migrating: creates the tables if they don't exist yet. Means there's
// no separate "run schema.sql" step — deploying this service IS setting up
// the database. Safe to run every time the app boots (CREATE TABLE IF NOT EXISTS).
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS submissions (
    id                TEXT PRIMARY KEY,
    auditor_name      TEXT NOT NULL,
    customer_name     TEXT NOT NULL,
    account_number    TEXT NOT NULL,
    utility_name      TEXT NOT NULL,
    utility_type      TEXT NOT NULL,
    issue_type        TEXT NOT NULL,
    financial_impact  NUMERIC,
    case_id           TEXT,
    submission_date   DATE,
    submission_text   TEXT,
    status            TEXT NOT NULL DEFAULT 'Under Review',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submission_versions (
    id                SERIAL PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    version_number    INTEGER NOT NULL,
    score             INTEGER,
    score_breakdown   JSONB DEFAULT '[]'::jsonb,
    issues            JSONB DEFAULT '[]'::jsonb,
    suggestions       JSONB DEFAULT '[]'::jsonb,
    auditor_name      TEXT,
    status            TEXT,
    auditor_notes     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, version_number)
);

CREATE TABLE IF NOT EXISTS submission_files (
    id                SERIAL PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    file_name         TEXT NOT NULL,
    mime_type         TEXT,
    file_size         INTEGER,
    file_data         BYTEA NOT NULL,
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 'intake' (the original upload area), 'final_letter' (attached via the
-- redline tab's "Final Letter as Submitted" upload — see /letter-feedback/files),
-- or 'outcome_letter' (the utility's own rejection/adjustment letter, attached
-- via /submissions/:id/extract-outcome-reason).
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'intake';

-- Added after submissions already existed in production, so this can't just be
-- a column in the CREATE TABLE above — ADD COLUMN IF NOT EXISTS is what makes
-- this migration safe to run against a database that already has the table.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS analysis_notes TEXT;

-- Expected Financial Impact split into two dollar-denominated fields. The old
-- financial_impact column is kept and kept in sync (refund + future) so any
-- older code path reading it still gets a sensible number.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS financial_impact_refund NUMERIC;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS financial_impact_future NUMERIC;

-- Custom values typed into an "Other" field. Field-scoped (utilityName,
-- issueType, ...) so the same word can mean different things in different
-- fields, and UNIQUE so the same value doesn't get added twice.
CREATE TABLE IF NOT EXISTS custom_field_options (
    id            SERIAL PRIMARY KEY,
    field_name    TEXT NOT NULL,
    value         TEXT NOT NULL,
    added_by      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (field_name, value)
);

-- One row per submission (upserted) — the auditor's proposed addition to the
-- shared Auditor Skills Framework, queued for Michael to review.
CREATE TABLE IF NOT EXISTS skill_suggestions (
    id                SERIAL PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    auditor_name      TEXT,
    suggestion        TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'Pending',
    admin_notes       TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id)
);

-- Set when a suggestion is Accepted: Claude's drafted wording for the actual
-- framework change, so Michael has exact text to paste in rather than just a
-- status flip (see POST /suggestions/:id/accept).
ALTER TABLE skill_suggestions ADD COLUMN IF NOT EXISTS drafted_wording TEXT;

-- 'auditor' (the intake form's "Suggested Addition..." box) or 'critique'
-- (auto-created from the "Critique of This Draft" box on the redline tab —
-- see POST /letter-feedback). Lets admin.html label where a suggestion came
-- from, and lets one submission have both kinds without conflicting.
ALTER TABLE skill_suggestions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auditor';

-- Cache of the last-generated SKILL.md text for this suggestion (see
-- POST /suggestions/:id/generate-skill), so admin.html can show it again on
-- reload without regenerating.
ALTER TABLE skill_suggestions ADD COLUMN IF NOT EXISTS skill_markdown TEXT;

-- Before widening uniqueness below, remove any pre-existing duplicate rows
-- that would violate the new constraint (can happen if an earlier deploy
-- attempt got partway through this migration before the constraint was in
-- place). Keeps the newest row per (submission_id, source), drops the rest.
-- Safe to run repeatedly: a no-op once no duplicates remain.
DELETE FROM skill_suggestions a
USING skill_suggestions b
WHERE a.id < b.id
  AND a.submission_id = b.submission_id
  AND a.source = b.source;

-- The original UNIQUE(submission_id) only allowed one suggestion per case —
-- too narrow now that a critique can also produce one. Widen it to
-- (submission_id, source) so each source gets its own upsertable slot. Safe
-- to run repeatedly: only acts if the old single-column constraint is still
-- there and the new one isn't.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'skill_suggestions_submission_id_key'
    ) THEN
        ALTER TABLE skill_suggestions DROP CONSTRAINT skill_suggestions_submission_id_key;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'skill_suggestions_submission_id_source_key'
    ) THEN
        ALTER TABLE skill_suggestions ADD CONSTRAINT skill_suggestions_submission_id_source_key UNIQUE (submission_id, source);
    END IF;
END $$;

-- Cache for AI-generated, case-specific content (score-gap explanation, live
-- research checklist suggestions, redlined letter). One row per
-- (submission, kind) — regenerating overwrites rather than piling up rows.
CREATE TABLE IF NOT EXISTS ai_analyses (
    id                SERIAL PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    content           JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, kind)
);

-- The real-world "what actually happened" record for a case's letter: the
-- final text as actually sent (after any human edits beyond the AI's
-- redline), and an auditor's critique of the AI's draft (what it got right,
-- what it got wrong). Both feed back into future redline-letter generations
-- as few-shot examples — see /analyze/redline-letter.
CREATE TABLE IF NOT EXISTS letter_feedback (
    id                  SERIAL PRIMARY KEY,
    submission_id       TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    final_letter_text   TEXT,
    critique            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id)
);

-- ---- "Reopen a case" support -------------------------------------------
-- A case can be filed, rejected, and refiled as an appeal all under the SAME
-- submission id, as a new submission_versions row (a "round") — the same
-- mechanism already used for pre-submission edits. outcome_reason lives on
-- the version it describes (see POST /submissions/:id/outcome).
ALTER TABLE submission_versions ADD COLUMN IF NOT EXISTS outcome_reason TEXT;

-- letter_feedback, skill_suggestions, and submission_files were each keyed to
-- just submission_id (one slot per case), so reopening a case for a new round
-- would silently overwrite the previous round's actual letter, critique,
-- suggestion, or attached files — exactly the history this feature exists to
-- preserve. version_number ties each row to the round (submission_versions.
-- version_number) it belongs to. Existing rows default to 1 (their only round).
ALTER TABLE letter_feedback ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE skill_suggestions ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;

-- Widen letter_feedback's uniqueness from (submission_id) to
-- (submission_id, version_number) so each round keeps its own letter+critique
-- instead of the next round's save overwriting it.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'letter_feedback_submission_id_key') THEN
        ALTER TABLE letter_feedback DROP CONSTRAINT letter_feedback_submission_id_key;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'letter_feedback_submission_id_version_number_key') THEN
        ALTER TABLE letter_feedback ADD CONSTRAINT letter_feedback_submission_id_version_number_key UNIQUE (submission_id, version_number);
    END IF;
END $$;

-- Widen skill_suggestions' uniqueness from (submission_id, source) to
-- (submission_id, source, version_number) for the same reason: a round-2
-- suggestion shouldn't erase round 1's.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_suggestions_submission_id_source_key') THEN
        ALTER TABLE skill_suggestions DROP CONSTRAINT skill_suggestions_submission_id_source_key;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_suggestions_submission_id_source_version_number_key') THEN
        ALTER TABLE skill_suggestions ADD CONSTRAINT skill_suggestions_submission_id_source_version_number_key UNIQUE (submission_id, source, version_number);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_submission_versions_submission_id ON submission_versions(submission_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_case_id ON submissions(case_id);
CREATE INDEX IF NOT EXISTS idx_submission_files_submission_id ON submission_files(submission_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_options_field ON custom_field_options(field_name);
CREATE INDEX IF NOT EXISTS idx_skill_suggestions_status ON skill_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_submission_id ON ai_analyses(submission_id);
CREATE INDEX IF NOT EXISTS idx_letter_feedback_submission_id ON letter_feedback(submission_id);

-- ---- Management console support ---------------------------------------
-- The utility's own case/claim number, kept separate from case_id, which is
-- UtiliSave's internal issue number. Optional by design.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utility_case_id TEXT;

-- Fields management owns, not the auditor: who is working it, how urgent, the
-- internal note thread, and the next date it must be looked at.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'Normal';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

-- An append-only trail of every management action, so a case can always be
-- reconstructed: who changed what, when, and why.
CREATE TABLE IF NOT EXISTS submission_events (
    id                SERIAL PRIMARY KEY,
    submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    event_type        TEXT NOT NULL,
    detail            TEXT,
    actor             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submission_events_submission_id ON submission_events(submission_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assigned_to ON submissions(assigned_to);

-- ---- Accounts ----------------------------------------------------------
-- Passwords are stored as scrypt hashes with a per-user random salt. The
-- plaintext is never written anywhere, including the audit trail.
-- role: 'admin' sees the management console and can manage people;
--       'auditor' can only file and review submissions.
CREATE TABLE IF NOT EXISTS app_users (
    id                   SERIAL PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE,
    full_name            TEXT,
    role                 TEXT NOT NULL DEFAULT 'auditor',
    password_hash        TEXT,
    password_salt        TEXT,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    active               BOOLEAN NOT NULL DEFAULT true,
    created_by           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at        TIMESTAMPTZ
);

-- Sessions live server-side so a sign-out, a deactivation or a password reset
-- can kill a token immediately.
CREATE TABLE IF NOT EXISTS app_sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user_id ON app_sessions(user_id);

-- ---- Email log (2026-09-23) ---------------------------------------------
-- One row per send attempt, whatever triggered it. Records what the mail
-- server actually answered, so "the invite never arrived" can be split into
-- "our server refused it" versus "accepted, then lost downstream (spam,
-- quarantine, wrong address)". Never stores the message body: invite and
-- reset emails carry a temporary password.
CREATE TABLE IF NOT EXISTS email_log (
    id               SERIAL PRIMARY KEY,
    kind             TEXT NOT NULL,
    to_address       TEXT NOT NULL,
    subject          TEXT,
    sent             BOOLEAN NOT NULL,
    reason           TEXT,
    message_id       TEXT,
    server_response  TEXT,
    transport        TEXT,
    related_user_id  INTEGER,
    submission_id    TEXT,
    actor            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(related_user_id);

-- Invite bookkeeping, so the People panel can show when someone was last
-- invited and how many times.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS invite_count INTEGER NOT NULL DEFAULT 0;
-- Accounts created before this existing were invited once, at creation.
UPDATE app_users SET invited_at = created_at, invite_count = GREATEST(invite_count, 1)
 WHERE invited_at IS NULL AND created_by IS DISTINCT FROM 'system';

-- Small key/value store for administrator settings (the saved invite
-- message template lives here).
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Document history (2026-09-23) --------------------------------------
-- Who attached each file, and soft deletion: removing a document from a case
-- now hides it from the case rather than destroying it, so the document
-- history can always show what was filed, by whom, when, and what was later
-- taken out.
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS uploaded_by TEXT;
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS deleted_by TEXT;
`;

async function runMigrations(retriesLeft = 10) {
    try {
        await pool.query(MIGRATION_SQL);
        console.log('Database schema ready (submissions, submission_versions, submission_files, custom_field_options, skill_suggestions, ai_analyses, letter_feedback).');
    } catch (err) {
        if (retriesLeft <= 0) {
            console.error('Migration failed after repeated attempts:', err.message);
            throw err;
        }
        // Postgres may not be reachable yet in the first second or two after boot
        // (both services starting at once) — back off and retry a few times.
        console.warn(`Migration attempt failed (${err.message}), retrying in 3s... (${retriesLeft} left)`);
        await new Promise(r => setTimeout(r, 3000));
        return runMigrations(retriesLeft - 1);
    }
}



// ============================================================================
// RATE LIMITING
// ----------------------------------------------------------------------------
// Three ceilings, each doing a different job:
//
//   1. Failed sign-ins per account PER CONNECTION - stops someone guessing one
//      person's password. Keyed on account+IP rather than account alone, so a
//      guesser cannot lock the real user out of their own account. Counts
//      FAILURES only; a correct password clears the count.
//   2. Failed sign-ins per account across all connections - a looser backstop
//      (25) for a guesser spread over many addresses.
//   3. Sign-in attempts per IP      - stops one machine spraying many accounts.
//   4. Requests per IP overall      - a blunt ceiling that keeps a runaway
//      script or a scraper from flattening the database.
//
// Counters are held in memory. That is honest and sufficient for a single
// Railway instance: if the service restarts the counters reset, and if you ever
// run two instances each keeps its own. Moving them to Postgres or Redis is the
// upgrade path, and is not worth the complexity at this size.
// ============================================================================

const LOGIN_FAIL_LIMIT   = Number(process.env.LOGIN_FAIL_LIMIT   || 5);    // per account
const LOGIN_FAIL_WINDOW  = Number(process.env.LOGIN_FAIL_WINDOW  || 15);   // minutes
const LOGIN_ACCOUNT_LIMIT = Number(process.env.LOGIN_ACCOUNT_LIMIT || 25);  // failures per account, all IPs
const LOGIN_IP_LIMIT     = Number(process.env.LOGIN_IP_LIMIT     || 20);   // attempts per IP
const REQUEST_IP_LIMIT   = Number(process.env.REQUEST_IP_LIMIT   || 600);  // requests per IP
const REQUEST_IP_WINDOW  = Number(process.env.REQUEST_IP_WINDOW  || 1);    // minutes

// Railway terminates TLS in front of the app, so the client address arrives in
// X-Forwarded-For. Without this every request looks like it comes from the
// proxy and the per-IP limits would throttle everyone at once.
app.set('trust proxy', true);

const buckets = new Map();

function hitCount(key, windowMinutes) {
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
    buckets.set(key, hits);
    return hits.length;
}

function recordHit(key, windowMinutes) {
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
    hits.push(now);
    buckets.set(key, hits);
    return hits.length;
}

function clearBucket(key) { buckets.delete(key); }

function retryAfterSeconds(key, windowMinutes) {
    const hits = buckets.get(key) || [];
    if (!hits.length) return windowMinutes * 60;
    const oldest = hits[0];
    return Math.max(1, Math.ceil((oldest + windowMinutes * 60 * 1000 - Date.now()) / 1000));
}

// Old keys would otherwise accumulate forever on a long-running instance.
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, hits] of buckets) {
        const live = hits.filter(t => t > cutoff);
        if (live.length) buckets.set(key, live); else buckets.delete(key);
    }
}, 10 * 60 * 1000).unref();

function tooMany(res, seconds, message) {
    res.set('Retry-After', String(seconds));
    return res.status(429).json({ error: message, retryAfterSeconds: seconds });
}

// The blunt per-IP ceiling, in front of everything.
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const key = 'ip:' + req.ip;
    const count = recordHit(key, REQUEST_IP_WINDOW);
    if (count > REQUEST_IP_LIMIT) {
        return tooMany(res, retryAfterSeconds(key, REQUEST_IP_WINDOW),
            'Too many requests from this connection. Wait a moment and try again.');
    }
    next();
});

// ============================================================================
// AUTHENTICATION
// ----------------------------------------------------------------------------
// Every route below the middleware requires a valid bearer token except the
// bare health check and the login endpoint itself. Tokens are opaque random
// strings stored in app_sessions, so revoking one is a DELETE, not a wait for
// expiry. Password hashing is scrypt from Node's own crypto module - no extra
// dependency, and no home-grown crypto.
// ============================================================================

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || 'ms@utilisave.com').trim().toLowerCase();
const APP_URL = process.env.APP_URL || '';

function hashPassword(password, salt) {
    const useSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
    return { hash, salt: useSalt };
}

function passwordMatches(password, storedHash, storedSalt) {
    if (!storedHash || !storedSalt) return false;
    const { hash } = hashPassword(password, storedSalt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Readable but not guessable: 3 groups of 4 from an alphabet with no 0/O/1/l.
function generateTempPassword() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const pick = n => Array.from(crypto.randomBytes(n)).map(b => alphabet[b % alphabet.length]).join('');
    return `${pick(4)}-${pick(4)}-${pick(4)}`;
}

function publicUser(u) {
    return {
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        role: u.role,
        active: u.active,
        mustChangePassword: u.must_change_password,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at
    };
}

// The token can arrive as a bearer header (normal API calls) or as ?token=
// (plain <a href> downloads, which cannot set headers).
function tokenFrom(req) {
    const header = req.headers.authorization || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    if (req.query && req.query.token) return String(req.query.token);
    return null;
}

async function userForToken(token) {
    if (!token) return null;
    const r = await pool.query(
        `SELECT u.* FROM app_sessions s
         JOIN app_users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > now() AND u.active = true`,
        [token]
    );
    return r.rows[0] || null;
}

// Public routes: the health check (so the API URL stays a one-click diagnostic
// even when signed out) and the login/logout endpoints.
function isPublic(req) {
    if (req.method === 'OPTIONS') return true;
    const p = req.path;
    if (p === '/auth/login' || p === '/auth/logout') return true;
    if (p === '/' && req.method === 'GET' && !req.query.action) return true;
    return false;
}

app.use(async (req, res, next) => {
    if (isPublic(req)) return next();
    try {
        const user = await userForToken(tokenFrom(req));
        if (!user) {
            return res.status(401).json({ error: 'Not signed in.', authRequired: true });
        }
        // A user who has not set their own password yet can only read who they
        // are and set it - nothing else.
        if (user.must_change_password && req.path !== '/auth/me' && req.path !== '/auth/change-password') {
            return res.status(403).json({ error: 'Set a new password before continuing.', mustChangePassword: true });
        }
        req.user = user;
        next();
    } catch (err) {
        console.error('auth check failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'This action is limited to administrators.' });
    }
    next();
}

app.post('/auth/login', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are both required.' });

    // Three gates before the password is even checked.
    //
    // The primary lock is on (account + this connection), NOT on the account
    // alone. Locking an account globally on 5 failures would hand anyone who
    // knows Michael's email address a way to lock HIM out at will - the attack
    // becomes the denial of service. Keyed this way, a guesser only locks out
    // their own connection; the real user, on a different connection, is
    // unaffected. The account-wide counter below is a much looser backstop for
    // a guesser spread across many addresses.
    const failKey = 'loginfail:' + email + '|' + req.ip;
    const acctKey = 'loginacct:' + email;
    const ipKey = 'loginip:' + req.ip;

    if (hitCount(failKey, LOGIN_FAIL_WINDOW) >= LOGIN_FAIL_LIMIT) {
        const wait = retryAfterSeconds(failKey, LOGIN_FAIL_WINDOW);
        console.warn(`Login blocked for ${email} from ${req.ip}: too many failures from this connection.`);
        return tooMany(res, wait,
            `Too many failed sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s), or ask an administrator to reset your password.`);
    }
    if (hitCount(acctKey, LOGIN_FAIL_WINDOW) >= LOGIN_ACCOUNT_LIMIT) {
        const wait = retryAfterSeconds(acctKey, LOGIN_FAIL_WINDOW);
        console.warn(`Login blocked for ${email}: ${LOGIN_ACCOUNT_LIMIT}+ failures across multiple connections - possible distributed guessing.`);
        return tooMany(res, wait,
            `This account is temporarily locked after repeated failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s), or ask an administrator to reset your password.`);
    }
    if (recordHit(ipKey, LOGIN_FAIL_WINDOW) > LOGIN_IP_LIMIT) {
        const wait = retryAfterSeconds(ipKey, LOGIN_FAIL_WINDOW);
        console.warn(`Login blocked from ${req.ip}: too many attempts across accounts.`);
        return tooMany(res, wait, 'Too many sign-in attempts from this connection. Try again shortly.');
    }

    try {
        const r = await pool.query('SELECT * FROM app_users WHERE lower(email) = $1', [email]);
        const user = r.rows[0];
        // Same message either way - it should not reveal which addresses exist.
        if (!user || !user.active || !passwordMatches(password, user.password_hash, user.password_salt)) {
            const fails = recordHit(failKey, LOGIN_FAIL_WINDOW);
            recordHit(acctKey, LOGIN_FAIL_WINDOW);
            const left = LOGIN_FAIL_LIMIT - fails;
            return res.status(401).json({
                error: 'That email and password combination was not recognised.'
                    + (left > 0 && left <= 2 ? ` ${left} attempt(s) left before this account is locked for ${LOGIN_FAIL_WINDOW} minutes.` : '')
            });
        }

        // A correct password clears this connection's failure count. The
        // account-wide backstop is deliberately left alone so a distributed
        // guesser cannot reset it by getting one password right.
        clearBucket(failKey);

        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO app_sessions (token, user_id, expires_at)
             VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
            [token, user.id, String(SESSION_DAYS)]
        );
        await pool.query('UPDATE app_users SET last_login_at = now() WHERE id = $1', [user.id]);
        await pool.query('DELETE FROM app_sessions WHERE expires_at < now()');

        res.json({ token, user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/logout', async (req, res) => {
    const token = tokenFrom(req);
    try {
        if (token) await pool.query('DELETE FROM app_sessions WHERE token = $1', [token]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: true });
    }
});

app.get('/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/auth/change-password', async (req, res) => {
    const current = String((req.body && req.body.currentPassword) || '');
    const next = String((req.body && req.body.newPassword) || '');
    if (next.length < 10) {
        return res.status(400).json({ error: 'Choose a password of at least 10 characters.' });
    }
    if (!passwordMatches(current, req.user.password_hash, req.user.password_salt)) {
        return res.status(401).json({ error: 'Your current password is not correct.' });
    }
    try {
        const { hash, salt } = hashPassword(next);
        await pool.query(
            'UPDATE app_users SET password_hash = $2, password_salt = $3, must_change_password = false WHERE id = $1',
            [req.user.id, hash, salt]
        );
        // Every other session for this person is dropped; the one in use stays.
        await pool.query('DELETE FROM app_sessions WHERE user_id = $1 AND token <> $2', [req.user.id, tokenFrom(req)]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- People administration (admins only) -----------------------------------

// The invite message an administrator can edit. Placeholders are filled in
// per person. The sign-in details block (link, email, temporary password,
// access level) is ALWAYS appended by the system below the message, so a
// customised message can never accidentally leave out the password.
const INVITE_PLACEHOLDERS = ['{name}', '{firstName}', '{email}', '{role}', '{signInLink}', '{sender}'];
const DEFAULT_INVITE_TEMPLATE = {
    subject: 'Your UtiliSave Issue Review account',
    message: 'Hello {firstName},\n\n{sender} has created an account for you on the UtiliSave Issue Review System, where issues are submitted for review before they go to the utility.\n\nYour sign-in details are below. You will be asked to choose your own password the first time you sign in.'
};

async function getInviteTemplate() {
    try {
        const r = await pool.query("SELECT value, updated_by, updated_at FROM app_settings WHERE key = 'invite_template'");
        if (r.rows.length) {
            const v = JSON.parse(r.rows[0].value || '{}');
            return {
                subject: v.subject || DEFAULT_INVITE_TEMPLATE.subject,
                message: v.message || DEFAULT_INVITE_TEMPLATE.message,
                isDefault: false, updatedBy: r.rows[0].updated_by, updatedAt: r.rows[0].updated_at
            };
        }
    } catch (err) { console.error('invite template read failed:', err.message); }
    return Object.assign({ isDefault: true }, DEFAULT_INVITE_TEMPLATE);
}

// The link in an invite or reset email. It names the person it was sent to
// (?signin=their email) so the page always opens on the sign-in screen for
// THAT account, even in a browser where someone else - typically the
// administrator who sent the invite - is already signed in.
function signInUrl(email) {
    if (!APP_URL) return '';
    return APP_URL + (APP_URL.indexOf('?') === -1 ? '?' : '&') + 'signin=' + encodeURIComponent(email);
}

function fillPlaceholders(text, user, actorName) {
    const name = user.full_name || user.email;
    const vals = {
        '{name}': name,
        '{firstName}': String(name).split(/\s+/)[0],
        '{email}': user.email,
        '{role}': user.role === 'admin' ? 'Administrator' : 'Auditor',
        '{signInLink}': signInUrl(user.email) || 'the UtiliSave Issue Review System',
        '{sender}': actorName || 'An administrator'
    };
    return String(text || '').replace(/\{(name|firstName|email|role|signInLink|sender)\}/g, m => vals[m]);
}

// Message text -> safe HTML paragraphs. The text is escaped first, so nothing
// an administrator types can inject markup into the email.
function messageToHtml(text) {
    return esc(text).split(/\n{2,}/).map(par =>
        `<p style="font-size:13.5px; line-height:1.6; color:#333; margin:0 0 12px;">${par.replace(/\n/g, '<br>')}</p>`).join('');
}

function credentialsEmail(user, tempPassword, isReset, actorName, customMessage) {
    const where = APP_URL || 'the UtiliSave Issue Review System';
    const intro = customMessage !== undefined && customMessage !== null
        ? messageToHtml(fillPlaceholders(customMessage, user, actorName))
        : `<p style="font-size:13.5px; line-height:1.6; color:#333;">
          ${isReset ? 'An administrator reset your password' : `${esc(actorName || 'An administrator')} created an account for you`}
          on the UtiliSave Issue Review System.
        </p>`;
    return `
      <div style="font-family:Segoe UI,Helvetica,Arial,sans-serif; color:#1a1a1a; max-width:620px;">
        <h2 style="color:#0B3E76; margin:0 0 10px;">${isReset ? 'Your password has been reset' : 'Your UtiliSave Issue Review account'}</h2>
        ${intro}
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13.5px; margin:18px 0;">
          <tr><td style="padding:7px 14px 7px 0; color:#666;">Sign in at</td>
              <td style="padding:7px 0;"><strong>${APP_URL ? `<a href="${esc(signInUrl(user.email))}">${esc(signInUrl(user.email))}</a>` : esc(where)}</strong></td></tr>
          <tr><td style="padding:7px 14px 7px 0; color:#666;">Email</td>
              <td style="padding:7px 0;"><strong>${esc(user.email)}</strong></td></tr>
          <tr><td style="padding:7px 14px 7px 0; color:#666;">Temporary password</td>
              <td style="padding:7px 0;"><strong style="font-family:Consolas,monospace; font-size:15px; letter-spacing:1px;">${esc(tempPassword)}</strong></td></tr>
          <tr><td style="padding:7px 14px 7px 0; color:#666;">Access level</td>
              <td style="padding:7px 0;"><strong>${user.role === 'admin' ? 'Administrator — full management console' : 'Auditor — submission form only'}</strong></td></tr>
        </table>
        <p style="font-size:13px; line-height:1.6; background:#fff8e1; border:1px solid #f0dca8; border-radius:6px; padding:13px; color:#6d5410;">
          You will be asked to set your own password the first time you sign in. This temporary one stops working at that point.
          If you did not expect this email, tell ${esc(BOOTSTRAP_ADMIN_EMAIL)} and do not sign in.
        </p>
        <p style="color:#888; font-size:11px; margin-top:24px;">Private and confidential UtiliSave work product. Do not disseminate.</p>
      </div>`;
}

// opts = { subject, message, kind, actorEmail } - subject/message override
// the saved template for invites; resets keep their fixed wording unless a
// message is supplied.
async function emailCredentials(user, tempPassword, isReset, actorName, opts) {
    opts = opts || {};
    let subject, message;
    if (isReset) {
        subject = opts.subject || 'Your UtiliSave Issue Review password has been reset';
        message = opts.message !== undefined && opts.message !== '' ? opts.message : undefined;
    } else {
        const tpl = await getInviteTemplate();
        subject = fillPlaceholders(opts.subject || tpl.subject, user, actorName);
        message = opts.message !== undefined && opts.message !== '' ? opts.message : tpl.message;
    }
    const html = credentialsEmail(user, tempPassword, isReset, actorName, message);
    return deliverEmail(user.email, subject, html, {
        kind: opts.kind || (isReset ? 'password_reset' : 'invite'),
        userId: user.id,
        actor: opts.actorEmail || null
    });
}

// The most recent credentials email for each person, for the People panel.
async function latestCredentialEmails() {
    const r = await pool.query(
        `SELECT DISTINCT ON (related_user_id) related_user_id, kind, sent, reason, server_response, created_at
         FROM email_log WHERE related_user_id IS NOT NULL AND kind IN ('invite','invite_resend','password_reset')
         ORDER BY related_user_id, created_at DESC`
    );
    const map = {};
    r.rows.forEach(e => {
        map[e.related_user_id] = { kind: e.kind, sent: e.sent, reason: e.reason, serverResponse: e.server_response, at: e.created_at };
    });
    return map;
}

app.get('/users', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM app_users ORDER BY active DESC, lower(email) ASC');
        const mail = await latestCredentialEmails();
        res.json({ users: r.rows.map(u => Object.assign(publicUser(u), {
            invitedAt: u.invited_at || u.created_at,
            inviteCount: u.invite_count,
            lastEmail: mail[u.id] || null
        })) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

function templateOverrides(body) {
    const o = {};
    if (body && typeof body.subject === 'string' && body.subject.trim()) o.subject = body.subject.trim().slice(0, 200);
    if (body && typeof body.message === 'string' && body.message.trim()) o.message = body.message.slice(0, 5000);
    return o;
}

app.post('/users', requireAdmin, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const fullName = String((req.body && req.body.fullName) || '').trim();
    const role = (req.body && req.body.role) === 'admin' ? 'admin' : 'auditor';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'That does not look like a valid email address.' });
    }
    // A name is required at invite time: submissions display the auditor's
    // name straight from this account (see the locked auditorName field on
    // the form), so an invite with no name would mean a case with no visible
    // auditor. See requireAdmin/POST /submissions below for the other half
    // of this — the submitted auditorName is checked against this value.
    if (!fullName) {
        return res.status(400).json({ error: 'A full name is required to invite someone — it is what will show as the auditor on their submissions.' });
    }
    try {
        const exists = await pool.query('SELECT id, must_change_password, active FROM app_users WHERE lower(email) = $1', [email]);
        if (exists.rows.length) {
            const u = exists.rows[0];
            const hint = u.active && u.must_change_password
                ? ' They have not signed in yet — use "Resend invite" on their row in the list below.'
                : '';
            return res.status(400).json({ error: 'Someone already has that email address.' + hint, existingUserId: u.id });
        }

        const tempPassword = generateTempPassword();
        const { hash, salt } = hashPassword(tempPassword);
        const r = await pool.query(
            `INSERT INTO app_users (email, full_name, role, password_hash, password_salt, must_change_password, created_by, invited_at, invite_count)
             VALUES ($1,$2,$3,$4,$5,true,$6, now(), 1) RETURNING *`,
            [email, fullName, role, hash, salt, req.user.email]
        );
        const user = r.rows[0];
        const mail = await emailCredentials(user, tempPassword, false, req.user.full_name || req.user.email,
            Object.assign(templateOverrides(req.body), { kind: 'invite', actorEmail: req.user.email }));
        res.json({ user: publicUser(user), tempPassword, email: mail });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Re-send the invitation to someone who has not signed in yet. We only ever
// store a hash of the temporary password, so the original cannot be re-sent:
// a fresh temporary password is issued and the earlier one stops working.
app.post('/users/:id/resend-invite', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    try {
        const found = await pool.query('SELECT * FROM app_users WHERE id = $1', [id]);
        if (!found.rows.length) return res.status(404).json({ error: 'No such user.' });
        const existing = found.rows[0];
        if (!existing.active) {
            return res.status(400).json({ error: 'This account is disabled. Re-enable it before re-sending the invite.' });
        }
        if (!existing.must_change_password) {
            return res.status(400).json({ error: 'This person has already signed in and set their own password. Use "Reset password" if they are locked out.' });
        }

        const tempPassword = generateTempPassword();
        const { hash, salt } = hashPassword(tempPassword);
        const r = await pool.query(
            `UPDATE app_users SET password_hash = $2, password_salt = $3, must_change_password = true,
                    invited_at = now(), invite_count = COALESCE(invite_count, 0) + 1
             WHERE id = $1 RETURNING *`,
            [id, hash, salt]
        );
        await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
        const user = r.rows[0];
        const mail = await emailCredentials(user, tempPassword, false, req.user.full_name || req.user.email,
            Object.assign(templateOverrides(req.body), { kind: 'invite_resend', actorEmail: req.user.email }));
        res.json({ user: publicUser(user), tempPassword, email: mail });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// The saved invite message.
app.get('/admin/invite-template', requireAdmin, async (req, res) => {
    try {
        const tpl = await getInviteTemplate();
        res.json(Object.assign(tpl, { defaults: DEFAULT_INVITE_TEMPLATE, placeholders: INVITE_PLACEHOLDERS }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save (or, with reset:true, restore the built-in default).
app.put('/admin/invite-template', requireAdmin, async (req, res) => {
    const body = req.body || {};
    try {
        if (body.reset) {
            await pool.query("DELETE FROM app_settings WHERE key = 'invite_template'");
        } else {
            const subject = String(body.subject || '').trim().slice(0, 200) || DEFAULT_INVITE_TEMPLATE.subject;
            const message = String(body.message || '').slice(0, 5000);
            if (!message.trim()) return res.status(400).json({ error: 'The message cannot be empty. Use "Restore default" instead.' });
            await pool.query(
                `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('invite_template', $1, $2, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
                [JSON.stringify({ subject, message }), req.user.email]
            );
        }
        const tpl = await getInviteTemplate();
        res.json(Object.assign(tpl, { defaults: DEFAULT_INVITE_TEMPLATE, placeholders: INVITE_PLACEHOLDERS }));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Exactly what the person will receive, rendered by the same code that sends
// it - with the password masked, since none has been issued yet.
app.post('/admin/invite-preview', requireAdmin, async (req, res) => {
    const body = req.body || {};
    try {
        let user = { id: 0, email: String(body.email || 'new.auditor@example.com'), full_name: String(body.fullName || 'New Auditor'),
                     role: body.role === 'admin' ? 'admin' : 'auditor' };
        if (body.userId) {
            const f = await pool.query('SELECT * FROM app_users WHERE id = $1', [Number(body.userId)]);
            if (f.rows.length) user = f.rows[0];
        }
        const tpl = await getInviteTemplate();
        const actor = req.user.full_name || req.user.email;
        const o = templateOverrides(body);
        const subject = fillPlaceholders(o.subject || tpl.subject, user, actor);
        const html = credentialsEmail(user, '(issued when sent)', false, actor, o.message || tpl.message);
        res.json({ to: user.email, subject, html, text: htmlToText(html) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Every send attempt, newest first.
app.get('/admin/email-log', requireAdmin, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const vals = [limit];
    let where = '';
    if (req.query.userId) { vals.push(Number(req.query.userId)); where = `WHERE related_user_id = $${vals.length}`; }
    try {
        const r = await pool.query(
            `SELECT id, kind, to_address, subject, sent, reason, message_id, server_response, transport,
                    related_user_id, submission_id, actor, created_at
             FROM email_log ${where} ORDER BY created_at DESC LIMIT $1`, vals);
        res.json({ entries: r.rows.map(e => ({
            id: e.id, kind: e.kind, to: e.to_address, subject: e.subject, sent: e.sent, reason: e.reason,
            messageId: e.message_id, serverResponse: e.server_response, transport: e.transport,
            userId: e.related_user_id, submissionId: e.submission_id, actor: e.actor, at: e.created_at
        })) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/users/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets = [], vals = [id];
    if (body.fullName !== undefined) { vals.push(String(body.fullName).trim() || null); sets.push(`full_name = $${vals.length}`); }
    if (body.role !== undefined) { vals.push(body.role === 'admin' ? 'admin' : 'auditor'); sets.push(`role = $${vals.length}`); }
    if (body.active !== undefined) { vals.push(!!body.active); sets.push(`active = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    if (Number(req.user.id) === id && body.active === false) {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    if (Number(req.user.id) === id && body.role === 'auditor') {
        return res.status(400).json({ error: 'You cannot remove your own administrator access.' });
    }

    try {
        const r = await pool.query(`UPDATE app_users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
        if (!r.rows.length) return res.status(404).json({ error: 'No such user.' });
        // Deactivating someone signs them out everywhere, immediately.
        if (body.active === false) await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
        res.json({ user: publicUser(r.rows[0]) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    try {
        const found = await pool.query('SELECT * FROM app_users WHERE id = $1', [id]);
        if (!found.rows.length) return res.status(404).json({ error: 'No such user.' });

        const tempPassword = generateTempPassword();
        const { hash, salt } = hashPassword(tempPassword);
        const r = await pool.query(
            `UPDATE app_users SET password_hash = $2, password_salt = $3, must_change_password = true
             WHERE id = $1 RETURNING *`,
            [id, hash, salt]
        );
        await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
        const user = r.rows[0];
        const mail = await emailCredentials(user, tempPassword, true, req.user.full_name || req.user.email,
            { kind: 'password_reset', actorEmail: req.user.email });
        res.json({ user: publicUser(user), tempPassword, email: mail });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// On an empty database, create the first administrator so there is a way in.
// The password comes from BOOTSTRAP_ADMIN_PASSWORD if set; otherwise one is
// generated and printed to the deploy log exactly once.
async function ensureBootstrapAdmin() {
    const existing = await pool.query('SELECT COUNT(*)::int AS n FROM app_users');
    if (existing.rows[0].n > 0) return;

    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || generateTempPassword();
    const { hash, salt } = hashPassword(password);
    await pool.query(
        `INSERT INTO app_users (email, full_name, role, password_hash, password_salt, must_change_password, created_by)
         VALUES ($1,$2,'admin',$3,$4,true,'system')`,
        [BOOTSTRAP_ADMIN_EMAIL, 'Michael Steifman', hash, salt]
    );
    console.log('==============================================================');
    console.log('FIRST ADMINISTRATOR CREATED');
    console.log('  Email    :', BOOTSTRAP_ADMIN_EMAIL);
    console.log('  Password :', password);
    console.log('  You will be asked to change it on first sign-in.');
    console.log('==============================================================');
}

// ---- Management notification -------------------------------------------
// Email is sent over Resend's HTTP API rather than an SMTP library so the
// service needs no new npm dependency (Node 18+ has global fetch). Set
// RESEND_API_KEY in the Railway service variables to switch it on; without a
// key every notify call returns {sent:false} with the reason, and the rest of
// the system carries on unaffected.
const NOTIFY_TO = process.env.NOTIFY_EMAIL || 'internalaudit@utilisave.com';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'UtiliSave Issue Review <internalaudit@utilisave.com>';
const MANAGEMENT_URL = process.env.MANAGEMENT_URL || '';

// ---- Mail transport -----------------------------------------------------
// Two ways out, checked in this order:
//
//   1. SMTP  - UtiliSave's own mail server. Set SMTP_HOST and the rest below.
//              Mail leaves from your domain, through infrastructure you own,
//              and nothing about a submission touches a third party.
//   2. Resend - the hosted fallback, used only if no SMTP host is configured.
//
// If neither is set, everything still saves and every caller is told plainly
// that the mail did not go. Email is never allowed to fail a submission.
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = process.env.SMTP_PASS || '';
// true = implicit TLS from the first byte (port 465). false = plain connection
// upgraded with STARTTLS (port 587, the usual choice).
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;
// Last resort for a server presenting a self-signed or mismatched certificate.
// Leaving this false is correct; setting it true means the connection is
// encrypted but the identity of the far end is no longer verified.
const SMTP_ALLOW_SELF_SIGNED = String(process.env.SMTP_ALLOW_SELF_SIGNED || '').toLowerCase() === 'true';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

let mailer = null;
if (SMTP_HOST) {
    try {
        const nodemailer = require('nodemailer');
        mailer = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
            tls: SMTP_ALLOW_SELF_SIGNED ? { rejectUnauthorized: false } : undefined,
            connectionTimeout: 15000,
            greetingTimeout: 10000,
            socketTimeout: 20000
        });
        console.log(`Mail: SMTP via ${SMTP_HOST}:${SMTP_PORT} (${SMTP_SECURE ? 'implicit TLS' : 'STARTTLS'}${SMTP_USER ? ', authenticated' : ', no auth'})`);
    } catch (err) {
        console.error('Mail: SMTP_HOST is set but nodemailer could not be loaded -', err.message);
    }
} else if (RESEND_API_KEY) {
    console.log('Mail: Resend HTTP API (no SMTP_HOST set)');
} else {
    console.log('Mail: NOT CONFIGURED - submissions will save but no email will be sent.');
}

function esc(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(v) {
    if (v === null || v === undefined || v === '') return '$0';
    return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Turns the cryptic end of an SMTP failure into something you can act on.
function explainMailError(err) {
    const code = err && (err.code || err.responseCode);
    const msg = (err && err.message) || String(err);
    const hints = {
        EAUTH: 'the mail server rejected the username or password (check SMTP_USER / SMTP_PASS; Microsoft 365 also needs SMTP AUTH enabled on that specific mailbox)',
        ECONNREFUSED: 'nothing answered on that host and port (check SMTP_HOST / SMTP_PORT, and that the server accepts connections from outside your office network)',
        ETIMEDOUT: 'the connection timed out - most often a firewall on the mail server blocking the API service\'s address',
        ECONNECTION: 'could not open a connection to the mail server',
        ESOCKET: 'the TLS handshake failed - if the port is 465 set SMTP_SECURE=true; if it is 587 set SMTP_SECURE=false',
        EENVELOPE: 'the server refused the sender or recipient address (often the From address must match the authenticated mailbox)',
        EDNS: 'the mail server hostname could not be resolved'
    };
    const hint = hints[code];
    if (code === 535 || /535/.test(msg)) return `${msg} - ${hints.EAUTH}`;
    if (code === 550 || /550|relay/i.test(msg)) return `${msg} - the server refused to relay this message. Most likely the API service's address is not permitted to send through it, or the From address is not one this mailbox may send as.`;
    return hint ? `${msg} - ${hint}` : msg;
}

// Plain-text version of an HTML email. Sending HTML with no text part is a
// well-known spam signal (SpamAssassin's MIME_HTML_ONLY and similar rules),
// and invite emails - a password plus a sign-in link - are already the shape
// filters are most suspicious of. Every message now goes out with both parts.
function htmlToText(html) {
    return String(html || '')
        .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
            const l = label.replace(/<[^>]+>/g, '').trim();
            return l && l !== href ? `${l} (${href})` : href;
        })
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/td>\s*<td[^>]*>/gi, ': ')
        .replace(/<\/(p|h[1-6]|table)>/gi, '\n\n')
        .replace(/<\/(div|tr|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').replace(/&mdash;/g, '—')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function logEmail(entry) {
    try {
        const r = await pool.query(
            `INSERT INTO email_log (kind, to_address, subject, sent, reason, message_id, server_response, transport, related_user_id, submission_id, actor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
            [entry.kind || 'other', entry.to, entry.subject || null, !!entry.sent, entry.reason || null,
             entry.messageId || null, entry.serverResponse || null, entry.via || null,
             entry.userId || null, entry.submissionId || null, entry.actor || null]
        );
        return r.rows[0];
    } catch (err) {
        // Logging must never break sending.
        console.error('email_log insert failed:', err.message);
        return null;
    }
}

// One way in, whichever transport is configured. meta = { kind, userId,
// submissionId, actor } is recorded in email_log alongside the server's answer.
async function deliverEmail(to, subject, html, meta) {
    meta = meta || {};
    const text = htmlToText(html);
    let result;

    if (mailer) {
        try {
            const info = await mailer.sendMail({ from: NOTIFY_FROM, to, subject, html, text });
            const rejected = (info.rejected || []).map(String);
            const accepted = (info.accepted || []).map(String);
            if (rejected.length && !accepted.length) {
                result = { sent: false, to, reason: `the mail server refused the recipient ${rejected.join(', ')}`, via: 'smtp',
                           serverResponse: info.response || null };
            } else {
                result = { sent: true, to, id: info.messageId || null, via: 'smtp', serverResponse: info.response || null };
            }
        } catch (err) {
            console.error('SMTP send failed:', err.message);
            result = { sent: false, to, reason: explainMailError(err), via: 'smtp', serverResponse: err.response || null };
        }
    } else if (RESEND_API_KEY) {
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, html, text })
            });
            const payload = await r.json().catch(() => ({}));
            result = r.ok
                ? { sent: true, to, id: payload.id || null, via: 'resend' }
                : { sent: false, to, reason: (payload && payload.message) || `Resend returned HTTP ${r.status}`, via: 'resend' };
        } catch (err) {
            result = { sent: false, to, reason: err.message, via: 'resend' };
        }
    } else {
        result = { sent: false, to, reason: 'no mail transport is configured on the API service (set SMTP_HOST, or RESEND_API_KEY)', via: 'none' };
    }

    const row = await logEmail(Object.assign({}, meta, result, { to, subject, messageId: result.id }));
    if (row) { result.logId = row.id; result.at = row.created_at; }
    return result;
}

async function sendEmail(subject, html, meta) {
    return deliverEmail(NOTIFY_TO, subject, html, meta);
}

// Builds and sends the "new submission" email for one case.
async function notifyNewSubmission(submissionId) {
    const subResult = await pool.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (subResult.rows.length === 0) return { sent: false, reason: 'submission not found' };
    const s = subResult.rows[0];

    const vResult = await pool.query(
        'SELECT version_number, score FROM submission_versions WHERE submission_id = $1 ORDER BY version_number DESC LIMIT 1',
        [submissionId]
    );
    const latest = vResult.rows[0] || {};

    const fResult = await pool.query(
        'SELECT file_name, file_size FROM submission_files WHERE submission_id = $1 AND deleted_at IS NULL ORDER BY uploaded_at ASC',
        [submissionId]
    );

    const total = (Number(s.financial_impact_refund) || 0) + (Number(s.financial_impact_future) || 0);
    const scoreLine = latest.score === null || latest.score === undefined
        ? 'not scored'
        : `${latest.score} / 100${latest.score < 75 ? ' — below the 75 threshold, CEO approval required' : ''}`;

    const rows = [
        ['Issue ID (repository)', s.id],
        ['UtiliSave Internal Issue ID', s.case_id || '—'],
        ['Utility Case ID', s.utility_case_id || '—'],
        ['Auditor', s.auditor_name],
        ['Customer', s.customer_name],
        ['Account Number', s.account_number],
        ['Utility', `${s.utility_name} (${s.utility_type})`],
        ['Issue Type', s.issue_type],
        ['Expected Refund', money(s.financial_impact_refund)],
        ['Expected Future Savings', money(s.financial_impact_future)],
        ['Total Exposure', money(total)],
        ['Score', scoreLine],
        ['Round', latest.version_number || 1],
        ['Attachments', fResult.rows.length ? fResult.rows.map(f => f.file_name).join(', ') : 'none'],
        ['Status', s.status]
    ];

    const html = `
        <div style="font-family:Segoe UI,Helvetica,Arial,sans-serif; color:#1a1a1a; max-width:680px;">
          <h2 style="color:#0B3E76; margin:0 0 4px;">New issue submitted for review</h2>
          <p style="color:#666; margin:0 0 18px; font-size:13px;">${esc(s.customer_name)} &middot; ${esc(s.utility_name)} &middot; ${money(total)} at stake</p>
          <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:100%; font-size:13px;">
            ${rows.map(([k, v]) => `<tr>
                <td style="padding:7px 12px 7px 0; color:#666; white-space:nowrap; border-bottom:1px solid #eef1f5; vertical-align:top;">${esc(k)}</td>
                <td style="padding:7px 0; border-bottom:1px solid #eef1f5;"><strong>${esc(v)}</strong></td>
              </tr>`).join('')}
          </table>
          ${MANAGEMENT_URL ? `<p style="margin:22px 0 0;"><a href="${esc(MANAGEMENT_URL)}?id=${encodeURIComponent(s.id)}" style="background:#0B3E76; color:#fff; padding:11px 22px; border-radius:6px; text-decoration:none; font-size:13px; display:inline-block;">Open in the management console</a></p>` : ''}
          ${s.submission_text ? `<h3 style="color:#0B3E76; font-size:14px; margin:26px 0 6px;">Submission text</h3>
            <div style="white-space:pre-wrap; font-size:12.5px; line-height:1.6; background:#f7f9fc; border:1px solid #e3e8ee; border-radius:6px; padding:14px;">${esc(String(s.submission_text).slice(0, 6000))}${String(s.submission_text).length > 6000 ? '\n\n[truncated — open the console for the full text]' : ''}</div>` : ''}
          <p style="color:#888; font-size:11px; margin-top:26px;">Private and confidential UtiliSave work product. Do not disseminate.</p>
        </div>`;

    const subject = `[Issue Submission] ${s.customer_name} — ${s.utility_name} — ${money(total)}${s.case_id ? ` — ${s.case_id}` : ''}`;
    const outcome = await sendEmail(subject, html, { kind: 'submission_alert', submissionId });

    await pool.query(
        'INSERT INTO submission_events (submission_id, event_type, detail, actor) VALUES ($1,$2,$3,$4)',
        [submissionId, 'notification', outcome.sent ? `Emailed ${NOTIFY_TO}` : `Email not sent: ${outcome.reason}`, 'system']
    );

    return outcome;
}

// Proves the mail path end to end without needing a submission. Returns the
// real error text on failure, so a misconfigured mail server can be diagnosed
// from the console instead of from Railway's logs.
app.post('/admin/test-email', requireAdmin, async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim() || NOTIFY_TO;
    const transport = mailer ? `SMTP (${SMTP_HOST}:${SMTP_PORT}, ${SMTP_SECURE ? 'implicit TLS' : 'STARTTLS'})`
        : (RESEND_API_KEY ? 'Resend HTTP API' : 'none configured');

    const html = `
      <div style="font-family:Segoe UI,Helvetica,Arial,sans-serif; color:#1a1a1a; max-width:620px;">
        <h2 style="color:#0B3E76; margin:0 0 6px;">Mail is working</h2>
        <p style="font-size:13.5px; line-height:1.6;">
          This is a test message from the UtiliSave Issue Review System. If you are reading it,
          submission alerts and login credentials will reach this address.
        </p>
        <table cellpadding="0" cellspacing="0" style="font-size:13px; margin-top:14px;">
          <tr><td style="padding:5px 14px 5px 0; color:#666;">Sent by</td><td style="padding:5px 0;"><strong>${esc(req.user.email)}</strong></td></tr>
          <tr><td style="padding:5px 14px 5px 0; color:#666;">Transport</td><td style="padding:5px 0;"><strong>${esc(transport)}</strong></td></tr>
          <tr><td style="padding:5px 14px 5px 0; color:#666;">From address</td><td style="padding:5px 0;"><strong>${esc(NOTIFY_FROM)}</strong></td></tr>
          <tr><td style="padding:5px 14px 5px 0; color:#666;">Time</td><td style="padding:5px 0;"><strong>${new Date().toISOString()}</strong></td></tr>
        </table>
        <p style="color:#888; font-size:11px; margin-top:24px;">Private and confidential UtiliSave work product. Do not disseminate.</p>
      </div>`;

    const result = await deliverEmail(to, 'UtiliSave Issue Review — mail test', html, { kind: 'test', actor: req.user.email });
    res.json(Object.assign({ transport, from: NOTIFY_FROM, to }, result));
});

// Manually (re)send the management notification for a case.
app.post('/notify', async (req, res) => {
    const submissionId = (req.body && req.body.submissionId || '').trim();
    if (!submissionId) return res.json({ sent: false, reason: 'submissionId is required' });
    try {
        res.json(await notifyNewSubmission(submissionId));
    } catch (err) {
        console.error(err);
        res.json({ sent: false, reason: err.message });
    }
});

// Management-owned fields. Every change is written to submission_events too,
// so the console can show a full audit trail rather than just current state.
app.patch('/submissions/:id/manage', async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const actor = body.actor || 'management';

    const fields = {
        status: body.status,
        assigned_to: body.assignedTo,
        priority: body.priority,
        admin_notes: body.adminNotes,
        due_date: body.dueDate,
        case_id: body.caseId,
        utility_case_id: body.utilityCaseId
    };

    const sets = [], vals = [id];
    Object.keys(fields).forEach(col => {
        if (fields[col] !== undefined) {
            vals.push(fields[col] === '' ? null : fields[col]);
            sets.push(`${col} = $${vals.length}`);
        }
    });

    if (!sets.length && !body.note) return res.json({ error: 'Nothing to update.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT * FROM submissions WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ error: `No submission found with ID ${id}` });
        }
        const before = existing.rows[0];

        if (sets.length) {
            await client.query(`UPDATE submissions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
            const changes = Object.keys(fields)
                .filter(col => fields[col] !== undefined && String(fields[col] || '') !== String(before[col] || ''))
                .map(col => `${col}: "${before[col] || '(empty)'}" -> "${fields[col] || '(empty)'}"`);
            if (changes.length) {
                await client.query(
                    'INSERT INTO submission_events (submission_id, event_type, detail, actor) VALUES ($1,$2,$3,$4)',
                    [id, 'update', changes.join('; '), actor]
                );
            }
        }

        if (body.note && String(body.note).trim()) {
            await client.query(
                'INSERT INTO submission_events (submission_id, event_type, detail, actor) VALUES ($1,$2,$3,$4)',
                [id, 'note', String(body.note).trim(), actor]
            );
        }

        await client.query('COMMIT');
        res.json({ ok: true, submissionId: id });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/', async (req, res) => {
    if (req.query.action === 'list') {
        return handleList(req, res);
    }

    if (req.query.action !== 'history') {
        return res.json({ status: 'ok', message: 'UtiliSave Issue Review API is running.' });
    }

    const submissionId = (req.query.submissionId || '').trim();
    if (!submissionId) {
        return res.json({ error: 'submissionId is required' });
    }

    try {
        const subResult = await pool.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
        if (subResult.rows.length === 0) {
            return res.json({ error: 'No submission found with that ID.' });
        }
        const sub = subResult.rows[0];

        const versionsResult = await pool.query(
            'SELECT * FROM submission_versions WHERE submission_id = $1 ORDER BY version_number DESC',
            [submissionId]
        );

        const filesResult = await pool.query(
            `SELECT id, file_name, mime_type, file_size, category, version_number, uploaded_at, uploaded_by
             FROM submission_files WHERE submission_id = $1 AND deleted_at IS NULL ORDER BY version_number ASC, uploaded_at ASC`,
            [submissionId]
        );

        const suggestionResult = await pool.query(
            `SELECT suggestion, status, admin_notes, drafted_wording, source, version_number, updated_at
             FROM skill_suggestions WHERE submission_id = $1
             ORDER BY version_number ASC, source ASC`,
            [submissionId]
        );

        const letterFeedbackResult = await pool.query(
            `SELECT final_letter_text, critique, version_number, updated_at
             FROM letter_feedback WHERE submission_id = $1
             ORDER BY version_number ASC`,
            [submissionId]
        );

        // AI-generated output (score-gap explanation, live research checklist,
        // redlined letter). Previously only ever visible inside index.html's
        // own tabs to whoever was actively working the case — an admin
        // reviewing it in management.html had no way to see this at all.
        const aiAnalysesResult = await pool.query(
            `SELECT kind, content, created_at FROM ai_analyses WHERE submission_id = $1`,
            [submissionId]
        );

        const eventsResult = await pool.query(
            `SELECT event_type, detail, actor, created_at
             FROM submission_events WHERE submission_id = $1
             ORDER BY created_at DESC LIMIT 200`,
            [submissionId]
        );

        res.json({
            submission: {
                CustomerName: sub.customer_name,
                CaseID: sub.case_id,
                UtilityCaseID: sub.utility_case_id,
                AssignedTo: sub.assigned_to,
                Priority: sub.priority,
                AdminNotes: sub.admin_notes,
                DueDate: sub.due_date,
                SubmissionDate: sub.submission_date,
                CreatedAt: sub.created_at,
                UpdatedAt: sub.updated_at,
                Status: sub.status,
                AuditorName: sub.auditor_name,
                UtilityName: sub.utility_name,
                UtilityType: sub.utility_type,
                AccountNumber: sub.account_number,
                IssueType: sub.issue_type,
                SubmissionText: sub.submission_text,
                FinancialImpact: sub.financial_impact,
                FinancialImpactRefund: sub.financial_impact_refund,
                FinancialImpactFuture: sub.financial_impact_future,
                AnalysisNotes: sub.analysis_notes
            },
            versions: versionsResult.rows.map(v => ({
                VersionNumber: v.version_number,
                Timestamp: v.created_at,
                Score: v.score,
                ScoreBreakdown: v.score_breakdown,
                Issues: v.issues,
                Suggestions: v.suggestions,
                AuditorName: v.auditor_name,
                Status: v.status,
                OutcomeReason: v.outcome_reason,
                AuditorNotes: v.auditor_notes
            })),
            files: filesResult.rows.map(f => ({
                FileId: f.id,
                FileName: f.file_name,
                MimeType: f.mime_type,
                FileSize: f.file_size,
                Category: f.category,
                VersionNumber: f.version_number,
                UploadedAt: f.uploaded_at,
                UploadedBy: f.uploaded_by
            })),
            // An array now, not a single object — a case can have both an
            // auditor-submitted suggestion AND a critique-derived one, and now
            // one of each per round (version_number) instead of just one ever.
            skillSuggestions: suggestionResult.rows.map(r => ({
                Suggestion: r.suggestion,
                Status: r.status,
                AdminNotes: r.admin_notes,
                DraftedWording: r.drafted_wording,
                Source: r.source,
                VersionNumber: r.version_number,
                UpdatedAt: r.updated_at
            })),
            // Also an array now — one entry per round that has a saved letter
            // and/or critique, so reopening a case for an appeal doesn't erase
            // the record of what was actually sent (and rejected) last round.
            letterFeedback: letterFeedbackResult.rows.map(r => ({
                VersionNumber: r.version_number,
                FinalLetterText: r.final_letter_text,
                Critique: r.critique,
                UpdatedAt: r.updated_at
            })),
            // Keyed by kind ('score_gap' / 'research_checklist' / 'redline_letter')
            // rather than an array, since there is at most one cached row per kind
            // per submission (see saveAnalysis's ON CONFLICT (submission_id, kind)).
            aiAnalyses: aiAnalysesResult.rows.reduce((acc, r) => {
                acc[r.kind] = { content: r.content, generatedAt: r.created_at };
                return acc;
            }, {}),
            events: eventsResult.rows.map(e => ({
                EventType: e.event_type,
                Detail: e.detail,
                Actor: e.actor,
                CreatedAt: e.created_at
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Powers the repository.html overview page: one row per submission, with its
// most recent version's score attached, newest-updated first.
async function handleList(req, res) {
    try {
        const result = await pool.query(`
            SELECT
                s.id, s.auditor_name, s.customer_name, s.account_number, s.utility_name,
                s.utility_type, s.issue_type, s.financial_impact,
                s.financial_impact_refund, s.financial_impact_future, s.case_id, s.status,
                s.utility_case_id, s.assigned_to, s.priority, s.admin_notes, s.due_date,
                s.submission_date, s.created_at, s.updated_at,
                COALESCE(vc.version_count, 0) AS version_count,
                COALESCE(fc.file_count, 0) AS file_count,
                lv.score AS latest_score,
                lv.version_number AS latest_round,
                lv.outcome_reason AS latest_outcome_reason
            FROM submissions s
            LEFT JOIN (
                SELECT submission_id, COUNT(*) AS version_count
                FROM submission_versions
                GROUP BY submission_id
            ) vc ON vc.submission_id = s.id
            LEFT JOIN (
                SELECT submission_id, COUNT(*) AS file_count
                FROM submission_files
                WHERE deleted_at IS NULL
                GROUP BY submission_id
            ) fc ON fc.submission_id = s.id
            LEFT JOIN LATERAL (
                SELECT score, version_number, outcome_reason, created_at
                FROM submission_versions v2
                WHERE v2.submission_id = s.id
                ORDER BY v2.version_number DESC
                LIMIT 1
            ) lv ON true
            ORDER BY s.updated_at DESC
        `);

        res.json({
            submissions: result.rows.map(s => ({
                SubmissionId: s.id,
                AuditorName: s.auditor_name,
                CustomerName: s.customer_name,
                AccountNumber: s.account_number,
                UtilityName: s.utility_name,
                UtilityType: s.utility_type,
                IssueType: s.issue_type,
                FinancialImpact: s.financial_impact,
                FinancialImpactRefund: s.financial_impact_refund,
                FinancialImpactFuture: s.financial_impact_future,
                CaseID: s.case_id,
                UtilityCaseID: s.utility_case_id,
                Status: s.status,
                AssignedTo: s.assigned_to,
                Priority: s.priority,
                AdminNotes: s.admin_notes,
                DueDate: s.due_date,
                SubmissionDate: s.submission_date,
                CreatedAt: s.created_at,
                UpdatedAt: s.updated_at,
                VersionCount: Number(s.version_count),
                FileCount: Number(s.file_count),
                LatestScore: s.latest_score,
                LatestRound: s.latest_round,
                LatestOutcomeReason: s.latest_outcome_reason
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
}

app.post('/', async (req, res) => {
    const body = req.body || {};
    if (body.action !== 'saveVersion') {
        return res.status(400).json({ error: 'Unsupported action.' });
    }

    const required = ['auditorName', 'customerName', 'accountNumber', 'utilityName', 'utilityType', 'issueType'];
    const isNewSubmission = !body.submissionId;
    if (isNewSubmission) {
        const missing = required.filter(f => !body[f]);
        if (missing.length) {
            return res.json({ error: `Missing required field(s): ${missing.join(', ')}` });
        }
    }

    // The auditor's name on a case must be THEIR OWN name, not any string
    // they choose to type — otherwise anyone with a login could file a
    // submission under a colleague's name (or a name that was never issued
    // an account at all). index.html locks this field to the signed-in
    // account and never lets it be edited, but that is a client-side
    // convenience only; this is the actual enforcement. Checked against
    // both full_name and email since a brand-new account may not have a
    // full_name recorded yet (fullName is required going forward — see
    // POST /users — but older accounts created before that could still be
    // missing one).
    const submittedName = String(body.auditorName || '').trim().toLowerCase();
    const allowedNames = [req.user.full_name, req.user.email]
        .filter(Boolean)
        .map(n => String(n).trim().toLowerCase());
    if (submittedName && !allowedNames.includes(submittedName)) {
        return res.json({ error: 'The auditor name on a submission must match your own signed-in account name. Refresh the page and try again.' });
    }

    // Expected Financial Impact is now two dollar-denominated fields (Refund,
    // Future Savings). The legacy single financial_impact column is kept in
    // sync as their sum so older reads (or a body that only sends the old
    // financialImpact field) still get a sensible number.
    const refund = body.financialImpactRefund !== undefined && body.financialImpactRefund !== null && body.financialImpactRefund !== ''
        ? Number(body.financialImpactRefund) : null;
    const future = body.financialImpactFuture !== undefined && body.financialImpactFuture !== null && body.financialImpactFuture !== ''
        ? Number(body.financialImpactFuture) : null;
    const totalFinancialImpact = (refund !== null || future !== null)
        ? (refund || 0) + (future || 0)
        : (body.financialImpact || null);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let submissionId = body.submissionId;
        let versionNumber = 1;

        if (isNewSubmission) {
            submissionId = newSubmissionId();
            await client.query(
                `INSERT INTO submissions
                    (id, auditor_name, customer_name, account_number, utility_name, utility_type,
                     issue_type, financial_impact, financial_impact_refund, financial_impact_future,
                     case_id, submission_date, submission_text, status, analysis_notes,
                     utility_case_id, submitted_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
                [
                    submissionId, body.auditorName, body.customerName, body.accountNumber,
                    body.utilityName, body.utilityType, body.issueType,
                    totalFinancialImpact, refund, future, body.caseId || null,
                    body.submissionDate || new Date(), body.submissionText || null,
                    body.status || 'Under Review', body.analysisNotes || null,
                    body.utilityCaseId || null
                ]
            );
        } else {
            const existing = await client.query('SELECT id FROM submissions WHERE id = $1', [submissionId]);
            if (existing.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.json({ error: `No submission found with ID ${submissionId}` });
            }

            const maxVersion = await client.query(
                'SELECT COALESCE(MAX(version_number), 0) AS max_v FROM submission_versions WHERE submission_id = $1',
                [submissionId]
            );
            versionNumber = Number(maxVersion.rows[0].max_v) + 1;

            await client.query(
                `UPDATE submissions SET
                    utility_case_id = COALESCE($8, utility_case_id),
                    case_id = COALESCE($2, case_id),
                    financial_impact = COALESCE($3, financial_impact),
                    financial_impact_refund = COALESCE($4, financial_impact_refund),
                    financial_impact_future = COALESCE($5, financial_impact_future),
                    status = COALESCE($6, status),
                    analysis_notes = COALESCE($7, analysis_notes),
                    updated_at = now()
                 WHERE id = $1`,
                [submissionId, body.caseId || null, totalFinancialImpact, refund, future, body.status || null, body.analysisNotes || null, body.utilityCaseId || null]
            );
        }

        if (body.skillSuggestion && body.skillSuggestion.trim()) {
            await client.query(
                `INSERT INTO skill_suggestions (submission_id, auditor_name, suggestion, status, source, version_number)
                 VALUES ($1, $2, $3, 'Pending', 'auditor', $4)
                 ON CONFLICT (submission_id, source, version_number) DO UPDATE SET
                    suggestion = EXCLUDED.suggestion,
                    auditor_name = EXCLUDED.auditor_name,
                    updated_at = now()`,
                [submissionId, body.auditorName || null, body.skillSuggestion.trim(), versionNumber]
            );
        }

        await client.query(
            `INSERT INTO submission_versions
                (submission_id, version_number, score, score_breakdown, issues, suggestions,
                 auditor_name, status, auditor_notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                submissionId, versionNumber, body.score || null,
                JSON.stringify(body.scoreBreakdown || []),
                JSON.stringify(body.issues || []),
                JSON.stringify(body.suggestions || []),
                body.auditorName || null, body.status || 'Under Review', body.auditorNotes || null
            ]
        );

        await client.query('COMMIT');
        res.json({ submissionId, versionNumber });

        // After the response, so a mail failure can never roll back or delay a
        // save. isNewSubmission covers a first filing; body.notify covers the
        // Submit button re-filing an existing case as a new round.
        if (isNewSubmission || body.notify) {
            notifyNewSubmission(submissionId).catch(err => console.error('notify failed:', err.message));
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Who is acting, for audit rows: the signed-in account's name, else email.
function actorOf(req) {
    return (req && req.user && (req.user.full_name || req.user.email)) || 'system';
}

const FILE_CATEGORY_LABEL = { intake: 'Intake document', final_letter: 'Final letter as submitted', outcome_letter: "Utility's outcome letter" };

// The one way a document is attached to a case: stores the file with who
// attached it, and writes a matching entry to the case's audit trail so the
// document history survives even if the file is later removed.
async function insertCaseFile(submissionId, file, category, versionNumber, req) {
    const actor = actorOf(req);
    const r = await pool.query(
        `INSERT INTO submission_files (submission_id, file_name, mime_type, file_size, file_data, category, version_number, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, file_name, mime_type, file_size, uploaded_at`,
        [submissionId, file.originalname, file.mimetype, file.size, file.buffer, category, versionNumber, actor]
    );
    const row = r.rows[0];
    await pool.query(
        'INSERT INTO submission_events (submission_id, event_type, detail, actor) VALUES ($1,$2,$3,$4)',
        [submissionId, 'document_added',
         `${file.originalname} (${FILE_CATEGORY_LABEL[category] || category}, round ${versionNumber}, ${Math.max(1, Math.round((file.size || 0) / 1024))} KB) [file #${row.id}]`,
         actor]
    ).catch(err => console.error('document_added event failed:', err.message));
    return row;
}

// Attach one or more files to an existing submission.
// multipart/form-data fields: submissionId (text), files (one or more).
app.post('/files', upload.array('files', 20), async (req, res) => {
    const submissionId = (req.body.submissionId || '').trim();
    if (!submissionId) {
        return res.status(400).json({ error: 'submissionId is required' });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files were uploaded.' });
    }

    try {
        const existing = await pool.query('SELECT id FROM submissions WHERE id = $1', [submissionId]);
        if (existing.rows.length === 0) {
            return res.json({ error: `No submission found with ID ${submissionId}` });
        }

        const versionNumber = await getLatestVersionNumber(submissionId);
        const inserted = [];
        for (const file of req.files) {
            const row = await insertCaseFile(submissionId, file, 'intake', versionNumber, req);
            inserted.push({
                FileId: row.id,
                FileName: row.file_name,
                MimeType: row.mime_type,
                FileSize: row.file_size,
                UploadedAt: row.uploaded_at
            });
        }

        res.json({ submissionId, files: inserted });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Everything filed on one case, and its history: every document ever
// attached (including ones later removed), which round it belongs to, who
// attached or removed it and when, plus each round's filing. Administrators
// only - it includes removed documents.
app.get('/submissions/:id/documents', requireAdmin, async (req, res) => {
    const id = req.params.id;
    try {
        const sub = await pool.query('SELECT * FROM submissions WHERE id = $1', [id]);
        if (!sub.rows.length) return res.status(404).json({ error: 'No submission found with that ID.' });
        const s = sub.rows[0];

        const [files, versions, events, letters, redline] = await Promise.all([
            pool.query(`SELECT id, file_name, mime_type, file_size, category, version_number, uploaded_at, uploaded_by, deleted_at, deleted_by
                        FROM submission_files WHERE submission_id = $1 ORDER BY version_number ASC, uploaded_at ASC, id ASC`, [id]),
            pool.query(`SELECT version_number, created_at, auditor_name, status, score, outcome_reason
                        FROM submission_versions WHERE submission_id = $1 ORDER BY version_number ASC`, [id]),
            pool.query(`SELECT event_type, detail, actor, created_at FROM submission_events
                        WHERE submission_id = $1 AND event_type IN ('document_added','document_removed')
                        ORDER BY created_at ASC`, [id]),
            pool.query(`SELECT version_number, (final_letter_text IS NOT NULL AND final_letter_text <> '') AS has_text,
                               (critique IS NOT NULL AND critique <> '') AS has_critique, updated_at
                        FROM letter_feedback WHERE submission_id = $1 ORDER BY version_number ASC`, [id]),
            pool.query(`SELECT created_at FROM ai_analyses WHERE submission_id = $1 AND kind = 'redline_letter'`, [id])
        ]);

        // Files attached before tracking began have no audit entry; show them
        // from the file row itself, flagged, rather than pretend we know more.
        const tracked = new Set();
        events.rows.forEach(e => {
            const m = /\[file #(\d+)\]/.exec(e.detail || '');
            if (m && e.event_type === 'document_added') tracked.add(Number(m[1]));
        });

        const history = [];
        versions.rows.forEach(v => history.push({
            type: 'round_filed', at: v.created_at, actor: v.auditor_name,
            detail: `Round ${v.version_number} saved` + (v.status ? ` — ${v.status}` : '') + (v.score !== null && v.score !== undefined ? ` — score ${v.score}` : ''),
            round: v.version_number
        }));
        events.rows.forEach(e => {
            const m = /\[file #(\d+)\]/.exec(e.detail || '');
            history.push({ type: e.event_type, at: e.created_at, actor: e.actor,
                           detail: String(e.detail || '').replace(/\s*\[file #\d+\]/, ''), fileId: m ? Number(m[1]) : null });
        });
        files.rows.forEach(f => {
            if (!tracked.has(f.id)) {
                history.push({ type: 'document_added', at: f.uploaded_at, actor: f.uploaded_by || null, legacy: true, fileId: f.id,
                               detail: `${f.file_name} (${FILE_CATEGORY_LABEL[f.category] || f.category}, round ${f.version_number})` });
                if (f.deleted_at) history.push({ type: 'document_removed', at: f.deleted_at, actor: f.deleted_by, legacy: true, fileId: f.id,
                               detail: `${f.file_name} (${FILE_CATEGORY_LABEL[f.category] || f.category}, round ${f.version_number})` });
            }
        });
        history.sort((a, b) => new Date(a.at) - new Date(b.at));

        res.json({
            submission: {
                SubmissionId: s.id, CaseID: s.case_id, UtilityCaseID: s.utility_case_id,
                CustomerName: s.customer_name, AccountNumber: s.account_number,
                UtilityName: s.utility_name, UtilityType: s.utility_type, IssueType: s.issue_type,
                AuditorName: s.auditor_name, Status: s.status, CreatedAt: s.created_at, UpdatedAt: s.updated_at,
                HasSubmissionText: !!(s.submission_text && String(s.submission_text).trim())
            },
            rounds: versions.rows.map(v => ({ VersionNumber: v.version_number, CreatedAt: v.created_at,
                AuditorName: v.auditor_name, Status: v.status, Score: v.score, OutcomeReason: v.outcome_reason })),
            documents: files.rows.map(f => ({
                FileId: f.id, FileName: f.file_name, MimeType: f.mime_type, FileSize: f.file_size,
                Category: f.category, CategoryLabel: FILE_CATEGORY_LABEL[f.category] || f.category,
                VersionNumber: f.version_number, UploadedAt: f.uploaded_at, UploadedBy: f.uploaded_by,
                Removed: !!f.deleted_at, RemovedAt: f.deleted_at, RemovedBy: f.deleted_by
            })),
            letters: letters.rows.map(l => ({ VersionNumber: l.version_number, HasText: l.has_text, HasCritique: l.has_critique, UpdatedAt: l.updated_at })),
            redlineLetterAt: redline.rows.length ? redline.rows[0].created_at : null,
            history
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Download one attached file.
app.get('/files/:id', async (req, res) => {
    const fileId = parseInt(req.params.id, 10);
    if (!Number.isInteger(fileId)) {
        return res.status(400).json({ error: 'Invalid file id' });
    }

    try {
        const result = await pool.query(
            'SELECT file_name, mime_type, file_data, deleted_at FROM submission_files WHERE id = $1',
            [fileId]
        );
        // A removed document stays retrievable for administrators (it is part
        // of the case's history) but disappears for everyone else.
        if (result.rows.length === 0 || (result.rows[0].deleted_at && req.user.role !== 'admin')) {
            return res.status(404).json({ error: 'File not found' });
        }
        const file = result.rows[0];
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);
        res.send(file.file_data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Remove one attached file.
app.delete('/files/:id', async (req, res) => {
    const fileId = parseInt(req.params.id, 10);
    if (!Number.isInteger(fileId)) {
        return res.status(400).json({ error: 'Invalid file id' });
    }

    try {
        // Soft delete: the file leaves the case but stays in its document
        // history, with who removed it and when.
        const actor = actorOf(req);
        const result = await pool.query(
            `UPDATE submission_files SET deleted_at = now(), deleted_by = $2
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING id, submission_id, file_name, category, version_number`,
            [fileId, actor]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }
        const f = result.rows[0];
        await pool.query(
            'INSERT INTO submission_events (submission_id, event_type, detail, actor) VALUES ($1,$2,$3,$4)',
            [f.submission_id, 'document_removed', `${f.file_name} (${FILE_CATEGORY_LABEL[f.category] || f.category}, round ${f.version_number}) [file #${f.id}]`, actor]
        ).catch(err => console.error('document_removed event failed:', err.message));
        res.json({ deleted: fileId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const ALLOWED_OPTION_FIELDS = ['utilityName', 'issueType'];

// Every custom "Other" value added so far, grouped by field — fetched on page
// load so previously-typed values show up as real dropdown choices, not just "Other".
app.get('/options', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT field_name, value FROM custom_field_options ORDER BY value ASC'
        );
        const options = {};
        ALLOWED_OPTION_FIELDS.forEach(f => { options[f] = []; });
        result.rows.forEach(row => {
            if (!options[row.field_name]) options[row.field_name] = [];
            options[row.field_name].push(row.value);
        });
        res.json({ options });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Persist a new custom "Other" value so it's a real option for everyone from here on.
app.post('/options', async (req, res) => {
    const body = req.body || {};
    const field = body.field;
    const value = (body.value || '').trim();

    if (!ALLOWED_OPTION_FIELDS.includes(field)) {
        return res.status(400).json({ error: `Unknown field: ${field}` });
    }
    if (!value) {
        return res.status(400).json({ error: 'value is required' });
    }

    try {
        await pool.query(
            `INSERT INTO custom_field_options (field_name, value, added_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (field_name, value) DO NOTHING`,
            [field, value, body.addedBy || null]
        );
        const result = await pool.query(
            'SELECT value FROM custom_field_options WHERE field_name = $1 ORDER BY value ASC',
            [field]
        );
        res.json({ field, options: result.rows.map(r => r.value) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---- Admin management of dropdown options (Utility, Issue Type) ----------
// The plain GET /options above only ever returns bare value strings (that's
// all the submission form needs). The admin panel needs the row id to target
// a specific value for rename/delete, so it gets its own read route.
app.get('/admin/options', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, field_name, value, added_by, created_at
             FROM custom_field_options ORDER BY field_name ASC, value ASC`
        );
        res.json({ options: result.rows.map(r => ({
            Id: r.id, FieldName: r.field_name, Value: r.value, AddedBy: r.added_by, CreatedAt: r.created_at
        })) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Rename a value already in use. Existing submissions that reference the old
// text are NOT retroactively changed (they keep whatever string was true at
// the time), only the dropdown choice going forward.
app.patch('/options/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const value = String((req.body && req.body.value) || '').trim();
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid option id' });
    if (!value) return res.status(400).json({ error: 'value is required' });
    try {
        const result = await pool.query(
            'UPDATE custom_field_options SET value = $2 WHERE id = $1 RETURNING id, field_name, value',
            [id, value]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Option not found' });
        res.json({ updated: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') { // unique_violation on (field_name, value)
            return res.status(400).json({ error: 'That value already exists for this field.' });
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Remove a value from the dropdown going forward. Existing submissions keep
// showing whatever they already have on file — this only stops it from
// being offered as a choice on new/future submissions.
app.delete('/options/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid option id' });
    try {
        const result = await pool.query('DELETE FROM custom_field_options WHERE id = $1 RETURNING id', [id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Option not found' });
        res.json({ deleted: id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Every proposed addition to the Auditor Skills Framework, for admin.html.
app.get('/suggestions', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ss.id, ss.submission_id, ss.auditor_name, ss.suggestion, ss.status,
                   ss.admin_notes, ss.drafted_wording, ss.skill_markdown, ss.source, ss.version_number,
                   ss.created_at, ss.updated_at,
                   s.customer_name, s.case_id, s.utility_name, s.issue_type
            FROM skill_suggestions ss
            JOIN submissions s ON s.id = ss.submission_id
            ORDER BY ss.updated_at DESC
        `);
        res.json({
            suggestions: result.rows.map(r => ({
                SuggestionId: r.id,
                SubmissionId: r.submission_id,
                AuditorName: r.auditor_name,
                Suggestion: r.suggestion,
                Status: r.status,
                AdminNotes: r.admin_notes,
                DraftedWording: r.drafted_wording,
                SkillMarkdown: r.skill_markdown,
                Source: r.source,
                VersionNumber: r.version_number,
                CreatedAt: r.created_at,
                UpdatedAt: r.updated_at,
                CustomerName: r.customer_name,
                CaseID: r.case_id,
                UtilityName: r.utility_name,
                IssueType: r.issue_type
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Edit admin notes only — status changes go through /accept or /reject below,
// which is where the "move to a pile" + wording-drafting behavior lives.
app.patch('/suggestions/:id', async (req, res) => {
    const suggestionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(suggestionId)) {
        return res.status(400).json({ error: 'Invalid suggestion id' });
    }
    const body = req.body || {};

    try {
        const result = await pool.query(
            `UPDATE skill_suggestions SET
                admin_notes = COALESCE($2, admin_notes),
                drafted_wording = COALESCE($3, drafted_wording),
                updated_at = now()
             WHERE id = $1
             RETURNING id, status, admin_notes, drafted_wording, skill_markdown, updated_at`,
            [
                suggestionId,
                body.adminNotes !== undefined ? body.adminNotes : null,
                body.draftedWording !== undefined ? body.draftedWording : null
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Suggestion not found' });
        }
        res.json({
            SuggestionId: result.rows[0].id,
            Status: result.rows[0].status,
            AdminNotes: result.rows[0].admin_notes,
            DraftedWording: result.rows[0].drafted_wording,
            SkillMarkdown: result.rows[0].skill_markdown,
            UpdatedAt: result.rows[0].updated_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Accept: moves the suggestion to the Accepted pile AND asks Claude to draft
// the exact wording to add to the Auditor Skills Framework (this API can't
// edit that framework itself — it lives in project instructions/skills — so
// this gives Michael ready-to-paste language instead of just a status flip).
app.post('/suggestions/:id/accept', async (req, res) => {
    const suggestionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(suggestionId)) {
        return res.status(400).json({ error: 'Invalid suggestion id' });
    }

    try {
        const existing = await pool.query('SELECT * FROM skill_suggestions WHERE id = $1', [suggestionId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Suggestion not found' });
        }
        const row = existing.rows[0];

        let draftedWording = row.drafted_wording || null;
        const anthropic = getAnthropic();
        if (anthropic) {
            try {
                const prompt = `An auditor proposed this addition to our shared "Auditor Skills Framework" — a set of rules that guides every future utility-billing-dispute review:

"""${row.suggestion}"""

Draft the exact wording to add to that framework. Match the tone and format of existing rules (concise, imperative, one idea per line — e.g. "Verify every fact. Distinguish material from immaterial." or "Never accept explanations at face value."). Return ONLY the drafted wording itself — no preamble, no explanation, no surrounding quotes.`;
                const message = await anthropic.messages.create({
                    model: CLAUDE_MODEL,
                    max_tokens: 512,
                    messages: [{ role: 'user', content: prompt }]
                });
                draftedWording = extractText(message) || draftedWording;
            } catch (aiErr) {
                // Don't block the Accept action just because drafting failed —
                // Michael can still write the wording himself.
                console.error('Drafting wording failed, accepting without it:', aiErr.message);
            }
        }

        const result = await pool.query(
            `UPDATE skill_suggestions SET status = 'Accepted', drafted_wording = $2, updated_at = now()
             WHERE id = $1
             RETURNING id, status, admin_notes, drafted_wording, updated_at`,
            [suggestionId, draftedWording]
        );
        res.json({
            SuggestionId: result.rows[0].id,
            Status: result.rows[0].status,
            AdminNotes: result.rows[0].admin_notes,
            DraftedWording: result.rows[0].drafted_wording,
            UpdatedAt: result.rows[0].updated_at,
            aiConfigured: !!anthropic
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Reject: moves the suggestion to the Rejected pile. No further action.
app.post('/suggestions/:id/reject', async (req, res) => {
    const suggestionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(suggestionId)) {
        return res.status(400).json({ error: 'Invalid suggestion id' });
    }

    try {
        const result = await pool.query(
            `UPDATE skill_suggestions SET status = 'Rejected', updated_at = now()
             WHERE id = $1
             RETURNING id, status, admin_notes, drafted_wording, updated_at`,
            [suggestionId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Suggestion not found' });
        }
        res.json({
            SuggestionId: result.rows[0].id,
            Status: result.rows[0].status,
            AdminNotes: result.rows[0].admin_notes,
            DraftedWording: result.rows[0].drafted_wording,
            UpdatedAt: result.rows[0].updated_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Writes a complete SKILL.md (frontmatter + body) from an Accepted
// suggestion's (possibly just-edited) drafted wording. Saves that wording and
// the generated file together, so nothing is lost even if this was the first
// time it was ever persisted. This does NOT install anything anywhere — it
// only produces text for Michael to bring into a Claude session (to package
// as an installable .skill file) or paste into Settings > Capabilities
// himself; no session or backend can write to skill storage directly.
app.post('/suggestions/:id/generate-skill', async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return aiNotConfigured(res);

    const suggestionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(suggestionId)) {
        return res.status(400).json({ error: 'Invalid suggestion id' });
    }
    const body = req.body || {};

    try {
        const existing = await pool.query(`
            SELECT ss.*, s.utility_name, s.issue_type, s.customer_name
            FROM skill_suggestions ss
            JOIN submissions s ON s.id = ss.submission_id
            WHERE ss.id = $1
        `, [suggestionId]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Suggestion not found' });
        const row = existing.rows[0];

        const draftedWording = (body.draftedWording !== undefined ? body.draftedWording : row.drafted_wording) || '';
        if (!draftedWording.trim()) {
            return res.status(400).json({ error: 'There is no drafted wording yet to convert into a skill — accept the suggestion first, or write wording into the box before generating.' });
        }

        const prompt = `You are creating an Anthropic "Skill" file (SKILL.md) from an approved addition to the UtiliSave Auditor Skills Framework, so it can be reused as a standalone, portable skill.

APPROVED RULE (what the skill should encode):
"""${draftedWording}"""

Original auditor suggestion this came from: """${row.suggestion}"""
Example case that prompted it: ${row.utility_name}, a ${row.issue_type} issue.

Write a complete SKILL.md file:
1. YAML frontmatter with "name" (short, specific, kebab-case) and "description" (one sentence specific enough that a future auditing session would know exactly when to load it).
2. A body explaining the rule, when/how to apply it during utility billing dispute review, and a brief concrete example.

Return ONLY the complete file content (frontmatter then body), no extra commentary, starting with "---".`;

        const message = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 1536,
            messages: [{ role: 'user', content: prompt }]
        });

        const skillMarkdown = extractText(message);

        const updated = await pool.query(
            `UPDATE skill_suggestions SET drafted_wording = $2, skill_markdown = $3, updated_at = now()
             WHERE id = $1
             RETURNING drafted_wording, skill_markdown, updated_at`,
            [suggestionId, draftedWording, skillMarkdown]
        );

        res.json({
            SuggestionId: suggestionId,
            DraftedWording: updated.rows[0].drafted_wording,
            SkillMarkdown: updated.rows[0].skill_markdown,
            UpdatedAt: updated.rows[0].updated_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Save the real-world outcome for a case's letter: the final text as actually
// sent (after any human edits beyond the AI's redline) and/or an auditor's
// critique of the AI's draft. Either field can be sent alone. This is the
// data /analyze/redline-letter draws on as few-shot examples for future cases
// — see "Learning from past letters" below.
app.post('/letter-feedback', async (req, res) => {
    const body = req.body || {};
    const submissionId = (body.submissionId || '').trim();
    if (!submissionId) return res.status(400).json({ error: 'submissionId is required' });

    try {
        const existing = await pool.query('SELECT id, auditor_name FROM submissions WHERE id = $1', [submissionId]);
        if (existing.rows.length === 0) {
            return res.json({ error: `No submission found with ID ${submissionId}` });
        }

        // Ties this save to whichever round (version) is currently the most
        // recent for this case, so an appeal's letter/critique lands in its
        // own slot instead of overwriting the round that was actually rejected.
        const versionNumber = await getLatestVersionNumber(submissionId);

        const result = await pool.query(
            `INSERT INTO letter_feedback (submission_id, version_number, final_letter_text, critique)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (submission_id, version_number) DO UPDATE SET
                final_letter_text = COALESCE(EXCLUDED.final_letter_text, letter_feedback.final_letter_text),
                critique = COALESCE(EXCLUDED.critique, letter_feedback.critique),
                updated_at = now()
             RETURNING version_number, final_letter_text, critique, updated_at`,
            [submissionId, versionNumber, body.finalLetterText || null, body.critique || null]
        );

        // A non-empty critique also becomes its own entry in the skill-
        // suggestion queue (admin.html), tagged source='critique' so Michael
        // can tell at a glance this came from a letter review rather than the
        // intake form's "Suggested Addition..." box. Still goes through the
        // same Pending -> Accept/Reject review — this doesn't change the
        // framework by itself. Also tagged with this round's version_number.
        if (body.critique && body.critique.trim()) {
            await pool.query(
                `INSERT INTO skill_suggestions (submission_id, auditor_name, suggestion, status, source, version_number)
                 VALUES ($1, $2, $3, 'Pending', 'critique', $4)
                 ON CONFLICT (submission_id, source, version_number) DO UPDATE SET
                    suggestion = EXCLUDED.suggestion,
                    auditor_name = EXCLUDED.auditor_name,
                    updated_at = now()`,
                [submissionId, existing.rows[0].auditor_name || null, body.critique.trim(), versionNumber]
            );
        }

        res.json({
            submissionId,
            VersionNumber: result.rows[0].version_number,
            FinalLetterText: result.rows[0].final_letter_text,
            Critique: result.rows[0].critique,
            UpdatedAt: result.rows[0].updated_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Best-effort text extraction so an uploaded file can feed the same
// final_letter_text field the paste box writes to. Unsupported types return
// null — the file is still stored and downloadable, it just won't contribute
// text until supplemented via the paste box.
async function extractTextFromFile(file) {
    const name = (file.originalname || '').toLowerCase();
    try {
        if (name.endsWith('.docx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            return result.value;
        }
        if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
            const pdfParse = require('pdf-parse');
            const result = await pdfParse(file.buffer);
            return result.text;
        }
        if (name.endsWith('.txt') || file.mimetype === 'text/plain') {
            return file.buffer.toString('utf-8');
        }
    } catch (err) {
        console.error(`Text extraction failed for ${file.originalname}:`, err.message);
    }
    return null;
}

// Attach the final letter (and any exhibits) as files instead of pasting
// text. Text is auto-extracted from .docx/.pdf/.txt and appended into
// letter_feedback.final_letter_text — the same field the paste box writes
// to, so either method (or both) feeds "Learning from past letters" the same
// way. Files of any type are stored either way (category='final_letter') so
// they're downloadable later even if their text couldn't be auto-extracted.
app.post('/letter-feedback/files', upload.array('files', 20), async (req, res) => {
    const submissionId = (req.body.submissionId || '').trim();
    if (!submissionId) return res.status(400).json({ error: 'submissionId is required' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files were uploaded.' });

    try {
        const existing = await pool.query('SELECT id FROM submissions WHERE id = $1', [submissionId]);
        if (existing.rows.length === 0) return res.json({ error: `No submission found with ID ${submissionId}` });

        const versionNumber = await getLatestVersionNumber(submissionId);
        const extractedParts = [];
        const storedFiles = [];
        const unsupported = [];

        for (const file of req.files) {
            const row = await insertCaseFile(submissionId, file, 'final_letter', versionNumber, req);
            storedFiles.push({
                FileId: row.id, FileName: row.file_name, MimeType: row.mime_type,
                FileSize: row.file_size, UploadedAt: row.uploaded_at
            });

            const text = await extractTextFromFile(file);
            if (text && text.trim()) {
                extractedParts.push(`--- ${file.originalname} ---\n${text.trim()}`);
            } else {
                unsupported.push(file.originalname);
            }
        }

        let finalLetterText = null;
        if (extractedParts.length) {
            const combined = extractedParts.join('\n\n');
            const upserted = await pool.query(
                `INSERT INTO letter_feedback (submission_id, version_number, final_letter_text)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (submission_id, version_number) DO UPDATE SET
                    final_letter_text = CASE
                        WHEN letter_feedback.final_letter_text IS NULL OR letter_feedback.final_letter_text = ''
                        THEN EXCLUDED.final_letter_text
                        ELSE letter_feedback.final_letter_text || E'\\n\\n' || EXCLUDED.final_letter_text
                    END,
                    updated_at = now()
                 RETURNING final_letter_text`,
                [submissionId, versionNumber, combined]
            );
            finalLetterText = upserted.rows[0].final_letter_text;
        }

        res.json({
            submissionId,
            VersionNumber: versionNumber,
            files: storedFiles,
            textExtractedFromCount: extractedParts.length,
            unsupportedForTextExtraction: unsupported,
            finalLetterText
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Records the real-world outcome of the CURRENT round (the most recent
// submission_versions row) — e.g. "Rejected: cited Tariff Sec. 4.2, said the
// meter was field-verified." This resolves the round that already happened;
// it does NOT create a new one. To actually refile/appeal, use the "Reopen
// This Case" flow on the front end, which starts a new round the normal way
// (another saveVersion call), leaving this round's outcome untouched as the
// record of what got rejected and why.
app.post('/submissions/:id/outcome', async (req, res) => {
    const submissionId = req.params.id;
    const body = req.body || {};
    if (!body.status && !body.outcomeReason) {
        return res.status(400).json({ error: 'Provide at least a status or an outcomeReason.' });
    }

    try {
        const existing = await pool.query('SELECT id FROM submissions WHERE id = $1', [submissionId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: `No submission found with ID ${submissionId}` });
        }

        const versionNumber = await getLatestVersionNumber(submissionId);

        const updated = await pool.query(
            `UPDATE submission_versions SET
                status = COALESCE($3, status),
                outcome_reason = COALESCE($4, outcome_reason)
             WHERE submission_id = $1 AND version_number = $2
             RETURNING version_number, status, outcome_reason`,
            [submissionId, versionNumber, body.status || null, body.outcomeReason || null]
        );

        // Keep the denormalized "current status" on submissions in sync so
        // repository.html's list/filter view reflects the outcome too.
        if (body.status) {
            await pool.query('UPDATE submissions SET status = $2, updated_at = now() WHERE id = $1', [submissionId, body.status]);
        }

        res.json({
            submissionId,
            VersionNumber: updated.rows[0].version_number,
            Status: updated.rows[0].status,
            OutcomeReason: updated.rows[0].outcome_reason
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// AI analysis — Claude Messages API calls that generate genuinely case-specific
// content. Requires ANTHROPIC_API_KEY (Railway Variables on this service). All
// results are cached in ai_analyses (one row per submission+kind) so repeat
// views don't re-call the API; pass forceRefresh:true to regenerate.
// ============================================================================

let anthropicClient = null;
function getAnthropic() {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (!anthropicClient) {
        const Anthropic = require('@anthropic-ai/sdk');
        anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropicClient;
}

function aiNotConfigured(res) {
    return res.status(503).json({
        error: 'AI analysis is not configured yet. Set ANTHROPIC_API_KEY in this service\'s Railway Variables to enable it (see backend/README.md, "AI features setup").'
    });
}

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

async function loadSubmissionContext(submissionId) {
    const subResult = await pool.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (subResult.rows.length === 0) return null;
    const versionResult = await pool.query(
        'SELECT * FROM submission_versions WHERE submission_id = $1 ORDER BY version_number DESC LIMIT 1',
        [submissionId]
    );
    return { submission: subResult.rows[0], latestVersion: versionResult.rows[0] || null };
}

async function getCachedAnalysis(submissionId, kind) {
    const result = await pool.query(
        'SELECT content, created_at FROM ai_analyses WHERE submission_id = $1 AND kind = $2',
        [submissionId, kind]
    );
    return result.rows[0] || null;
}

async function saveAnalysis(submissionId, kind, content) {
    await pool.query(
        `INSERT INTO ai_analyses (submission_id, kind, content)
         VALUES ($1, $2, $3)
         ON CONFLICT (submission_id, kind) DO UPDATE SET content = EXCLUDED.content, created_at = now()`,
        [submissionId, kind, JSON.stringify(content)]
    );
}

function extractText(message) {
    return (message.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
}

function extractCitations(message) {
    const citations = [];
    (message.content || []).forEach(block => {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
            block.content.forEach(r => {
                if (r.type === 'web_search_result') citations.push({ url: r.url, title: r.title });
            });
        }
    });
    return citations;
}

function parseJsonResponse(text, fallback) {
    try {
        return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    } catch {
        return fallback(text);
    }
}

// AI-assist for recording an outcome: attach (or paste) the utility's actual
// rejection/adjustment letter, and Claude summarizes why in 1-3 sentences —
// a starting point for the outcomeReason box, not a final answer. The auditor
// reviews/edits the suggestion, then saves it for real via
// POST /submissions/:id/outcome. Any attached file is archived as a
// submission_file (category='outcome_letter') either way, tagged to the
// current round, so the utility's own letter is part of that round's record
// even before AI is configured. Without ANTHROPIC_API_KEY set, this still
// stores the file(s) and returns the raw extracted text as a fallback
// suggestion rather than blocking outright.
app.post('/submissions/:id/extract-outcome-reason', upload.array('files', 5), async (req, res) => {
    const submissionId = req.params.id;
    const body = req.body || {};
    const pastedText = (body.text || '').trim();

    try {
        const existing = await pool.query('SELECT id FROM submissions WHERE id = $1', [submissionId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: `No submission found with ID ${submissionId}` });
        }

        const versionNumber = await getLatestVersionNumber(submissionId);
        const storedFiles = [];
        const extractedParts = [];

        for (const file of (req.files || [])) {
            const row = await insertCaseFile(submissionId, file, 'outcome_letter', versionNumber, req);
            storedFiles.push({
                FileId: row.id, FileName: row.file_name, MimeType: row.mime_type,
                FileSize: row.file_size, UploadedAt: row.uploaded_at
            });
            const text = await extractTextFromFile(file);
            if (text && text.trim()) extractedParts.push(text.trim());
        }

        if (pastedText) extractedParts.push(pastedText);
        const combinedText = extractedParts.join('\n\n').trim();

        if (!combinedText) {
            return res.json({
                submissionId, VersionNumber: versionNumber, files: storedFiles, suggestedReason: null,
                aiConfigured: !!getAnthropic(),
                note: 'No text was found to summarize — paste the letter\'s text, or attach a .docx/.pdf/.txt file.'
            });
        }

        const anthropic = getAnthropic();
        if (!anthropic) {
            return res.json({
                submissionId, VersionNumber: versionNumber, files: storedFiles, aiConfigured: false,
                suggestedReason: combinedText.length > 600 ? combinedText.slice(0, 600) + '…' : combinedText,
                note: 'AI summarization is not configured — showing the raw extracted text instead. Set ANTHROPIC_API_KEY to get a real summary.'
            });
        }

        const prompt = `Summarize, in 1-3 concise sentences, why the utility rejected or adjusted this billing dispute claim. Base it only on the text below — do not invent reasons that aren't stated. Return ONLY the summary, no preamble.\n\n"""${combinedText.slice(0, 8000)}"""`;
        const message = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 300,
            messages: [{ role: 'user', content: prompt }]
        });
        const suggestedReason = extractText(message);

        res.json({ submissionId, VersionNumber: versionNumber, files: storedFiles, aiConfigured: true, suggestedReason });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Why isn't this case at 80+ yet, what should the auditor still dig into, and
// why does the gap exist? Genuinely case-specific — not the old keyword scorer.
app.post('/analyze/score-gap', async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return aiNotConfigured(res);

    const { submissionId, forceRefresh } = req.body || {};
    if (!submissionId) return res.status(400).json({ error: 'submissionId is required' });

    try {
        if (!forceRefresh) {
            const cached = await getCachedAnalysis(submissionId, 'score_gap');
            if (cached) return res.json({ cached: true, generatedAt: cached.created_at, ...cached.content });
        }

        const ctx = await loadSubmissionContext(submissionId);
        if (!ctx) return res.status(404).json({ error: 'No submission found with that ID.' });
        const { submission, latestVersion } = ctx;
        const score = latestVersion ? latestVersion.score : null;

        const prompt = `You are a skeptical, detail-obsessed utility billing dispute auditor reviewing a colleague's submission before it goes to the utility. Be specific to THIS case — no generic boilerplate.

CASE:
- Customer: ${submission.customer_name}
- Utility: ${submission.utility_name} (${submission.utility_type})
- Issue type: ${submission.issue_type}
- Requested refund: $${submission.financial_impact_refund || 0}; projected future savings: $${submission.financial_impact_future || 0}
- Submission text: """${submission.submission_text || '(none provided)'}"""
- Auditor's notes for this analysis: """${submission.analysis_notes || '(none)'}"""
- Current heuristic score: ${score ?? 'not yet scored'}/100
- Score breakdown so far: ${JSON.stringify(latestVersion ? latestVersion.score_breakdown : [])}
- Issues already flagged: ${JSON.stringify(latestVersion ? latestVersion.issues : [])}

Explain, concretely and tied to this case:
1. Exactly why this can't yet score 80+ — name the specific missing evidence, weak logic, or unverified claims.
2. What the auditor should still research, verify, or obtain (specific documents/data/facts, not vague advice).
3. Why the gap to 100 exists — the utility's strongest likely counterargument, and what specifically would close that gap.

Return ONLY valid JSON in this exact shape, no other text:
{"whyNot80": "...", "furtherResearch": ["...", "..."], "gapReasoning": "..."}`;

        const message = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }]
        });

        const parsed = parseJsonResponse(extractText(message), (text) => ({ whyNot80: text, furtherResearch: [], gapReasoning: '' }));
        await saveAnalysis(submissionId, 'score_gap', parsed);
        res.json({ cached: false, generatedAt: new Date().toISOString(), ...parsed });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Live-research Pre-Submission Checklist: real, web-search-verified tariff
// citations, PSC/PUC case citations with links, and state-specific relief
// language — each returned with a stable id so the front end can track which
// ones the auditor has chosen to incorporate.
app.post('/analyze/research-checklist', async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return aiNotConfigured(res);

    const { submissionId, forceRefresh } = req.body || {};
    if (!submissionId) return res.status(400).json({ error: 'submissionId is required' });

    try {
        if (!forceRefresh) {
            const cached = await getCachedAnalysis(submissionId, 'research_checklist');
            if (cached) return res.json({ cached: true, generatedAt: cached.created_at, ...cached.content });
        }

        const ctx = await loadSubmissionContext(submissionId);
        if (!ctx) return res.status(404).json({ error: 'No submission found with that ID.' });
        const { submission } = ctx;

        const prompt = `You are researching support for a utility billing dispute so an auditor can strengthen a submission before it goes to the utility. Use web search to find REAL, specific, verifiable sources. Do not invent tariff section numbers or case citations — if you can't verify something with search results, leave it out.

CASE:
- Utility: ${submission.utility_name} (${submission.utility_type})
- Issue type: ${submission.issue_type}
- Submission text: """${submission.submission_text || '(none provided)'}"""

Find and return as many genuinely relevant items as you can (quality over quantity) in these categories:
1. Site-specific tariff citations — specific tariff sections of this utility that could support this argument, with section number/title and why it's relevant.
2. Public/Utility Service Commission cases — real cases you found via search, with the URL and a 1-2 sentence key takeaway.
3. State-specific relief requested — language or precedent for the specific relief to request in this jurisdiction.
4. Anything else you find relevant.

Return ONLY valid JSON, no other text, in this exact shape:
{
  "tariffCitations": [{"citation": "Section X.X - Title", "relevance": "..."}],
  "pscCases": [{"caseName": "...", "url": "https://...", "takeaway": "..."}],
  "stateRelief": [{"suggestion": "...", "basis": "..."}],
  "other": [{"suggestion": "...", "basis": "..."}]
}`;

        const message = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
            messages: [{ role: 'user', content: prompt }]
        });

        const parsed = parseJsonResponse(extractText(message), (text) => ({ tariffCitations: [], pscCases: [], stateRelief: [], other: [], rawText: text }));
        let counter = 0;
        ['tariffCitations', 'pscCases', 'stateRelief', 'other'].forEach(key => {
            (parsed[key] || []).forEach(item => { item.id = `${key}-${counter++}`; });
        });
        parsed.sourcesSearched = extractCitations(message);

        await saveAnalysis(submissionId, 'research_checklist', parsed);
        res.json({ cached: false, generatedAt: new Date().toISOString(), ...parsed });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Total Letter with Redlines: drafts (or revises) the formal dispute letter,
// marking every AI-added/changed passage with <ins>/<del> so it renders as a
// redline. Folds in whichever research-checklist items the auditor checked.
app.post('/analyze/redline-letter', async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return aiNotConfigured(res);

    const { submissionId, incorporatedItems, forceRefresh } = req.body || {};
    if (!submissionId) return res.status(400).json({ error: 'submissionId is required' });

    try {
        if (!forceRefresh && (!incorporatedItems || incorporatedItems.length === 0)) {
            const cached = await getCachedAnalysis(submissionId, 'redline_letter');
            if (cached) return res.json({ cached: true, generatedAt: cached.created_at, ...cached.content });
        }

        const ctx = await loadSubmissionContext(submissionId);
        if (!ctx) return res.status(404).json({ error: 'No submission found with that ID.' });
        const { submission } = ctx;

        const researchCache = await getCachedAnalysis(submissionId, 'research_checklist');
        const allResearchItems = researchCache ? researchCache.content : {};
        const selectedItems = [];
        if (incorporatedItems && incorporatedItems.length) {
            ['tariffCitations', 'pscCases', 'stateRelief', 'other'].forEach(key => {
                (allResearchItems[key] || []).forEach(item => {
                    if (incorporatedItems.includes(item.id)) selectedItems.push({ category: key, ...item });
                });
            });
        }

        // "Learning from past letters": pull real outcomes from OTHER cases —
        // the letter as actually sent, and/or an auditor's critique of the AI
        // draft — and feed them in as few-shot examples. This is retrieval,
        // not model fine-tuning (see README "AI features setup" for what this
        // does and doesn't do); it's how the system's letters can genuinely
        // improve over time as more feedback accumulates. Same-utility and
        // same-issue-type examples are prioritized, most recent first.
        const feedbackHistory = await pool.query(
            `SELECT s.utility_name, s.issue_type, lf.final_letter_text, lf.critique
             FROM letter_feedback lf
             JOIN submissions s ON s.id = lf.submission_id
             WHERE lf.submission_id != $1
               AND (lf.final_letter_text IS NOT NULL OR lf.critique IS NOT NULL)
             ORDER BY
               (s.utility_name = $2) DESC,
               (s.issue_type = $3) DESC,
               lf.updated_at DESC
             LIMIT 3`,
            [submissionId, submission.utility_name, submission.issue_type]
        );

        const lessonsBlock = feedbackHistory.rows.length ? `

LESSONS FROM PAST LETTERS — apply this real-world feedback: keep doing what worked, do not repeat what didn't.
${feedbackHistory.rows.map((r, i) => `
Example ${i + 1} (${r.utility_name}, ${r.issue_type}):
${r.final_letter_text ? `Final letter as actually submitted: """${r.final_letter_text.slice(0, 3000)}"""` : ''}
${r.critique ? `Auditor's critique of that draft: """${r.critique}"""` : ''}`).join('\n')}
` : '';

        const prompt = `You are drafting/revising a formal utility billing dispute letter for submission to the utility. Produce a redlined (track-changes style) version showing exactly what you added or changed versus the auditor's original text.

CASE:
- Customer: ${submission.customer_name}
- Account: ${submission.account_number}
- Utility: ${submission.utility_name} (${submission.utility_type})
- Issue type: ${submission.issue_type}
- Requested refund: $${submission.financial_impact_refund || 0}; projected future savings: $${submission.financial_impact_future || 0}
- Auditor's original submission text (treat this as the "original" to redline — if it already reads like a formal letter, edit it directly; if it's just notes, draft a complete formal letter and mark ALL of it as inserted): """${submission.submission_text || '(none provided — draft a complete letter from the case facts above)'}"""
- Case notes: """${submission.analysis_notes || '(none)'}"""
- Research items the auditor chose to incorporate: ${selectedItems.length ? JSON.stringify(selectedItems) : '(none selected — use your own judgment on what strengthens the letter)'}
${lessonsBlock}
Output the letter as an HTML fragment using ONLY <p>, <ins>, and <del> tags — wrap every inserted sentence/phrase in <ins>...</ins> and every deleted phrase in <del>...</del> so changes render as a redline. Leave unchanged text bare (no tags). Professional, factual, non-accusatory tone.

Return ONLY valid JSON, no other text, in this exact shape:
{"letterHtml": "<p>...</p>", "changeSummary": ["short bullet describing one change", "..."]}`;

        const message = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }]
        });

        const parsed = parseJsonResponse(extractText(message), (text) => ({ letterHtml: `<p>${text}</p>`, changeSummary: [] }));
        await saveAnalysis(submissionId, 'redline_letter', parsed);
        res.json({ cached: false, generatedAt: new Date().toISOString(), ...parsed });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Downloads the most recently generated redlined letter as a real .docx, with
// insertions shown underlined (green) and deletions struck through (red) —
// the traditional redline convention — so it can be opened, edited, and
// adapted directly in Word.
app.get('/analyze/redline-letter/:submissionId/docx', async (req, res) => {
    const submissionId = req.params.submissionId;
    try {
        const cached = await getCachedAnalysis(submissionId, 'redline_letter');
        if (!cached) {
            return res.status(404).json({ error: 'No redlined letter has been generated for this submission yet. Generate it in the "Total Letter with Redlines" tab first.' });
        }

        const { Document, Packer, Paragraph, TextRun } = require('docx');
        const html = cached.content.letterHtml || '';
        const paragraphChunks = html.match(/<p>[\s\S]*?<\/p>/g) || [`<p>${html}</p>`];
        const tokenRegex = /<ins>([\s\S]*?)<\/ins>|<del>([\s\S]*?)<\/del>|([^<]+)/g;

        const paragraphs = paragraphChunks.map(chunk => {
            const inner = chunk.replace(/^<p>/, '').replace(/<\/p>$/, '');
            const runs = [];
            let m;
            while ((m = tokenRegex.exec(inner)) !== null) {
                if (m[1] !== undefined) {
                    runs.push(new TextRun({ text: m[1], color: '1E7E34', underline: {} }));
                } else if (m[2] !== undefined) {
                    runs.push(new TextRun({ text: m[2], color: 'CC0000', strike: true }));
                } else if (m[3] !== undefined && m[3].trim()) {
                    runs.push(new TextRun({ text: m[3] }));
                }
            }
            return new Paragraph({ children: runs, spacing: { after: 200 } });
        });

        const doc = new Document({ sections: [{ children: paragraphs }] });
        const buffer = await Packer.toBuffer(doc);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${submissionId}-redlined-letter.docx"`);
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Bundles a case's ENTIRE history — every round's status/outcome/score,
// letter text, critique, and skill suggestion, plus every attached file —
// into one ZIP, so it can be shared with someone outside this system. A
// generated Word summary (using the same `docx` package as the redlined-
// letter download above) is the first thing in the ZIP; every row in
// submission_files is added after it, as-is, under attachments/. Streamed
// straight through — nothing is written to disk on this server.
app.get('/export/:submissionId/zip', async (req, res) => {
    const submissionId = req.params.submissionId;
    try {
        const subResult = await pool.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
        if (subResult.rows.length === 0) return res.status(404).json({ error: 'No submission found with that ID.' });
        const sub = subResult.rows[0];

        const [versions, files, suggestions, letters] = await Promise.all([
            pool.query('SELECT * FROM submission_versions WHERE submission_id = $1 ORDER BY version_number ASC', [submissionId]),
            pool.query('SELECT * FROM submission_files WHERE submission_id = $1 AND deleted_at IS NULL ORDER BY version_number ASC, uploaded_at ASC', [submissionId]),
            pool.query('SELECT * FROM skill_suggestions WHERE submission_id = $1 ORDER BY version_number ASC, source ASC', [submissionId]),
            pool.query('SELECT * FROM letter_feedback WHERE submission_id = $1 ORDER BY version_number ASC', [submissionId])
        ]);

        const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
        const paragraphs = [];
        const addHeading = (text, level) => paragraphs.push(new Paragraph({ text, heading: level, spacing: { before: 300, after: 150 } }));
        const addLine = (label, value) => {
            if (value === null || value === undefined || value === '') return;
            paragraphs.push(new Paragraph({
                children: [new TextRun({ text: label + ': ', bold: true }), new TextRun({ text: String(value) })],
                spacing: { after: 100 }
            }));
        };

        addHeading(`Case History — ${sub.customer_name}`, HeadingLevel.HEADING_1);
        addLine('Submission ID', sub.id);
        addLine('Case ID (utility reference)', sub.case_id);
        addLine('Auditor', sub.auditor_name);
        addLine('Utility', `${sub.utility_name} (${sub.utility_type})`);
        addLine('Account Number', sub.account_number);
        addLine('Issue Type', sub.issue_type);
        addLine('Current Status', sub.status);
        addLine('Requested Refund', sub.financial_impact_refund != null ? `$${sub.financial_impact_refund}` : null);
        addLine('Projected Future Savings', sub.financial_impact_future != null ? `$${sub.financial_impact_future}` : null);
        addLine('Exported', new Date().toLocaleString());

        versions.rows.forEach(v => {
            const letter = letters.rows.find(l => l.version_number === v.version_number);
            const roundSuggestions = suggestions.rows.filter(s => s.version_number === v.version_number);
            const roundFiles = files.rows.filter(f => f.version_number === v.version_number);

            addHeading(`Round ${v.version_number} — ${new Date(v.created_at).toLocaleDateString()}`, HeadingLevel.HEADING_2);
            addLine('Status', v.status);
            addLine('Outcome Reason', v.outcome_reason);
            addLine('Score', v.score != null ? `${v.score}/100` : 'not scored');
            addLine('Auditor Notes', v.auditor_notes);

            if (letter && letter.final_letter_text) {
                paragraphs.push(new Paragraph({ text: 'Final Letter as Submitted:', spacing: { before: 150, after: 80 } }));
                paragraphs.push(new Paragraph({ text: letter.final_letter_text.slice(0, 4000), spacing: { after: 150 } }));
            }
            if (letter && letter.critique) {
                paragraphs.push(new Paragraph({ text: 'Critique of This Draft:', spacing: { before: 100, after: 80 } }));
                paragraphs.push(new Paragraph({ text: letter.critique, spacing: { after: 150 } }));
            }
            roundSuggestions.forEach(s => {
                addLine(`Suggested Framework Addition (${s.source}, ${s.status})`, s.suggestion);
            });
            if (roundFiles.length) {
                addLine('Files attached this round', roundFiles.map(f => `${f.file_name} (${f.category})`).join('; '));
            }
        });

        const doc = new Document({ sections: [{ children: paragraphs }] });
        const docxBuffer = await Packer.toBuffer(doc);

        const archiver = require('archiver');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${submissionId}-case-history.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => {
            console.error(err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        });
        archive.pipe(res);

        archive.append(docxBuffer, { name: 'Case-Summary.docx' });
        files.rows.forEach(f => {
            const safeCategory = (f.category || 'other').replace(/[^a-z0-9_-]/gi, '_');
            archive.append(f.file_data, { name: `attachments/round-${f.version_number}-${safeCategory}/${f.id}-${f.file_name}` });
        });

        await archive.finalize();
    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Multer errors (file too large, too many files) land here rather than the
// generic error handlers above — give a clear message instead of a raw stack.
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
    next();
});

const PORT = process.env.PORT || 3000;
runMigrations()
    .then(() => ensureBootstrapAdmin())
    .then(() => {
        app.listen(PORT, () => console.log(`UtiliSave Issue Review API listening on port ${PORT}`));
    })
    .catch(err => {
        console.error('Could not start server — migrations never succeeded:', err);
        process.exit(1);
    });
