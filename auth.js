/* ===========================================================================
   UtiliSave Issue Review System — shared sign-in gate
   ---------------------------------------------------------------------------
   Include this as the FIRST script in every page:

       <script src="auth.js"></script>                    <!-- any signed-in user -->
       <script src="auth.js" data-require="admin"></script>  <!-- admins only -->

   What it does:
     * hides the page until somebody is signed in, and shows a login screen
     * forces a password change on first sign-in (or after an admin reset)
     * attaches the session token to every call this page makes to the API
     * signs the user out the moment the API says the token is no longer good
     * puts a small "signed in as" chip in the corner with Sign out

   The token lives in localStorage. That is a deliberate trade-off, not an
   oversight: the pages are served from GitHub Pages and the API lives on
   Railway, so a cookie would be cross-site and blocked by default in most
   browsers. The consequence is that a cross-site-scripting hole in these pages
   would expose the token — which is why nothing here ever writes untrusted
   text into the DOM as HTML.
   =========================================================================== */
(function () {
    'use strict';

    // Must match the API used by every page in this app.
    var API = 'https://issue-review-api-production.up.railway.app';

    var REQUIRE_ROLE = (document.currentScript && document.currentScript.dataset.require) || null;
    var TOKEN_KEY = 'us_token';
    var realFetch = window.fetch.bind(window);

    var state = { token: null, user: null };

    // ?signin=<email> comes from the link in an invite or password-reset
    // email. It means "this link is for THAT person": always open on the
    // sign-in screen for that account, never on whatever session this browser
    // already holds (often the administrator who sent the invite). The
    // parameter is removed from the address bar straight away so a bookmark
    // or a refresh does not keep forcing the sign-in screen.
    var SIGNIN_FOR = null;
    try {
        var params = new URLSearchParams(location.search);
        var wanted = (params.get('signin') || '').trim().toLowerCase();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wanted)) SIGNIN_FOR = wanted;
        if (params.has('signin')) {
            params.delete('signin');
            var rest = params.toString();
            history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
        }
    } catch (e) { SIGNIN_FOR = null; }
    try { state.token = localStorage.getItem(TOKEN_KEY); } catch (e) { state.token = null; }

    // ---- public surface -----------------------------------------------------
    var US = window.US = {
        API: API,
        get token() { return state.token; },
        get user() { return state.user; },
        isAdmin: function () { return !!state.user && state.user.role === 'admin'; },
        signOut: signOut,
        // For plain <a href> downloads, which cannot carry an Authorization header.
        authedUrl: function (url) {
            if (!state.token) return url;
            return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(state.token);
        }
    };
    window.US_API = API;

    // ---- fetch wrapper ------------------------------------------------------
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf(API) !== 0) return realFetch(input, init);

        // Never fire an API call before there is a session — it would only
        // produce noise in the console and a wave of 401s on page load.
        if (!state.token) {
            return Promise.reject(new Error('Not signed in.'));
        }

        var opts = Object.assign({}, init || {});
        var headers = new Headers((init && init.headers) || {});
        headers.set('Authorization', 'Bearer ' + state.token);
        opts.headers = headers;

        return realFetch(input, opts).then(function (res) {
            if (res.status === 401) {
                clearToken();
                showLogin('Your session has ended. Sign in again.');
            } else if (res.status === 403) {
                // Clone so the caller still gets an unread body.
                res.clone().json().then(function (b) {
                    if (b && b.mustChangePassword) showChangePassword(true);
                }).catch(function () {});
            }
            return res;
        });
    };

    // ---- styles -------------------------------------------------------------
    var css = document.createElement('style');
    css.textContent = [
        '#us-gate{position:fixed;inset:0;z-index:99999;background:linear-gradient(135deg,#0A2342,#0B3E76);',
        '  display:flex;align-items:center;justify-content:center;padding:20px;',
        "  font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;}",
        '#us-card{background:#fff;border-radius:12px;padding:34px 34px 28px;width:100%;max-width:410px;',
        '  box-shadow:0 18px 50px rgba(0,0,0,.35);}',
        '#us-card h1{margin:0 0 4px;font-size:20px;color:#0B3E76;font-weight:600;letter-spacing:-.3px;}',
        '#us-card .us-sub{font-size:12.5px;color:#6b7785;margin-bottom:22px;line-height:1.5;}',
        '#us-card label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.5px;',
        '  color:#6b7785;margin:0 0 5px;}',
        '#us-card input{width:100%;box-sizing:border-box;font-family:inherit;font-size:14px;padding:10px 12px;',
        '  border:1px solid #d7dee7;border-radius:6px;margin-bottom:15px;color:#1a2129;background:#fff;}',
        '#us-card input:focus{outline:none;border-color:#0B3E76;box-shadow:0 0 0 3px rgba(11,62,118,.12);}',
        '#us-card button{width:100%;font-family:inherit;font-size:14px;font-weight:600;padding:11px;',
        '  background:#0B3E76;color:#fff;border:0;border-radius:6px;cursor:pointer;}',
        '#us-card button:hover{background:#0d4b8f;} #us-card button:disabled{opacity:.55;cursor:not-allowed;}',
        '#us-msg{font-size:12.5px;line-height:1.55;border-radius:6px;padding:10px 12px;margin-bottom:16px;display:none;}',
        '#us-msg.err{background:#fdecea;border:1px solid #f5c2bd;color:#7d211a;display:block;}',
        '#us-msg.info{background:#e8f1fb;border:1px solid #c3d8f0;color:#134a86;display:block;}',
        '#us-card .us-foot{font-size:11px;color:#9aa5b1;margin-top:18px;text-align:center;line-height:1.5;}',
        '#us-card .us-link{background:none;color:#0B3E76;font-weight:400;font-size:12px;padding:6px 0;width:auto;}',
        '#us-chip{position:fixed;right:14px;bottom:14px;z-index:9998;background:#fff;border:1px solid #e3e8ee;',
        '  border-radius:22px;padding:6px 8px 6px 14px;display:flex;align-items:center;gap:10px;',
        '  box-shadow:0 3px 14px rgba(10,35,66,.13);font-size:12px;',
        "  font-family:'Segoe UI',-apple-system,Helvetica,Arial,sans-serif;color:#1a2129;}",
        '#us-chip .us-role{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#6b7785;}',
        '#us-chip button{font-family:inherit;font-size:11.5px;border:1px solid #e3e8ee;background:#f7f9fc;',
        '  color:#0B3E76;border-radius:14px;padding:5px 11px;cursor:pointer;}',
        '#us-chip button:hover{background:#eef4fb;}',
        // The gate lives inside <body>, and the page-hiding rule below sets
        // visibility:hidden on <body> — which inherits. Without this the login
        // screen is present in the DOM but invisible, which looks exactly like
        // a blank white page.
        '#us-gate,#us-gate *{visibility:visible !important;}',
        '@media print{#us-chip{display:none;}}'
    ].join('');
    document.head.appendChild(css);

    // Keep the page itself out of sight until we know who is looking at it.
    var hider = document.createElement('style');
    hider.id = 'us-hider';
    hider.textContent = 'body{visibility:hidden !important;}';
    document.head.appendChild(hider);

    // ---- gate rendering -----------------------------------------------------
    var gate = null;

    function ensureGate() {
        if (gate) return gate;
        gate = document.createElement('div');
        gate.id = 'us-gate';
        gate.innerHTML = '<div id="us-card"></div>';
        (document.body || document.documentElement).appendChild(gate);
        return gate;
    }

    function el(id) { return document.getElementById(id); }

    function setMsg(kind, text) {
        var m = el('us-msg');
        if (!m) return;
        m.className = kind || '';
        m.textContent = text || '';
    }

    function showLogin(message, prefillEmail) {
        hidePage();
        ensureGate();
        gate.style.display = 'flex';
        el('us-card').innerHTML =
            '<h1>UtiliSave Issue Review</h1>' +
            '<div class="us-sub">Sign in to continue. Private and confidential work product.</div>' +
            '<div id="us-msg"></div>' +
            '<form id="us-form" autocomplete="on">' +
            '<label for="us-email">Email</label>' +
            '<input id="us-email" type="email" autocomplete="username" required>' +
            '<label for="us-pw">Password</label>' +
            '<input id="us-pw" type="password" autocomplete="current-password" required>' +
            '<button id="us-go" type="submit">Sign in</button>' +
            '</form>' +
            '<div class="us-foot">Forgot your password? Ask an administrator to reset it &mdash; you will get a new one by email.</div>';
        if (message) setMsg('info', message);
        el('us-form').addEventListener('submit', doLogin);
        if (prefillEmail) {
            el('us-email').value = prefillEmail;   // .value, never HTML
            el('us-pw').focus();
        } else {
            el('us-email').focus();
        }
    }

    function doLogin(e) {
        e.preventDefault();
        var email = el('us-email').value.trim();
        var pw = el('us-pw').value;
        var btn = el('us-go');
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        setMsg('', '');

        realFetch(API + '/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: pw })
        })
            .then(function (r) {
                return r.json().catch(function () {
                    throw new Error('The API answered HTTP ' + r.status + ' and not JSON. It is probably down or redeploying.');
                }).then(function (b) {
                    if (!r.ok || b.error) throw new Error(b.error || ('HTTP ' + r.status));
                    return b;
                });
            })
            .then(function (b) {
                state.token = b.token;
                state.user = b.user;
                try { localStorage.setItem(TOKEN_KEY, b.token); } catch (err) {}
                if (b.user.mustChangePassword) { showChangePassword(false); return; }
                admit();
            })
            .catch(function (err) {
                var m = err.message === 'Failed to fetch'
                    ? 'Cannot reach the API at ' + API + '. It is down, asleep, or this page is being opened as a local file instead of over https.'
                    : err.message;
                setMsg('err', m);
                btn.disabled = false;
                btn.textContent = 'Sign in';
                el('us-pw').value = '';
                el('us-pw').focus();
            });
    }

    function showChangePassword(interrupted) {
        hidePage();
        ensureGate();
        gate.style.display = 'flex';
        el('us-card').innerHTML =
            '<h1>Choose your password</h1>' +
            '<div class="us-sub">' +
            (interrupted ? 'Your password was reset by an administrator. ' : '') +
            'Set a password only you know. The temporary one stops working now. Minimum 10 characters.</div>' +
            '<div id="us-msg"></div>' +
            '<form id="us-form">' +
            '<label for="us-cur">Temporary password</label>' +
            '<input id="us-cur" type="password" autocomplete="current-password" required>' +
            '<label for="us-new">New password</label>' +
            '<input id="us-new" type="password" autocomplete="new-password" required>' +
            '<label for="us-new2">New password again</label>' +
            '<input id="us-new2" type="password" autocomplete="new-password" required>' +
            '<button id="us-go" type="submit">Save and continue</button>' +
            '</form>' +
            '<button class="us-link" id="us-back" type="button">Sign in as someone else</button>';

        el('us-form').addEventListener('submit', doChangePassword);
        el('us-back').addEventListener('click', function () { signOut(); });
        el('us-cur').focus();
    }

    function doChangePassword(e) {
        e.preventDefault();
        var cur = el('us-cur').value, a = el('us-new').value, b = el('us-new2').value;
        var btn = el('us-go');
        if (a !== b) { setMsg('err', 'The two new passwords do not match.'); return; }
        if (a.length < 10) { setMsg('err', 'Use at least 10 characters.'); return; }

        btn.disabled = true;
        btn.textContent = 'Saving…';
        setMsg('', '');

        realFetch(API + '/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
            body: JSON.stringify({ currentPassword: cur, newPassword: a })
        })
            .then(function (r) { return r.json().then(function (x) { if (!r.ok || x.error) throw new Error(x.error || ('HTTP ' + r.status)); return x; }); })
            .then(function () { return loadMe(); })
            .then(function () { admit(); })
            .catch(function (err) {
                setMsg('err', err.message);
                btn.disabled = false;
                btn.textContent = 'Save and continue';
            });
    }

    function showDenied() {
        hidePage();
        ensureGate();
        gate.style.display = 'flex';
        el('us-card').innerHTML =
            '<h1>Not your page</h1>' +
            '<div class="us-sub">This page is for administrators. You are signed in as <strong></strong>, ' +
            'which is an auditor account. Use the submission form instead, or ask for administrator access.</div>' +
            '<button id="us-go" type="button">Go to the submission form</button>' +
            '<button class="us-link" id="us-back" type="button">Sign out</button>';
        el('us-card').querySelector('strong').textContent = state.user ? state.user.email : '';
        el('us-go').addEventListener('click', function () { location.href = 'index.html'; });
        el('us-back').addEventListener('click', function () { signOut(); });
    }

    // ---- session helpers ----------------------------------------------------
    function loadMe() {
        return realFetch(API + '/auth/me', { headers: { 'Authorization': 'Bearer ' + state.token } })
            .then(function (r) {
                if (r.status === 401) { clearToken(); throw new Error('expired'); }
                return r.json();
            })
            .then(function (b) {
                if (b.error) throw new Error(b.error);
                state.user = b.user;
                return b.user;
            });
    }

    function clearToken() {
        state.token = null;
        state.user = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    }

    function signOut() {
        var t = state.token;
        clearToken();
        var chip = el('us-chip');
        if (chip) chip.remove();
        if (t) {
            realFetch(API + '/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } })
                .catch(function () {})
                .then(function () { showLogin('You are signed out.'); });
        } else {
            showLogin('You are signed out.');
        }
    }

    function hidePage() {
        if (!document.getElementById('us-hider')) document.head.appendChild(hider);
    }

    function showPage() {
        var h = document.getElementById('us-hider');
        if (h) h.remove();
    }

    function renderChip() {
        if (el('us-chip')) el('us-chip').remove();
        var chip = document.createElement('div');
        chip.id = 'us-chip';
        var who = document.createElement('div');
        var name = document.createElement('div');
        name.textContent = state.user.fullName || state.user.email;
        var role = document.createElement('div');
        role.className = 'us-role';
        role.textContent = state.user.role === 'admin' ? 'Administrator' : 'Auditor';
        who.appendChild(name);
        who.appendChild(role);

        var pw = document.createElement('button');
        pw.type = 'button';
        pw.textContent = 'Password';
        pw.addEventListener('click', function () { showChangePassword(false); });

        var out = document.createElement('button');
        out.type = 'button';
        out.textContent = 'Sign out';
        out.addEventListener('click', signOut);

        chip.appendChild(who);
        chip.appendChild(pw);
        chip.appendChild(out);
        document.body.appendChild(chip);
    }

    // Everything is in order — reveal the page and let it load its data.
    function admit() {
        if (REQUIRE_ROLE === 'admin' && !US.isAdmin()) { showDenied(); return; }
        if (gate) gate.style.display = 'none';
        showPage();
        renderChip();
        document.dispatchEvent(new CustomEvent('us-auth-ready', { detail: { user: state.user } }));
    }

    // ---- boot ---------------------------------------------------------------
    var INVITE_MSG = 'Enter the temporary password from your email. You will then choose your own password.';

    // Signs out whoever this browser is signed in as, then shows the sign-in
    // screen for the account the email link was sent to.
    function signInAsInvitee(previousEmail) {
        var t = state.token;
        clearToken();
        var chip = el('us-chip');
        if (chip) chip.remove();
        var msg = previousEmail
            ? 'This link is for ' + SIGNIN_FOR + '. ' + previousEmail + ' has been signed out on this browser. ' + INVITE_MSG
            : INVITE_MSG;
        if (t) {
            realFetch(API + '/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } })
                .catch(function () {})
                .then(function () { showLogin(msg, SIGNIN_FOR); });
        } else {
            showLogin(msg, SIGNIN_FOR);
        }
    }

    function boot() {
        if (SIGNIN_FOR) {
            if (!state.token) { showLogin(INVITE_MSG, SIGNIN_FOR); return; }
            // Already signed in: continue only if it is the very account the
            // link was sent to; otherwise sign that session out first.
            loadMe()
                .then(function (user) {
                    if (String(user.email || '').toLowerCase() !== SIGNIN_FOR) { signInAsInvitee(user.email); return; }
                    if (user.mustChangePassword) { showChangePassword(false); return; }
                    admit();
                })
                .catch(function () { clearToken(); showLogin(INVITE_MSG, SIGNIN_FOR); });
            return;
        }
        if (!state.token) { showLogin(); return; }
        loadMe()
            .then(function (user) {
                if (user.mustChangePassword) { showChangePassword(false); return; }
                admit();
            })
            .catch(function (err) {
                if (err.message === 'expired') { showLogin('Your session has ended. Sign in again.'); return; }
                clearToken();
                showLogin('Could not verify your session: ' + err.message);
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
