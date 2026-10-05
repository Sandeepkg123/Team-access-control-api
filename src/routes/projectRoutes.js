const express = require("express");
const router = express.Router({ mergeParams: true }); // needed to access :teamId from parent router
const { createProject, listProjects, updateProject, deleteProject } = require("../controllers/projectController");
const authenticate = require("../middleware/authenticate");
const requireTeamMember = require("../middleware/requireTeamMember");
const requireRole = require("../middleware/requireRole");
const validateObjectId = require("../middleware/validateObjectId");
const { writeLimiter } = require("../middleware/rateLimiter");

router.use(authenticate);

router.post("/", requireTeamMember, writeLimiter, createProject);
router.get("/", requireTeamMember, listProjects);
router.patch("/:projectId", validateObjectId("projectId"), requireTeamMember, writeLimiter, updateProject);
router.delete("/:projectId", validateObjectId("projectId"), requireTeamMember, requireRole(["owner", "admin"]), writeLimiter, deleteProject);

module.exports = router;