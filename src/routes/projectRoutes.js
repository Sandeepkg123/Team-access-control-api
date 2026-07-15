const express = require("express");
const router = express.Router({ mergeParams: true }); // needed to access :teamId from parent router
const { createProject, listProjects, updateProject, deleteProject } = require("../controllers/projectController");
const authenticate = require("../middleware/authenticate");
const requireTeamMember = require("../middleware/requireTeamMember");
const requireRole = require("../middleware/requireRole");

router.use(authenticate);

router.post("/", requireTeamMember, createProject);
router.get("/", requireTeamMember, listProjects);
router.patch("/:projectId", requireTeamMember, updateProject);
router.delete("/:projectId", requireTeamMember, requireRole(["owner", "admin"]), deleteProject);

module.exports = router;