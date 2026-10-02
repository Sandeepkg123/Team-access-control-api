const Team = require("../models/Team");
const TeamMember = require("../models/TeamMember");
const Project = require("../models/Project");
const User = require("../models/User");

// CREATE TEAM
const createTeam = async (req, res, next) => {
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
    next(err);
  }
};

// GET TEAM BY ID
const getTeam = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found" });
    res.status(200).json({ team, role: req.membership.role });
  } catch (err) {
    next(err);
  }
};

// GET ALL TEAMS FOR LOGGED-IN USER
const getMyTeams = async (req, res, next) => {
  try {
    const memberships = await TeamMember.find({ userId: req.user.id }).populate("teamId");
    res.status(200).json({ teams: memberships });
  } catch (err) {
    next(err);
  }
};

// DELETE TEAM
const deleteTeam = async (req, res, next) => {
  try {
    const { teamId } = req.params;

    // Cascade: delete the team's projects as well as its memberships. Without
    // this, deleting a team left Project rows pointing at a team that no longer
    // exists — unreachable over HTTP (every route 403s on the missing team) but
    // still sitting in the collection forever.
    // Parallel, so all three run concurrently rather than in series.
    const [, , projectResult] = await Promise.all([
      Team.findByIdAndDelete(teamId),
      TeamMember.deleteMany({ teamId }),
      Project.deleteMany({ teamId }),
    ]);

    res.status(200).json({
      message: "Team deleted",
      deletedProjects: projectResult.deletedCount,
    });
  } catch (err) {
    next(err);
  }
};



// ADD MEMBER
const addMember = async (req, res, next) => {
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

    // An admin may only grant "member". Only an owner may grant "admin"/"owner".
    // Without this clamp, an admin can POST role:"owner" and mint an owner for
    // an account they control (signup has no email verification), taking over a
    // team that isn't theirs. req.membership.role is set by requireTeamMember,
    // so this needs no extra query.
    const requested = ["owner", "admin"].includes(role) ? role : "member";
    const assigned = req.membership.role === "owner" ? requested : "member";

    const membership = await TeamMember.create({
      teamId,
      userId: user._id,
      role: assigned,
    });

    res.status(201).json({ message: "Member added", membership });
  } catch (err) {
    next(err);
    
  }
};

// LIST MEMBERS
const listMembers = async (req, res, next) => {
  try {
    const { teamId } = req.params;

    const members = await TeamMember.find({ teamId }).populate("userId", "name email");

    res.status(200).json({ members });
  } catch (err) {
    next(err);
  }
};

// REMOVE MEMBER
const removeMember = async (req, res, next) => {
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
    next(err);
  }
};


// TRANSFER OWNERSHIP
const transferOwnership = async (req, res, next) => {
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
    next(err);
  }
};

module.exports = { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember, transferOwnership };


