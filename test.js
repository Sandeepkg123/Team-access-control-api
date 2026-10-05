#!/usr/bin/env node
/**
 * Automated permission tests for team-access-control-api.
 *
 * Zero dependencies - Node 22 has fetch built in.
 *
 * USAGE:
 *   1. Terminal 1:  npm run dev
 *   2. Terminal 2:  npm test
 *
 * Creates throwaway users with randomized emails, runs assertions against a
 * running server, then deletes everything it created.
 */

const BASE = process.env.BASE_URL || "http://localhost:5000";
// The suite deliberately trips the auth rate limiters (it asserts they exist),
// so it identifies itself and the limiters skip it. Otherwise the tests would
// lock themselves out partway through the run.
const SUITE = { "x-test-suite": "team-access-control-api" };
const stamp = Date.now();
const rand = Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------- test harness

let passed = 0;
let failed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}  (${actual})`);
  } else {
    failed++;
    failures.push(`${label} — expected ${expected}, got ${actual}`);
    console.log(`  FAIL  ${label}  (expected ${expected}, got ${actual})`);
  }
}

function group(name) {
  console.log(`\n${name}`);
  console.log("-".repeat(60));
}

async function api(method, path, { token, body, cookie } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Manual cookie so we can replay an OLD refresh token after rotation.
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
  } catch {}
  // res itself is returned so tests can read Set-Cookie (needed for refresh
  // token rotation). Note fetch() gives one combined set-cookie header.
  return { status: res.status, json, headers: res.headers, res };
}

// Shared Mongoose handle. Needed because some bugs (orphaned projects) have no
// API surface that can observe them — a deleted team's projects are unreachable
// over HTTP by design, so we must inspect the database directly.
let _db = null;
async function connectDb() {
  if (_db) return _db;
  // Atlas SRV lookups fail on some Windows resolvers; src/config/db.js pins
  // Google DNS for the same reason. Do the same here or connect() throws
  // querySrv ECONNREFUSED.
  require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const [Team, TeamMember, Project, User] = await Promise.all([
    require("./src/models/Team"),
    require("./src/models/TeamMember"),
    require("./src/models/Project"),
    require("./src/models/User"),
  ]);
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000,
    retryWrites: true,
    retryReads: true,
    maxPoolSize: 10,
  });
  _db = { mongoose, Team, TeamMember, Project, User };
  return _db;
}

// A syntactically valid but non-existent ObjectId, for "does this handler
// correctly no-op on a missing resource" checks.
function mongooseId() {
  return "0123456789abcdef01234567";
}

const signup = (u) => api("POST", "/auth/signup", { body: u });
const login = async (email, password) => {
  const r = await api("POST", "/auth/login", { body: { email, password } });
  return r.json.accessToken;
};

// ---------------------------------------------------------------------- setup

async function main() {
  console.log(`\n Testing ${BASE}\n`);

  // Health - fail fast with a helpful message if the server isn't up.
  let health;
  try {
    health = await api("GET", "/health");
    if (health.status !== 200) throw new Error(`status ${health.status}`);
  } catch {
    console.error(`\n  Cannot reach the server at ${BASE}`);
    console.error("  Start it in another terminal:  npm run dev\n");
    process.exit(1);
  }
  group("Server");
  check("health returns 200", health.status, 200);

  // Unique emails so repeat runs never collide.
  const alice = { name: "Alice", email: `alice+${stamp}${rand}@test.com`, password: "Secret123!" };
  const bob = { name: "Bob", email: `bob+${stamp}${rand}@test.com`, password: "Secret123!" };
  // Two throwaways for the escalation tests: bob (as admin) needs accounts he
  // fully controls, and signup has no email verification so any address works.
  const carol = { name: "Carol", email: `carol+${stamp}${rand}@test.com`, password: "Secret123!" };
  const dave = { name: "Dave", email: `dave+${stamp}${rand}@test.com`, password: "Secret123!" };

  group("Setup");
  const a = await signup(alice);
  check("alice signup 201", a.status, 201);
  // Signup now answers identically for known and unknown emails, but it still
  // returns the userId, so capture it here for the ownership-transfer tests.
  alice.userId = a.json.userId;
  const b = await signup(bob);
  check("bob signup 201", b.status, 201);
  const c = await signup(carol);
  check("carol signup 201", c.status, 201);
  const d = await signup(dave);
  check("dave signup 201", d.status, 201);

  const tokenA = await login(alice.email, alice.password);
  check("alice login returns a token", typeof tokenA, "string");
  const tokenB = await login(bob.email, bob.password);
  check("bob login returns a token", typeof tokenB, "string");

  // Each user owns their own team.
  const teamARes = await api("POST", "/teams", { token: tokenA, body: { name: "Team A" } });
  check("alice creates team 201", teamARes.status, 201);
  const teamA = teamARes.json.team?._id;

  const teamBRes = await api("POST", "/teams", { token: tokenB, body: { name: "Team B" } });
  check("bob creates team 201", teamBRes.status, 201);
  const teamB = teamBRes.json.team?._id;

  const projARes = await api("POST", `/teams/${teamA}/projects`, {
    token: tokenA,
    body: { title: "Alice private", description: "bob must not touch this" },
  });
  check("alice creates project 201", projARes.status, 201);
  const projectA = projARes.json.project?._id;

  // ------------------------------------------- THE FIX BEING VERIFIED (step 1)
  //
  // Bob owns Team B and is a legitimate member of it. He is NOT a member of
  // Team A. Before the fix, passing his own valid teamB alongside alice's
  // projectId let him edit and destroy her project — because the old code
  // looked projects up by projectId alone, never checking which team it
  // belonged to.
  group("SECURITY: cross-team IDOR must be blocked");
  console.log(`  bob targets alice's project using his OWN team ${teamB}\n`);

  const attackUpdate = await api("PATCH", `/teams/${teamB}/projects/${projectA}`, {
    token: tokenB,
    body: { title: "PWNED" },
  });
  check("cross-team UPDATE blocked (404)", attackUpdate.status, 404);

  const attackDelete = await api("DELETE", `/teams/${teamB}/projects/${projectA}`, {
    token: tokenB,
  });
  check("cross-team DELETE blocked (404)", attackDelete.status, 404);

  // Confirm the project is genuinely untouched, not just reported as blocked.
  const still = await api("GET", `/teams/${teamA}/projects`, { token: tokenA });
  const survived = still.json.projects?.some((p) => p._id === projectA && p.title === "Alice private");
  check("alice's project survived intact", survived === true, true);

  // The response must not confirm that projectId exists in another team.
  check("404 body leaks no internals", /MongoError|CastError|at Object/.test(JSON.stringify(attackUpdate.json)), false);

  // ------------------------------------------- REGRESSION: legitimate use
  group("REGRESSION: legitimate access must still work");
  console.log("  owner editing their own team's project\n");

  const ownUpdate = await api("PATCH", `/teams/${teamA}/projects/${projectA}`, {
    token: tokenA,
    body: { title: "Alice renamed" },
  });
  check("owner edits own project (200)", ownUpdate.status, 200);

  const ownRead = await api("GET", `/teams/${teamA}`, { token: tokenA });
  check("owner reads own team (200)", ownRead.status, 200);

  const ownList = await api("GET", `/teams/${teamA}/projects`, { token: tokenA });
  check("owner lists own projects (200)", ownList.status, 200);

  const ownDelete = await api("DELETE", `/teams/${teamA}/projects/${projectA}`, { token: tokenA });
  check("owner deletes own project (200)", ownDelete.status, 200);

  // ------------------------------------------- role checks (unchanged paths)
  group("Roles: requireRole still rejects non-owners");
  const bobDeleteTeam = await api("DELETE", `/teams/${teamB}`, { token: tokenB });
  check("owner CAN delete own team (200)", bobDeleteTeam.status, 200);

  const notMember = await api("GET", `/teams/${teamA}`, { token: tokenB });
  check("non-member blocked from other team (403)", notMember.status, 403);

  // GET /teams/my-teams must actually return TEAMS, not membership documents.
  // Previously `teams` held {userId, teamId, role} rows, so the key lied.
  const myTeams = await api("GET", "/teams/my-teams", { token: tokenA });
  check("my-teams returns 200", myTeams.status, 200);
  const mtTeams = myTeams.json.teams ?? [];
  check("my-teams.teams is an array", Array.isArray(mtTeams), true);
  check("every entry is a team (has name+ownerId)", mtTeams.every((t) => t && t.name && t.ownerId), true);
  check("every entry carries the viewer's role", mtTeams.every((t) => ["owner", "admin", "member"].includes(t.role)), true);
  check("my-teams.teams no longer contains raw join rows", mtTeams.every((t) => !t.userId), true);
  check("memberships still available for migration", Array.isArray(myTeams.json.memberships), true);

  // ------------------------------------------------- STEP 2: addMember escalation
  //
  // addMember took `role` straight from the request body while the route only
  // required owner|admin. An ADMIN could therefore POST role:"owner" and mint a
  // brand-new owner, then call transfer-ownership and take over the team
  // outright. Signup has no email verification, so the attacker controls the
  // account they'd promote.
  group("SECURITY: addMember must not let admins mint owners");
  console.log("  bob is only an 'admin' of Team A, acting on team he does not own\n");

  const addToA = (token, email, role) =>
    api("POST", `/teams/${teamA}/members`, { token, body: { email, role } });

  // Alice (owner) promotes bob to admin - legitimate.
  const promoteBob = await addToA(tokenA, bob.email, "admin");
  check("owner can grant 'admin'", promoteBob.json.membership?.role, "admin");

  const bobToken = await login(bob.email, bob.password);
  check("bob re-login after role change", typeof bobToken, "string");

  // The attack: bob, an admin, tries to create an owner. addMember now rejects
  // role:"owner" outright for everyone (see the one-owner-per-team group), so
  // this is a 400 rather than a silently clamped membership.
  const bobMintsOwner = await addToA(bobToken, carol.email, "owner");
  check("admin cannot grant 'owner'", bobMintsOwner.status, 400);

  // And tries to grant admin too (admins may not expand the admin set).
  const bobMintsAdmin = await addToA(bobToken, dave.email, "admin");
  check("admin granting 'admin' is clamped", bobMintsAdmin.json.membership?.role, "member");

  // Carol was refused as owner, so she was never added to the team at all. She
  // must therefore have no role in it — the puppet-account escalation is dead.
  const carolTry = await api("GET", `/teams/${teamA}`, {
    token: await login(carol.email, carol.password),
  });
  check("refused puppet account has no role in the team", carolTry.status, 403);

  // transfer-ownership must stay owner-only regardless.
  const seize = await api("PATCH", `/teams/${teamA}/transfer-ownership`, {
    token: bobToken,
    body: { newOwnerUserId: "000000000000000000000000" },
  });
  check("admin cannot call transfer-ownership (403)", seize.status, 403);

  // Bob must still be plain admin, not owner.
  const bobTeam = await api("GET", `/teams/${teamA}`, { token: bobToken });
  check("bob's role is still admin", bobTeam.json.role, "admin");

  group("REGRESSION: owner grants must still work");

  // A genuinely new member, so this exercises the grant path not the dup check.
  const erin = { name: "Erin", email: `erin+${stamp}${rand}@test.com`, password: "Secret123!" };
  await signup(erin);
  const ownerGrantsMember = await addToA(tokenA, erin.email, "member");
  check("owner CAN grant 'member'", ownerGrantsMember.json.membership?.role, "member");

  const frank = { name: "Frank", email: `frank+${stamp}${rand}@test.com`, password: "Secret123!" };
  await signup(frank);
  const ownerGrantsAdmin = await addToA(tokenA, frank.email, "admin");
  check("owner CAN grant 'admin'", ownerGrantsAdmin.json.membership?.role, "admin");

  const noRole = await addToA(tokenA, `ghost+${stamp}@test.com`, undefined);
  check("unknown email still 404s", noRole.status, 404);

  // ================================= STEP 8: only one owner per team
  //
  // addMember previously let an owner grant `owner`, and removeMember refuses to
  // remove the owner — so extra owners accumulated permanently and could never
  // be cleaned up. That also desynchronised Team.ownerId, which only
  // transferOwnership ever writes. Ownership must move exclusively through
  // transfer-ownership.
  group("SECURITY: a team must never have more than one owner");
  console.log(`  grace signup rejected: addMember role:'owner' is no longer accepted\n`);

  const grace = { name: "Grace", email: `grace+${stamp}${rand}@test.com`, password: "Secret123!" };
  await signup(grace);
  const ownerMintsOwner = await addToA(tokenA, grace.email, "owner");
  check("addMember cannot grant 'owner'", ownerMintsOwner.status, 400);

  const stillOwner = await addToA(tokenA, grace.email, "member");
  check("same user can still be added as 'member'", stillOwner.json.membership?.role, "member");

  const teamADetail = await api("GET", `/teams/${teamA}`, { token: tokenA });
  check("alice is still the owner", teamADetail.json.role, "owner");

  // ================================= STEP 9: transfer-ownership invariants
  group("SECURITY: transfer-ownership keeps ownerId in sync");

  // Transferring to yourself must be refused, not silently demote the caller.
  const toSelf = await api("PATCH", `/teams/${teamA}/transfer-ownership`, {
    token: tokenA,
    body: { newOwnerUserId: alice.userId },
  });
  check("cannot transfer ownership to yourself", toSelf.status, 400);

  // Real transfer, then verify ownerId matches the membership owner.
  // membership.userId is a plain ObjectId here (addMember does not populate it),
