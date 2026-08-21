# API-Football setup v1.0

## Purpose

JFW uses API-Football only from server-side/background code. The API key must never be committed to the repository or exposed to browser JavaScript.

## GitHub Actions setup

1. Open the repository on GitHub.
2. Go to **Settings** → **Secrets and variables** → **Actions**.
3. Choose **New repository secret**.
4. Use the exact secret name `API_FOOTBALL_KEY`.
5. Paste the API-Football key from the API-SPORTS dashboard and save it.

The workflow `.github/workflows/api-football-smoke.yml` reads this secret as an environment variable and never writes the value to repository files.

## Connection test

After the secret is configured:

1. Open **Actions**.
2. Select **API-Football Smoke Test**.
3. Choose **Run workflow**.

The smoke test performs one authenticated `/countries` request and reports only the connection result, result count, and rate-limit metadata. It does not print the API key.

## Local development

Copy `.env.example` to `.env` and place the key there:

```text
API_FOOTBALL_KEY=your-real-key
API_FOOTBALL_BASE_URL=https://v3.football.api-sports.io
```

`.env` and `.env.*` are ignored by Git. `.env.example` is intentionally committed with an empty key.

Node does not automatically load `.env` in the current foundation. For a one-off local test, export the variables in the shell before running:

```bash
export API_FOOTBALL_KEY='...'
node scripts/api-football/smoke-test.js
```

## Security rules

- Never put the real key in `data.json`, backfill JSON, HTML, browser JavaScript, documentation, issues, PR comments, or screenshots.
- Never append the key to a request URL. Authentication uses the `x-apisports-key` request header.
- Never log request headers containing the key.
- If a key is accidentally exposed, regenerate it in the API-SPORTS dashboard immediately.

## Next implementation step

Once the connection test succeeds, use the generic client in `scripts/api-football/client.js` to inventory API-Football endpoint/field coverage and map all returned data into the JFW Data Schema v2 superset model before enabling scheduled synchronization.
