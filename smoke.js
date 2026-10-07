#!/usr/bin/env node
/**
 * Endpoint smoke test for team-access-control-api.
 *
 * Where test.js asks "does this permission rule hold?", this asks "does every
 * route respond at all?". It walks all 28 endpoints in dependency order, reusing
 * ids as it goes, and prints one line per route.
 *
 * The two suites overlap on purpose. test.js is the deep one — it asserts exact
 * status codes for edge cases and 403 paths that should never succeed. This one
 * is the shallow one: a single happy path per endpoint, so a renamed route or a
 * broken import shows up here immediately instead of hiding behind a permission
 * assertion that never reached the handler.
 *
 * Zero dependencies — Node 22 has fetch built in.
 *
 * USAGE:
 *   1. Terminal 1:  npm run dev
 *   2. Terminal 2:  npm run smoke
 *
 * Override the target with:  BASE_URL=http://host:port npm run smoke
 */

const BASE = process.env.BASE_URL || "http://localhost:5000";

// The write limiter caps at 30 requests / 15 min, and this suite fires well over
// 30 writes (signup, team create, several project and member calls). Without the
// exemption header the suite would lock itself out halfway through and every
// later endpoint would report a misleading 429.
const SUITE = { "x-test-suite": "team-access-control-api" };
const stamp = Date.now();
const rand = Math.random().toString(36).slice(2, 8);

// Distinct from test.js's stamp so the two suites can run back to back without
// colliding on the unique User.email index.
const email = (who) => `${who}+smoke${stamp}${rand}@test.com`;
const PASSWORD = "SmokeTest123!";

// ---------------------------------------------------------------- harness

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
  console.log("-".repeat(74));
}

// Records one endpoint result. `expect` is the status the route should return on
// the happy path; `note` surfaces a short confirmation that the body was real and
// not just a 200 on an empty object.
function record(method, path, status, expected, note) {
  // Guard against a call site forgetting the path argument. Without this the
  // signature shifts, `path` arrives as a number, and the run dies on
  // path.padEnd with a TypeError that says nothing about which call is wrong.
  if (typeof path !== "string") {
    throw new Error(
      `record() called with a non-string path — check the call for ${method}. ` +
        `Expected (method, path, status, expected, note) but got path=${JSON.stringify(path)}.`
    );
  }

  const ok = status === expected;
  results.push({ group: currentGroup, method, path, status, expected, ok, note });

  const mark = ok ? "PASS" : "FAIL";
  const detail = note ? `  ${note}` : "";
  console.log(`  ${mark}  ${method.padEnd(6)} ${path.padEnd(52)} ${status}${detail}`);

  return ok;
}

async function api(method, path, { token, body, cookie } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Cookie is set by hand so we can replay a specific refresh token rather than
  // whatever the runtime happens to have stored.
  if (cookie) headers.Cookie = cookie;
  Object.assign(headers, SUITE);

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = {};
  try {
    json = await res.json();
  } catch {
    // A route with no body (logout, delete) legitimately returns nothing.
  }

  const setCookie = res.headers.get("set-cookie") || "";
  const refresh = /refreshToken=([^;]+)/.exec(setCookie)?.[1] ?? null;

  return { status: res.status, json, refresh };
}

// Reads the refresh token out of a login response so the rotation endpoints can
// be exercised without a cookie jar.
async function login(addr, password = PASSWORD) {
  const r = await api("POST", "/auth/login", { body: { email: addr, password } });
  return { token: r.json.accessToken, refresh: r.refresh, status: r.status };
}

// Shared Mongoose handle, used only for teardown. There is no DELETE /auth/users
// endpoint, so the throwaway accounts have to be removed through the database.
let _db = null;
async function connectDb() {
  if (_db) return _db;
  require("dns").setServers(["8.8.8.8", "8.8.4.4"]); // Atlas SRV fails on some Windows resolvers
  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const [Team, TeamMember, Project, User, AuditLog, ProjectMember] = await Promise.all([
    require("./src/models/Team"),
    require("./src/models/TeamMember"),
    require("./src/models/Project"),
    require("./src/models/User"),
    require("./src/models/AuditLog"),
    require("./src/models/ProjectMember"),
  ]);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  _db = { mongoose, Team, TeamMember, Project, User, AuditLog, ProjectMember };
  return _db;
}

// ------------------------------------------------------------------- run

