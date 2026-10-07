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
| Security | helmet, bcrypt hashing, express-validator, express-rate-limit |
| Dev | nodemon, dotenv |

## The Core Idea

Everything in this repo follows from **one decision**: roles do not live on `User` or `Team`. They live in a **join table**, `TeamMember`.

```
User          (name, email, hashed password, refreshToken, reset-token fields)
Team          (name, description, ownerId ──► User)
TeamMember    (userId ──► User, teamId ──► Team, role)      ← team roles live ONLY here
Project       (title, description, teamId ──► Team, createdBy ──► User)
ProjectMember (userId ──► User, projectId ──► Project, role) ← per-project overrides
AuditLog      (actorId, action, teamId, targetUserId, details)
```

Because `TeamMember` is a many-to-many join, one person can be `owner` of Team A and a `member` of Team B simultaneously. A compound unique index prevents duplicate rows:

```js
teamMemberSchema.index({ userId: 1, teamId: 1 }, { unique: true });
```

`Team.ownerId` is a **denormalized shortcut** — a fast pointer to the current owner, kept in sync manually during ownership transfer.

`ProjectMember` adds a second, *narrower* permission layer. The team role decides everything about a project by default, which leaves no way to hand someone edit rights on **one** project without promoting them team-wide. A `ProjectMember` row grants `editor` or `viewer` on that project only. See [Per-Project Overrides](#per-project-overrides).

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

### 4. Where the pattern breaks: Per-resource rules

Most permissions are expressible as a role list, but "edit project" is not — it depends on *which* project. So `PATCH /projects/:projectId` deliberately has **no** `requireRole`, and the check lives in the controller instead:

```js
// controllers/projectController.js → resolveProjectAccess()
const access = await resolveProjectAccess(project, req);
if (!access.canEdit) return res.status(403).json({ error: "..." });
```

`resolveProjectAccess()` is the one place that combines the team role with any per-project override:

```js
canEdit = ["owner", "admin"].includes(teamRole)
       || projectRole === "editor"
       || (teamRole === "member" && isCreator)
```

The same helper decides `canManageOverrides`, which is `owner | admin | editor` — a plain member or a viewer cannot hand out access.

## Permissions Matrix

| Action | Owner | Admin | Member |
| --- | :---: | :---: | :---: |
| View team / members / projects | ✅ | ✅ | ✅ |
| Create project | ✅ | ✅ | ✅ |
| Update team | ✅ | ✅ | ❌ |
| Add / remove member | ✅ | ✅ | ❌ |
| Change a member's role | ✅ | ❌ | ❌ |
| Delete project | ✅ | ✅ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ |
| Delete team | ✅ | ❌ | ❌ |
| Leave team | ✅ | ✅ | ✅ |
| Read audit log | ✅ | ✅ | ❌ |
| Edit project | ✅ | ✅ | Own only, **or** if granted `editor` |

An **owner cannot leave** a team — `POST /teams/:teamId/leave` returns 400 until ownership is transferred, since a team with no owner is permanently stuck (removing the owner is blocked, and both delete-team and transfer-ownership require one).

## Per-Project Overrides

By default the team role is the only thing that matters, which makes the system
coarse: a plain `member` can edit the projects they created and nothing else.
Handing someone edit rights on **one** project would otherwise mean promoting
them team-wide, granting far more than intended.

`ProjectMember` adds a narrower layer:

```
Team A
├── Project X  →  alice: editor,  bob: viewer
├── Project Y  →  (no overrides — team role applies as normal)
└── Project Z  →  carol: editor
```

Two rules govern it:

- **Grant-only.** A `ProjectMember` row can add access the team role would not
  grant, but never removes it. A `viewer` row therefore cannot lock an owner, an
  admin, or a project's own creator out of their work — the worst a bad override
  can do is grant access too widely, which is visible and fixable.
- **Editors may delegate.** `canManageOverrides` is `owner | admin | editor`, so
  `editor` means full control of the project rather than a content-only role.
  Plain members and viewers cannot hand out access.

`POST` **upserts**: re-granting the same user with a different role changes it
rather than colliding with the unique `{userId, projectId}` index as a 409.

Deleting a project or a team cascades its overrides. Team deletion collects the
project ids *before* deleting the projects — reversing that order leaves nothing
to filter on and strands the rows.

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

### Reuse detection

Rotation alone does not distinguish a stolen token from a stale one, so `refresh` treats a mismatch as evidence of theft:

```js
if (user.refreshToken !== token) {
  user.refreshToken = null;            // revoke EVERY session for this user
  await user.save();
  return res.status(403).json({ error: "Refresh token reuse detected — all sessions revoked" });
}
```

A token that passes signature and expiry verification but does **not** match the stored current token has already been rotated out. Presenting it again means someone else holds it, so the whole account is locked down and the user must log in again.

### Password reset

`POST /auth/forgot-password` mints a 32-byte random token, stores only its **SHA-256 hash** (so a database leak does not expose live reset links), and sets a 15-minute expiry. `POST /auth/reset-password` re-hashes the submitted token, matches it, clears both reset fields, and returns a generic error for unknown or expired tokens. The endpoint answers identically whether or not the email is registered, so it cannot be used to enumerate accounts.

## API Routes

### Auth — `src/routes/authRoutes.js`

| Method | Path | Access |
| --- | --- | --- |
| POST | `/auth/signup` | public, validated, **20 / hour** |
| POST | `/auth/login` | public, **5 attempts / 15 min** |
| POST | `/auth/refresh` | refresh cookie, **60 / 15 min** |
| POST | `/auth/logout` | refresh cookie |
| POST | `/auth/forgot-password` | public, **3 / hour** |
| POST | `/auth/reset-password` | public, validated |

### Users — `src/routes/userRoutes.js`

| Method | Path | Access |
| --- | --- | --- |
| GET | `/users/me` | any authenticated user |
| PATCH | `/users/me` | any authenticated user |

`PATCH` updates `name`, and/or `password` — the latter requires `currentPassword` to be supplied alongside it. Changing either does **not** invalidate the current access token.

### Teams — `src/routes/teamRoutes.js`

| Method | Path | Required role |
| --- | --- | --- |
| POST | `/teams` | any authenticated user |
| GET | `/teams/my-teams` | any authenticated user |
| GET | `/teams/:teamId` | any member |
| PATCH | `/teams/:teamId` | owner, admin |
| DELETE | `/teams/:teamId` | owner |
| POST | `/teams/:teamId/members` | owner, admin |
| GET | `/teams/:teamId/members` | any member |
| DELETE | `/teams/:teamId/members/:userId` | owner, admin |
| PATCH | `/teams/:teamId/members/:userId/role` | **owner** |
| PATCH | `/teams/:teamId/transfer-ownership` | owner |
| POST | `/teams/:teamId/leave` | any member (not the owner) |
| GET | `/teams/:teamId/audit-log` | owner, admin |

`GET /teams/my-teams` must stay declared **before** `/:teamId` — Express matches in declaration order, so moving it later would capture `my-teams` as a teamId.

### Projects — `src/routes/projectRoutes.js`

| Method | Path | Required role |
| --- | --- | --- |
| POST | `/teams/:teamId/projects` | any member |
| GET | `/teams/:teamId/projects` | any member |
| PATCH | `/teams/:teamId/projects/:projectId` | owner, admin, creator, **or `editor`** |
| DELETE | `/teams/:teamId/projects/:projectId` | owner, admin |

### Per-Project Overrides

| Method | Path | Required role |
| --- | --- | --- |
| GET | `/teams/:teamId/projects/:projectId/members` | any member |
| POST | `/teams/:teamId/projects/:projectId/members` | owner, admin, **or `editor`** |
| DELETE | `/teams/:teamId/projects/:projectId/members/:userId` | owner, admin, **or `editor`** |

`POST` takes `{ userId, role }` where role is `editor` or `viewer`, and **upserts** — re-granting with a different role changes it rather than colliding with the unique index. The target must already be a team member.

These three routes carry no `requireRole`. Who may manage access depends on the project, not just the team, which a team-role check cannot express — the controller resolves it.

`GET /health` is unauthenticated and returns a liveness timestamp.

Each route file is effectively the permission spec on one screen:

```js
router.delete("/:teamId",
  validateObjectId("teamId"),
  requireTeamMember,
  requireRole(["owner"]),
  writeLimiter,
  deleteTeam);
```

### Pagination

`GET` list routes accept `?page=` and `?limit=` and return pagination metadata alongside the items:

```json
{ "projects": [ ... ], "total": 25, "page": 1, "pages": 3 }
```

Defaults are `page=1`, `limit=20`; `limit` is capped at 100. Applies to team members, projects, and the audit log.

### Rate limiting

| Limiter | Budget | Applied to |
| --- | --- | --- |
| `loginLimiter` | 5 / 15 min | `POST /auth/login` |
| `signupLimiter` | 20 / hour | `POST /auth/signup` |
| `refreshLimiter` | 60 / 15 min | `POST /auth/refresh` |
| `forgotPasswordLimiter` | 3 / hour | `POST /auth/forgot-password` |
| `writeLimiter` | 30 / 15 min | every mutating team/project route |

All counters are in-memory, so they reset when the process restarts.

Behind a reverse proxy, set `TRUST_PROXY` — otherwise every request arrives from the proxy's own IP and one user exhausting a limit locks out everyone. It is opt-in because trusting `X-Forwarded-For` unconditionally lets any client spoof its IP and bypass the limiters.

## Project Structure

```
server.js                      entry: load env → connect DB → listen
test.js                        189 permission + security assertions
smoke.js                       39 endpoint checks across all routes
src/
├── app.js                     express app, helmet, CORS (allowlist + credentials), route mounting
├── config/
│   ├── db.js                  mongoose connect; exits on failure
│   └── env.js                 fails fast on missing/weak/duplicate JWT secrets
├── models/                    User, Team, TeamMember, Project, ProjectMember, AuditLog
├── middleware/                authenticate, requireTeamMember, requireRole,
│                              validateObjectId, validate, rateLimiter, errorHandler
├── validators/                express-validator chains (auth, member, user, project)
├── controllers/               authController, teamController, projectController, userController
├── routes/                    authRoutes, teamRoutes, userRoutes, projectRoutes (nested)
└── utils/generateToken.js     access + refresh token factories
```

`projectRoutes` is mounted **inside** `teamRoutes` via `router.use("/:teamId/projects", projectRoutes)` with `mergeParams: true`, so project handlers can read `req.params.teamId` from the parent route. `teamId` is validated at the mount point because the nested router only ever sees `:projectId` — a malformed teamId would otherwise reach `requireTeamMember` and surface as a 500.

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

# Only needed behind a reverse proxy — number of hops, or "true" for one.
# Leave blank on localhost.
TRUST_PROXY=
```

`config/env.js` refuses to boot if a required variable is missing, if either JWT secret is under 32 characters, or if both secrets are identical (which would let a stolen access token be replayed as a refresh token).

```bash
npm run dev     # nodemon server.js
```

Server starts on `http://localhost:5000`. Confirm with `GET /health`.

> `config/db.js` pins DNS to `8.8.8.8` / `8.8.4.4` — a workaround for SRV-based Atlas URIs failing to resolve on some Windows networks.

### npm scripts

| Script | Does |
| --- | --- |
| `npm run dev` | nodemon, restarts on change |
| `npm start` | plain `node server.js` |
| `npm test` | 189 permission + security assertions |
| `npm run smoke` | 39 endpoint checks across every route |
| `npm run verify` | both suites in sequence |

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
   elsewhere. The same both-id scoping guards the override routes.
2. **Privilege escalation via `addMember` — fixed.** `role` came straight from
   the request body while the route only required owner or admin, so an admin
   could mint an owner for an account they controlled. Admins may now grant only
   `member`, owners may grant `admin` or `member`, and `owner` is **rejected
   outright** — ownership moves only via `transfer-ownership`, which keeps
   `Team.ownerId` in sync. Granting it directly let a team accumulate extra
   owners, which `removeMember` then refused to clean up.
3. **Orphaned projects on team deletion — fixed.** `deleteTeam` removed the team
   and its memberships but left every `Project` pointing at a team that no
   longer existed — unreachable over HTTP yet stored forever. The cascade now
   runs inside a MongoDB transaction so it is all-or-nothing.
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
7. **Ownership transfer was not transactional — fixed.** Three sequential writes
   (demote, promote, sync `Team.ownerId`) could leave a team with no owner, or
   with `Team.ownerId` disagreeing with the membership table. All three now run
   in a MongoDB session.
8. **Replayed refresh tokens went undetected — fixed.** Rotation invalidates the
   old token but cannot tell a stolen one from a stale one. A valid-but-superseded
   token now revokes every session for that user.
9. **Writes were unlimited — fixed.** Only auth routes were rate limited, so an
   authenticated user could spam team and project creation without bound. All
   mutating routes now carry `writeLimiter`.
10. **Signup and refresh were unlimited — fixed.** Signup allowed automated
    account creation and email enumeration; refresh was a free verification
    oracle. Both are now bounded, as is forgot-password (an email-spam vector).
11. **Orphaned project overrides — fixed.** Deleting a project or its team left
    `ProjectMember` rows pointing at projects that no longer existed. Both
    cascades now collect ids first and delete the rows in the same transaction.

### Still open

12. **No email verification on signup** — which is what makes issue 2 possible in
    the first place. Every transactional email provider requires either a
    verified sending domain or a verified sender before delivering to third
    parties, so an invite-only flow is not currently buildable here.
13. **Route ordering is fragile.** `/my-teams` must stay declared before
    `/:teamId`. There is a comment in `teamRoutes.js` warning about this, but
    nothing enforces it — reordering the lines would break the route.
14. **Rate-limit counters are in-memory.** They reset on restart and are not
    shared across instances. A multi-instance deployment needs a shared store
    such as Redis.

## Testing

Two suites, both dependency-free — they use Node's built-in `fetch`.

```bash
npm run dev       # terminal 1
npm run verify    # terminal 2
```

| Suite | Checks | Question it answers |
| --- | --- | --- |
| `test.js` | 189 | Do the permission rules hold? |
| `smoke.js` | 39 across 27 endpoints | Does every route respond? |

They overlap on purpose. `test.js` asserts exact statuses for edge cases and 403
paths that should never succeed, so a broken import can hide behind a permission
check that never reached the handler. `smoke.js` walks every route on a happy
path, so a renamed route shows up immediately.

Both create throwaway users with randomized emails, exercise the API, then delete
everything they made — scoped by a per-run timestamp so real accounts are never
touched. Output is `PASS`/`FAIL` per check and the exit code is non-zero on
failure, so both work in CI.

Every security check was confirmed to fail when its fix was reverted, so a green
run is meaningful rather than a test that always agrees.

> If you see `429 Too many login attempts`, restart `npm run dev` — the limiter
> allows 5 logins per 15 minutes and its counter is in-memory.

> Both suites send `x-test-suite`, which the limiters skip. Without that
> exemption the suites would lock themselves out partway through a run.

## Possible Next Steps

- Email verification on signup, once a sending domain is available
- Shared rate-limit store (Redis) for multi-instance deployments
- Invite-by-email flow, same blocker as email verification
- Soft delete / archive for projects and teams
- Task or sub-resource under a project

## License

MIT