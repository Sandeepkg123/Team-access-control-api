const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  action: {
    type: String,
    required: true,
    enum: [
      "member_added",
      "member_removed",
      "role_changed",
      "ownership_transferred",
      "member_left",
      "team_deleted",
      "team_updated",
    ],
  },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  details: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

// Index for querying logs by team, newest first (the most common access pattern)
auditLogSchema.index({ teamId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
