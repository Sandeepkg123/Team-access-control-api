# Team Access Control API

A backend API implementing role-based access control (RBAC) for teams, projects, and members — built with Node.js, Express, and MongoDB.

## Overview

This project models a real-world multi-tenant permission system, similar to how tools like Notion, Slack, or GitHub organizations manage teams. A user can belong to multiple teams, with a different role in each. Access to every action — viewing, creating, editing, and deleting — is enforced based on that role.

## Tech Stack

- Runtime: Node.js, Express
- Database: MongoDB (Mongoose ODM)
- Auth: JWT (access + refresh tokens), httpOnly cookies
- Security: bcrypt password hashing, express-validator, express-rate-limit

## Core Concepts

- **Authentication vs Authorization** — JWT access tokens (short-lived; 15 minutes) identify who you are, while role checks look up fresh data from the database on every request to determine what you can do.
- **Many-to-many relationships** — a `TeamMember` join table connects `User` and `Team`, since one user can belong to many teams with different roles in each.
- **Layered middleware** — every protected route runs through `authenticate → requireTeamMember → requireRole`, composing small reusable checks instead of duplicating logic per route.
- **Ownership-based rules** — some actions (like editing a project) depend not only on role, but also on whether the user created that specific resource.

## Permissions Matrix

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Update team | ✅ | ✅ | ❌ |
| Delete team | ✅ | ❌ | ❌ |
| Add/remove member | ✅ | ✅ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ |
| Create project | ✅ | ✅ | ✅ |
| Edit project | ✅ | ✅ | Own only |
| Delete project | ✅ | ✅ | ❌ |
| View team/members/projects | ✅ | ✅ | ✅ |

## API Routes

### Auth

- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`

### Teams

- `POST /teams`
- `GET /teams/my-teams`
- `GET /teams/:teamId`
- `DELETE /teams/:teamId`
- `PATCH /teams/:teamId/transfer-ownership`

### Members

- `POST /teams/:teamId/members`
- `GET /teams/:teamId/members`
- `DELETE /teams/:teamId/members/:userId`

### Projects

- `POST /teams/:teamId/projects`
- `GET /teams/:teamId/projects`
- `PATCH /teams/:teamId/projects/:projectId`
- `DELETE /teams/:teamId/projects/:projectId`

## Setup

```bash
git clone https://github.com/Sandeepkg123/team-access-control-api.git
cd team-access-control-api
npm install
```

Create a `.env` file:

```env
PORT=5000
MONGO_URI=your_mongodb_atlas_uri
JWT_ACCESS_SECRET=your_access_secret
JWT_REFRESH_SECRET=your_refresh_secret
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d
NODE_ENV=development
```

Run it:

```bash
npm run dev
```

The server starts on `http://localhost:5000` — check `/health` to confirm it is running.

## Frontend

Paired with a React frontend: [team-access-control-frontend](https://github.com/Sandeepkg123/team-access-control-frontend)

## Notes

A few notes about this README:

- I left out a "Live Demo" section — add one once you deploy.
- I left out screenshots — you will want 2–3 from your actual running frontend, drop them in an `/screenshots` folder, and reference them with `![Dashboard](./screenshots/dashboard.png)`.
- The permissions matrix is genuinely your strongest selling point here — it shows design thinking, not just code.