async function main() {
  console.log(`\n Smoke-testing ${BASE}\n`);

  try {
    const h = await api("GET", "/health");
    if (h.status !== 200) throw new Error(`status ${h.status}`);
  } catch {
    console.error(`\n  Cannot reach the server at ${BASE}`);
    console.error("  Start it in another terminal:  npm run dev\n");
    process.exit(1);
  }

  // ---------------------------------------------------------------- auth
  group("Auth");

  const alice = { name: "Alice", email: email("alice"), password: PASSWORD };
  const bob = { name: "Bob", email: email("bob"), password: PASSWORD };
  const carol = { name: "Carol", email: email("carol"), password: PASSWORD };
  const dave = { name: "Dave", email: email("dave"), password: PASSWORD };

  const sa = await api("POST", "/auth/signup", { body: alice });
  record("POST", "/auth/signup", sa.status, 201, `alice userId ${String(sa.json.userId).slice(-6)}`);
  alice.userId = sa.json.userId;

  const sb = await api("POST", "/auth/signup", { body: bob });
  record("POST", "/auth/signup", sb.status, 201);
  bob.userId = sb.json.userId;

  const sc = await api("POST", "/auth/signup", { body: carol });
  record("POST", "/auth/signup", sc.status, 201);
  carol.userId = sc.json.userId;

  const sd = await api("POST", "/auth/signup", { body: dave });
  record("POST", "/auth/signup", sd.status, 201);
  dave.userId = sd.json.userId;

  const la = await login(alice.email);
  record("POST", "/auth/login", la.status, 200, "access + refresh issued");
  const lb = await login(bob.email);
  record("POST", "/auth/login", lb.status, 200);

  const forgot = await api("POST", "/auth/forgot-password", { body: { email: alice.email } });
  record("POST", "/auth/forgot-password", forgot.status, 200, "no enumeration");

  // reset-password can only be exercised outside production: the raw token is
  // deliberately not returned when NODE_ENV=production, so there is nothing to
  // submit. Report the skip instead of a false pass.
  if (forgot.json.devToken) {
    const reset = await api("POST", "/auth/reset-password", {
      body: { token: forgot.json.devToken, newPassword: "ResetPass456!" },
    });
    record("POST", "/auth/reset-password", reset.status, 200);

    const relogin = await login(alice.email, "ResetPass456!");
    record("POST", "/auth/login (reset pw)", relogin.status, 200, "new password works");
    alice.password = "ResetPass456!";
    la.token = relogin.token;
    la.refresh = relogin.refresh;
  } else {
    console.log("  SKIP  POST   /auth/reset-password                            no devToken in production");
  }

  const rot = await api("POST", "/auth/refresh", { cookie: `refreshToken=${la.refresh}` });
  record("POST", "/auth/refresh", rot.status, 200, "token rotated");

  const lo = await api("POST", "/auth/logout", { cookie: `refreshToken=${rot.refresh}` });
  record("POST", "/auth/logout", lo.status, 200);

  const afterLogout = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${rot.refresh}`,
  });
  record("POST", "/auth/refresh (post-logout)", afterLogout.status, 403, "revoked");

  // --------------------------------------------------------------- users
  group("Users");

  const me = await api("GET", "/users/me", { token: la.token });
  record("GET", "/users/me", me.status, 200, `${me.json.user?.email}`);

  const mePatch = await api("PATCH", "/users/me", {
    token: la.token,
    body: { name: "Alice Renamed" },
  });
  record("PATCH", "/users/me", mePatch.status, 200, mePatch.json.user?.name);
  const mePw = await api("PATCH", "/users/me", {
    token: la.token,
    body: { currentPassword: alice.password, password: PASSWORD },
  });
  record("PATCH", "/users/me (password)", mePw.status, 200);

  // --------------------------------------------------------------- teams
  group("Teams");

  const team = await api("POST", "/teams", { token: la.token, body: { name: "Smoke Team" } });
  record("POST", "/teams", team.status, 201, `team ${String(team.json.team?._id).slice(-6)}`);
  const teamId = team.json.team?._id;

  const mine = await api("GET", "/teams/my-teams", { token: la.token });
  record("GET", "/teams/my-teams", mine.status, 200, `${mine.json.teams?.length} team(s)`);

  const getTeam = await api("GET", `/teams/${teamId}`, { token: la.token });
  record("GET", "/teams/:teamId", getTeam.status, 200, `role ${getTeam.json.role}`);

  const patchTeam = await api("PATCH", `/teams/${teamId}`, {
    token: la.token,
    body: { name: "Smoke Team Renamed", description: "updated by smoke" },
  });
  record("PATCH", "/teams/:teamId", patchTeam.status, 200, patchTeam.json.team?.name);

  const addBob = await api("POST", `/teams/${teamId}/members`, {
    token: la.token,
    body: { email: bob.email, role: "member" },
  });
  record("POST", "/teams/:teamId/members", addBob.status, 201, "bob joined");

  const addCarol = await api("POST", `/teams/${teamId}/members`, {
    token: la.token,
    body: { email: carol.email, role: "member" },
  });
  record("POST", "/teams/:teamId/members", addCarol.status, 201, "carol joined");

  const addDave = await api("POST", `/teams/${teamId}/members`, {
    token: la.token,
    body: { email: dave.email, role: "member" },
  });
  record("POST", "/teams/:teamId/members", addDave.status, 201, "dave joined");

  const listMembers = await api("GET", `/teams/${teamId}/members`, { token: la.token });
  record(
    "GET",
    "/teams/:teamId/members",
    listMembers.status,
    200,
    `total ${listMembers.json.total}, pages ${listMembers.json.pages}`
  );

  const promote = await api("PATCH", `/teams/${teamId}/members/${carol.userId}/role`, {
    token: la.token,
    body: { role: "admin" },
  });
  record("PATCH", "/teams/:teamId/members/:userId/role", promote.status, 200, "carol -> admin");

  // ------------------------------------------------------------ projects
  group("Projects");

  const proj = await api("POST", `/teams/${teamId}/projects`, {
    token: la.token,
    body: { title: "Smoke Project", description: "created by smoke" },
  });
  record("POST", "/teams/:teamId/projects", proj.status, 201, "project created");
  const projectId = proj.json.project?._id;

  const listProjects = await api("GET", `/teams/${teamId}/projects`, { token: la.token });
  record(
    "GET",
    "/teams/:teamId/projects",
    listProjects.status,
    200,
    `total ${listProjects.json.total}, pages ${listProjects.json.pages}`
  );

  const editProject = await api("PATCH", `/teams/${teamId}/projects/${projectId}`, {
    token: la.token,
    body: { title: "Smoke Project Edited" },
  });
  record("PATCH", "/teams/:teamId/projects/:projectId", editProject.status, 200, "title applied");

  // ------------------------------------------------- per-project overrides
  group("Per-project overrides");

  const grant = await api("POST", `/teams/${teamId}/projects/${projectId}/members`, {
    token: la.token,
    body: { userId: bob.userId, role: "editor" },
  });
  record("POST", ".../projects/:projectId/members", grant.status, 201, "bob -> editor");

  const listOverrides = await api("GET", `/teams/${teamId}/projects/${projectId}/members`, {
    token: la.token,
  });
  record(
    "GET",
    ".../projects/:projectId/members",
    listOverrides.status,
    200,
    `${listOverrides.json.members?.length} override(s)`
  );

  const bobEdit = await api("PATCH", `/teams/${teamId}/projects/${projectId}`, {
    token: lb.token,
    body: { title: "Edited by bob via override" },
  });
  record("PATCH", ".../projects/:projectId (editor override)", bobEdit.status, 200, "override granted edit");

  const revoke = await api("DELETE", `/teams/${teamId}/projects/${projectId}/members/${bob.userId}`, {
    token: la.token,
  });
  record("DELETE", ".../projects/:projectId/members/:userId", revoke.status, 200);

  // ------------------------------------------------------------ audit log
  group("Audit log");

  const audit = await api("GET", `/teams/${teamId}/audit-log`, { token: la.token });
  const actions = [...new Set((audit.json.logs || []).map((l) => l.action))];
  record(
    "GET",
    "/teams/:teamId/audit-log",
    audit.status,
    200,
    `total ${audit.json.total}: ${actions.slice(0, 4).join(", ")}`
  );

  // ------------------------------------------------- membership mutations
  group("Membership mutations");

  const kickDave = await api("DELETE", `/teams/${teamId}/members/${dave.userId}`, {
    token: la.token,
  });
  record("DELETE", "/teams/:teamId/members/:userId", kickDave.status, 200, "dave removed");

  const carolLogin = await login(carol.email);
  const carolLeave = await api("POST", `/teams/${teamId}/leave`, { token: carolLogin.token });
  record("POST", "/teams/:teamId/leave", carolLeave.status, 200, "carol left");

  const transfer = await api("PATCH", `/teams/${teamId}/transfer-ownership`, {
    token: la.token,
    body: { newOwnerUserId: bob.userId },
  });
  record("PATCH", "/teams/:teamId/transfer-ownership", transfer.status, 200, "alice -> bob");

  // bob owns the team from here, so the remaining owner-only routes use his token.
  const bobTeam = await login(bob.email);
  record("POST", "/auth/login (new owner)", bobTeam.status, 200);

  const delProject = await api("DELETE", `/teams/${teamId}/projects/${projectId}`, {
    token: bobTeam.token,
  });
  record("DELETE", "/teams/:teamId/projects/:projectId", delProject.status, 200);

  const delTeam = await api("DELETE", `/teams/${teamId}`, { token: bobTeam.token });
  record("DELETE", "/teams/:teamId", delTeam.status, 200, `cascaded ${delTeam.json.deletedProjects} project(s)`);

  const gone = await api("GET", `/teams/${teamId}`, { token: bobTeam.token });
  record("GET", "/teams/:teamId (deleted)", gone.status, 403, "no longer reachable");

  // ------------------------------------------------------------- teardown
  group("Teardown");
  try {
    const db = await connectDb();
    // Bare stamp, not "+smoke<stamp>". Every account here goes through the email()
    // helper so the "+smoke" form is consistent today, but depending on that
    // formatting detail is what previously let test.js leak rows into the database
    // while its own cleanup assertion reported success. The stamp is a 13-digit
    // millisecond timestamp, so matching it anywhere cannot catch a real account.
    const pattern = new RegExp(`${stamp}`);
    const users = await db.User.find({ email: pattern }, { _id: 1 }).lean();
    const userIds = users.map((u) => u._id);
    const teams = await db.Team.find({ ownerId: { $in: userIds } }, { _id: 1 }).lean();
    const teamIds = teams.map((t) => t._id);
    const projects = await db.Project.find({ teamId: { $in: teamIds } }, { _id: 1 }).lean();
    const projectIds = projects.map((p) => p._id);

    // AuditLog rows are keyed by teamId/userId rather than owning a reference, so
    // they need their own delete or every run would leave a growing trail behind.
    const [u, t, p, m, a, pm] = await Promise.all([
      db.User.deleteMany({ _id: { $in: userIds } }),
      db.Team.deleteMany({ _id: { $in: teamIds } }),
      db.Project.deleteMany({ teamId: { $in: teamIds } }),
      db.TeamMember.deleteMany({ $or: [{ teamId: { $in: teamIds } }, { userId: { $in: userIds } }] }),
      db.AuditLog.deleteMany({ $or: [{ teamId: { $in: teamIds } }, { actorId: { $in: userIds } }] }),
      db.ProjectMember.deleteMany({
        $or: [{ projectId: { $in: projectIds } }, { userId: { $in: userIds } }],
      }),
    ]);

    console.log(
      `  Removed ${u.deletedCount} users, ${t.deletedCount} teams, ${p.deletedCount} projects,` +
        ` ${m.deletedCount} memberships, ${a.deletedCount} audit entries, ${pm.deletedCount} overrides.`
    );

    await db.mongoose.disconnect();
  } catch (err) {
    // A cleanup failure must never read as a test failure — the endpoints already
    // reported their own results above.
    console.log(`  Teardown skipped: ${err.message}`);
    console.log(`  Manual cleanup in mongosh:  db.users.deleteMany({ email: { $regex: "${stamp}" } })`);
  }

  // --------------------------------------------------------------- report
  const failed = results.filter((r) => !r.ok);

  // results.length counts CALLS, not distinct routes: signup runs four times and
  // login three times so the suite has the users and rotated tokens it needs.
  //
  // Counting distinct method+path needs care, because several checks reuse a
  // route with a different body and label it accordingly ("/auth/login (reset
  // pw)", "/users/me (password)"). Those are the SAME endpoint exercised twice,
  // so the trailing "(...)" annotation is stripped before deduping — otherwise
  // every variant inflates the total and the number overstates the coverage.
  const distinct = new Set(
    results.map((r) => `${r.method} ${r.path.replace(/\s*\(.*\)$/, "")}`)
  ).size;

  console.log(`\n${"=".repeat(74)}`);
  if (failed.length === 0) {
    console.log(`  OK — ${distinct} distinct endpoints, ${results.length} checks, 0 failed`);
  } else {
    console.log(`  ${results.length - failed.length}/${results.length} checks OK, ${failed.length} FAILED\n`);
    failed.forEach((f) =>
      console.log(`   - ${f.method} ${f.path} — expected ${f.expected}, got ${f.status}`)
    );
    console.log("\n  A FAIL here means a route is unreachable, not merely mis-permissioned.");
  }
  console.log(`${"=".repeat(74)}\n`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  Unexpected error:", err.message, "\n");
  process.exit(1);
});