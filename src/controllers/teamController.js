const Team = require("../models/Team");
const TeamMember = require("../models/TeamMember");

// CREATE TEAM
const createTeam = async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.user.id;

    const team = await Team.create({ name, ownerId: userId });

    await TeamMember.create({
      userId,
      teamId: team._id,
      role: "owner",
    });

    res.status(201).json({ message: "Team created", team });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET TEAM BY ID
const getTeam = async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found" });
    res.status(200).json({ team });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET ALL TEAMS FOR LOGGED-IN USER
const getMyTeams = async (req, res) => {
  try {
    const memberships = await TeamMember.find({ userId: req.user.id }).populate("teamId");
    res.status(200).json({ teams: memberships });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE TEAM
const deleteTeam = async (req, res) => {
  try {
    const { teamId } = req.params;

    await Team.findByIdAndDelete(teamId);
    await TeamMember.deleteMany({ teamId }); // cleanup all memberships too

    res.status(200).json({ message: "Team deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { createTeam, getTeam, getMyTeams, deleteTeam };