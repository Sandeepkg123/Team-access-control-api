const { body } = require("express-validator");

// Guards the project override endpoint. Without this, a non-string userId fell
// through to ProjectMember.findOne as undefined — matching an arbitrary row or
// none — and an unknown role string reached the Mongoose enum and surfaced as a
// 500 rather than a clear 400.
const addProjectMemberValidator = [
  body("userId")
    .isMongoId()
    .withMessage("userId must be a valid user id"),
  body("role")
    .isIn(["editor", "viewer"])
    .withMessage("Role must be one of: editor, viewer"),
];

module.exports = { addProjectMemberValidator };