const mongoose = require("mongoose");
const Team = require("../models/Team");
const TeamMember = require("../models/TeamMember");
const Project = require("../models/Project");
const User = require("../models/User");

// CREATE TEAM
const createTeam = async (req, res, next) => {
  try {
    const { name } = req.body;
    const userId = req.user.id;

    // Two writes that must both land. If the membership insert failed, the team
    // would exist with NO owner — and a team with no owner is permanently stuck:
    // removeMember refuses to remove an owner, while deleteTeam and
    // transferOwnership both require one, so nobody could ever clean it up.
    let team;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        team = await Team.create([{ name, ownerId: userId }], { session }).then((r) => r[0]);

        await TeamMember.create(
          [{ userId, teamId: team._id, role: "owner" }],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

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

    // `teams` used to hold membership documents ({userId, teamId, role}) despite
    // the name, which was misleading for every consumer. It now holds real team
    // documents with the viewer's role merged in, so the key means what it says.
    // `memberships` is kept alongside it for callers that want the raw join rows,
    // which gives the frontend a migration path off the old shape.
    //
    // The filter drops memberships whose team has since been deleted: populate
    // leaves teamId null there rather than erroring.
    const teams = memberships
      .filter((m) => m.teamId)
      .map((m) => ({ ...m.teamId.toObject(), role: m.role }));

    res.status(200).json({ teams, memberships });
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
    //
    // Wrapped in a transaction: three independent writes would otherwise apply
    // one by one, so a failure part-way through left the team deleted but its
    // projects orphaned — the very bug the cascade was added to fix.
    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: "Team not found" });

    const session = await mongoose.startSession();
    let deletedProjects = 0;
    try {
      await session.withTransaction(async () => {
        await Team.deleteOne({ _id: teamId }, { session });
        await TeamMember.deleteMany({ teamId }, { session });
        const projectResult = await Project.deleteMany({ teamId }, { session });
        deletedProjects = projectResult.deletedCount;
      });

      res.status(200).json({
        message: "Team deleted",
        deletedProjects,
      });
    } finally {
      await session.endSession();
    }
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

    // Role assignment rules, from most to least privileged:
    //   - "owner" is NEVER assignable here. Ownership moves only through
    //     transfer-ownership, which keeps Team.ownerId in sync. Granting it
    //     directly let a team accumulate extra owners, which removeMember then
    //     refused to clean up (it blocks removing the owner), so they were
    //     permanent.
    //   - Only an owner may grant "admin".
    //   - Everyone else grants "member".
    // Any unrecognised role also falls through to "member".
    // req.membership.role is set by requireTeamMember, so no extra query.
    if (role === "owner") {
      return res.status(400).json({
        error: "Ownership cannot be assigned directly — use transfer-ownership",
      });
    }

    const requested = role === "admin" ? "admin" : "member";
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

    // An admin may only remove plain members. Letting one admin strip a peer's
    // admin role means a single compromised admin can lock every other admin out
    // of the team. Owners are unaffected and may remove anyone but themselves.
    if (membership.role === "admin" && req.membership.role !== "owner") {
      return res.status(403).json({ error: "Only an owner can remove another admin" });
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

    // Transferring to yourself would demote the only owner and then re-promote
    // them, but the ordering made the intermediate state observable and it is
    // never a meaningful request.
    if (newOwnerUserId === currentOwnerId) {
      return res.status(400).json({ error: "You are already the owner" });
    }

    // Confirm the target is actually a member of this team
    const newOwnerMembership = await TeamMember.findOne({ teamId, userId: newOwnerUserId });
    if (!newOwnerMembership) {
      return res.status(404).json({ error: "Target user is not a member of this team" });
    }

    if (newOwnerMembership.role === "owner") {
      return res.status(400).json({ error: "This user is already the owner" });
    }

    // Three writes that must all land or none: demote, promote, sync ownerId.
    // Previously these ran independently, so a failure part-way through could
    // leave a team with no owner at all, or with Team.ownerId disagreeing with
    // the membership table. A session guarantees all-or-nothing.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await TeamMember.updateOne(
          { teamId, userId: currentOwnerId },
          { role: "admin" },
          { session }
        );

        await TeamMember.updateOne(
          { _id: newOwnerMembership._id },
          { role: "owner" },
          { session }
        );

        // Keep Team.ownerId in sync (our denormalized shortcut)
        await Team.updateOne({ _id: teamId }, { ownerId: newOwnerUserId }, { session });
      });

      res.status(200).json({ message: "Ownership transferred successfully" });
    } finally {
      await session.endSession();
    }
  } catch (err) {
    next(err);
  }
};

module.exports = { createTeam, getTeam, getMyTeams, deleteTeam, addMember, listMembers, removeMember, transferOwnership };


