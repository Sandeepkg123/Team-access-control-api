const mongoose = require("mongoose");

const teamMemberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
  role: { type: String, enum: ["owner", "admin", "member"], required: true },
}, { timestamps: true });

// Prevent duplicate memberships (same user added twice to same team)
teamMemberSchema.index({ userId: 1, teamId: 1 }, { unique: true });

module.exports = mongoose.model("TeamMember", teamMemberSchema);