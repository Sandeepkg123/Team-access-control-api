const { body } = require("express-validator");

// Validates the addMember request body. Without this, a missing email fell
// through to User.findOne({ email: undefined }) which matched an arbitrary
// document (or none), and an unknown role string reached the Mongoose enum and
// surfaced as a 500.
const addMemberValidator = [
  body("email")
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  // Mirrors the clamping in addMember: owners may grant owner/admin, admins may
  // only grant member. Rejecting anything outside the enum keeps the error a
  // clear 400 instead of a database failure.
  body("role")
    .optional()
    .isIn(["owner", "admin", "member"])
    .withMessage("Role must be one of: owner, admin, member"),
];

// newOwnerUserId is compared against ObjectIds in the database, so a malformed
// value threw a CastError and returned 500 before this validator existed.
const transferOwnershipValidator = [
  body("newOwnerUserId")
    .isMongoId()
    .withMessage("newOwnerUserId must be a valid user id"),
];

const updateTeamValidator = [
  body("name")
    .optional()
    .isString()
    .withMessage("Name must be a string")
    .bail()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty"),
  body("description")
    .optional()
    .isString()
    .withMessage("Description must be a string"),
];

// Only owner can change roles. Role can only be "admin" or "member" — never "owner".
const changeRoleValidator = [
  body("role")
    .isIn(["admin", "member"])
    .withMessage("Role must be one of: admin, member"),
];

module.exports = { addMemberValidator, transferOwnershipValidator, updateTeamValidator, changeRoleValidator };