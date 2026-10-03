const { body } = require("express-validator");
const { MAX_PASSWORD_BYTES } = require("./authValidators");

const updateProfileValidator = [
  body("name")
    .optional()
    .isString()
    .withMessage("Name must be a string")
    .bail()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty"),
  body("password")
    .optional()
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
  // currentPassword is required when changing password
  body("currentPassword")
    .if(body("password").exists())
    .notEmpty()
    .withMessage("Current password is required to set a new password"),
];

module.exports = { updateProfileValidator };
