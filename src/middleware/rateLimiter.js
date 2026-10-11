const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

// The automated test suite deliberately trips these limiters to prove they work.
// It presents a shared secret and is skipped, otherwise it would lock itself out
// partway through a run.
//
// SECURITY: the secret is REQUIRED and compared for equality. The previous check
// was `Boolean(req.headers["x-test-suite"])` — the mere PRESENCE of a
// client-chosen header skipped every limiter, so anyone could defeat the login
// brute-force guard, the signup cap and the write cap by sending one header.
// Keying on a value the client cannot guess restores the limiter's purpose: an
// attacker can no longer opt themselves out of it.
//
// TEST_SUITE_SECRET is intentionally NOT in config/env.js's REQUIRED list.
// A production deployment that never sets it gets no bypass at all, which is
// the safe default; only the suites need it, and they read it from .env too.
const common = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const secret = process.env.TEST_SUITE_SECRET;
    if (!secret) return false;
    const presented = req.get("x-test-suite");
    if (typeof presented !== "string" || presented.length === 0) return false;
    // Constant-time comparison so the secret cannot be recovered by timing the
    // response. Length is compared first because timingSafeEqual throws when the
    // two buffers differ in size.
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },
};

// Login is the most valuable target: it takes an unbounded number of password
// guesses with no lockout elsewhere.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: { error: "Too many login attempts, please try again after 15 minutes" },
  ...common,
});

// Signup was previously unlimited, which allowed both automated account
// creation and email enumeration.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 signups per window per IP
  message: { error: "Too many accounts created, please try again later" },
  ...common,
});

// Refresh accepts an attacker-supplied token, so it is a free verification
// oracle. Bounded to stop brute-forcing or flooding the handler.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // 60 refresh attempts per window
  message: { error: "Too many token refresh attempts, please try again later" },
  ...common,
});

// Forgot-password is an email-triggering endpoint. Without a limit, an attacker
// can use it to flood arbitrary addresses with reset emails (spam vector).
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per window per IP
  message: { error: "Too many password reset attempts, please try again later" },
  ...common,
});

// Write operations on teams and projects. Without a limit, an authenticated
// user can spam creates and edits without bound.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 write requests per window
  message: { error: "Too many requests, please slow down" },
  ...common,
});

module.exports = { loginLimiter, signupLimiter, refreshLimiter, forgotPasswordLimiter, writeLimiter };