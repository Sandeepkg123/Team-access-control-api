const Team = require("../models/Team");
const TeamMember = require("../models/TeamMember");
const User = require("../models/User");

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



// ADD MEMBER
const addMember = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { email, role } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingMembership = await TeamMember.findOne({ teamId, userId: user._id });
    if (existingMembership) {
      return res.status(400).json({ error: "User is already a member of this team" });
    }

    const membership = await TeamMember.create({
      teamId,
      userId: user._id,
      role: role || "member", // default to "member" if not specified
    });

    res.status(201).json({ message: "Member added", membership });
  } catch (err) {
    res.status(500).json({ error: err.message });
    
  }
};

// LIST MEMBERS
const listMembers = async (req, res) => {
  try {
    const { teamId } = req.params;

    const members = await TeamMember.find({ teamId }).populate("userId", "name email");

    res.status(200).json({ members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// REMOVE MEMBER
const removeMember = async (req, res) => {
  try {
    const { teamId, userId } = req.params;

    const membership = await TeamMember.findOne({ teamId, userId });
    if (!membership) {
      return res.status(404).json({ error: "Membership not found" });
    }

    if (membership.role === "owner") {
      return res.status(400).json({ error: "Cannot remove the team owner" });
    }

    await TeamMember.findByIdAndDelete(membership._id);

    res.status(200).json({ message: "Member removed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// TRANSFER OWNERSHIP
const transferOwnership = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { newOwnerUserId } = req.body;
    const currentOwnerId = req.user.id;

    // Confirm the target is actually a member of this team
    const newOwnerMembership = await TeamMember.findOne({ teamId, userId: newOwnerUserId });
    if (!newOwnerMembership) {
      return res.status(404).json({ error: "Target user is not a member of this team" });
    }

    if (newOwnerMembership.role === "owner") {
      return res.status(400).json({ error: "This user is already the owner" });
    }

    // Demote current owner to admin
    await TeamMember.findOneAndUpdate(
      { teamId, userId: currentOwnerId },
      { role: "admin" }
    );

    // Promote target to owner
    newOwnerMembership.role = "owner";
    await newOwnerMembership.save();

    // Keep Team.ownerId in sync (our denormalized shortcut from Step 3)
    await Team.findByIdAndUpdate(teamId, { ownerId: newOwnerUserId });

    res.status(200).json({ message: "Ownership transferred successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember, transferOwnership };


