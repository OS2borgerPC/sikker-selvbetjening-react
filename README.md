# Sikker Selvbetjening React

A full-stack starter for schema-driven JSON editing with GitHub-backed storage.

## Architecture

This project uses the exact 3-layer pattern:

1. Frontend (`frontend`)
- React + JSON Forms for editing schema-driven data.
- Users never need to edit raw JSON.

2. Backend (`backend`)
- Node.js + Express API endpoint at `POST /api/save`.
- Receives form data and commits it to GitHub via Octokit.
- Keeps `GITHUB_TOKEN` on the server only.

3. GitHub repository
- Stores JSON files and commit history.
- Works as the source of truth and version log.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure backend secrets:

```bash
cp backend/.env.example backend/.env
```

Set these required values in `backend/.env`:

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

Optional values:

- `GITHUB_BRANCH` (default: `main`)
- `PORT` (default: `3001`)
- `FRONTEND_ORIGIN` (default: `http://localhost:5173`)
- `GITHUB_SCHEMA_OWNER` (default: `OS2borgerPC`)
- `GITHUB_SCHEMA_REPO` (default: `sikker-selvbetjening`)
- `GITHUB_SCHEMA_BRANCH` (default: `main`)
- `GITHUB_SCHEMA_PATH` (default: `system_files/usr/share/sikker-selvbetjening/schemas`)

By default, schemas are fetched from:

- `https://github.com/OS2borgerPC/sikker-selvbetjening/tree/main/system_files/usr/share/sikker-selvbetjening/schemas`

3. Start frontend + backend:

```bash
npm run dev
```

4. Open:

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:3001/api/health`

## API Contract

`POST /api/save`

```json
{
  "path": "data/example.json",
  "content": {
    "title": "Example"
  },
  "message": "Update via form"
}
```

Notes:
- `path` must be repository-relative.
- Only `.json` files are allowed.
- Existing files are updated using the current file SHA.
- New files are created if they do not exist.

## Security

- Do not expose `GITHUB_TOKEN` in frontend code.
- Token is used only by the backend server.
- Use a fine-grained token with least-privilege repo permissions.
