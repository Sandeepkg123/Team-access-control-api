/**
 * Fail fast on a bad environment.
 *
 * Without this, a missing JWT secret only surfaced at request time as a 500
 * from jsonwebtoken, and a missing MONGO_URI left the server listening against
 * no database. Checking at boot turns both into an immediate, obvious failure.
 */

const REQUIRED = [
  "MONGO_URI",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "ACCESS_TOKEN_EXPIRY",
  "REFRESH_TOKEN_EXPIRY",
];

// Short secrets are brute-forceable, which defeats the point of signing JWTs.
const MIN_SECRET_LENGTH = 32;

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach((key) => console.error(`     ${key}`));
    console.error("   Copy .env.example to .env and fill in the values.\n");
    process.exit(1);
  }

  const weak = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"].filter(
    (key) => process.env[key].length < MIN_SECRET_LENGTH
  );

  if (weak.length > 0) {
    console.error("❌ Refusing to start with a short JWT secret:");
    weak.forEach((key) =>
      console.error(`     ${key} is ${process.env[key].length} chars, minimum ${MIN_SECRET_LENGTH}`)
    );
    console.error("   Generate one with:  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n");
    process.exit(1);
  }

  if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    console.error("❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ.");
    console.error("   Reusing one secret means a stolen access token can be replayed as a refresh token.\n");
    process.exit(1);
  }

  console.log("✅ Environment validated");
}

module.exports = { validateEnv };