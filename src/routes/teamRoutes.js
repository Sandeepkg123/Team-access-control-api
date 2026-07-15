const express = require("express");
const router = express.Router();
const { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember } = require("../controllers/teamController");
const authenticate = require("../middleware/authenticate");
const requireTeamMember = require("../middleware/requireTeamMember");
const requireRole = require("../middleware/requireRole");
const projectRoutes = require("./projectRoutes");

router.use(authenticate); // every team route requires login

router.post("/", createTeam);                    // any logged-in user can create
router.get("/my-teams", getMyTeams);              // no teamId involved

router.get("/:teamId", requireTeamMember, getTeam);
router.delete("/:teamId", requireTeamMember, requireRole(["owner"]), deleteTeam);

router.post("/:teamId/members", requireTeamMember, requireRole(["owner", "admin"]), addMember);
router.get("/:teamId/members", requireTeamMember, listMembers);
router.delete("/:teamId/members/:userId", requireTeamMember, requireRole(["owner", "admin"]), removeMember);
router.patch("/:teamId/transfer-ownership", requireTeamMember, requireRole(["owner"]), transferOwnership);

router.use("/:teamId/projects", projectRoutes);

module.exports = router;