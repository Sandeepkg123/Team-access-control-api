const rateLimit = require("express-rate-limit");

// The automated test suite deliberately trips these limiters to prove they work.
// It sends x-test-suite on every request and is skipped, otherwise it would lock
// itself out partway through a run.
const common = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => Boolean(req.headers["x-test-suite"]),
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