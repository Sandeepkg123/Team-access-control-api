const { body } = require("express-validator");

// bcrypt hashes at most 72 BYTES and silently discards anything beyond that.
// Without an explicit cap, "A"*100 and "A"*72 produce the same hash and either
// password logs into the account — so the stored credential is never the one
// the user actually chose. The limit is expressed in bytes because bcrypt
// counts bytes, not characters: 30 four-byte emoji already exceed it.
const MAX_PASSWORD_BYTES = 72;

const signupValidator = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("email").isEmail().withMessage("Valid email required").normalizeEmail(),
  body("password")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    // custom validator so the limit is measured in bytes, matching bcrypt
    .custom((value) => {
      const bytes = Buffer.byteLength(String(value), "utf8");
      if (bytes > MAX_PASSWORD_BYTES) {
        throw new Error(
          `Password must be at most ${MAX_PASSWORD_BYTES} bytes (you sent ${bytes})`
        );
      }
      return true;
    }),
];

const loginValidator = [
  body("email").isEmail().withMessage("Valid email required"),
  body("password").notEmpty().withMessage("Password is required"),
];

module.exports = { signupValidator, loginValidator, MAX_PASSWORD_BYTES };