const mongoose = require("mongoose");

// Per-project permission overrides.
//
// The team role on TeamMember already decides everything about a project: an
// owner/admin may edit all of them, and a plain member may only edit the ones
// they created. That leaves no way to hand someone edit rights on ONE project
// without promoting them team-wide, which is far more access than intended.
//
// This table adds that missing layer. A row here means "this user has this role
// on this specific project", and it takes precedence over the team role for
// edit/delete decisions on that project only. Absent a row, the team role
// applies exactly as before.
//
// "editor" can edit. "viewer" is explicitly read-only, which is the point of
// having it: it is the only way to grant access to someone who should NOT edit,
// on a project where the team default would otherwise let them edit their own.
const projectMemberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
  role: { type: String, enum: ["editor", "viewer"], required: true },
}, { timestamps: true });

// One override per user per project. Without this, calling the add endpoint
// twice would create two rows and the permission check would pick one
// arbitrarily — a silent, hard-to-debug inconsistency.
projectMemberSchema.index({ userId: 1, projectId: 1 }, { unique: true });

// Every permission check loads the override by project, so index that side too.
projectMemberSchema.index({ projectId: 1 });

module.exports = mongoose.model("ProjectMember", projectMemberSchema);