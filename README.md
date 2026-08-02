# Restaurant Attendance Backend (F09 → Hours → DA → Email/Drive)

Tested end-to-end locally: device push → parsed punches → daily hours →
rate-based amount due. See `server.log` behavior notes below for what to
expect on first real device connection.

## 1. What this does

- Receives punch pushes from the ZKTeco F09 over its ADMS/Push protocol
  (`/iclock/cdata`, `/iclock/getrequest`)
- Stores raw punches in SQLite
- Computes daily hours worked (earliest punch = in, latest = out) and flags
  anything that looks wrong (single punch, >14h shift, <1h shift) instead of
  silently trusting it
- Applies each employee's hourly or daily rate to produce an amount due
- Exposes `/api/report/daily` (JSON) and `/api/report/daily.csv` for n8n to
  pull and turn into an email + Drive upload

## 1a. Does the F09 actually support this?

Yes — confirmed against ZKTeco's own documentation for this model, not
inferred. What this system needs, and where the vendor documents it:

| Requirement | Evidence |
|---|---|
| Pushes punches to a self-hosted server | **ADMS** listed under Standard Functions (datasheet); **Cloud Server Settings** menu with Server Address / Port (manual §10.4) |
| Can act as an attendance device, not just a door controller | **Device Type: attendance terminal** (manual §11.5); attendance-specific settings in §11.2 |
| Attendance-flavoured push protocol | *"firmware has AC push and can convert to TA push"* (datasheet); Communication Protocol selector (manual §11.5) |
| Wireless | Wi-Fi 802.11 b/g/n/ax **2.4 GHz**, enabled by default (manual §10.3) |
| Enough storage for a restaurant | 3,000 users, **150,000 transactions**, 14-digit User IDs (datasheet) |

Manual §20 uses the very same Cloud Server Settings menu to attach the device
to ZKTeco's ZKBio CVSecurity software. **This server stands in where that
software would be** — it's the vendor's own integration path, not a workaround.

The one thing still unverified without the physical unit is the exact byte
layout of an ATTLOG line in TA push mode. That is what the format-agnostic
parser, the `raw_uploads` table, and `/api/debug/reparse` exist to absorb —
worst case is a parser tweak and a re-parse, not lost punches.

## 2. Setup

```bash
npm install
cp .env.example .env   # set API_KEY to something real
npm start
```

Runs on port 3000 by default (`PORT` env var to change it).

## 3. Add employees and rates

Open **`http://YOUR_SERVER/admin`** in a browser (works on a phone). Enter the
API key, then add each waiter and their rate. The page also shows a warning
banner listing any User IDs that have punched on the device but have no pay
rate yet — one click prefills the add form with that ID, which is the quickest
way to get everyone registered after the device goes live.

Rates are validated before saving: a blank name, a zero or negative rate, or a
zero minimum-hours value is rejected with a clear message rather than silently
producing a ₹0 payout.

There is no delete — untick **Active** instead. That keeps the person's punch
history and past reports intact while leaving them out of new ones.

The same thing over the API, if you prefer:

```bash
curl -X PUT http://YOUR_SERVER/api/employees/1 \
  -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Ramesh","rate_type":"daily","daily_rate":600,"daily_min_hours":6}'
```

`1` in the URL must match the **User ID you set on the F09 device itself**
(Menu > User Mgt. > New User > User ID) — this is the join key between the
device and your rate table. `rate_type` is either `"daily"` (flat rate if
`daily_min_hours` is met, else prorated) or `"hourly"`.

## 3a. Tests

```bash
npm test
```

Covers `parseAttLogLine()` — the ATTLOG parser, which is the only part of this
system written against ZKTeco's published protocol rather than the physical
device, and so the part most likely to need adjusting. 21 assertions across the
format variants it must accept and the lines it must refuse (a false punch
becomes a payout). Runs against an in-memory database, so it never touches
`attendance.db`.

If the real F09 sends something these don't cover, paste the raw line from
`GET /api/debug/raw?unparsed=1` into `test/parser.test.js` as a new case, make
it pass, then `POST /api/debug/reparse` to recover the dropped punches.

## 4. Configuring the F09 — do these in this order

**The order matters. Step 1 erases the device.** Doing it after enrolling
staff means enrolling every one of them a second time.

Section references below are to *F09 User Manual EN v1.0 (2024)*, kept in the
parent folder.

### 1. Device Type → attendance terminal (DO THIS FIRST)

**M/OK > System > Device Type Settings > Device Type** (manual §11.5).

The F09 is sold as an access control terminal and ships in that mode. It must
be switched to **attendance terminal**. The manual's own warning:

> After changing the device type, the device will delete all the data and
> restart, and some functions will be adjusted accordingly.

So: switch the type, let it wipe and reboot, *then* do everything else.

### 2. Communication Protocol → the TA/attendance push protocol

**M/OK > System > Device Type Settings > Communication Protocol** (manual §11.5).

