# Team Access Control API

A backend REST API implementing **role-based access control (RBAC)** for teams, projects, and members — built with Node.js, Express, and MongoDB.

## Overview

This project models a real-world multi-tenant permission system, similar to how Notion, Slack, or GitHub organizations manage teams. A user can belong to multiple teams with a **different role in each**, and access to every action — viewing, creating, editing, deleting — is enforced against that role.

Paired React frontend: [team-access-control-frontend](https://github.com/Sandeepkg123/team-access-control-frontend)

## Tech Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js, Express 5 |
| Database | MongoDB (Mongoose ODM) |
| Auth | JWT access + refresh tokens, httpOnly cookies |
| Security | bcrypt hashing, express-validator, express-rate-limit |
| Dev | nodemon, dotenv |

## The Core Idea

Everything in this repo follows from **one decision**: roles do not live on `User` or `Team`. They live in a **join table**, `TeamMember`.

```
User       (name, email, hashed password, refreshToken)
Team       (name, ownerId ──► User)
TeamMember (userId ──► User, teamId ──► Team, role)   ← roles live ONLY here
Project    (title, description, teamId ──► Team, createdBy ──► User)
```

Because `TeamMember` is a many-to-many join, one person can be `owner` of Team A and a `member` of Team B simultaneously. A compound unique index prevents duplicate rows:

```js
teamMemberSchema.index({ userId: 1, teamId: 1 }, { unique: true });
```

`Team.ownerId` is a **denormalized shortcut** — a fast pointer to the current owner, kept in sync manually during ownership transfer.

## The Request Pipeline

This is the single most important pattern in the codebase. Every protected route composes small middleware that each do **one** job and attach data to `req` for the next layer:

```
request
  → authenticate        WHO is this?             sets req.user = { id }
  → validateObjectId    is this even a real ID?   prevents CastError 500s
  → requireTeamMember   are they on THIS team?    sets req.membership
  → requireRole         do they outrank it?       pure check, no DB hit
  → controller          do the work
```

### 1. `middleware/authenticate.js` — Authentication

Verifies the `Authorization: Bearer <token>` header against `JWT_ACCESS_SECRET` and sets `req.user = { id: decoded.userId }`. Answers *who are you*.

### 2. `middleware/requireTeamMember.js` — Membership

```js
const membership = await TeamMember.findOne({ teamId, userId });
if (!membership) return res.status(403).json({ error: "You are not a member of this team" });
req.membership = membership;
```

Note the **fresh database lookup on every request**. This is deliberate: when an admin demotes someone, the change takes effect on their very next request, with no waiting for a token to expire.

### 3. `middleware/requireRole.js` — Authorization

A middleware factory: `requireRole(["owner", "admin"])`. Reads `req.membership.role` — **zero DB queries**, because layer 2 already fetched it.

### 4. Where the pattern breaks: Ownership-based rules

Most permissions are expressible as a role list, but "edit project" is not — it depends on *which* project. So `PATCH /projects/:projectId` deliberately has **no** `requireRole`, and the check lives in the controller instead:

```js
// controllers/projectController.js
const isOwnerOrAdmin = ["owner", "admin"].includes(req.membership.role);
const isCreator = project.createdBy.toString() === req.user.id;
if (!isOwnerOrAdmin && !isCreator) {
  return res.status(403).json({ error: "You can only edit your own projects" });
}
```

## Permissions Matrix

| Action | Owner | Admin | Member |
| --- | :---: | :---: | :---: |
| View team / members / projects | ✅ | ✅ | ✅ |
| Create project | ✅ | ✅ | ✅ |
| Update team | ✅ | ✅ | ❌ |
| Add / remove member | ✅ | ✅ | ❌ |
| Delete project | ✅ | ✅ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ |
| Delete team | ✅ | ❌ | ❌ |
| Edit project | ✅ | ✅ | Own only |

## Authentication vs Authorization

The distinction the project is built around:

- **Authentication** = *who are you?* → short-lived JWT access token (15 min)
- **Authorization** = *what can you do?* → role read fresh from `TeamMember` on every request

| Token | Lifetime | Transport | Rationale |
| --- | --- | --- | --- |
| Access | 15 min | JSON response body | Sent on every request; short life limits damage if leaked |
| Refresh | 7 days | `httpOnly` cookie | Unreadable by JavaScript, so XSS cannot exfiltrate it |

**Login** verifies the bcrypt hash, mints both tokens, and stores the refresh token in *two* places (DB field + cookie).
**Refresh** verifies the cookie, then compares it against the DB copy — that comparison is what makes logout actually revoke a stolen token (you can't enumerate JWTs, but you can null the field).
**Logout** nulls the DB field and clears the cookie.

## API Routes

### Auth — `src/routes/authRoutes.js`

| Method | Path | Access |
| --- | --- | --- |
| POST | `/auth/signup` | public (validated input) |
| POST | `/auth/login` | public, **5 attempts / 15 min** |
| POST | `/auth/refresh` | refresh cookie |
| POST | `/auth/logout` | refresh cookie |

### Teams — `src/routes/teamRoutes.js`

| Method | Path | Required role |
| --- | --- | --- |
| POST | `/teams` | any authenticated user |
| GET | `/teams/my-teams` | any authenticated user |
| GET | `/teams/:teamId` | any member |
| DELETE | `/teams/:teamId` | owner |
| POST | `/teams/:teamId/members` | owner, admin |
| GET | `/teams/:teamId/members` | any member |
| DELETE | `/teams/:teamId/members/:userId` | owner, admin |
| PATCH | `/teams/:teamId/transfer-ownership` | owner |

### Projects — `src/routes/projectRoutes.js`

| Method | Path | Required role |
| --- | --- | --- |
| POST | `/teams/:teamId/projects` | any member |
| GET | `/teams/:teamId/projects` | any member |
| PATCH | `/teams/:teamId/projects/:projectId` | owner, admin, **or creator** |
| DELETE | `/teams/:teamId/projects/:projectId` | owner, admin |

`GET /health` is unauthenticated and returns a liveness timestamp.

Each route file is effectively the permission spec on one screen:

```js
router.delete("/:teamId",
  validateObjectId("teamId"),
  requireTeamMember,
  requireRole(["owner"]),
  deleteTeam);
```

## Project Structure

```
server.js                      entry: load env → connect DB → listen
src/
├── app.js                     express app, CORS (allowlist + credentials), route mounting
├── config/db.js               mongoose connect; exits on failure
├── models/                    User, Team, TeamMember, Project
├── middleware/                authenticate, requireTeamMember, requireRole,
│                              validateObjectId, validate, rateLimiter, errorHandler
├── validators/                express-validator chains
├── controllers/               authController, teamController, projectController
├── routes/                    authRoutes, teamRoutes, projectRoutes (nested)
└── utils/generateToken.js     access + refresh token factories
```

`projectRoutes` is mounted **inside** `teamRoutes` via `router.use("/:teamId/projects", projectRoutes)` with `mergeParams: true`, so project handlers can read `req.params.teamId` from the parent route.

## Setup

```bash
git clone https://github.com/Sandeepkg123/team-access-control-api.git
cd team-access-control-api
npm install
```

`.env`:

```env
PORT=5000
MONGO_URI=your_mongodb_atlas_uri
JWT_ACCESS_SECRET=your_access_secret
JWT_REFRESH_SECRET=your_refresh_secret
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d
NODE_ENV=development
```

```bash
npm run dev     # nodemon server.js
```

Server starts on `http://localhost:5000`. Confirm with `GET /health`.

> `config/db.js` pins DNS to `8.8.8.8` / `8.8.4.4` — a workaround for SRV-based Atlas URIs failing to resolve on some Windows networks.

## Try It Yourself

The fastest way to *feel* the permission system:

1. Sign up user A → create a team → A is automatically `owner`.
2. Sign up user B in a private/incognito window → log in.
3. As A: `POST /teams/:teamId/members` with B's email and `role: "member"`.
4. As B: `DELETE /teams/:teamId` → **403 "Insufficient permissions for this action"**, thrown by `requireRole`.

That single 403 is the entire project in one response.

## Security Fixes Applied

Issues found during a security review, each fixed with a failing-test-first
workflow and verified by reverting the fix to confirm the tests catch it.

1. **Cross-team project access (IDOR) — fixed.** `updateProject` and
   `deleteProject` loaded projects by `projectId` alone, never checking which
   team owned them. Owning any team was enough to edit or delete any project in
   the database. Both now query `Project.findOne({ _id, teamId })` and return
   404 rather than 403 so the response cannot confirm that an id exists
   elsewhere.
2. **Privilege escalation via `addMember` — fixed.** `role` came straight from
   the request body while the route only required owner or admin, so an admin
   could mint an owner for an account they controlled. Admins may now grant only
   `member`; owners may grant `admin` or `owner`.
3. **Orphaned projects on team deletion — fixed.** `deleteTeam` removed the team
   and its memberships but left every `Project` pointing at a team that no
   longer existed — unreachable over HTTP yet stored forever. All three deletes
   now run via `Promise.all`.
4. **Dead error handler / internals leaked in production — fixed.** Every
   controller caught its own errors and returned `err.message`, so
   `errorHandler` was unreachable and its production redaction never ran. All
   controllers now call `next(err)`; `errorHandler` maps duplicate-key,
   validation, and cast failures onto safe 4xx responses and redacts the rest.
5. **Unvalidated request bodies — fixed.** `addMember` and `transferOwnership`
   had no validators, so a missing email or a malformed `newOwnerUserId` reached
   Mongoose and surfaced as a 500. Both are now checked in
   `validators/memberValidators.js`.
6. **Refresh tokens did not rotate — fixed.** `refresh` issued a new access
   token but left the presented refresh token valid for its full 7 days, so a
   leaked one stayed usable indefinitely. Rotation now happens on every use.
   Refresh tokens also carry a `jti`, because without one two tokens minted in
   the same second were byte-identical.

### Still open

7. **Ownership transfer is not transactional** — three sequential writes
   (demote, promote, sync `Team.ownerId`) can leave inconsistent state if the
   process dies mid-way. Wrap in a MongoDB session.
8. **No email verification on signup** — which is what made issue 2 exploitable.
   An invite-only flow would remove the class of attack entirely.
9. **Route ordering is fragile.** `/my-teams` must stay declared before
   `/:teamId`. There is now a comment in `teamRoutes.js` warning about this.

## Testing

`test.js` contains 64 assertions covering the permission matrix, each security
fix above, and regression checks. It uses Node's built-in `fetch`, so there are
**no dependencies to install**.

```bash
npm run dev    # terminal 1
npm test       # terminal 2
```

It creates throwaway users with randomized emails, exercises the API, then
deletes everything it made — scoped by a per-run timestamp so real accounts are
never touched. Output is `PASS`/`FAIL` per check, and the exit code is non-zero
if anything fails, so it works in CI.

Every security check was confirmed to fail when its fix was reverted, so a green
run is meaningful rather than a test that always agrees.

> If you see `429 Too many login attempts`, restart `npm run dev` — the limiter
> allows 5 logins per 15 minutes and its counter is in-memory.

## Possible Next Steps

- Invite-by-email flow with expiry tokens
- Per-project permission overrides on top of the team role
- Audit log of membership and ownership changes
- Paginated member/project listing
- Integration tests covering the permissions matrix
- Rate limiting on signup and refresh, not just login

## License

MIT