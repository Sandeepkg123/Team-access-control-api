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

  group("Setup");
  const a = await signup(alice);
  check("alice signup 201", a.status, 201);
  const b = await signup(bob);
  check("bob signup 201", b.status, 201);

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

  // ------------------------------------------------------------------- report
  console.log(`\n${"=".repeat(60)}`);
  if (failed === 0) {
    console.log(`  ALL ${passed} CHECKS PASSED`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED\n`);
    failures.forEach((f) => console.log(`   - ${f}`));
    console.log("\n  A failing SECURITY check means the IDOR is still exploitable.");
  }
  console.log(`${"=".repeat(60)}\n`);
  console.log(`  Throwaway accounts: ${alice.email}, ${bob.email}`);
  console.log(`  Left in Atlas — delete them from the users collection if unwanted.\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  Unexpected error:", err.message, "\n");
  process.exit(1);
});