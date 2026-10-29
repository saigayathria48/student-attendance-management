# Student Attendance Management System

A single-instance attendance application with an Express API, a vanilla JavaScript interface and a persistent SQLite database. It supports administrator and faculty accounts, class and student management, attendance entry and monthly reports. The Docker configuration runs the application as a non-root user and stores its database in a named volume.

## Prerequisites

Use Node.js 22.23.2 for local development. For containers, install Docker Desktop or a compatible Docker engine with Docker Compose. Run the following commands from the project directory. The application does not automatically load `.env`; `.env.example` documents environment variables without storing credentials.

## Run with Docker Compose

```powershell
docker compose build
docker compose up -d
```

The application listens on `http://localhost:3000`. To choose another host port, set `$env:HOST_PORT = '3100'` before `docker compose up -d`. The `attendance-data` volume persists the database. The initial database has no administrator; create one once using an isolated shell:

```powershell
$env:ADMIN_USERNAME = Read-Host 'Initial admin username'
$secret = Read-Host 'Initial admin password (at least 12 characters)' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
try {
  docker compose exec -e ADMIN_USERNAME -e ADMIN_PASSWORD attendance node scripts/seed.js
} finally {
  Remove-Item Env:ADMIN_USERNAME, Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Variable secret -ErrorAction SilentlyContinue
}
```

Seed creates an administrator only if none exists; it does not reset an existing password. For a fresh demonstration database, set `$env:SEED_DEMO = 'true'` and add `-e SEED_DEMO` to the command, then remove that environment variable. Seeded students are synthetic. Keep credentials in a secure password manager or secret store, not in source, Git, image layers, logs or screenshots.

`docker compose down` stops the application; the named volume remains. Deleting the volume deletes its database, so back it up first when it contains data. This setup uses one SQLite writer and is intended for a single-instance demonstration. Use HTTPS and appropriate access controls before exposing it beyond a trusted local network.

## Local development and tests

```powershell
npm ci
npm test
npm run test:selenium
```

Selenium requires Chrome and a compatible ChromeDriver. `npm start` launches the application locally; `DB_PATH` defaults to `data/attendance.sqlite`. Use `npm run seed` with the environment variables above to bootstrap a separate local database. The container and local databases are independent. See [the API](docs/API.md), [architecture](docs/architecture.md), [attendance policy](docs/attendance-policy.md) and [demonstration walkthrough](docs/demo.md).

`Jenkinsfile` describes a parameterized pipeline for an isolated Kubernetes test environment. Configure your own registry image, Jenkins credentials, test credentials, cluster context and namespace before running it. The manifests under `k8s/` require suitable persistent storage and a separately created bootstrap Secret. Prior runs are not evidence of a new deployment.

## Source provenance

This publishable snapshot is based on the existing local project at commit `8d88af5d0999b260f6229bb7c642e24e04fe4bbe`. The original repository retains its complete history and attribution, including commits by Pranitha Bandiga and the recorded orchestrator identities. This snapshot excludes prior deployment reports and evidence; it does not claim that its tests or deployment have been freshly verified.
