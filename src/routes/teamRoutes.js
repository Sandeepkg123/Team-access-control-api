const express = require("express");
const router = express.Router();
const { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember } = require("../controllers/teamController");
const authenticate = require("../middleware/authenticate");

router.use(authenticate); // every team route requires login

router.post("/", createTeam);
router.get("/my-teams", getMyTeams);
router.get("/:teamId", getTeam);
router.delete("/:teamId", deleteTeam);


router.post("/:teamId/members", addMember);
router.get("/:teamId/members", listMembers);
router.delete("/:teamId/members/:userId", removeMember);


module.exports = router;