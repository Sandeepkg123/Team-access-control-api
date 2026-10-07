const express = require("express");
const router = express.Router({ mergeParams: true }); // needed to access :teamId from parent router
const {
  createProject,
  listProjects,
  updateProject,
  deleteProject,
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
} = require("../controllers/projectController");
const authenticate = require("../middleware/authenticate");
const requireTeamMember = require("../middleware/requireTeamMember");
const requireRole = require("../middleware/requireRole");
const validateObjectId = require("../middleware/validateObjectId");
const validate = require("../middleware/validate");
const { writeLimiter } = require("../middleware/rateLimiter");
const { addProjectMemberValidator } = require("../validators/projectValidators");

router.use(authenticate);

router.post("/", requireTeamMember, writeLimiter, createProject);
router.get("/", requireTeamMember, listProjects);
router.patch("/:projectId", validateObjectId("projectId"), requireTeamMember, writeLimiter, updateProject);
router.delete("/:projectId", validateObjectId("projectId"), requireTeamMember, requireRole(["owner", "admin"]), writeLimiter, deleteProject);

// Per-project permission overrides.
//
// No requireRole here on purpose. Whoever may manage access to a project is
// determined per project (owner/admin of the team, or an existing editor on
// that project), which requireRole cannot express — it only sees the team role.
// The controller resolves that and returns 403 itself.
router.post(
  "/:projectId/members",
  validateObjectId("projectId"),
  requireTeamMember,
  addProjectMemberValidator,
  validate,
  writeLimiter,
  addProjectMember
);
router.get("/:projectId/members", validateObjectId("projectId"), requireTeamMember, listProjectMembers);
router.delete(
  "/:projectId/members/:userId",
  validateObjectId("projectId"),
  validateObjectId("userId"),
  requireTeamMember,
  writeLimiter,
  removeProjectMember
);

module.exports = router;