The datasheet states the firmware "has AC push and can convert to TA push."
This server implements the **TA (time & attendance) push** flavour — the one
that uploads `table=ATTLOG`. Set it accordingly.

- If it is left on **AC push**, the device will connect and talk happily but
  send access-control events in a different layout. You'll see uploads land in
  `raw_uploads` with `parsed_count` of 0.
- **BEST protocol** is for ZKBio Zlink (manual §22) and must not be selected —
  the device would report to ZKTeco's cloud instead of to this server.

This is the most likely thing to be wrong on first connection. It is a menu
setting, not a code problem.

### 3. Set the device clock, and match the server timezone

The device sends wall-clock time with no timezone attached, and `calc.js`
decides which day a shift belongs to using the *server's* local time. The two
must agree.

The server prints its timezone on startup. If it says UTC, set
`TZ=Asia/Kolkata` in the systemd unit or `.env`.

### 4. Wi-Fi

**M/OK > COMM. > Wi-Fi Settings** (manual §10.3). Wi-Fi is on by default;
the radio is 2.4 GHz only, so if the restaurant router runs a combined
2.4/5 GHz SSID, make sure the 2.4 GHz band is enabled and reachable from
wherever the device is mounted.

### 5. Point it at this server

**M/OK > COMM. > Cloud Server Settings** (manual §10.4).

- Server Address: this server's IP (or domain, if *Enable Domain Name* is on)
- Server Port: `3000`, or whatever `PORT` is set to

This is the same menu the manual uses to attach the device to ZKTeco's own
ZKBio CVSecurity software (§20) — this server simply stands in for it.

### 6. Recommended: Duplicate Punch Period

**M/OK > System > Attendance** (manual §11.2, attendance-terminal version).

Discards repeat punches from the same person within N minutes. Setting it to
around **2 minutes** removes accidental double-taps at the device, rather than
leaving `calc.js` to flag them afterwards. Purely a quality-of-life setting.

If you enable **Alphanumeric User ID** on the same screen, that's fine — the
parser and the employees table both handle non-numeric IDs.

### 7. Enrol staff, using the same User IDs as the admin page

**M/OK > User Mgt. > New User.** The User ID here is the join key to a pay
rate. Enrol everyone, then open `/admin` and add each ID with their rate.

## 5. Day one — verifying it works

The ATTLOG parser does not assume fixed column positions. It finds the
timestamp with a regex and reads the PIN and status codes relative to it, so
it already handles tab- or space-separated lines, `/` or `.` date separators,
single-digit month/day/hour, a `T` separator, missing seconds, extra trailing
columns, and one extra column before the PIN. Every request is also stored
verbatim in `raw_uploads` before parsing, so nothing is lost even if a line
still isn't understood.

After completing section 4, punch once and work through this:

1. **Check the log.** You want `Received N line(s) ... parsed N punch(es)`.
   Anything the parser couldn't read is printed loudly as
   `!! UNPARSED ATTLOG LINE` followed by the exact raw bytes.
2. **Nothing in the log at all?** The device isn't reaching the server. Check
   the Wi-Fi logo on the device's home screen, then the Server Address/Port in
   §10.4, then that the server's firewall allows the device's IP. The device
   also has a built-in network test: **COMM. > Network Diagnosis** (§10.5).
3. **Lines arriving but `parsed 0`?** Almost certainly still on AC push —
   revisit step 2 of section 4. Confirm what actually arrived:
   ```bash
   curl -H "x-api-key: YOUR_KEY" "http://YOUR_SERVER/api/debug/raw?unparsed=1"
   ```
   The stored `body` is the real wire format. Nothing is lost either way — fix
   the mode (or the parser) and `POST /api/debug/reparse` recovers the punches.
4. **Punches parsed, but no report row?** A User ID mismatch, not the parser.
   The `/admin` page shows unregistered IDs in a banner, or:
   ```bash
   curl -H "x-api-key: YOUR_KEY" http://YOUR_SERVER/api/debug/unknown-users
   ```
   Any ID listed there punched but has no row in `employees`.

### Diagnostic endpoints (all require `x-api-key`)

| Endpoint | What it's for |
|---|---|
| `GET /api/debug/raw?limit=20` | Last N raw requests from the device, exactly as received |
| `GET /api/debug/raw?unparsed=1` | Only uploads containing a line the parser didn't understand |
| `GET /api/debug/punches?limit=20` | Last N successfully parsed punches |
| `GET /api/debug/unknown-users` | Punches whose User ID has no employee row |
| `POST /api/debug/reparse` | Re-runs the parser over all stored uploads |

`reparse` deliberately attempts every table that could carry attendance
records, not just `ATTLOG` — punches captured while the device was still in AC
push mode arrive under a different table name, and recovering those is the
whole point. Tables that are definitely something else (photos, templates,
operation logs) are skipped so their timestamps can't be misread as punches.
The response reports `recovered_by_table`; anything other than `ATTLOG` there
is worth a glance to confirm the times look sane.

