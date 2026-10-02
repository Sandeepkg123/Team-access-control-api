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

async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
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

  // The attack: bob, an admin, tries to create an owner.
  const bobMintsOwner = await addToA(bobToken, carol.email, "owner");
  check("admin granting 'owner' is clamped", bobMintsOwner.json.membership?.role, "member");

  // And tries to grant admin too (admins may not expand the admin set).
  const bobMintsAdmin = await addToA(bobToken, dave.email, "admin");
  check("admin granting 'admin' is clamped", bobMintsAdmin.json.membership?.role, "member");

  // The real escalation does NOT need transfer-ownership: if bob can create
  // carol as 'owner', bob owns carol's account (signup has no email
  // verification), so logging in AS carol makes bob an owner. We assert on the
  // role carol actually holds.
  const carolTeam = await api("GET", `/teams/${teamA}`, {
    token: await login(carol.email, carol.password),
  });
  check("puppet account is NOT an owner", carolTeam.json.role, "member");

  // transfer-ownership must stay owner-only regardless.
  const seize = await api("PATCH", `/teams/${teamA}/transfer-ownership`, {
    token: bobToken,
    body: { newOwnerUserId: carolTeam.json?.userId?._id ?? "000000000000000000000000" },
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

  const grace = { name: "Grace", email: `grace+${stamp}${rand}@test.com`, password: "Secret123!" };
  await signup(grace);
  const ownerMintsOwner = await addToA(tokenA, grace.email, "owner");
  check("owner granting 'owner' is still allowed (policy)", ownerMintsOwner.json.membership?.role, "owner");

  const noRole = await addToA(tokenA, `ghost+${stamp}@test.com`, undefined);
  check("unknown email still 404s", noRole.status, 404);

  // ----------------------------------------------------------------- teardown
  // There is no DELETE /auth/users endpoint, so we clean up straight through
  // Mongoose. Everything is scoped by the unique stamp in the test emails, so
  // this can never touch real accounts. Wrapped in its own try/catch: a cleanup
  // failure must never be mistaken for a test failure.
  group("Teardown");
  try {
    require("dotenv").config({ quiet: true });
    const mongoose = require("mongoose");
    const [Team, TeamMember, Project, User] = await Promise.all([
      require("./src/models/Team"),
      require("./src/models/TeamMember"),
      require("./src/models/Project"),
      require("./src/models/User"),
    ]);

    // Atlas SRV lookups fail on some Windows resolvers; src/config/db.js pins
    // Google DNS for the same reason. Do the same here or connect() throws
    // querySrv ECONNREFUSED.
    require("dns").setServers(["8.8.8.8", "8.8.4.4"]);

    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

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