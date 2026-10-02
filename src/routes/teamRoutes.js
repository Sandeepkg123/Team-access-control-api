const express = require("express");
const router = express.Router();
const { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember,transferOwnership } = require("../controllers/teamController");
const authenticate = require("../middleware/authenticate");
const requireTeamMember = require("../middleware/requireTeamMember");
const requireRole = require("../middleware/requireRole");
const projectRoutes = require("./projectRoutes");
const validateObjectId = require("../middleware/validateObjectId");
const validate = require("../middleware/validate");
const { addMemberValidator, transferOwnershipValidator } = require("../validators/memberValidators");

router.use(authenticate); // every team route requires login

router.post("/", createTeam);                    // any logged-in user can create
// NOTE: this MUST stay above "/:teamId" below. Express matches routes in
// declaration order, so moving it after would let "/my-teams" be captured as a
// teamId and fail validateObjectId with a confusing 400.
router.get("/my-teams", getMyTeams);              // no teamId involved

router.get("/:teamId", validateObjectId("teamId"), requireTeamMember, getTeam);
router.delete("/:teamId", validateObjectId("teamId"), requireTeamMember, requireRole(["owner"]), deleteTeam);

router.post("/:teamId/members", validateObjectId("teamId"), requireTeamMember, requireRole(["owner", "admin"]), addMemberValidator, validate, addMember);
router.get("/:teamId/members", validateObjectId("teamId"), requireTeamMember, listMembers);
router.delete("/:teamId/members/:userId", validateObjectId("teamId"), validateObjectId("userId"), requireTeamMember, requireRole(["owner", "admin"]), removeMember);
router.patch("/:teamId/transfer-ownership", validateObjectId("teamId"), requireTeamMember, requireRole(["owner"]), transferOwnershipValidator, validate, transferOwnership);

router.use("/:teamId/projects", projectRoutes);

module.exports = router;