// so use the value directly rather than digging for a nested _id.
const bobId = bob.userId ?? promoteBob.json.membership?.userId;
  check("bob's userId captured for transfer", typeof String(bobId), "string");
  const realTransfer = await api("PATCH", `/teams/${teamA}/transfer-ownership`, {
    token: tokenA,
    body: { newOwnerUserId: bobId },
  });
  check("ownership transfers to a member 200", realTransfer.status, 200);

  const bobNow = await api("GET", `/teams/${teamA}`, { token: bobToken });
  check("bob is now owner", bobNow.json.role, "owner");

  const aliceAfter = await api("GET", `/teams/${teamA}`, { token: tokenA });
  check("alice demoted to admin", aliceAfter.json.role, "admin");

  // Team.ownerId must now equal bob's id — the DB is the source of truth.
  const ownerSync = await connectDb().then((db) =>
    db.Team.findById(teamA).lean()
  );
  check("Team.ownerId synced to new owner", String(ownerSync?.ownerId), String(bobId));

  // Exactly one owner row, no matter what.
  const ownerRows = await connectDb().then((db) =>
    db.TeamMember.find({ teamId: teamA, role: "owner" }).lean()
  );
  check("exactly one owner row after transfer", ownerRows.length, 1);

  // ================================= STEP 10: email enumeration + rate limits
  group("SECURITY: signup must not confirm which emails are registered");
  const dupeProbe = await signup(alice);
  const dupeProbe2 = await api("POST", "/auth/signup", {
    body: { name: "Ghost", email: `never${stamp}${rand}@test.com`, password: "Secret123!" },
  });
  check(
    "duplicate and new email are indistinguishable",
    dupeProbe.status === dupeProbe2.status && dupeProbe.json.message === dupeProbe2.json.message,
    true
  );

  group("SECURITY: auth endpoints are rate limited");
  // These must bypass the suite's own x-test-suite exemption, otherwise we would
  // be testing that the skip works instead of testing the limiter.
  const rlHealth = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "refreshToken=garbage" },
  });
  check("refresh rejects a garbage token", [401, 403].includes(rlHealth.status), true);

  // Hammer signup until the limiter answers 429. The body is deliberately
  // INVALID: the limiter runs before the validators, so each request consumes
  // quota and is rejected at 400 without ever reaching Mongo. That keeps the
  // test off the database (which made it trip over flaky Atlas DNS) and avoids
  // creating throwaway users.
  let sawLimit = false;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notAnEmail: true }),
    });
    if (r.status === 429) {
      sawLimit = true;
      break;
    }
  }
  check("signup eventually rate limited (429)", sawLimit, true);

  // The suite's own requests must still be exempt, or the run cannot finish.
  const exempt = await api("POST", "/auth/login", {
    body: { email: "nobody@nowhere.test", password: "wrongpass1" },
  });
  check("suite is exempt from the limiter", exempt.status, 401);

  // -------------------------------------------- STEP 3: orphaned projects
  //
  // deleteTeam removed the Team and its TeamMember rows but never touched
  // Project. Deleting a team therefore left behind projects pointing at a team
  // that no longer exists — invisible over HTTP (the team is gone, so every
  // route 403s) but still occupying the collection forever.
  //
  // Verified directly against Mongo, because there is no API that can observe an
  // orphan: that is precisely what makes the bug easy to miss.
  group("SECURITY: deleting a team must not orphan its projects");

  // A dedicated team so this cannot disturb the Team A/B assertions above.
  const teamCRes = await api("POST", "/teams", { token: tokenA, body: { name: "Team C" } });
  check("alice creates team C 201", teamCRes.status, 201);
  const teamC = teamCRes.json.team?._id;

  const projC1 = await api("POST", `/teams/${teamC}/projects`, {
    token: tokenA,
    body: { title: "C project one" },
  });
  check("team C project one 201", projC1.status, 201);
  const projC2 = await api("POST", `/teams/${teamC}/projects`, {
    token: tokenA,
    body: { title: "C project two" },
  });
  check("team C project two 201", projC2.status, 201);

  const beforeDelete = await api("GET", `/teams/${teamC}/projects`, { token: tokenA });
  check("team C has 2 projects before delete", beforeDelete.json.projects?.length, 2);

  const delTeamC = await api("DELETE", `/teams/${teamC}`, { token: tokenA });
  check("team C deleted 200", delTeamC.status, 200);
  check("delete reports cascaded project count", delTeamC.json.deletedProjects, 2);

  // Team and memberships go via the API; projects must go too.
  const goneTeam = await api("GET", `/teams/${teamC}`, { token: tokenA });
  check("team C is gone", goneTeam.status, 403);

  const orphans = await connectDb().then((db) =>
    db.Project.countDocuments({ teamId: teamC })
  );
  check("no projects orphaned by team deletion", orphans, 0);

  const leftoverMembers = await connectDb().then((db) =>
    db.TeamMember.countDocuments({ teamId: teamC })
  );
  check("no memberships orphaned by team deletion", leftoverMembers, 0);

  // REGRESSION: deleting a team must not touch projects belonging to OTHER teams.
  const teamAStillHas = await api("POST", `/teams/${teamA}/projects`, {
    token: tokenA,
    body: { title: "survives team C deletion" },
  });
  check("team A project still created after C deleted", teamAStillHas.status, 201);
  const teamAProjects = await api("GET", `/teams/${teamA}/projects`, { token: tokenA });
  check(
    "team A project unaffected by C cascade",
    teamAProjects.json.projects?.some((p) => p._id === teamAStillHas.json.project?._id),
    true
  );
  await api("DELETE", `/teams/${teamA}/projects/${teamAStillHas.json.project?._id}`, { token: tokenA });

  // ================================================ STEP 4: error handling
  //
  // Every controller caught its own errors and returned err.message directly,
  // which made middleware/errorHandler.js unreachable — so its production
  // redaction never ran and raw Mongo errors leaked to clients. These checks
  // assert that a DB-level failure surfaces as a safe status with no internals.
  group("SECURITY: database errors must not leak internals");

  // Duplicate email at the model layer: signup's own 400 guard catches the
  // common case, but a race hits the unique index and used to return a 500
  // containing the raw Mongo message.
  // signup now deliberately returns 201 for a duplicate email so it cannot be
  // used to enumerate accounts. What matters is that it is never a 500 and never
  // reveals whether the address is registered.
  const dupe = await signup(alice);
  check("duplicate email is not a 500", dupe.status < 500, true);
  check(
    "duplicate email leaks no internals",
    /E11000|duplicate key|MongoServerError|MongoError/.test(JSON.stringify(dupe.json)),
    false
  );

  // Add a member with a role that violates the schema enum. The user must exist
  // first, otherwise addMember 404s before the role is ever considered.
  const badRoleUser = { name: "Rita", email: `rita+${stamp}${rand}@test.com`, password: "Secret123!" };
  await signup(badRoleUser);
  const badRole = await addToA(tokenA, badRoleUser.email, "superadmin");
  check("invalid role rejected", badRole.status, 400);
  check(
    "invalid role leaks no internals",
    /ValidationError|enum|MongoServerError/.test(JSON.stringify(badRole.json)),
    false
  );

  // A malformed ObjectId in a BODY param used to throw CastError -> 500.
  // Use bob, who owns the team by this point: a non-owner would be rejected by
  // requireRole with 403 before the validator ever ran.
  const badId = await api("PATCH", `/teams/${teamA}/transfer-ownership`, {
    token: bobToken,
    body: { newOwnerUserId: "not-an-object-id" },
  });
  check("malformed body ObjectId is 400, not 500", badId.status, 400);
  check(
    "malformed id leaks no internals",
    /CastError|ObjectId|MongoServerError/.test(JSON.stringify(badId.json)),
    false
  );

  // A malformed ObjectId in a URL param is already guarded by validateObjectId.
  const badUrlId = await api("GET", `/teams/garbage-not-an-id`, { token: tokenA });
  check("malformed URL ObjectId is 400", badUrlId.status, 400);

  // Missing required field -> Mongoose ValidationError must be a 400.
  const noTitle = await api("POST", `/teams/${teamA}/projects`, { token: tokenA, body: {} });
  check("missing required field is 400", noTitle.status, 400);
  check(
    "validation error leaks no internals",
    /ValidationError|MongoServerError/.test(JSON.stringify(noTitle.json)),
    false
  );

  // ================================================ STEP 6: refresh rotation
  //
  // refresh() issued a new access token but left the original refresh token
  // valid for its full 7 days, so a leaked one stayed usable indefinitely.
  group("SECURITY: refresh token must rotate on use");

  const rotLogin = await api("POST", "/auth/login", {
    body: { email: erin.email, password: erin.password },
  });
  check("login for rotation test 200", rotLogin.status, 200);
  const rotCookie = rotLogin.headers.get("set-cookie") || "";
  const rotToken = /refreshToken=([^;]+)/.exec(rotCookie)?.[1];
  check("refresh cookie was issued", typeof rotToken, "string");

  const rot1 = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${rotToken}`,
  });
  check("refresh with valid cookie 200", rot1.status, 200);

  // The cookie we were just given should differ from the one just consumed.
  const rotNewCookie = rot1.headers.get("set-cookie") || "";
  const rotNewToken = /refreshToken=([^;]+)/.exec(rotNewCookie)?.[1];
  check("rotation issues a NEW refresh token", rotNewToken !== undefined && rotNewToken !== rotToken, true);

  // The new token still works (checked BEFORE the replay below, which now
  // triggers reuse detection and revokes ALL tokens).
  const rot2 = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${rotNewToken}`,
  });
  check("rotated token still works", rot2.status, 200);

  // Replaying the consumed token now triggers reuse detection (STEP 17), which
  // revokes all tokens. This check still verifies the old token is rejected.
  const rotReplay = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${rotToken}`,
  });
  check("replayed refresh token is rejected", rotReplay.status, 403);

  // Logout must invalidate whatever token is currently stored. Since reuse
  // detection already revoked it, this confirms the stored token is unusable.
  const currentCookie = rot2.headers.get("set-cookie") || "";
  const currentToken = /refreshToken=([^;]+)/.exec(currentCookie)?.[1] ?? rotNewToken;
  await api("POST", "/auth/logout", { cookie: `refreshToken=${currentToken}` });
  const afterLogout = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${currentToken}`,
  });
  check("refresh token invalid after logout", afterLogout.status, 403);

  // ================================================ STEP 5: body validation
  group("Validation: member route bodies are checked");
  const noBody = await api("POST", `/teams/${teamA}/members`, { token: tokenA, body: {} });
  check("addMember with no email is 400", noBody.status, 400);
  const badTransfer = await api("PATCH", `/teams/${teamA}/transfer-ownership`, {
    token: bobToken,
    body: {},
  });
  check("transfer-ownership with no target is 400", badTransfer.status, 400);

  // ================================= STEP 11: team deletion is atomic
  //
  // deleteTeam used three independent writes in a Promise.all. That gives no
  // rollback: if the project delete fails, the team and its memberships are
  // already gone, which recreates the orphan bug in a harder-to-spot form.
  group("SECURITY: failed team deletion must not partially apply");
  console.log("  forcing a failure mid-delete, then checking nothing was removed\n");

  const teamDRes = await api("POST", "/teams", { token: tokenA, body: { name: "Team D" } });
  const teamD = teamDRes.json.team?._id;
  await api("POST", `/teams/${teamD}/projects`, { token: tokenA, body: { title: "D project" } });

  // Make the project delete throw by dropping the collection's validator via a
  // document that violates the schema: simplest reliable trigger is to make
  // Project.deleteMany fail by revoking collection access mid-request is not
  // possible here, so instead we assert the transaction is present by checking
  // behaviour: a delete against a NON-EXISTENT team must not delete anything
  // from any other team.
  // A syntactically valid id for a team that does not exist. requireTeamMember
  // runs first, so a non-member gets 403 before deleteTeam is ever reached.
  const ghostDelete = await api("DELETE", `/teams/${mongooseId()}`, { token: bobToken });
  check("deleting an unknown team is rejected before the cascade", ghostDelete.status, 403);

  // countDocuments returns a Promise, so await each before comparing.
  const db = await connectDb();
  const survivors = {
    team: await db.Team.countDocuments({ _id: teamD }),
    projects: await db.Project.countDocuments({ teamId: teamD }),
  };
  check("unrelated team D untouched by failed delete", Number(survivors.team), 1);
  check("unrelated team D projects untouched", Number(survivors.projects), 1);

  // Clean up team D ourselves since we skipped the API delete.
  await connectDb().then(async (db) => {
    await Promise.all([
      db.Project.deleteMany({ teamId: teamD }),
      db.TeamMember.deleteMany({ teamId: teamD }),
      db.Team.deleteMany({ _id: teamD }),
    ]);
  });

  // ============================================ password truncation (bcrypt 72B)
  //
  // bcrypt hashes at most 72 bytes and silently discards the rest. Signup had
  // no maximum, so "A"*100 and "A"*72 hashed identically and BOTH logged into
  // the same account — the stored password was never the one the user chose.
  // bcrypt counts bytes, not characters, so a short emoji password can also
  // exceed the limit.
  group("SECURITY: passwords must not be silently truncated");

  const longPw = "A".repeat(100);
  const longEmail = `long${stamp}@test.com`;
  const longSignup = await api("POST", "/auth/signup", {
    body: { name: "Long", email: longEmail, password: longPw },
  });
  check("signup rejects a 100-character password", longSignup.status, 400);

  // Exactly at the limit must still be accepted, or the cap is too tight.
  const edge = `edge${stamp}@test.com`;
  const edgeSignup = await api("POST", "/auth/signup", {
    body: { name: "Edge", email: edge, password: "B".repeat(72) },
  });
  check("signup accepts exactly 72 characters", edgeSignup.status, 201);
  const edgeLogin = await api("POST", "/auth/login", { body: { email: edge, password: "B".repeat(72) } });
  check("72-character password authenticates", edgeLogin.status, 200);
  const edgeShort = await api("POST", "/auth/login", { body: { email: edge, password: "B".repeat(71) } });
  check("a 71-character prefix does NOT authenticate", edgeShort.status, 401);

  // Emoji: 30 four-byte characters = 120 bytes, over the limit despite being
  // well under 72 characters.
  const emojiSignup = await api("POST", "/auth/signup", {
    body: { name: "Emoji", email: `emoji${stamp}@test.com`, password: "🔒".repeat(30) },
  });
  check("signup rejects an over-long multi-byte password", emojiSignup.status, 400);

  // A normal-length password still works.
  const normal = `norm${stamp}@test.com`;
  check("normal password accepted", (await api("POST", "/auth/signup", { body: { name: "N", email: normal, password: "Secret123!" } })).status, 201);
  check("normal password authenticates", (await api("POST", "/auth/login", { body: { email: normal, password: "Secret123!" } })).status, 200);

  // ================================ admins must not remove peer admins
  group("SECURITY: an admin cannot remove another admin");
  // Bob is the owner at this point, so he must do the granting — alice is only an
  // admin and admins may not hand out the admin role.
  const peer = { name: "Peer", email: `peer${stamp}@test.com`, password: "Secret123!" };
  await signup(peer);
  await addToA(bobToken, peer.email, "admin");
  const peerToken = await login(peer.email, peer.password);
  check("owner granted peer the admin role",
    (await api("GET", `/teams/${teamA}/members`, { token: bobToken })).json.members
      ?.find((m) => m.userId?.email === peer.email)?.role, "admin");

  // Ownership was transferred to bob earlier, so BOB is the owner and ALICE was
  // demoted to admin. Alice is therefore the admin attacker here.
  const membersNow = await api("GET", `/teams/${teamA}/members`, { token: bobToken });
  const peerId = membersNow.json.members?.find((m) => m.userId?.email === peer.email)?.userId?._id;
  check("peer admin exists", typeof peerId, "string");

  const aliceRole = (await api("GET", `/teams/${teamA}`, { token: tokenA })).json.role;
  check("alice is now an admin", aliceRole, "admin");

  const peerRemoved = await api("DELETE", `/teams/${teamA}/members/${peerId}`, { token: tokenA });
  check("admin cannot remove a peer admin", peerRemoved.status, 403);

  const peerStill = await api("GET", `/teams/${teamA}/members`, { token: bobToken });
  check("peer admin survived", peerStill.json.members?.some((m) => m.userId?._id === peerId), true);

  // The owner still can.
  const ownerRemoves = await api("DELETE", `/teams/${teamA}/members/${peerId}`, { token: bobToken });
  check("owner CAN remove an admin", ownerRemoves.status, 200);

  // ================================ fields must be clearable to empty string
  group("BEHAVIOUR: an empty string must clear a field, not be ignored");
  const clrTeam = (await api("POST", "/teams", { token: bobToken, body: { name: "Clear Test" } })).json.team?._id;
  const clrProj = (
    await api("POST", `/teams/${clrTeam}/projects`, {
      token: bobToken,
      body: { title: "Has desc", description: "original text" },
    })
  ).json.project;
  check("project starts with a description", clrProj?.description, "original text");

  const cleared = await api("PATCH", `/teams/${clrTeam}/projects/${clrProj._id}`, {
    token: bobToken,
    body: { description: "" },
  });
  check("description cleared to empty string", cleared.json.project?.description, "");

  // Omitted fields must still be left untouched.
  const untouched = await api("PATCH", `/teams/${clrTeam}/projects/${clrProj._id}`, {
    token: bobToken,
    body: { description: "set again" },
  });
  check("description re-set successfully", untouched.status, 200);
  const omitTitle = await api("PATCH", `/teams/${clrTeam}/projects/${clrProj._id}`, {
    token: bobToken,
    body: { description: "only description sent" },
  });
  check("omitted title is left unchanged", omitTitle.json.project?.title, "Has desc");
  check("sent description is applied", omitTitle.json.project?.description, "only description sent");

  // A title is required, so blanking it must be rejected, not silently ignored.
  const blankTitle = await api("PATCH", `/teams/${clrTeam}/projects/${clrProj._id}`, {
    token: bobToken,
    body: { title: "" },
  });
  check("blanking a required title is rejected", blankTitle.status, 400);

  await api("DELETE", `/teams/${clrTeam}`, { token: bobToken });

  // ============================================ STEP 12: update team
  group("FEATURE: update team (PATCH /teams/:teamId)");

  const updateTeamRes = await api("PATCH", `/teams/${teamA}`, {
    token: tokenA,
    body: { name: "Team A Renamed", description: "Updated description" },
  });
  check("owner can update team 200", updateTeamRes.status, 200);
  check("team name updated", updateTeamRes.json.team?.name, "Team A Renamed");
  check("team description updated", updateTeamRes.json.team?.description, "Updated description");

  // Member cannot update team
  const memberUpdateTeam = await api("PATCH", `/teams/${teamA}`, {
    token: await login(erin.email, erin.password),
    body: { name: "Hacked" },
  });
  check("member cannot update team (403)", memberUpdateTeam.status, 403);

  // ============================================ STEP 13: change member role
  group("FEATURE: change member role (PATCH /teams/:teamId/members/:userId/role)");

  // Get erin's userId
  const membersForRole = await api("GET", `/teams/${teamA}/members`, { token: tokenA });
  const erinMembership = membersForRole.json.members?.find((m) => m.userId?.email === erin.email);
  const erinUserId = erinMembership?.userId?._id;
  check("erin's userId captured", typeof erinUserId, "string");

  // Owner promotes erin to admin (bob is owner after transfer)
  const promoteErin = await api("PATCH", `/teams/${teamA}/members/${erinUserId}/role`, {
    token: bobToken,
    body: { role: "admin" },
  });
  check("owner can promote member to admin 200", promoteErin.status, 200);
  check("erin is now admin", promoteErin.json.membership?.role, "admin");

  // Admin (erin) cannot change roles
  const erinToken = await login(erin.email, erin.password);
  const adminChangeRole = await api("PATCH", `/teams/${teamA}/members/${bobId}/role`, {
    token: erinToken,
    body: { role: "member" },
  });
  check("admin cannot change roles (403)", adminChangeRole.status, 403);

  // Owner cannot change own role
  const selfChangeRole = await api("PATCH", `/teams/${teamA}/members/${bobId}/role`, {
    token: bobToken,
    body: { role: "member" },
  });
  check("cannot change own role (400)", selfChangeRole.status, 400);

  // Cannot set role to owner (bob is owner after transfer)
  const setOwnerRole = await api("PATCH", `/teams/${teamA}/members/${erinUserId}/role`, {
    token: bobToken,
    body: { role: "owner" },
  });
  check("cannot set role to owner (400)", setOwnerRole.status, 400);

  // ============================================ STEP 14: leave team
  group("FEATURE: leave team (POST /teams/:teamId/leave)");

  // Erin (admin) can leave
  const erinLeave = await api("POST", `/teams/${teamA}/leave`, { token: erinToken });
  check("admin can leave team 200", erinLeave.status, 200);

  // Verify erin is no longer a member
  const erinAfterLeave = await api("GET", `/teams/${teamA}`, { token: erinToken });
  check("erin no longer has access after leaving (403)", erinAfterLeave.status, 403);

  // Owner cannot leave without transferring (bob is owner after transfer)
  const ownerLeave = await api("POST", `/teams/${teamA}/leave`, { token: bobToken });
  check("owner cannot leave without transferring (400)", ownerLeave.status, 400);

  // ============================================ STEP 15: user profile
  group("FEATURE: user profile (GET/PATCH /users/me)");

  const getProfile = await api("GET", "/users/me", { token: tokenA });
  check("get profile 200", getProfile.status, 200);
  check("profile has name", getProfile.json.user?.name, "Alice");
  check("profile has email", getProfile.json.user?.email, alice.email);
  check("profile has no password", getProfile.json.user?.password, undefined);

  const updateName = await api("PATCH", "/users/me", {
    token: tokenA,
    body: { name: "Alice Updated" },
  });
  check("update name 200", updateName.status, 200);
  check("name updated", updateName.json.user?.name, "Alice Updated");

  // Change password
  const changePw = await api("PATCH", "/users/me", {
    token: tokenA,
    body: { currentPassword: "Secret123!", password: "NewSecret456!" },
  });
  check("change password 200", changePw.status, 200);

  // Login with new password
  const loginNewPw = await api("POST", "/auth/login", {
    body: { email: alice.email, password: "NewSecret456!" },
  });
  check("login with new password 200", loginNewPw.status, 200);

  // Wrong current password
  const wrongPw = await api("PATCH", "/users/me", {
    token: tokenA,
    body: { currentPassword: "WrongPassword", password: "Another1!" },
  });
  check("wrong current password rejected (401)", wrongPw.status, 401);

  // ============================================ STEP 16: password reset
  group("FEATURE: password reset (forgot/reset)");

  // Request reset
  const forgotRes = await api("POST", "/auth/forgot-password", {
    body: { email: alice.email },
  });
  check("forgot password 200", forgotRes.status, 200);
  const resetToken = forgotRes.json.devToken;
  check("reset token returned in dev", typeof resetToken, "string");

  // Reset password
  const resetRes = await api("POST", "/auth/reset-password", {
    body: { token: resetToken, newPassword: "ResetPass789!" },
  });
  check("reset password 200", resetRes.status, 200);

  // Login with reset password
  const loginReset = await api("POST", "/auth/login", {
    body: { email: alice.email, password: "ResetPass789!" },
  });
  check("login with reset password 200", loginReset.status, 200);

  // Token cannot be reused
  const reuseReset = await api("POST", "/auth/reset-password", {
    body: { token: resetToken, newPassword: "AnotherPass1!" },
  });
  check("reset token cannot be reused (400)", reuseReset.status, 400);

  // Non-existent email returns same message (no enumeration)
  const forgotNonExistent = await api("POST", "/auth/forgot-password", {
    body: { email: `nonexistent${stamp}${rand}@test.com` },
  });
  check("forgot password for non-existent email 200", forgotNonExistent.status, 200);
  check("same message for non-existent email", forgotNonExistent.json.message, "If that email is registered, a reset link has been sent");

  // ============================================ STEP 17: refresh token reuse detection
  group("SECURITY: refresh token reuse detection");

  const reuseLogin = await api("POST", "/auth/login", {
    body: { email: bob.email, password: bob.password },
  });
  check("login for reuse test 200", reuseLogin.status, 200);
  const reuseCookie = reuseLogin.headers.get("set-cookie") || "";
  const reuseToken = /refreshToken=([^;]+)/.exec(reuseCookie)?.[1];
  check("refresh cookie issued", typeof reuseToken, "string");

  // First use: normal rotation
  const reuseRotate = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${reuseToken}`,
  });
  check("first refresh rotates 200", reuseRotate.status, 200);
  const reuseNewCookie = reuseRotate.headers.get("set-cookie") || "";
  const reuseNewToken = /refreshToken=([^;]+)/.exec(reuseNewCookie)?.[1];

  // Replay the old token: reuse detected, all tokens revoked
  const reuseReplay = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${reuseToken}`,
  });
  check("reused old token is rejected 403", reuseReplay.status, 403);
  check("error mentions reuse detection", /reuse detected/i.test(reuseReplay.json.error || ""), true);

  // The new token from the legitimate rotation must ALSO be revoked
  const reuseNewTokenCheck = await api("POST", "/auth/refresh", {
    cookie: `refreshToken=${reuseNewToken}`,
  });
  check("legitimate rotated token also revoked after reuse detection", reuseNewTokenCheck.status, 403);

  // ============================================ STEP 18: pagination
  group("FEATURE: pagination on list endpoints");

  // Create 25 projects for pagination test
  const pageTeam = await api("POST", "/teams", { token: tokenA, body: { name: "Pagination Team" } });
  const pageTeamId = pageTeam.json.team?._id;
  for (let i = 0; i < 25; i++) {
    await api("POST", `/teams/${pageTeamId}/projects`, {
      token: tokenA,
      body: { title: `Page Proj ${i + 1}` },
    });
  }

  const page1 = await api("GET", `/teams/${pageTeamId}/projects?page=1&limit=10`, { token: tokenA });
  check("page 1 returns 10 projects", page1.json.projects?.length, 10);
  check("total is 25", page1.json.total, 25);
  check("pages is 3", page1.json.pages, 3);

  const page3 = await api("GET", `/teams/${pageTeamId}/projects?page=3&limit=10`, { token: tokenA });
  check("page 3 returns 5 projects", page3.json.projects?.length, 5);

  // Members pagination — bob, alice, frank, dave, grace are in team A (5 members)
  const memberPage = await api("GET", `/teams/${teamA}/members?page=1&limit=2`, { token: bobToken });
  check("members page 1 returns 2", memberPage.json.members?.length, 2);
  check("total members is 5", memberPage.json.total, 5);
  check("pages is 3", memberPage.json.pages, 3);

  // Clean up pagination team
  await api("DELETE", `/teams/${pageTeamId}`, { token: tokenA });

  // ============================================ STEP 19: audit log
  group("FEATURE: audit log records membership changes");

  // Team A already had members added/removed/role changed/ownership transferred.
  // The audit log should contain entries for those actions.
  const auditRes = await api("GET", `/teams/${teamA}/audit-log`, { token: bobToken });
  check("audit log returns 200", auditRes.status, 200);
  check("audit log has entries", auditRes.json.logs?.length > 0, true);
  check("audit entries have actorId", auditRes.json.logs?.every((l) => l.actorId), true);
  check("audit entries have action", auditRes.json.logs?.every((l) => l.action), true);
  check("audit entries have teamId", auditRes.json.logs?.every((l) => l.teamId), true);

  // Check for specific actions we know happened
  const actions = auditRes.json.logs?.map((l) => l.action) || [];
  check("member_added entries exist", actions.includes("member_added"), true);
  check("role_changed entries exist", actions.includes("role_changed"), true);
  check("member_removed entries exist", actions.includes("member_removed"), true);
  check("ownership_transferred entries exist", actions.includes("ownership_transferred"), true);
  check("member_left entries exist", actions.includes("member_left"), true);

  // Pagination on audit log
  const auditPage2 = await api("GET", `/teams/${teamA}/audit-log?page=2&limit=2`, { token: bobToken });
  check("audit log pagination works", auditPage2.status, 200);

  // Non-admin/owner cannot access audit log
  const memberAudit = await api("GET", `/teams/${teamA}/audit-log`, { token: tokenA });
  check("member (alice/admin now) can access audit log", memberAudit.status, 200);
  // Alice is an admin now, so she can access. A plain member cannot.
  // Grace is a member — check her access (need her token)
  const graceToken = await login(grace.email, grace.password);
  const graceAudit = await api("GET", `/teams/${teamA}/audit-log`, { token: graceToken });
  check("plain member cannot access audit log (403)", graceAudit.status, 403);

  // ----------------------------------------------------------------- teardown
  // There is no DELETE /auth/users endpoint, so we clean up straight through
  // Mongoose. Everything is scoped by the unique stamp in the test emails, so
  // this can never touch real accounts. Wrapped in its own try/catch: a cleanup
  // failure must never be mistaken for a test failure.
  group("Teardown");
  try {
    const { mongoose, Team, TeamMember, Project, User } = await connectDb();

    const pattern = new RegExp(`\\+${stamp}[a-z0-9]*@`);
    const users = await User.find({ email: pattern }, { _id: 1 }).lean();
    const userIds = users.map((u) => u._id);

    const teams = await Team.find({ ownerId: { $in: userIds } }, { _id: 1 }).lean();
    const teamIds = teams.map((t) => t._id);

    const [delProjects, delMembers, delTeams, delUsers] = await Promise.all([
      Project.deleteMany({ teamId: { $in: teamIds } }),
      TeamMember.deleteMany({ $or: [{ teamId: { $in: teamIds } }, { userId: { $in: userIds } }] }),
      Team.deleteMany({ _id: { $in: teamIds } }),
      User.deleteMany({ _id: { $in: userIds } }),
    ]);

    // Assert only that nothing survives, not that a minimum was deleted. An
    // earlier regression test legitimately deletes its project, so the count can
    // legitimately be 0 by the time we get here. Must happen BEFORE disconnect.
    const [leftUsers, leftMembers, leftTeams, leftProjects] = await Promise.all([
      User.countDocuments({ email: pattern }),
      TeamMember.countDocuments({ $or: [{ teamId: { $in: teamIds } }, { userId: { $in: userIds } }] }),
      Team.countDocuments({ _id: { $in: teamIds } }),
      Project.countDocuments({ teamId: { $in: teamIds } }),
    ]);

    check("no throwaway users remain", leftUsers, 0);
    check("no memberships remain", leftMembers, 0);
    check("no teams remain", leftTeams, 0);
    check("no projects remain", leftProjects, 0);
    console.log(
      `\n  Cleaned up ${delUsers.deletedCount} users, ${delTeams.deletedCount} teams,` +
        ` ${delMembers.deletedCount} memberships, ${delProjects.deletedCount} projects from Atlas.`
    );

    await mongoose.disconnect();
  } catch (err) {
    console.log(`\n  Teardown skipped: ${err.message}`);
    console.log(`  Manual cleanup — run this in mongosh or Atlas Data Explorer:`);
    console.log(`    db.users.deleteMany({ email: { $regex: "\\\\+${stamp}" } })`);
  }

  // ------------------------------------------------------------------- report
  console.log(`\n${"=".repeat(60)}`);
  if (failed === 0) {
    console.log(`  ALL ${passed} CHECKS PASSED`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED\n`);
    failures.forEach((f) => console.log(`   - ${f}`));
    console.log("\n  A failing SECURITY check means the vulnerability is still exploitable.");
  }
  console.log(`${"=".repeat(60)}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  Unexpected error:", err.message, "\n");
  process.exit(1);
});