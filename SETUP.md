# Quick Setup Guide

Get the F09 attendance system running in 10 minutes.

## 1. Install & Start

```bash
npm install
cp .env.example .env
```

Edit `.env` and set a real API key:
```
API_KEY=your-strong-key-here
```

Then start:
```bash
npm start
```

Server runs on `http://localhost:3000`.

## 2. Before Monday — Configure the Device

**DO THESE IN ORDER** (step 1 wipes the device if staff are enrolled):

1. **M/OK > System > Device Type Settings > Device Type** → `attendance terminal`
2. **M/OK > System > Device Type Settings > Communication Protocol** → `TA Push`
3. **M/OK > System > Attendance** → set Duplicate Punch Period to ~2 min (optional but nice)
4. **M/OK > COMM. > Wi-Fi Settings** → connect to your restaurant WiFi
5. **M/OK > COMM. > Cloud Server Settings**:
   - Server Address: your server's IP (e.g. `192.168.1.50`) or domain
   - Server Port: `3000`

## 3. Add Staff & Pay Rates

Open `http://YOUR_SERVER:3000/admin` in a browser.

Enter the API key from `.env`, then:
- Click **Add employee**
- Device User ID: the number you assigned to this person on the F09 (Menu > User Mgt. > New User)
- Name: their name
- Rate type: daily or hourly
- Fill in their rate and save

Repeat for each waiter.

## 4. Test It Works

- Have someone punch on the F09 (face or fingerprint)
- Check `http://YOUR_SERVER:3000/api/report/daily?date=TODAY -H "x-api-key: YOUR_KEY"`
  - Should show the punch, hours worked, and amount due

If nothing shows up:
- `http://YOUR_SERVER:3000/api/debug/raw?limit=5 -H "x-api-key: YOUR_KEY"` — did the device upload anything?
- `http://YOUR_SERVER:3000/api/debug/unknown-users -H "x-api-key: YOUR_KEY"` — did the punch come through but have no matching employee?

## 5. Next: Deploy to VPS & Wire Up n8n

Once live data is flowing, move to a VPS (don't run `npm start` on your laptop forever) and set up n8n to email the daily report.

See README.md for the full reference.

## Troubleshooting

| Problem | Check |
|---|---|
| Server won't start | Node.js installed? `node -v` should show v20+ |
| Device won't connect | WiFi on? Server address/port correct? Try `Menu > COMM. > Network Diagnosis` on the device |
| Punches arrive but don't show in reports | Go to `/admin`, scroll down — unregistered User IDs show in a warning banner |
| `npm start` fails on `better-sqlite3` | Try `npm rebuild` or reinstall: `rm -rf node_modules && npm install` |
