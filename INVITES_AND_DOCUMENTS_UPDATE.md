# Invites, email log & case documents — 2026-09-23

## What changed

| File | Change |
|---|---|
| `backend/server.js` | Email log (every send + the mail server's answer); plain-text part on every email; `POST /users/:id/resend-invite`; saved invite template (`GET/PUT /admin/invite-template`, `POST /admin/invite-preview`); `GET /admin/email-log`; `GET /submissions/:id/documents`; uploader recorded on every file; removing a file now hides it instead of destroying it; `document_added` / `document_removed` audit entries. Migrations run automatically on boot. |
| `management.html` | People panel: **Resend invite**, **Customize message…**, **Invite message** (saved default), **Email log**, per-person "last email" status. Cases: **Docs** column + **Documents & history** button. |
| `documents.html` | **New page.** Every document on a case, grouped by round, including removed ones, with who/when, plus a chronological document history. Admin only. |
| `auth.js` | **Invite link fix.** Invite, resend and reset emails now link to `…/?signin=<their email>`. That link always opens the sign-in screen for that person, with their email filled in. If the browser is signed in as someone else, that session is signed out first and the screen says so. If it is already signed in as that same person, it goes straight in. Ordinary links and the console's `?id=` deep links behave exactly as before. |

`index.html`, `repository.html`, `admin.html` are unchanged.

## Deploy

1. **API**: replace `backend/server.js` in the code Railway deploys from, then redeploy `issue-review-api`. No new variables and no new npm packages.
2. **Pages**: upload `auth.js`, `management.html` and the new `documents.html` to the root of the `issue-tester-phase1` GitHub repo, replacing the existing `auth.js` and `management.html`.
3. Hard refresh the console (Ctrl+F5).

## Verified locally (Postgres 16 + a real SMTP conversation + headless Chromium)

- Invite, custom invite, resend, refused recipient (550) → each logged with the server's reply; the People panel shows it.
- Resend refused for people who have already signed in (use Reset password) and for disabled accounts.
- Upload / appeal round / final letter / remove → documents page shows all four with uploader, and the removed file struck through.
- Auditor accounts get 403 on the documents page and 404 on removed files.
- Migration applied cleanly to a database created by the previous server.js.
- Invite link: opened in a browser already signed in as the admin → sign-in screen for the invitee, admin signed out, parameter removed from the address bar; temporary password → "Choose your password". Also tested with no session, a link for the signed-in account itself, a malformed parameter, and the console deep link.
- No JavaScript errors (the only console errors were the AI endpoints returning 503 because the test had no Anthropic key).

## Known limits

- The email log starts now. It cannot tell you what happened to invites sent before this update.
- "Accepted" means your mail server took the message. Whether it then lands in the inbox is decided after that point (spam filtering, quarantine), and the system cannot see it.
- A resend issues a new temporary password, because only a hash of the old one is stored. The earlier email's password stops working.
- Files attached before today show "uploader not recorded".