`reparse` is the recovery path: if the firmware turns out to use a format the
parser can't read, fix `parseAttLogLine()` in `src/routes/adms.js`, restart,
then POST to `/api/debug/reparse` — the punches are recovered from the stored
raw bodies rather than lost. It's safe to run repeatedly (duplicate punches
are ignored) and reports any lines still unreadable, with samples.

## 5a. Known limitation — shifts crossing midnight

`calc.js` pairs the earliest and latest punch *within one calendar day*. A
waiter who clocks in at 6pm and out at 1am produces two days each holding a
single punch, so both get flagged `Only one punch recorded` rather than being
silently mispaid. If late shifts are normal at this restaurant, the day
boundary needs to move (e.g. a "business day" running 5am–5am) — say so and
it's a small change to `calc.js`.

## 6. Security note

The `/iclock/*` routes have no authentication — that's a protocol limitation,
the device can't send an API key. Don't expose this server's port 3000
directly to the whole internet without a firewall rule restricting it to
your device's IP (or put it behind a VPN/reverse proxy that only allows your
restaurant's network + your dealer's remote-support IP if needed). The
`/api/*` routes ARE protected by `x-api-key`, so at minimum only ADMS traffic
is exposed.

`/admin` serves the rate-management page without a key, but the page contains
no data — it asks for the key on load and every call it makes goes through the
protected `/api/*` routes. Still, put the whole server behind HTTPS before
using it over the internet: the key is sent in a header on each request, and
over plain HTTP that's readable in transit.

---

# Execution plan: punch → hours → email, and where n8n fits

## What n8n handles vs. what this backend handles

n8n is genuinely a good fit for the **scheduling + email + Drive** half of
this. It is NOT a good fit for the **device protocol + hours calculation**
half — that needs to run continuously and understand SQLite/date-boundary
logic that's easier to keep in real code you can test. So the split is:

- **This Node backend** (always-on): receives punches 24/7, computes hours,
  exposes a report API
- **n8n** (scheduled): once a day, calls the report API and handles
  email + Google Drive delivery

## The n8n workflow (5 nodes)

1. **Cron trigger** — e.g. every day at 8:00 AM, "yesterday's" report
2. **HTTP Request node** — `GET http://YOUR_SERVER/api/report/daily.csv?date={{ $today.minus(1,'day').format('yyyy-MM-dd') }}`
   with header `x-api-key: YOUR_KEY`
3. **Gmail node** — send the CSV as an attachment to yourself/your accountant,
   subject like "Attendance & DA — {{ date }}", body can include the JSON
   summary (total amount due, flagged count) pulled from the `/api/report/daily`
   JSON endpoint in a parallel HTTP Request node
4. **Google Drive node** — upload the same CSV to a dated folder
   (`Attendance Reports/2026/`)
5. *(Optional, later)* **IF node** checking `flagged_count > 0` → send a
   separate Slack/email alert so you review flagged shifts before any payout

This is genuinely a config job in n8n, not custom code — all four core nodes
(Cron, HTTP Request, Gmail, Google Drive) are built-in.

## Where should this actually run? VPS vs. free cloud vs. shared hosting

**Recommendation: a small VPS. Here's why, plainly:**

| Option | Verdict for this use case |
|---|---|
| **Free cloud tiers** (Render/Railway/Fly free plans) | **Not recommended.** Free tiers sleep after inactivity and wake on the next request — but your F09 pushes punches in real time throughout the day with no one "waking" the server first. A missed punch during a cold-start window is a missed DA calculation. Also, several free tiers use ephemeral filesystems, meaning your SQLite file (all your punch history) can vanish on redeploy. |
| **Shared hosting** (typical cPanel-style hosting) | **Not recommended.** Shared hosting is built for PHP/static sites, not a long-running Node process listening on a custom port 24/7. Most shared hosts don't allow arbitrary ports or persistent background processes at all. |
| **Small VPS** (Hostinger VPS, DigitalOcean, Linode — ~$4-6/mo) | **Recommended.** You already have a Hostinger relationship — their VPS plans run Node.js processes persistently, give you a real IP/port to point the F09 at, and SQLite persists on real disk. This is the standard way self-hosted ADMS servers are run in practice. |
| **n8n specifically** | Self-host n8n on the same VPS (Docker, one command) or use n8n Cloud's free/starter tier — either works, since n8n's job here is just a daily scheduled HTTP call, not a 24/7 listener. |

**Bottom line:** the Node backend needs to be always-on and reachable at a
fixed address because the F09 initiates the connection to it — that alone
rules out free/serverless tiers designed for on-demand traffic. A ~$5/month
VPS (your existing Hostinger account can likely do this) plus either
self-hosted or free-tier n8n is the realistic, low-cost setup that will
actually stay reliable for daily payroll data.
