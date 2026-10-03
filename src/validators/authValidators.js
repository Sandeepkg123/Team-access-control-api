const { body } = require("express-validator");

// bcrypt hashes at most 72 BYTES and silently discards anything beyond that.
// Without an explicit cap, "A"*100 and "A"*72 produce the same hash and either
// password logs into the account — so the stored credential is never the one
// the user actually chose. The limit is expressed in bytes because bcrypt
// counts bytes, not characters: 30 four-byte emoji already exceed it.
const MAX_PASSWORD_BYTES = 72;

// isString() guards come first on purpose. `isLength` happily coerces a number
// to its digit string, so a JSON body of {"password": 123456} passed the length
// check and then reached bcrypt.hash(123456, 10), which throws
// "Illegal arguments: number, number" — a 500 on a purely malformed request.
// Similarly an object body is stringified by Mongoose into "[object Object]",
// which was silently persisted as a user's real name.
const signupValidator = [
  body("name")
    .isString()
    .withMessage("Name must be a string")
    .bail()
    .trim()
    .notEmpty()
    .withMessage("Name is required"),
  body("email").isEmail().withMessage("Valid email required").normalizeEmail(),
  body("password")
    .isString()
    .withMessage("Password must be a string")
    .bail()
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
  // bcrypt.compare throws the same "Illegal arguments" fault on a non-string
  // password, so the same guard is needed here as on signup.
  body("password")
    .isString()
    .withMessage("Password must be a string")
    .bail()
    .notEmpty()
    .withMessage("Password is required"),
];

const forgotPasswordValidator = [
  body("email").isEmail().withMessage("Valid email required").normalizeEmail(),
];

const resetPasswordValidator = [
  body("token")
    .isString()
    .withMessage("Reset token is required")
    .bail()
    .notEmpty()
    .withMessage("Reset token is required"),
  body("newPassword")
    .isString()
    .withMessage("Password must be a string")
    .bail()
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
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

module.exports = { signupValidator, loginValidator, forgotPasswordValidator, resetPasswordValidator, MAX_PASSWORD_BYTES };