# Still — accounts and sync

The Worker that holds everyone's record. One file, no build step, no libraries.
Everything below is done in the Cloudflare dashboard — nothing to install.

## What it does

Three people sign in, each keeps their own private history and settings, and a shared
table shows how much each of them has sat. The phone stays the source of truth: a sit
is written on the device first and pushed here afterwards, so sitting never depends on
a network, a server, or a valid session.

Every sit carries an id made on the phone, so sending the same one twice is a no-op
rather than a duplicate.

## Deploy, once

**1. Make the database**

Cloudflare dashboard → **Storage & Databases** → **D1** → **Create**. Call it `still`.

**2. Create the tables**

Open the new database → **Console**, paste the whole of [`schema.sql`](schema.sql), run it.
It is safe to run more than once. It also creates the three accounts.

**3. Create the Worker**

**Compute (Workers)** → **Create** → **Start from Hello World** → **Deploy**, then
**Edit code**. Replace everything with [`worker.js`](worker.js) and deploy.

**4. Connect the database to the Worker**

Worker → **Settings** → **Bindings** → **Add** → **D1 database**.
Variable name **`DB`** — exactly that — pointing at the `still` database.

**5. Add the two settings**

Still under **Settings** → **Variables and Secrets**:

| Name | Type | Value |
|---|---|---|
| `ALLOWED_ORIGINS` | Text | where the app is served from, e.g. `https://yourname.github.io` |
| `ADMIN_TOKEN` | Secret | a long random string you keep |

`ALLOWED_ORIGINS` takes a comma-separated list, so you can add
`http://localhost:8000` while testing. `*` allows anything — fine to start with, worth
narrowing once you know the address.

**6. Check it answers**

```
curl https://YOUR-WORKER.workers.dev/
```

`{"ok":true,"service":"still"}` means the Worker is up. Then check the database is
wired in — this should say the account has not been set up yet, not a 500:

```
curl -X POST https://YOUR-WORKER.workers.dev/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"adithya","password":"x"}'
```

## The three accounts

Nobody has a password yet. Each person signs in once with their **setup code** and
chooses their own password at that moment. The code stops working the instant it is used.

| Person | Username | Setup code |
|---|---|---|
| Adithya | `adithya` | `M5EK-BQWS` |
| Aishwaryya | `aishwaryya` | `PSWR-4CQV` |
| Sandhya | `sandhya` | `FXK7-GZF9` |

Give each person their own code, not the whole table. Adithya's account is the admin.

## When someone forgets their password

Two ways. In the **D1 console**, with a new code of your choosing:

```sql
UPDATE users SET pw_hash = NULL, setup_code = 'NEW-CODE1' WHERE username = 'sandhya';
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'sandhya');
```

Or with `ADMIN_TOKEN`, without opening the console:

```
curl -X POST https://YOUR-WORKER.workers.dev/admin/users \
  -H 'Authorization: Bearer YOUR-ADMIN-TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"username":"sandhya","name":"Sandhya","code":"NEW-CODE1","reset":true}'
```

Either way their history is untouched — only the password is cleared. They sign in
with the new code and pick a new password. The same call without `"reset":true`
creates a fourth person.

## Routes

| Route | Needs | Does |
|---|---|---|
| `GET /` | — | health check |
| `POST /auth/claim` | username, code, password | first sign-in, sets the password |
| `POST /auth/login` | username, password | returns a session token |
| `POST /auth/logout` | token | ends this session |
| `POST /auth/password` | token | change it; signs other devices out |
| `GET /me` | token | your settings and sits |
| `POST /sync` | token | push sits and settings, pull what is missing |
| `GET /leaderboard` | token | everyone's totals, no one's raw record |
| `POST /admin/users` | `ADMIN_TOKEN` | create or reset a person |

## How it is kept safe

- The password never leaves the device. The browser stretches it with 250,000 rounds of
  PBKDF2-SHA256 and sends only the result, which the Worker salts and stretches again
  before storing. Anyone who took the database would still have to pay those 250,000
  rounds per guess to get back to a password.
- The heavy work is on the device deliberately: Cloudflare's free plan allows a request
  10ms of CPU, and stretching a password properly costs far more than that. A Worker that
  tries is killed mid-hash, and returns a bare 500 with no explanation.
- A session token is 32 random bytes. Only its SHA-256 is stored, so the database
  never holds anything that could be used to sign in.
- Sessions last 400 days and renew as you use them. You stay signed in until you sign out.
- Eight wrong passwords locks that name for 15 minutes. A correct one clears the count.
- Every query is filtered by the signed-in person. The shared table returns totals only —
  never another person's individual sits.
- Replies carry `Cache-Control: no-store`, and the app's service worker is scoped to
  its own files, so no one's record is ever written to a shared cache on the device.

## Cost

Free, with a lot of room. Cloudflare's free tier allows 100,000 Worker requests and
5 million D1 row reads a day. Three people syncing after each sit use a few hundred
requests a day — around four orders of magnitude below the limit.
