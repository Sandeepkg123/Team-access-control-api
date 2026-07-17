const express = require("express");
const router = express.Router();
const { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember,transferOwnership } = require("../controllers/teamController");
const authenticate = require("../middleware/authenticate");
const requireTeamMember = require("../middleware/requireTeamMember");
const requireRole = require("../middleware/requireRole");
const projectRoutes = require("./projectRoutes");
const validateObjectId = require("../middleware/validateObjectId");

router.use(authenticate); // every team route requires login

router.post("/", createTeam);                    // any logged-in user can create
router.get("/my-teams", getMyTeams);              // no teamId involved

router.get("/:teamId", validateObjectId("teamId"), requireTeamMember, getTeam);
router.delete("/:teamId", validateObjectId("teamId"), requireTeamMember, requireRole(["owner"]), deleteTeam);

router.post("/:teamId/members", validateObjectId("teamId"), requireTeamMember, requireRole(["owner", "admin"]), addMember);
router.get("/:teamId/members", validateObjectId("teamId"), requireTeamMember, listMembers);
router.delete("/:teamId/members/:userId", validateObjectId("teamId"), validateObjectId("userId"), requireTeamMember, requireRole(["owner", "admin"]), removeMember);
router.patch("/:teamId/transfer-ownership", validateObjectId("teamId"), requireTeamMember, requireRole(["owner"]), transferOwnership);

router.use("/:teamId/projects", projectRoutes);

module.exports = router;