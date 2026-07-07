const express = require("express");
const router = express.Router();
const { createTeam, getTeam, getMyTeams, deleteTeam } = require("../controllers/teamController");
const authenticate = require("../middleware/authenticate");

router.use(authenticate); // every team route requires login

router.post("/", createTeam);
router.get("/my-teams", getMyTeams);
router.get("/:teamId", getTeam);
router.delete("/:teamId", deleteTeam);

module.exports = router;