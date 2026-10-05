const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

// Index on teamId: every query filters by teamId (find, findOne). Without an
// index, MongoDB does a full collection scan on every project request.
projectSchema.index({ teamId: 1 });

module.exports = mongoose.model("Project", projectSchema);